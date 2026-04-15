interface Env {
  CORS_ORIGIN?: string;
  SQUARE_ACCESS_TOKEN?: string;
  SQUARE_LOCATION_ID?: string;
  SQUARE_VERSION?: string;
  SQUARE_ENV?: string;
  CHECKOUT_MOCK_MODE?: string;
}

type PaymentMethod = "square_card" | "cash_app_pay" | "apple_pay" | "google_pay";

interface CheckoutPayload {
  source?: string;
  paymentMethod: PaymentMethod;
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  shipping?: {
    addressLine1?: string;
    city?: string;
    state?: string;
    postalCode?: string;
  };
  items: Array<{
    sku: string;
    name: string;
    quantity: number;
    unitAmountCents: number;
  }>;
  notes?: string;
  amounts: {
    subtotalCents: number;
    feeCents: number;
    totalCents: number;
    currency: string;
  };
}

const METHOD_LABEL: Record<PaymentMethod, string> = {
  square_card: "Card (Square)",
  cash_app_pay: "Cash App Pay",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay"
};

const ROUTE_METHOD: Record<string, PaymentMethod> = {
  "/checkout/square/card-session": "square_card",
  "/checkout/square/cash-app-session": "cash_app_pay",
  "/checkout/square/apple-pay-session": "apple_pay",
  "/checkout/square/google-pay-session": "google_pay"
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8"
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";
    const corsOrigin = env.CORS_ORIGIN || "*";
    const allowOrigin = corsOrigin === "*" || origin === corsOrigin ? origin || corsOrigin : corsOrigin;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(allowOrigin)
      });
    }

    if (url.pathname === "/health") {
      return withCors(
        new Response(
          JSON.stringify({
            ok: true,
            service: "wild-concrete-checkout-api",
            timestamp: new Date().toISOString()
          }),
          { status: 200, headers: JSON_HEADERS }
        ),
        allowOrigin
      );
    }

    const routeMethod = ROUTE_METHOD[url.pathname];
    if (!routeMethod || request.method !== "POST") {
      return withCors(
        new Response(
          JSON.stringify({
            error: "not_found",
            message: "Use a supported checkout route or /health."
          }),
          { status: 404, headers: JSON_HEADERS }
        ),
        allowOrigin
      );
    }

    let payload: CheckoutPayload;
    try {
      payload = (await request.json()) as CheckoutPayload;
    } catch {
      return withCors(
        new Response(JSON.stringify({ error: "bad_json", message: "Invalid JSON payload." }), {
          status: 400,
          headers: JSON_HEADERS
        }),
        allowOrigin
      );
    }

    const validationError = validatePayload(payload, routeMethod);
    if (validationError) {
      return withCors(
        new Response(JSON.stringify({ error: "validation_failed", message: validationError }), {
          status: 400,
          headers: JSON_HEADERS
        }),
        allowOrigin
      );
    }

    try {
      const squareEnabled = Boolean(env.SQUARE_ACCESS_TOKEN && env.SQUARE_LOCATION_ID);
      const mockMode = (env.CHECKOUT_MOCK_MODE || "true").toLowerCase() === "true";

      if (!squareEnabled || mockMode) {
        const mockId = crypto.randomUUID().split("-")[0];
        const mockUrl = `https://checkout.wildconcrete.studio/mock/${mockId}`;
        return withCors(
          new Response(
            JSON.stringify({
              mode: "mock",
              provider: "square",
              method: payload.paymentMethod,
              checkoutUrl: mockUrl,
              message: "Mock checkout session created. Set Square secrets and CHECKOUT_MOCK_MODE=false for live calls."
            }),
            { status: 200, headers: JSON_HEADERS }
          ),
          allowOrigin
        );
      }

      const square = await createSquarePaymentLink(payload, env);
      return withCors(
        new Response(
          JSON.stringify({
            mode: "live",
            provider: "square",
            method: payload.paymentMethod,
            checkoutUrl: square.checkoutUrl,
            squarePaymentLinkId: square.id
          }),
          { status: 200, headers: JSON_HEADERS }
        ),
        allowOrigin
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected server error.";
      return withCors(
        new Response(JSON.stringify({ error: "checkout_failed", message }), {
          status: 502,
          headers: JSON_HEADERS
        }),
        allowOrigin
      );
    }
  }
};

function validatePayload(payload: CheckoutPayload, expectedMethod: PaymentMethod): string | null {
  if (!payload || !payload.items || !payload.items.length) return "At least one line item is required.";
  if (payload.paymentMethod !== expectedMethod) return "Route does not match selected payment method.";
  if (!payload.amounts || payload.amounts.totalCents < 100) return "Total amount must be at least $1.00.";
  if (!payload.customer?.name || !payload.customer?.email) return "Customer name and email are required.";

  for (const item of payload.items) {
    if (!item.name || !item.sku) return "Each item must include sku and name.";
    if (!Number.isFinite(item.quantity) || item.quantity < 1) return "Quantity must be >= 1.";
    if (!Number.isFinite(item.unitAmountCents) || item.unitAmountCents < 1) {
      return "Item amount must be >= 1 cent.";
    }
  }

  return null;
}

async function createSquarePaymentLink(payload: CheckoutPayload, env: Env): Promise<{ checkoutUrl: string; id: string }> {
  const baseUrl = env.SQUARE_ENV === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";

  const checkoutOptions: Record<string, unknown> = {
    ask_for_shipping_address: true,
    allow_tipping: false,
    custom_fields: [
      {
        title: "Preferred payment",
        uid: "preferred_payment",
        type: "STRING",
        value: METHOD_LABEL[payload.paymentMethod]
      }
    ]
  };

  const body = {
    idempotency_key: crypto.randomUUID(),
    description: `Wild Concrete order from ${payload.customer?.name || "customer"}`,
    quick_pay: {
      name: `Wild Concrete - ${payload.items[0].name}`,
      price_money: {
        amount: payload.amounts.totalCents,
        currency: payload.amounts.currency || "USD"
      },
      location_id: env.SQUARE_LOCATION_ID
    },
    checkout_options: checkoutOptions,
    pre_populated_data: {
      buyer_email: payload.customer?.email,
      buyer_phone_number: payload.customer?.phone
    },
    payment_note: `Method: ${METHOD_LABEL[payload.paymentMethod]} | SKU: ${payload.items[0].sku}`
  };

  const response = await fetch(`${baseUrl}/v2/online-checkout/payment-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "Square-Version": env.SQUARE_VERSION || "2026-01-22",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = (await response.json()) as {
    errors?: Array<{ detail?: string; code?: string }>;
    payment_link?: { id?: string; url?: string; long_url?: string };
  };

  if (!response.ok || !data.payment_link) {
    const detail = data.errors?.[0]?.detail || data.errors?.[0]?.code || "Square API request failed.";
    throw new Error(detail);
  }

  const checkoutUrl = data.payment_link.url || data.payment_link.long_url;
  if (!checkoutUrl) throw new Error("Square did not return a checkout URL.");

  return {
    checkoutUrl,
    id: data.payment_link.id || "unknown"
  };
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400"
  };
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(origin);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

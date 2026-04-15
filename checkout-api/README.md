# Wild Concrete Checkout API (Cloudflare Worker)

This Worker exposes API routes for checkout session creation used by the homepage form.

## Routes

- `POST /checkout/square/card-session`
- `POST /checkout/square/cash-app-session`
- `POST /checkout/square/apple-pay-session`
- `POST /checkout/square/google-pay-session`
- `GET /health`

## Modes

- **Mock mode** (default): returns a mock `checkoutUrl` immediately.
- **Live mode**: calls Square Checkout API to create a hosted payment link.

## Required secrets for live mode

Set in Worker:

- `SQUARE_ACCESS_TOKEN`
- `SQUARE_LOCATION_ID`

Optional vars:

- `SQUARE_ENV` = `production` or `sandbox`
- `SQUARE_VERSION` = API version header (default `2026-01-22`)
- `CHECKOUT_MOCK_MODE` = `false` to enable live calls
- `CORS_ORIGIN` = allowed frontend origin

## Deploy

```bash
cd checkout-api
npx wrangler deploy
```

## Add secrets

```bash
npx wrangler secret put SQUARE_ACCESS_TOKEN
npx wrangler secret put SQUARE_LOCATION_ID
```

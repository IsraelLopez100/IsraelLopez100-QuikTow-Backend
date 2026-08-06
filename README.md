# QuikTow Backend

A small Express API: create/list/update tow jobs, and process real (test-mode) Stripe payments. This replaces the browser-only storage used in the prototype artifact with a real server your apps can all talk to.

This repository contains a single-file Express server (server.js) and a tiny SQLite database for demo/testing only. See notes below for running locally and production recommendations.

## Endpoints

- `GET  /api/health` — sanity check
- `GET  /api/jobs` — list all jobs
- `POST /api/jobs` — create a job `{ service, priceValue, pickup, customer }`
- `PATCH /api/jobs/:id` — update `{ status, driver }`
- `POST /api/jobs/:id/pay` — creates a Stripe PaymentIntent, returns `{ clientSecret }`
- `POST /api/stripe/webhook` — Stripe calls this when a payment actually succeeds

## Run locally

```bash
npm install
cp .env.example .env   # then fill in your Stripe test keys
npm run dev
```

Test it:
```bash
curl http://localhost:4000/api/health
curl -X POST http://localhost:4000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"service":"Flatbed Tow","priceValue":85,"pickup":"123 Main St"}'
```

## Deploy free — Render.com

1. **Push this folder to a GitHub repo** (e.g. `quiktow-backend`).
2. Go to **render.com** → sign up (free) → **New +** → **Web Service**.
3. Connect your GitHub repo.
4. Settings:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Add environment variables (Render dashboard → Environment):
   - `STRIPE_SECRET_KEY` — from [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys) (make sure you're in **test mode**, top-right toggle)
   - `STRIPE_WEBHOOK_SECRET` — see step 6 below
6. Once deployed, you'll get a URL like `https://quiktow-backend.onrender.com`. Create the webhook:
   - Stripe dashboard → **Developers → Webhooks → Add endpoint**
   - URL: `https://quiktow-backend.onrender.com/api/stripe/webhook`
   - Event: `payment_intent.succeeded`
   - Copy the **signing secret** it gives you into `STRIPE_WEBHOOK_SECRET` on Render, redeploy.

### Free-tier limitations worth knowing about

- **Cold starts**: the free instance spins down after ~15 min idle. The first request after that takes 30-50 seconds to wake up. Fine for testing, not for real customers waiting on a tow.
- **Ephemeral disk**: the SQLite file resets on every redeploy or restart. Your job history won't survive a code push. When you're ready to keep real records, swap in a managed Postgres (Render offers one, or Supabase/Neon have free tiers with persistent storage) — the `better-sqlite3` calls in `server.js` would need to become async Postgres queries, but the API shape stays the same.
- **Test mode only**: with test Stripe keys, no real money moves — this is exactly what you want until the business, licensing, and insurance side (see the legal reminder) is actually in place.

## Next step

Once this is deployed and you have a live URL, the frontend prototype (`quiktow-app.jsx`) needs its `window.storage` calls swapped for `fetch()` calls to this API. Send me the deployed URL and I'll wire that up.

# Capture Studio API (Cloudflare Worker)

Backend for the "Upload to Cloud" feature in the Capture Studio desktop app: auth, subscription
billing (PayPal + PayOS), and presigned R2 uploads. See `../master-context.md` §"Cloud upload" for
how this fits into the overall app.

## Stack

Cloudflare Workers + D1 (SQLite) + R2, routed with [Hono](https://hono.dev). No Node server to run
or manage — deploys as a single edge function.

## One-time setup

1. **Cloudflare**
   - `npx wrangler login`
   - Create an R2 bucket: `npx wrangler r2 bucket create capture-studio-uploads`
   - Create an R2 API token (dashboard → R2 → Manage API Tokens → Object Read & Write, scoped to
     that bucket) → note the Access Key ID / Secret Access Key and your Account ID.
   - **Attach a custom domain to the bucket** (dashboard → R2 → bucket → Settings → Custom
     Domains) and set it as `PUBLIC_R2_URL` in `wrangler.toml`. Then add a Cache Rule for that
     hostname: **Cache Everything**, edge TTL a month.

     This is not a cosmetic "brand it later" step, it is what makes the economics work.
     Cloudflare documents `*.r2.dev` as **rate-limited, development-only**, and says caching
     is unavailable on it — so on `r2.dev` every image view is a billed Class B read
     ($0.36/million) instead of a free cache hit. An embedded screenshot in a popular post
     would bill you per reader.
   - The Worker itself can stay on `*.workers.dev`; only the *bucket* needs the custom domain.
   - Create the D1 database: `npx wrangler d1 create capture-studio-db` → copy the returned
     `database_id` into `wrangler.toml`.
   - Run the migrations: `npm run db:migrate:remote` (and `db:migrate:local` for local dev).
     Applies `0001_init.sql` and `0002_leak_fixes.sql`.
   - The nightly cron in `wrangler.toml` is what keeps storage costs bounded — see
     "Storage reclamation" below. It is deployed automatically with `wrangler deploy`.

2. **Secrets** (never committed — set via `wrangler secret put <NAME>`):
   ```
   wrangler secret put JWT_SECRET            # any random 32+ byte string
   wrangler secret put R2_ACCOUNT_ID
   wrangler secret put R2_ACCESS_KEY_ID
   wrangler secret put R2_SECRET_ACCESS_KEY
   wrangler secret put PAYPAL_API_BASE       # https://api-m.sandbox.paypal.com while testing
   wrangler secret put PAYPAL_CLIENT_ID
   wrangler secret put PAYPAL_CLIENT_SECRET
   wrangler secret put PAYPAL_WEBHOOK_ID
   # JSON map of "<tier>:<interval>" -> PayPal billing-plan id, one entry per price point
   # in src/pricing.ts. See wrangler.toml for the exact shape.
   wrangler secret put PAYPAL_PLAN_IDS
   wrangler secret put PAYOS_CLIENT_ID
   wrangler secret put PAYOS_API_KEY
   wrangler secret put PAYOS_CHECKSUM_KEY
   ```

3. **PayPal** — developer.paypal.com → create an App (sandbox first) → create a Product + two
   Billing Plans (monthly $3, annual $30) → note the Plan IDs → register a Webhook pointing at
   `https://<your-worker>.workers.dev/webhooks/paypal` subscribed to
   `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.CANCELLED`,
   `BILLING.SUBSCRIPTION.EXPIRED`, `BILLING.SUBSCRIPTION.SUSPENDED`, `PAYMENT.SALE.COMPLETED`,
   `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`.

4. **PayOS** — payos.vn merchant dashboard → Client ID / API Key / Checksum Key → register the
   webhook URL `https://<your-worker>.workers.dev/webhooks/payos`. **PayOS's API has had version
   churn — verify the exact create-payment / webhook payload and signature format in `payos.ts`
   against their current docs before going live**; this implementation follows their v2
   `payment-requests` contract as documented at the time this was written.

## Develop / deploy

```bash
npm install
npm run dev        # local dev server (wrangler dev)
npm run typecheck
npm run deploy      # publishes to your *.workers.dev subdomain
```

## Pricing

All amounts live in `src/pricing.ts` — change values there, nothing else needs touching.

| Plan | PayPal | PayOS | Storage included |
|---|---|---|---|
| Monthly | $3.00 | 50,000₫ | 3 GB |
| Annual | $30.00 | 500,000₫ | 3 GB |

| Top-up (one-time, permanent) | PayPal | PayOS |
|---|---|---|
| +5 GB | $4.00 | 100,000₫ |
| +20 GB | $12.00 | 300,000₫ |

## API surface

| Route | Auth | Purpose |
|---|---|---|
| `POST /auth/signup`, `/auth/login` | – | issue a 30-day JWT |
| `GET /account/status` | JWT | subscription + storage usage summary |
| `GET /pricing` | – | the storage-tier ladder; unauthenticated so the app can show prices before signup |
| `POST /billing/paypal/create-subscription {tier,interval}` | JWT | returns PayPal approval URL |
| `POST /billing/payos/create-payment {tier,interval}` | JWT | returns PayOS checkout URL |
| `POST /webhooks/paypal`, `/webhooks/payos` | signature-verified | activate/renew/cancel subscriptions |
| `POST /upload/presign {itemId,fileName,contentType,sizeBytes}` | JWT | 402 if no active plan or over quota; else a short-lived presigned R2 PUT URL |
| `POST /upload/confirm {itemId,r2Key,sizeBytes}` | JWT | records the upload so quota accounting stays accurate |

The desktop app's Rust `cloud.rs` module (`src-tauri/src/cloud.rs`) is the only client — it PUTs
file bytes straight to the presigned R2 URL, so upload bandwidth never passes through this Worker.

## Known follow-ups (not built yet)

- No custom URL-scheme deep link back into the app after payment — user manually refreshes
  status, or the app short-polls for ~2 minutes after opening checkout.
- No email receipts/renewal reminders (PayOS especially has no auto-renew).
- Deleting a local item does not delete its R2 object.
- No refund/cancel API — PayPal subscriptions are cancelled from the user's own PayPal account.


## Storage reclamation

Two scheduled sweeps run nightly (`src/cleanup.ts`, cron `0 3 * * *`). Without them the bucket
only ever grows, and R2 storage is billed monthly forever.

**Orphan sweep.** `/upload/confirm` is what records bytes against a user's quota, and a client
can simply never call it — the object still lands in the bucket, billed, counted against
nobody. The sweep lists the bucket and deletes any object with no matching `uploads` row that
is older than 6 hours (long enough that a slow upload in flight is never caught).

**Lapsed-account sweep.** Cloud copies are deliberately left readable when a subscription ends
so links already shared keep resolving, but that cannot be forever. After `LAPSE_GRACE_DAYS`
(30) past `current_period_end`, the account's objects and rows are deleted together. The value
is sent to the app in `/account/status` and shown in Settings, so the promise on screen and the
number enforced here cannot drift apart.

Both are idempotent: a run that is cut short leaves the database rows in place, so the next run
finds the same work rather than stranding objects.

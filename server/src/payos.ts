import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { requireAuth } from "./auth";
import {
  extendCurrentPeriodEnd,
  getPaymentByProviderId,
  markPaymentStatus,
  recordPayment,
  upsertSubscription,
  getActiveSubscription,
} from "./db";
import {
  DEFAULT_TIER,
  INTERVAL_DAYS,
  getTier,
  isPlanInterval,
  isTierId,
  tierPrice,
  type PlanInterval,
  type TierId,
} from "./pricing";
import type { Env } from "./types";

export const payosRoutes = new Hono<AppEnv>();
export const payosWebhook = new Hono<AppEnv>();

const PAYOS_API_BASE = "https://api-merchant.payos.vn";

// NOTE: PayOS is a smaller regional provider whose public API has had version
// churn — verify this payload/signature shape against current docs
// (https://payos.vn/docs) before going live. Structure below follows PayOS's
// documented v2 "payment-requests" create + webhook contract as of writing.

async function hmacHex(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// PayOS requires the create-payment signature over a specific alphabetically-sorted
// "key=value&..." string of the top-level fields below.
async function signCreatePayment(
  checksumKey: string,
  fields: { amount: number; cancelUrl: string; description: string; orderCode: number; returnUrl: string }
): Promise<string> {
  const data = `amount=${fields.amount}&cancelUrl=${fields.cancelUrl}&description=${fields.description}&orderCode=${fields.orderCode}&returnUrl=${fields.returnUrl}`;
  return hmacHex(checksumKey, data);
}

function newOrderCode(): number {
  // PayOS orderCode must be a positive integer unique per merchant; time-based is
  // sufficient at this app's volume and stays within JS's safe integer range.
  return Date.now();
}

async function createPaymentLink(
  env: Env,
  opts: { orderCode: number; amountVnd: number; description: string }
): Promise<{ checkoutUrl: string }> {
  const returnUrl = "https://example.com/payos/return"; // shown briefly before user returns to the app manually
  const cancelUrl = "https://example.com/payos/cancel";
  const signature = await signCreatePayment(env.PAYOS_CHECKSUM_KEY, {
    amount: opts.amountVnd,
    cancelUrl,
    description: opts.description,
    orderCode: opts.orderCode,
    returnUrl,
  });

  const res = await fetch(`${PAYOS_API_BASE}/v2/payment-requests`, {
    method: "POST",
    headers: {
      "x-client-id": env.PAYOS_CLIENT_ID,
      "x-api-key": env.PAYOS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      orderCode: opts.orderCode,
      amount: opts.amountVnd,
      description: opts.description,
      returnUrl,
      cancelUrl,
      signature,
    }),
  });
  if (!res.ok) throw new Error(`PayOS error: ${res.status} ${await res.text()}`);
  const json = await res.json<{ data: { checkoutUrl: string } }>();
  return { checkoutUrl: json.data.checkoutUrl };
}

payosRoutes.post("/create-payment", requireAuth, async (c) => {
  type Body = { interval?: string; tier?: string };
  const body = await c.req.json<Body>().catch(() => ({}) as Body);
  const { interval, tier } = body;
  if (!isPlanInterval(interval)) return c.json({ error: "Invalid interval" }, 400);
  if (!isTierId(tier)) return c.json({ error: "Invalid tier" }, 400);

  const orderCode = newOrderCode();
  const price = tierPrice(tier, interval);
  const userId = c.get("userId");

  // What was bought is written down here, on our own row, before the user ever reaches the
  // payment page. The webhook reads the tier back from this row rather than from the
  // callback payload, so nothing the user's browser touches can decide how much storage
  // gets granted.
  await recordPayment(c.env, {
    userId,
    subscriptionId: null,
    kind: "subscription",
    bytesAdded: null,
    provider: "payos",
    providerPaymentId: String(orderCode),
    amountCents: price.vndAmount, // VND has no cents; this column stores the integer VND amount
    currency: "VND",
    status: "pending",
    rawPayload: JSON.stringify({ interval, tier }),
  });

  const { checkoutUrl } = await createPaymentLink(c.env, {
    orderCode,
    amountVnd: price.vndAmount,
    // PayOS caps the description field, so this stays short: tier, interval, nothing else.
    description: `Capture Studio ${getTier(tier).label} ${interval}`,
  });
  return c.json({ checkoutUrl });
});

// Top-ups are gone — see the note in paypal.ts. Storage is a property of the current tier.

// ---- Webhook ----

async function verifyWebhookSignature(env: Env, payload: any): Promise<boolean> {
  const { signature, ...rest } = payload.data ?? {};
  if (!signature) return false;
  const sortedKeys = Object.keys(rest).sort();
  const data = sortedKeys.map((k) => `${k}=${rest[k]}`).join("&");
  const expected = await hmacHex(env.PAYOS_CHECKSUM_KEY, data);
  return expected === signature;
}

payosWebhook.post("/", async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  if (!body) return c.json({ error: "Invalid payload" }, 400);

  const ok = await verifyWebhookSignature(c.env, body);
  if (!ok) return c.json({ error: "Invalid signature" }, 400);

  const data = body.data ?? {};
  const orderCode: number | undefined = data.orderCode;
  const success = data.code === "00" || body.success === true;
  if (!orderCode || !success) return c.json({ received: true });

  const payment = await getPaymentByProviderId(c.env, "payos", String(orderCode));
  if (!payment || payment.status === "succeeded") return c.json({ received: true });

  // The webhook carries its own amount. It has to match the order we created, otherwise a
  // 100,000₫ top-up notification could be made to settle a 300,000₫ order — the pack that
  // gets granted below is read from our own pending row, not from the payload.
  const paidVnd = Number(data.amount ?? 0);
  if (!Number.isFinite(paidVnd) || paidVnd < payment.amount_cents) {
    await markPaymentStatus(c.env, payment.id, "failed");
    return c.json({ received: true });
  }

  await markPaymentStatus(c.env, payment.id, "succeeded");

  if (payment.kind === "subscription") {
    const ctx = JSON.parse(payment.raw_payload ?? "{}") as {
      interval?: PlanInterval;
      tier?: TierId;
    };
    const interval: PlanInterval = ctx.interval === "annual" ? "annual" : "monthly";
    // Rows written before tiers existed carry no tier; they were all the old single plan.
    const tier: TierId = isTierId(ctx.tier) ? ctx.tier : DEFAULT_TIER;
    const existing = await getActiveSubscription(c.env, payment.user_id);
    await upsertSubscription(c.env, {
      userId: payment.user_id,
      provider: "payos",
      providerSubscriptionId: null,
      planInterval: interval,
      tier,
      status: "active",
      currentPeriodEnd: existing?.current_period_end ?? new Date().toISOString(),
      // The tier just paid for decides the quota outright. Carrying the previous value over
      // would leave someone who moved up a tier on their old, smaller allowance.
      storageQuotaBytes: getTier(tier).bytes,
    });
    await extendCurrentPeriodEnd(c.env, payment.user_id, INTERVAL_DAYS[interval]);
  }

  return c.json({ received: true });
});

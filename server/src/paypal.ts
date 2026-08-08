import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { requireAuth } from "./auth";
import {
  extendCurrentPeriodEnd,
  getActiveSubscription,
  getPaymentByProviderId,
  recordPayment,
  upsertSubscription,
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

export const paypalRoutes = new Hono<AppEnv>();
export const paypalWebhook = new Hono<AppEnv>();

async function getAccessToken(env: Env): Promise<string> {
  const creds = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const res = await fetch(`${env.PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  const json = await res.json<{ access_token: string }>();
  return json.access_token;
}

/**
 * PayPal charges against a billing plan created in their dashboard, one per price point, so a
 * tier ladder needs a plan per (tier, interval) pair. They arrive as one JSON env var keyed
 * `"<tier>:<interval>"`.
 */
function planIds(env: Env): Record<string, string> {
  try {
    return JSON.parse(env.PAYPAL_PLAN_IDS || "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function planIdFor(env: Env, tier: TierId, interval: PlanInterval): string | null {
  return planIds(env)[`${tier}:${interval}`] ?? null;
}

/**
 * What a plan id was sold as. The webhook needs this because the plan is what PayPal actually
 * charged — it outranks anything we labelled the subscription with at creation time.
 */
function planFromId(env: Env, planId: string): { tier: TierId; interval: PlanInterval } | null {
  const hit = Object.entries(planIds(env)).find(([, id]) => id === planId);
  if (!hit) return null;
  const [tier, interval] = hit[0].split(":");
  return isTierId(tier) && isPlanInterval(interval) ? { tier, interval } : null;
}

/**
 * `custom_id` is set by us on the create call and echoed back untouched, so it survives as a
 * fallback for a plan id we no longer recognise — a plan retired from the map still has live
 * subscribers billing against it.
 */
function customIdFor(userId: string, tier: TierId, interval: PlanInterval): string {
  return `${userId}:${tier}:${interval}`;
}

function parseCustomId(
  raw: string | undefined
): { userId: string; tier: TierId | null; interval: PlanInterval | null } | null {
  if (!raw) return null;
  const [userId, tier, interval] = raw.split(":");
  if (!userId) return null;
  return {
    userId,
    tier: isTierId(tier) ? tier : null,
    interval: isPlanInterval(interval) ? interval : null,
  };
}

// ---- Authed: create subscription / topup order ----

paypalRoutes.post("/create-subscription", requireAuth, async (c) => {
  type Body = { interval?: string; tier?: string };
  const body = await c.req.json<Body>().catch(() => ({}) as Body);
  const { interval, tier } = body;
  if (!isPlanInterval(interval)) return c.json({ error: "Invalid interval" }, 400);
  if (!isTierId(tier)) return c.json({ error: "Invalid tier" }, 400);

  const planId = planIdFor(c.env, tier, interval);
  // A missing plan id means this deployment was never given one for this price point. Failing
  // here is the only honest outcome: sending the user to PayPal without it charges them
  // against whatever plan happens to be first in the account.
  if (!planId) return c.json({ error: "That plan is not available yet" }, 503);

  const token = await getAccessToken(c.env);
  const res = await fetch(`${c.env.PAYPAL_API_BASE}/v1/billing/subscriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      plan_id: planId,
      custom_id: customIdFor(c.get("userId"), tier, interval),
      application_context: {
        brand_name: "Capture Studio",
        user_action: "SUBSCRIBE_NOW",
      },
    }),
  });
  if (!res.ok) return c.json({ error: `PayPal error: ${await res.text()}` }, 502);
  const json = await res.json<{ links: { rel: string; href: string }[] }>();
  const approvalUrl = json.links.find((l) => l.rel === "approve")?.href;
  if (!approvalUrl) return c.json({ error: "No approval link returned" }, 502);
  return c.json({ approvalUrl });
});

// Storage top-ups are gone. They sold capacity once and owed it for as long as the account
// existed; a tier is re-charged every interval, so changing plan is now a subscription
// change rather than a separate one-off purchase.

// ---- Webhook (unauthenticated route, signature-verified below) ----

async function verifyWebhookSignature(
  env: Env,
  headers: Headers,
  body: string
): Promise<boolean> {
  const token = await getAccessToken(env);
  const res = await fetch(`${env.PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      transmission_id: headers.get("paypal-transmission-id"),
      transmission_time: headers.get("paypal-transmission-time"),
      cert_url: headers.get("paypal-cert-url"),
      auth_algo: headers.get("paypal-auth-algo"),
      transmission_sig: headers.get("paypal-transmission-sig"),
      webhook_id: env.PAYPAL_WEBHOOK_ID,
      webhook_event: JSON.parse(body),
    }),
  });
  if (!res.ok) return false;
  const json = await res.json<{ verification_status: string }>();
  return json.verification_status === "SUCCESS";
}

paypalWebhook.post("/", async (c) => {
  const raw = await c.req.text();
  const ok = await verifyWebhookSignature(c.env, c.req.raw.headers, raw);
  if (!ok) return c.json({ error: "Invalid signature" }, 400);

  const event = JSON.parse(raw) as {
    event_type: string;
    resource: Record<string, any>;
  };

  switch (event.event_type) {
    case "BILLING.SUBSCRIPTION.ACTIVATED": {
      const custom = parseCustomId(event.resource.custom_id);
      if (!custom) break;
      const planId: string | undefined = event.resource.plan_id;

      // The plan is what PayPal is actually charging, so it decides what was bought. The
      // labels we attached at creation are the fallback for a plan since retired from the
      // map — its subscribers are still being billed and must still be served.
      const sold = (planId && planFromId(c.env, planId)) || null;
      const tier: TierId = sold?.tier ?? custom.tier ?? DEFAULT_TIER;
      const interval: PlanInterval = sold?.interval ?? custom.interval ?? "monthly";

      await upsertSubscription(c.env, {
        userId: custom.userId,
        provider: "paypal",
        providerSubscriptionId: event.resource.id,
        planInterval: interval,
        tier,
        status: "active",
        currentPeriodEnd: new Date(
          Date.now() + INTERVAL_DAYS[interval] * 24 * 60 * 60 * 1000
        ).toISOString(),
        storageQuotaBytes: getTier(tier).bytes,
      });
      break;
    }
    case "PAYMENT.SALE.COMPLETED": {
      // Recurring charge on an existing subscription — extend the period.
      const custom = parseCustomId(event.resource.custom_id);
      if (!custom) break;
      const userId = custom.userId;

      // Retries of the same sale must not stack extra time onto the period.
      const saleId: string | undefined = event.resource.id;
      if (saleId && (await getPaymentByProviderId(c.env, "paypal", saleId))) break;

      // The term comes from the subscription's own plan. A hardcoded 30 days here gave an
      // annual subscriber one month of access per yearly payment.
      const existing = await getActiveSubscription(c.env, userId);
      const interval: PlanInterval = existing?.plan_interval === "annual" ? "annual" : "monthly";
      const tier: TierId = isTierId(existing?.tier) ? existing.tier : custom.tier ?? DEFAULT_TIER;
      await extendCurrentPeriodEnd(c.env, userId, INTERVAL_DAYS[interval]);
      await recordPayment(c.env, {
        userId,
        subscriptionId: existing?.id ?? null,
        kind: "subscription",
        bytesAdded: null,
        provider: "paypal",
        providerPaymentId: saleId ?? null,
        amountCents: tierPrice(tier, interval).usdCents,
        currency: "USD",
        status: "succeeded",
        rawPayload: raw,
      });
      break;
    }
    case "BILLING.SUBSCRIPTION.CANCELLED":
    case "BILLING.SUBSCRIPTION.EXPIRED":
    case "BILLING.SUBSCRIPTION.SUSPENDED": {
      const custom = parseCustomId(event.resource.custom_id);
      if (!custom) break;
      const existing = await getActiveSubscription(c.env, custom.userId);
      if (existing) {
        await upsertSubscription(c.env, {
          userId: custom.userId,
          provider: "paypal",
          providerSubscriptionId: existing.provider_subscription_id,
          planInterval: existing.plan_interval,
          tier: existing.tier,
          status: event.event_type.endsWith("SUSPENDED") ? "past_due" : "canceled",
          currentPeriodEnd: existing.current_period_end,
          storageQuotaBytes: existing.storage_quota_bytes,
        });
      }
      break;
    }
    // Deliberately NOT handling CHECKOUT.ORDER.APPROVED: "approved" means the payer clicked
    // through, not that any money moved. Granting storage there handed out gigabytes to
    // anyone willing to start a checkout and abandon it before capture.
    // PAYMENT.CAPTURE.COMPLETED is deliberately unhandled: the only one-off capture this
    // service ever created was a storage top-up, and top-ups no longer exist. Leaving the
    // case in place would be an invitation to grant capacity for a payment nothing here
    // charged for.
    default:
      break;
  }

  return c.json({ received: true });
});

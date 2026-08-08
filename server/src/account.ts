import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { requireAuth } from "./auth";
import { getActiveSubscription, getStorageUsedBytes, subscriptionIsActive } from "./db";
import { LAPSE_GRACE_DAYS } from "./cleanup";
import { NO_PLAN_STORAGE_BYTES } from "./pricing";
import type { AccountStatus } from "./types";

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.get("/status", requireAuth, async (c) => {
  const userId = c.get("userId");
  const email = c.get("userEmail");
  const sub = await getActiveSubscription(c.env, userId);
  const used = await getStorageUsedBytes(c.env, userId);

  const active = subscriptionIsActive(sub);

  const status: AccountStatus = {
    email,
    subscriptionActive: active,
    planInterval: sub?.plan_interval ?? null,
    tier: sub?.tier ?? null,
    currentPeriodEnd: sub?.current_period_end ?? null,
    provider: sub?.provider ?? null,
    storageUsedBytes: used,
    storageQuotaBytes: sub?.storage_quota_bytes ?? NO_PLAN_STORAGE_BYTES,
    // Sent rather than hardcoded in the app so the promise shown to the user and the number
    // the sweep actually enforces can never drift apart.
    lapseGraceDays: LAPSE_GRACE_DAYS,
  };
  return c.json(status);
});

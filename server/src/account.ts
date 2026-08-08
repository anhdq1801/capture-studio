import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { requireAuth } from "./auth";
import {
  getActiveSubscription,
  getStorageUsedBytes,
  nowIso,
  subscriptionIsActive,
} from "./db";
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

/** R2 takes many keys per delete call, but not an unbounded number. */
const DELETE_BATCH = 1000;

/**
 * Close the account and erase the personal data in it.
 *
 * The privacy policy promises this, so it exists as a button rather than as an email to
 * somebody who then runs SQL by hand — a promise that depends on a human being awake is not
 * a promise.
 *
 * What happens, in this order:
 *
 *  1. Uploaded objects are deleted from the bucket, then their rows. Objects first, so that a
 *     run cut short leaves rows pointing at nothing rather than objects nobody remembers —
 *     the latter would sit in the bucket, billed, invisible. Same reasoning as cleanup.ts.
 *  2. The subscription row goes.
 *  3. The user row is anonymised rather than deleted. Payment records must survive for tax
 *     and accounting, and they reference the user; deleting the row would either break that
 *     reference or take the financial record with it. Stripping the email and destroying the
 *     password hash removes everything personal and leaves an id that identifies nobody.
 *
 * Irreversible, and the caller is expected to have said so plainly first.
 */
accountRoutes.post("/delete", requireAuth, async (c) => {
  const userId = c.get("userId");

  const rows = await c.env.DB.prepare("SELECT r2_key FROM uploads WHERE user_id = ?")
    .bind(userId)
    .all<{ r2_key: string }>();
  const keys = (rows.results ?? []).map((r) => r.r2_key);

  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    await c.env.BUCKET.delete(keys.slice(i, i + DELETE_BATCH));
  }

  await c.env.DB.prepare("DELETE FROM uploads WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(userId).run();

  // A hash no password can produce, so the account cannot be logged into even if the row is
  // somehow reached again. `verifyPassword` splits on "$" and this has no parts to split.
  await c.env.DB.prepare("UPDATE users SET email = ?, password_hash = ? WHERE id = ?")
    .bind(`deleted+${userId}@invalid`, "deleted", userId)
    .run();

  console.log(`[account/delete ${nowIso()}] user=${userId} objects=${keys.length}`);
  return c.json({ deleted: true, objectsRemoved: keys.length });
});

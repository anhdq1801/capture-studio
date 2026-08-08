import type { Env, SubscriptionRow, UserRow } from "./types";

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function getUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE email = ?")
    .bind(email)
    .first<UserRow>();
}

export async function getUserById(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function insertUser(
  env: Env,
  user: { id: string; email: string; passwordHash: string; createdAt: string }
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(user.id, user.email, user.passwordHash, user.createdAt)
    .run();
}

/**
 * The user's subscription row, whatever state it is in. Despite the name it does NOT filter
 * by status — callers must run the row through `subscriptionIsActive`. Kept as-is because
 * quota and period-end still have to be readable for a lapsed account.
 */
export async function getActiveSubscription(
  env: Env,
  userId: string
): Promise<SubscriptionRow | null> {
  return env.DB.prepare(
    `SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1`
  )
    .bind(userId)
    .first<SubscriptionRow>();
}

/**
 * One definition of "may use paid features", shared by every caller.
 *
 * Both the status flag and the period end matter: a webhook that never arrives leaves
 * `status` stuck on 'active' long after the customer stopped paying.
 */
export function subscriptionIsActive(sub: SubscriptionRow | null): boolean {
  return !!sub && sub.status === "active" && new Date(sub.current_period_end) > new Date();
}

export async function getStorageUsedBytes(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(size_bytes), 0) AS total FROM uploads WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function upsertSubscription(
  env: Env,
  sub: {
    userId: string;
    provider: "paypal" | "payos";
    providerSubscriptionId: string | null;
    planInterval: "monthly" | "annual";
    tier: string;
    status: SubscriptionRow["status"];
    currentPeriodEnd: string;
    storageQuotaBytes: number;
  }
): Promise<void> {
  const existing = await getActiveSubscription(env, sub.userId);
  const now = nowIso();
  if (existing) {
    await env.DB.prepare(
      `UPDATE subscriptions SET provider=?, provider_subscription_id=?, plan_interval=?,
       tier=?, status=?, current_period_end=?, storage_quota_bytes=?, updated_at=? WHERE id=?`
    )
      .bind(
        sub.provider,
        sub.providerSubscriptionId,
        sub.planInterval,
        sub.tier,
        sub.status,
        sub.currentPeriodEnd,
        sub.storageQuotaBytes,
        now,
        existing.id
      )
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO subscriptions
       (id, user_id, provider, provider_subscription_id, plan_interval, tier, status,
        current_period_end, storage_quota_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        newId(),
        sub.userId,
        sub.provider,
        sub.providerSubscriptionId,
        sub.planInterval,
        sub.tier,
        sub.status,
        sub.currentPeriodEnd,
        sub.storageQuotaBytes,
        now,
        now
      )
      .run();
  }
}

export async function extendCurrentPeriodEnd(
  env: Env,
  userId: string,
  fromNowDays: number
): Promise<void> {
  const existing = await getActiveSubscription(env, userId);
  const base =
    existing && new Date(existing.current_period_end).getTime() > Date.now()
      ? new Date(existing.current_period_end)
      : new Date();
  base.setDate(base.getDate() + fromNowDays);
  await env.DB.prepare(
    `UPDATE subscriptions SET status='active', current_period_end=?, updated_at=? WHERE user_id=?`
  )
    .bind(base.toISOString(), nowIso(), userId)
    .run();
}

export async function recordPayment(
  env: Env,
  p: {
    userId: string;
    subscriptionId: string | null;
    kind: "subscription" | "topup";
    bytesAdded: number | null;
    provider: "paypal" | "payos";
    providerPaymentId: string | null;
    amountCents: number;
    currency: string;
    status: "succeeded" | "failed" | "pending";
    rawPayload: string;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO payments
     (id, user_id, subscription_id, kind, bytes_added, provider, provider_payment_id,
      amount_cents, currency, status, raw_payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId(),
      p.userId,
      p.subscriptionId,
      p.kind,
      p.bytesAdded,
      p.provider,
      p.providerPaymentId,
      p.amountCents,
      p.currency,
      p.status,
      p.rawPayload,
      nowIso()
    )
    .run();
}

export interface PaymentRow {
  id: string;
  user_id: string;
  subscription_id: string | null;
  kind: "subscription" | "topup";
  bytes_added: number | null;
  provider: "paypal" | "payos";
  provider_payment_id: string | null;
  amount_cents: number;
  currency: string;
  status: "succeeded" | "failed" | "pending";
  raw_payload: string | null;
  created_at: string;
}

export async function getPaymentByProviderId(
  env: Env,
  provider: "paypal" | "payos",
  providerPaymentId: string
): Promise<PaymentRow | null> {
  return env.DB.prepare(
    "SELECT * FROM payments WHERE provider = ? AND provider_payment_id = ? LIMIT 1"
  )
    .bind(provider, providerPaymentId)
    .first<PaymentRow>();
}

export async function markPaymentStatus(
  env: Env,
  id: string,
  status: "succeeded" | "failed"
): Promise<void> {
  await env.DB.prepare("UPDATE payments SET status = ? WHERE id = ?").bind(status, id).run();
}

export interface UploadRow {
  id: string;
  user_id: string;
  item_id: string;
  r2_key: string;
  size_bytes: number;
  created_at: string;
}

export async function getUploadByItem(
  env: Env,
  userId: string,
  itemId: string
): Promise<UploadRow | null> {
  return env.DB.prepare("SELECT * FROM uploads WHERE user_id = ? AND item_id = ? LIMIT 1")
    .bind(userId, itemId)
    .first<UploadRow>();
}

export async function deleteUploadRow(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(id).run();
}

/**
 * One row per (user, item). A plain INSERT let a client confirm the same upload repeatedly
 * and inflate its own usage, and left a second row behind whenever an item was re-uploaded,
 * so reported usage drifted away from what the bucket actually held.
 */
export async function recordUpload(
  env: Env,
  u: { userId: string; itemId: string; r2Key: string; sizeBytes: number }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO uploads (id, user_id, item_id, r2_key, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, item_id)
     DO UPDATE SET r2_key = excluded.r2_key, size_bytes = excluded.size_bytes,
                   created_at = excluded.created_at`
  )
    .bind(newId(), u.userId, u.itemId, u.r2Key, u.sizeBytes, nowIso())
    .run();
}

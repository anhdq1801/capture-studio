/**
 * Nightly reclamation.
 *
 * Two things in this system quietly cost money forever if nobody sweeps up:
 *
 *  1. An object that was uploaded but never confirmed. `/upload/confirm` is what records the
 *     bytes against a user's quota, and a client is free to simply not call it — the object
 *     still sits in the bucket, billed monthly, counted against nobody.
 *  2. An account whose subscription lapsed. Objects are deliberately left readable when a
 *     subscription ends, so links already shared out keep resolving, but "deliberately" has
 *     to stop somewhere or a customer who paid $3 once is stored at our expense indefinitely.
 *
 * Both sweeps are idempotent and safe to run again if a run is cut short.
 */

import { nowIso } from "./db";
import type { Env } from "./types";

/**
 * How long an unconfirmed object is left alone before it is treated as abandoned.
 *
 * Comfortably longer than a slow upload of a large recording plus the confirm round-trip, so
 * an in-flight upload is never swept out from under a paying customer.
 */
const ORPHAN_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * How long after a subscription lapses the files are kept.
 *
 * Long enough to cover a failed card, a forgotten renewal or a holiday — deleting someone's
 * shared links the morning a payment bounces would be indefensible. Surfaced in the UI so it
 * is a promise rather than a surprise.
 */
export const LAPSE_GRACE_DAYS = 30;

const LIST_PAGE = 1000;

/** Delete in batches — R2's delete takes many keys, but not unbounded. */
async function deleteKeys(env: Env, keys: string[]): Promise<number> {
  for (let i = 0; i < keys.length; i += LIST_PAGE) {
    await env.BUCKET.delete(keys.slice(i, i + LIST_PAGE));
  }
  return keys.length;
}

/**
 * Delete objects in the bucket that no `uploads` row points at.
 *
 * Driven from the bucket rather than from the database on purpose: the database only knows
 * about uploads that were confirmed, and the whole point is to find the ones that were not.
 */
export async function sweepOrphanObjects(env: Env): Promise<number> {
  const known = new Set<string>();
  const rows = await env.DB.prepare("SELECT r2_key FROM uploads").all<{ r2_key: string }>();
  for (const r of rows.results ?? []) known.add(r.r2_key);

  const cutoff = Date.now() - ORPHAN_GRACE_MS;
  const doomed: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: "u/", cursor, limit: LIST_PAGE });
    for (const obj of page.objects) {
      if (known.has(obj.key)) continue;
      // `uploaded` is R2's own timestamp, so a client clock can't keep an object alive.
      if (obj.uploaded.getTime() > cutoff) continue;
      doomed.push(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return deleteKeys(env, doomed);
}

/**
 * Reclaim storage from accounts whose subscription ended more than the grace period ago.
 *
 * Deletes the objects and their rows together, so reported usage matches the bucket and the
 * account starts from zero if they come back.
 */
export async function sweepLapsedAccounts(env: Env): Promise<{ users: number; objects: number }> {
  const cutoff = new Date(Date.now() - LAPSE_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const lapsed = await env.DB.prepare(
    `SELECT DISTINCT s.user_id AS user_id
       FROM subscriptions s
      WHERE s.current_period_end < ?
        AND s.status != 'active'
        AND EXISTS (SELECT 1 FROM uploads u WHERE u.user_id = s.user_id)`
  )
    .bind(cutoff)
    .all<{ user_id: string }>();

  let objects = 0;
  const users = lapsed.results ?? [];
  for (const { user_id } of users) {
    const rows = await env.DB.prepare("SELECT r2_key FROM uploads WHERE user_id = ?")
      .bind(user_id)
      .all<{ r2_key: string }>();
    const keys = (rows.results ?? []).map((r) => r.r2_key);
    if (keys.length === 0) continue;
    objects += await deleteKeys(env, keys);
    // Only after the objects are gone: if this run dies mid-way the rows are still there and
    // the next run finds the same account, rather than the bucket keeping orphans forever.
    await env.DB.prepare("DELETE FROM uploads WHERE user_id = ?").bind(user_id).run();
  }
  return { users: users.length, objects };
}

export async function runNightlySweeps(env: Env): Promise<void> {
  const orphans = await sweepOrphanObjects(env);
  const lapsed = await sweepLapsedAccounts(env);
  console.log(
    `[cleanup ${nowIso()}] orphan objects deleted=${orphans}; ` +
      `lapsed accounts=${lapsed.users}, their objects deleted=${lapsed.objects}`
  );
}

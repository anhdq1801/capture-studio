import { Hono } from "hono";
import { AwsClient } from "aws4fetch";
import type { AppEnv } from "./auth";
import { requireAuth } from "./auth";
import {
  getActiveSubscription,
  getStorageUsedBytes,
  getUploadByItem,
  deleteUploadRow,
  recordUpload,
  subscriptionIsActive,
} from "./db";

export const uploadRoutes = new Hono<AppEnv>();

const PRESIGN_TTL_SECONDS = 10 * 60;

/**
 * Hard ceiling on a single object, independent of the account's quota.
 *
 * The quota check alone is not enough: it is evaluated against the size the *client* claims
 * before the upload, and a client is free to lie. This is the number baked into the signature,
 * so R2 itself rejects anything larger.
 */
const MAX_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "file";
}

function objectKey(userId: string, itemId: string, fileName: string): string {
  return `u/${userId}/${itemId}-${sanitizeFileName(fileName)}`;
}

uploadRoutes.post("/presign", requireAuth, async (c) => {
  const userId = c.get("userId");
  type PresignBody = { itemId?: string; fileName?: string; contentType?: string; sizeBytes?: number };
  const body = await c.req.json<PresignBody>().catch(() => ({}) as PresignBody);
  const { itemId, fileName, contentType, sizeBytes } = body;
  if (!itemId || !fileName || !contentType || !sizeBytes || sizeBytes <= 0) {
    return c.json({ error: "Missing or invalid fields" }, 400);
  }
  if (sizeBytes > MAX_OBJECT_BYTES) {
    return c.json({ error: "File is too large to upload", code: "too_large" }, 413);
  }

  const sub = await getActiveSubscription(c.env, userId);
  if (!subscriptionIsActive(sub)) {
    return c.json({ error: "No active subscription", code: "no_subscription" }, 402);
  }

  // Replacing an item's own upload should not be charged twice — the old object is
  // overwritten (same key) or deleted at confirm time, so only the delta matters.
  const previous = await getUploadByItem(c.env, userId, itemId);
  const used = (await getStorageUsedBytes(c.env, userId)) - (previous?.size_bytes ?? 0);
  if (used + sizeBytes > sub!.storage_quota_bytes) {
    return c.json(
      {
        error: "Storage quota exceeded",
        code: "quota_exceeded",
        storageUsedBytes: used,
        storageQuotaBytes: sub!.storage_quota_bytes,
      },
      402
    );
  }

  const key = objectKey(userId, itemId, fileName);
  const client = new AwsClient({
    accessKeyId: c.env.R2_ACCESS_KEY_ID,
    secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });

  // aws4fetch only sets a default X-Amz-Expires (24h) when the URL doesn't already have one —
  // pre-set our shorter TTL so it gets signed into the canonical request.
  const objectUrl = new URL(
    `https://${c.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${c.env.R2_BUCKET}/${key}`
  );
  objectUrl.searchParams.set("X-Amz-Expires", String(PRESIGN_TTL_SECONDS));
  const signed = await client.sign(objectUrl.toString(), {
    method: "PUT",
    headers: { "content-type": contentType, "content-length": String(sizeBytes) },
    // `content-length` and `content-type` are both on aws4fetch's unsignable list and are
    // dropped unless allHeaders is set. Without this the signature covers neither, so the URL
    // authorises an upload of *any* size — the quota check above would be advisory only, and
    // a modified client could store unlimited data on a $3 plan. With it, R2 rejects the PUT
    // unless the byte count matches exactly what was quota-checked.
    aws: { signQuery: true, allHeaders: true },
  });

  return c.json({
    uploadUrl: signed.url,
    publicUrl: `${c.env.PUBLIC_R2_URL.replace(/\/$/, "")}/${key}`,
    r2Key: key,
    contentType,
  });
});

uploadRoutes.post("/confirm", requireAuth, async (c) => {
  const userId = c.get("userId");
  type ConfirmBody = { itemId?: string; r2Key?: string };
  const body = await c.req.json<ConfirmBody>().catch(() => ({}) as ConfirmBody);
  const { itemId, r2Key } = body;
  if (!itemId || !r2Key) {
    return c.json({ error: "Missing or invalid fields" }, 400);
  }
  // Only allow confirming uploads under this user's own key prefix.
  if (!r2Key.startsWith(`u/${userId}/`)) {
    return c.json({ error: "Invalid key" }, 403);
  }

  // The size is read back off the stored object rather than taken from the request. The
  // client used to supply it, which meant usage accounting believed whatever the client said
  // — upload 500 MB, report 1 KB, and the quota never moves.
  const head = await c.env.BUCKET.head(r2Key);
  if (!head) {
    return c.json({ error: "No uploaded object at that key", code: "missing_object" }, 409);
  }
  const sizeBytes = head.size;

  const sub = await getActiveSubscription(c.env, userId);
  if (!subscriptionIsActive(sub)) {
    // Subscription lapsed between presign and confirm. Don't keep the bytes.
    await c.env.BUCKET.delete(r2Key);
    return c.json({ error: "No active subscription", code: "no_subscription" }, 402);
  }

  const previous = await getUploadByItem(c.env, userId, itemId);
  const otherUsage = (await getStorageUsedBytes(c.env, userId)) - (previous?.size_bytes ?? 0);
  if (otherUsage + sizeBytes > sub!.storage_quota_bytes) {
    // Over quota despite the presign check — the only way here is a client that sent a
    // different byte count than it asked for. Refuse it and take the bytes back.
    await c.env.BUCKET.delete(r2Key);
    return c.json(
      {
        error: "Storage quota exceeded",
        code: "quota_exceeded",
        storageUsedBytes: otherUsage,
        storageQuotaBytes: sub!.storage_quota_bytes,
      },
      402
    );
  }

  // A re-upload under a new file name leaves the old object behind under its old key; it is
  // no longer referenced by anything, so it would be paid for forever.
  if (previous && previous.r2_key !== r2Key) {
    await c.env.BUCKET.delete(previous.r2_key);
  }
  await recordUpload(c.env, { userId, itemId, r2Key, sizeBytes });
  return c.json({ ok: true, sizeBytes });
});

/**
 * Drop an item's cloud copy. Called when the desktop app deletes the item locally, so the
 * bucket doesn't accumulate objects nothing points at any more.
 */
uploadRoutes.post("/delete", requireAuth, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ itemId?: string }>().catch(() => ({}) as { itemId?: string });
  const itemId = body.itemId;
  if (!itemId) return c.json({ error: "Missing itemId" }, 400);

  const row = await getUploadByItem(c.env, userId, itemId);
  if (!row) return c.json({ ok: true, deleted: false });

  await c.env.BUCKET.delete(row.r2_key);
  await deleteUploadRow(c.env, row.id);
  return c.json({ ok: true, deleted: true });
});

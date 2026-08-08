-- One upload row per (user, item).
--
-- `recordUpload` used a plain INSERT, so confirming the same upload twice created two rows
-- and counted the bytes twice, and re-uploading an item left the old row behind pointing at
-- an object that had been replaced. Usage therefore drifted away from what the bucket really
-- held, in both directions. The upsert in db.ts needs this constraint to have anything to
-- conflict on.
--
-- Duplicates are collapsed before the index is added, keeping the newest row for each pair —
-- that is the one whose r2_key matches the object currently in the bucket.
DELETE FROM uploads
WHERE rowid NOT IN (
  SELECT MAX(rowid) FROM uploads GROUP BY user_id, item_id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_uploads_user_item ON uploads(user_id, item_id);

-- Lets the nightly sweep find lapsed accounts without scanning every subscription.
CREATE INDEX IF NOT EXISTS idx_subscriptions_period_end
  ON subscriptions(current_period_end);

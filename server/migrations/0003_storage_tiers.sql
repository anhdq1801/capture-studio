-- Storage tiers replace "one 3GB plan plus permanent top-up packs".
--
-- The old model sold capacity once and owed it forever; the new one sells a tier that is
-- re-charged every interval, so capacity and revenue expire together. `storage_quota_bytes`
-- stays as the column every quota check reads — the tier decides what goes into it rather
-- than replacing it, which keeps upload.ts unchanged.

ALTER TABLE subscriptions ADD COLUMN tier TEXT NOT NULL DEFAULT '5gb';

-- Existing subscribers keep at least what they had. Their quota was 3GB plus whatever
-- top-ups they bought, so each row maps to the smallest tier that is no smaller than its
-- current allowance — nobody wakes up with less storage than they paid for, and the 3GB
-- base becomes 5GB.
UPDATE subscriptions SET tier = CASE
  WHEN storage_quota_bytes <=   5368709120 THEN '5gb'
  WHEN storage_quota_bytes <=  26843545600 THEN '25gb'
  WHEN storage_quota_bytes <=  53687091200 THEN '50gb'
  ELSE '100gb'
END;

-- Bring the stored quota up to the tier that was just assigned, so the number enforced on
-- upload and the number shown in the app both come from the tier from here on.
UPDATE subscriptions SET storage_quota_bytes = CASE tier
  WHEN '5gb'   THEN   5368709120
  WHEN '25gb'  THEN  26843545600
  WHEN '50gb'  THEN  53687091200
  WHEN '100gb' THEN 107374182400
  ELSE storage_quota_bytes
END;

-- Top-ups are gone: capacity is a property of the current tier now, and `kind='topup'` rows
-- can no longer be created. The historical rows stay for the payment record.

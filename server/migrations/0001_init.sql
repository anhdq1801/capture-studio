CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,               -- 'paypal' | 'payos'
  provider_subscription_id TEXT,        -- PayPal subscription id; NULL for PayOS
  plan_interval TEXT NOT NULL,          -- 'monthly' | 'annual'
  status TEXT NOT NULL,                 -- 'active' | 'past_due' | 'canceled' | 'expired'
  current_period_end TEXT NOT NULL,
  storage_quota_bytes INTEGER NOT NULL, -- base plan quota + all topups, permanent
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  subscription_id TEXT REFERENCES subscriptions(id),
  kind TEXT NOT NULL,                   -- 'subscription' | 'topup'
  bytes_added INTEGER,                  -- only set when kind = 'topup'
  provider TEXT NOT NULL,               -- 'paypal' | 'payos'
  provider_payment_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,               -- 'USD' | 'VND'
  status TEXT NOT NULL,                 -- 'succeeded' | 'failed' | 'pending'
  raw_payload TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_payments_user ON payments(user_id);

-- One row per uploaded item. SUM(size_bytes) per user is the storage-usage figure
-- checked against subscriptions.storage_quota_bytes on every presign request.
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  item_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_uploads_user ON uploads(user_id);

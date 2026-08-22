export interface Env {
  DB: D1Database;
  /** Server-side object access: size checks, orphan and lapsed-account cleanup. */
  BUCKET: R2Bucket;

  PUBLIC_R2_URL: string;
  R2_BUCKET: string;

  JWT_SECRET: string;

  /**
   * Transactional email, used only by password reset. Both are optional: without them the
   * reset route still answers normally and logs that it could not send, rather than 500ing
   * and telling an attacker which addresses are registered.
   */
  RESEND_API_KEY?: string;
  /** Envelope sender, e.g. `Capture Studio <noreply@capturestudio.app>`. Must be a domain
   *  verified with the mail provider. */
  MAIL_FROM?: string;
  /** Origin of the marketing site, used to build the link in the reset email. */
  SITE_URL?: string;

  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;

  PAYPAL_API_BASE: string; // https://api-m.sandbox.paypal.com or https://api-m.paypal.com
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PAYPAL_WEBHOOK_ID: string;
  /**
   * JSON object mapping `"<tier>:<interval>"` to a PayPal billing-plan id, e.g.
   * `{"5gb:monthly":"P-1AB…","5gb:annual":"P-2CD…", …}`.
   *
   * One env var rather than one per price point: a tier ladder needs a plan per
   * (tier, interval) pair, and eight discrete secrets is eight chances to set one wrong and
   * discover it only when a customer is charged the price of a different tier.
   */
  PAYPAL_PLAN_IDS: string;

  PAYOS_CLIENT_ID: string;
  PAYOS_API_KEY: string;
  PAYOS_CHECKSUM_KEY: string;
}

export interface JwtPayload {
  sub: string; // user id
  email: string;
  iat: number;
  exp: number;
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  /** Set by a password reset; sessions issued before it are refused. Null for accounts whose
   *  password has never been changed. */
  password_changed_at: string | null;
}

export interface PasswordResetRow {
  token_hash: string;
  user_id: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface SubscriptionRow {
  id: string;
  user_id: string;
  provider: "paypal" | "payos";
  provider_subscription_id: string | null;
  plan_interval: "monthly" | "annual";
  /** Storage tier id from pricing.ts. Kept as plain TEXT so a retired tier still reads back. */
  tier: string;
  status: "active" | "past_due" | "canceled" | "expired";
  current_period_end: string;
  storage_quota_bytes: number;
  created_at: string;
  updated_at: string;
}

export interface AccountStatus {
  email: string;
  subscriptionActive: boolean;
  planInterval: "monthly" | "annual" | null;
  /** Storage tier id, or null for an account that has never subscribed. */
  tier: string | null;
  currentPeriodEnd: string | null;
  provider: "paypal" | "payos" | null;
  storageUsedBytes: number;
  storageQuotaBytes: number;
  /** Days after a subscription lapses before cloud files are deleted. */
  lapseGraceDays: number;
}

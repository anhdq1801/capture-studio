// Single source of truth for plan pricing. Change values here only — billing logic in
// paypal.ts/payos.ts/upload.ts reads from this file, never hardcodes an amount, and the
// desktop app fetches them from GET /pricing rather than shipping its own copy.
//
// Storage is sold as a tier the subscriber picks, not as one fixed allowance. R2 bills for
// bytes actually stored, never for the ceiling that was sold, so a generous tier costs
// nothing until it is used — which is what makes a 25GB tier viable at this price. The
// numbers still have to be read as worst case: a subscriber who genuinely fills 100GB costs
// $1.50/month against $5.00 of revenue, so the margin narrows as the tiers grow and there is
// no room to keep extending the ladder at these increments.

const GB = 1024 * 1024 * 1024;

export type PlanInterval = "monthly" | "annual";
export type TierId = "5gb" | "25gb" | "50gb" | "100gb";

/** How long one payment buys. Annual is charged once and grants the whole year. */
export const INTERVAL_DAYS: Record<PlanInterval, number> = { monthly: 30, annual: 365 };

export interface TierPrice {
  /** USD, in cents — the amount actually charged for one interval. */
  usdCents: number;
  /** VND, whole dong — PayOS takes integers and Vietnamese pricing is not a conversion. */
  vndAmount: number;
}

export interface Tier {
  id: TierId;
  label: string;
  bytes: number;
  price: Record<PlanInterval, TierPrice>;
}

/**
 * Quota for an account with no active subscription.
 *
 * Zero: cloud upload is the paid feature, and the app is expected to send anyone who clicks
 * Upload to the plan picker. Giving this a real value (Teampaper hands out 100MB) would turn
 * it into a free tier — worth considering, since a free tier is what gets people uploading
 * before they are asked to pay, but note that nothing currently reclaims storage from an
 * account that never subscribed: `sweepLapsedAccounts` only looks at subscriptions that
 * ended. A free tier needs its own retention rule first.
 */
export const NO_PLAN_STORAGE_BYTES = 0;

export const TIERS: Tier[] = [
  {
    id: "5gb",
    label: "5 GB",
    bytes: 5 * GB,
    price: {
      monthly: { usdCents: 300, vndAmount: 50_000 },
      annual: { usdCents: 2400, vndAmount: 400_000 },
    },
  },
  {
    id: "25gb",
    label: "25 GB",
    bytes: 25 * GB,
    price: {
      monthly: { usdCents: 400, vndAmount: 70_000 },
      annual: { usdCents: 3600, vndAmount: 600_000 },
    },
  },
  {
    id: "50gb",
    label: "50 GB",
    bytes: 50 * GB,
    price: {
      monthly: { usdCents: 500, vndAmount: 85_000 },
      annual: { usdCents: 4800, vndAmount: 800_000 },
    },
  },
  {
    id: "100gb",
    label: "100 GB",
    bytes: 100 * GB,
    price: {
      monthly: { usdCents: 600, vndAmount: 100_000 },
      annual: { usdCents: 6000, vndAmount: 1_000_000 },
    },
  },
];

/** The tier a subscription defaults to when an older row predates the tier column. */
export const DEFAULT_TIER: TierId = "5gb";

export function isPlanInterval(v: unknown): v is PlanInterval {
  return v === "monthly" || v === "annual";
}

export function isTierId(v: unknown): v is TierId {
  return TIERS.some((t) => t.id === v);
}

export function getTier(id: TierId): Tier {
  // Non-null: every caller reaches this through `isTierId` or a column constrained to the
  // same set, and a missing tier would mean the table and this file have diverged.
  return TIERS.find((t) => t.id === id)!;
}

/**
 * Bytes a tier grants, tolerant of an unrecognised id.
 *
 * Rows written before a tier was retired still name it, and reading such a row must not throw
 * on a path as ordinary as showing someone their storage bar.
 */
export function tierBytes(id: string | null | undefined): number {
  return TIERS.find((t) => t.id === id)?.bytes ?? NO_PLAN_STORAGE_BYTES;
}

export function tierPrice(id: TierId, interval: PlanInterval): TierPrice {
  return getTier(id).price[interval];
}

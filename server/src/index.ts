import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import type { AppEnv } from "./auth";
import { authRoutes } from "./auth";
import { accountRoutes } from "./account";
import { uploadRoutes } from "./upload";
import { paypalRoutes, paypalWebhook } from "./paypal";
import { payosRoutes, payosWebhook } from "./payos";
import { runNightlySweeps } from "./cleanup";
import { LAPSE_GRACE_DAYS } from "./cleanup";
import { TIERS } from "./pricing";

const app = new Hono<AppEnv>();

app.get("/", (c) => c.json({ ok: true, service: "capture-studio-api" }));

/**
 * The plan ladder, so the app can render prices it did not compile in.
 *
 * Unauthenticated: someone deciding whether to create an account needs to see what it costs
 * before they have one. Serving it from `pricing.ts` is the point — a price shipped inside a
 * desktop build cannot be corrected without shipping another build, and the copy that gets
 * charged is always this one.
 *
 * CORS is opened on this route and only this route. The marketing site reads it from a browser
 * on another origin, which the desktop app never had to do — it calls from Rust, where the
 * same-origin policy does not exist. Everything else here is called by the app with a bearer
 * token, and handing those routes to arbitrary origins would be careless.
 */
app.use("/pricing", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }));

app.get("/pricing", (c) =>
  c.json({
    tiers: TIERS.map((t) => ({
      id: t.id,
      label: t.label,
      bytes: t.bytes,
      monthly: t.price.monthly,
      annual: t.price.annual,
    })),
    lapseGraceDays: LAPSE_GRACE_DAYS,
  })
);

app.route("/auth", authRoutes);
app.route("/account", accountRoutes);
app.route("/upload", uploadRoutes);
app.route("/billing/paypal", paypalRoutes);
app.route("/billing/payos", payosRoutes);
app.route("/webhooks/paypal", paypalWebhook);
app.route("/webhooks/payos", payosWebhook);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

// Exported as an object rather than the bare Hono app so the cron trigger in wrangler.toml
// has a `scheduled` handler to call. Without it the bucket only ever grows.
export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runNightlySweeps(env));
  },
};

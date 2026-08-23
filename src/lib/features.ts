/**
 * Which half of the app this build ships with.
 *
 * The cloud backend (`server/`) and the site (`web/`) are code-complete but not deployed:
 * `API_BASE` in `src-tauri/src/cloud.rs` is still a placeholder subdomain, `BUY_URL` still
 * points at example.com, and nothing is on sale. Shipping those surfaces anyway gives the
 * user a Log in button that fails DNS, a Buy button that opens example.com and a toast
 * quoting a price nobody can pay — so they are hidden behind this one flag rather than
 * deleted, and the day the infrastructure exists, turning them back on is this one line.
 *
 * Before flipping it to true:
 *   1. deploy `server/` and set `API_BASE` in `src-tauri/src/cloud.rs`
 *   2. deploy `web/` (fill `web/site.config.json`) so the reset page resolves
 *   3. set `BUY_URL` in `src/lib/links.ts`
 *
 * Everything else — capture, annotation, recording, OCR, the library — is local and free,
 * and is unaffected by this flag.
 */
export const COMMERCE_ENABLED = false;

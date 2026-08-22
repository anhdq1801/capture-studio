/**
 * Outward links, in one place.
 *
 * These were scattered as literals — a `https://example.com/...` placeholder sitting in the
 * middle of App.tsx — which is how a build ships pointing at nothing. They are gathered here so
 * there is a single list to go through before a release, alongside `API_BASE` in
 * `src-tauri/src/cloud.rs`.
 */

/** Origin of the marketing site. Must match `SITE_URL` on the Worker, which builds password
 *  reset links against it. */
export const SITE_URL = "https://capturestudio.app";

/** Where "Forgot your password?" goes. The page asks for an email and the Worker sends a link
 *  back to it with a token. */
export const RESET_URL = `${SITE_URL}/reset.html`;

/** Licence purchase. Still a placeholder — set this before shipping a build that shows it. */
export const BUY_URL = "https://example.com/capture-studio/license";

/**
 * Outward links, in one place.
 *
 * These were scattered as literals — a `https://example.com/...` placeholder sitting in the
 * middle of App.tsx — which is how a build ships pointing at nothing. They are gathered here so
 * there is a single list to go through before a release, alongside `API_BASE` in
 * `src-tauri/src/cloud.rs`.
 */

import { isMac, isWindows } from "./platform";

/** Origin of the marketing site. Must match `SITE_URL` on the Worker, which builds password
 *  reset links against it. */
export const SITE_URL = "https://capturestudio.app";

/** Where "Forgot your password?" goes. The page asks for an email and the Worker sends a link
 *  back to it with a token. */
export const RESET_URL = `${SITE_URL}/reset.html`;

/** Licence purchase. Still a placeholder — set this before shipping a build that shows it. */
export const BUY_URL = "https://example.com/capture-studio/license";

/** "Buy the author a coffee" in Settings — shown as a link and as a QR code, so a phone
 *  camera can take it straight from the screen without typing anything.
 *
 *  The amount in the path is a suggestion, not a price: PayPal opens with it filled in and the
 *  payer can type over it. It is there because "how much is the right amount for a free tool?"
 *  is a question most people answer by closing the tab. Three dollars is roughly a coffee,
 *  which is what the text promises. Drop the `/3USD` to go back to an empty field. */
export const DONATE_URL = "https://paypal.me/QuocAnhD/3USD?locale.x=en_US&country.x=VN";

/** Bank transfer details behind the VietQR code, for the half of this app's users that PayPal
 *  effectively locks out — opening a PayPal link in Vietnam means being asked to create an
 *  account, and that is where most people stop. Every banking app there scans this. */
export const DONATE_BANK = {
  /** NAPAS bank identification number. Techcombank. */
  bin: "970407",
  account: "13823426974016",
  holder: "DANG QUOC ANH",
  bankName: "Techcombank",
  /** Roughly what a coffee costs in Vietnam, and the local counterpart of the $3 above. */
  amount: 50000,
  /** No diacritics: the transfer description is not reliably read as UTF-8 by every bank. */
  message: "Ung ho Capture Studio",
} as const;

/**
 * Where a bug report goes.
 *
 * This link existed only in the release notes and the launch posts, which meant the only people
 * who could find it were the ones who had already read a Facebook post — not the ones sitting in
 * front of the app watching it misbehave. Every bug fixed so far was found by the author; zero
 * reports across the first four releases is what a missing route back looks like from the
 * outside, and says nothing about how many bugs are left.
 */
export const ISSUES_URL = "https://github.com/anhdq1801/capture-studio/issues";

/** The other half of the same thing. Reporting on GitHub means having an account, and someone
 *  who came here from a link a friend shared is not going to create one to say a capture came
 *  out wrong. */
export const CONTACT_EMAIL = "quocanh1801@gmail.com";

/**
 * A report that already carries the two facts every report needs.
 *
 * "It crashes sometimes" costs a round trip to establish which version on which OS, and a good
 * share of reporters never answer it. Both are known right here, so neither has to be asked for.
 * The headings are a prompt, not a form — whatever is left blank still sends.
 */
function reportBody(version: string): string {
  const os = isWindows ? "Windows" : isMac ? "macOS" : navigator.platform || "unknown";
  return [
    "What happened:",
    "",
    "",
    "What you expected instead:",
    "",
    "",
    `— Capture Studio ${version || "unknown"} · ${os}`,
  ].join("\n");
}

/** A new GitHub issue with the version and OS already filled in. */
export function issueUrl(version: string): string {
  return `${ISSUES_URL}/new?body=${encodeURIComponent(reportBody(version))}`;
}

/** The same report as an email, for anyone not on GitHub. */
export function contactMailto(version: string): string {
  const subject = `Capture Studio ${version ? `v${version} ` : ""}— bug report`;
  return (
    `mailto:${CONTACT_EMAIL}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(reportBody(version))}`
  );
}

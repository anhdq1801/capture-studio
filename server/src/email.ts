import type { Env } from "./types";

/**
 * Transactional email, for the one message this service sends.
 *
 * Resend rather than MailChannels: the free MailChannels route out of Workers was withdrawn in
 * 2024, so the "no API key needed" approach every older guide describes no longer exists.
 *
 * Configuration is optional on purpose. A deployment without `RESEND_API_KEY` still answers
 * reset requests normally and records that it could not send — the alternative, failing the
 * request, turns a misconfigured mailer into an oracle that tells anyone which addresses are
 * registered.
 */
export async function sendMail(
  env: Env,
  msg: { to: string; subject: string; text: string; html: string }
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    console.error("email not configured (RESEND_API_KEY / MAIL_FROM); dropped:", msg.subject);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      }),
    });
    if (!res.ok) {
      console.error("email send failed", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (e) {
    console.error("email send threw", e);
    return false;
  }
}

/** The reset message. Plain text as well as HTML, because a mail client that shows only the
 *  text part should still be usable rather than presenting an empty message. */
export function resetEmail(link: string, minutes: number) {
  return {
    subject: "Reset your Capture Studio password",
    text: [
      "Someone asked to reset the password on your Capture Studio account.",
      "",
      `Open this link to choose a new one — it expires in ${minutes} minutes:`,
      link,
      "",
      "If it wasn't you, ignore this email. Your password has not changed.",
    ].join("\n"),
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">
  <p>Someone asked to reset the password on your Capture Studio account.</p>
  <p><a href="${link}" style="display:inline-block;background:#6d5efc;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px">Choose a new password</a></p>
  <p style="color:#666;font-size:13px">The link expires in ${minutes} minutes. If it wasn't you, ignore this email — your password has not changed.</p>
  <p style="color:#666;font-size:13px">If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all">${link}</span></p>
</div>`,
  };
}

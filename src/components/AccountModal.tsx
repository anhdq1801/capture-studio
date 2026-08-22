import { useEffect, useRef, useState } from "react";
import { AccountStatus, Pricing, cloudLogin, cloudSignup, getPricing } from "../lib/api";
import { useEscapeKey } from "./Modal";

interface Props {
  onClose: () => void;
  onLoggedIn: (status: AccountStatus) => void;
  toast: (t: string, k?: "ok" | "err" | "info") => void;
}

/* No "Forgot your password?" here on purpose. There is nothing to link to: the Worker exposes
   /auth/signup and /auth/login and nothing else, so no reset exists to point at, and a link to
   a page that 404s is worse than an absent one. It belongs here the moment the route does. */

export function AccountModal({ onClose, onLoggedIn, toast }: Props) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Which field to complain about, and what to say. Empty until a submit has been attempted. */
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  useEscapeKey(onClose, !busy);

  useEffect(() => {
    // Unauthenticated on the server — the price has to be visible to someone who does not
    // have an account yet, which is exactly who is reading this modal.
    getPricing().then(setPricing).catch(() => setPricing(null));
  }, []);

  // Nobody opens this dialog to look at it. Landing in the first field saves a click and lets
  // the whole thing be done from the keyboard.
  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  // Quoted from the cheapest tier rather than a number written into this file, so the modal
  // cannot end up advertising a price the server stopped charging.
  const entry = pricing?.tiers.reduce(
    (lo, t) => (!lo || t.monthly.usdCents < lo.monthly.usdCents ? t : lo),
    null as Pricing["tiers"][number] | null
  );
  const cheapest = entry
    ? `$${(entry.monthly.usdCents / 100).toFixed(2)} / ${entry.monthly.vndAmount.toLocaleString("vi-VN")}₫ a month`
    : "a monthly subscription";
  const graceDays = pricing?.lapseGraceDays ?? 30;

  /**
   * Validation belongs against the field that failed.
   *
   * This used to throw "Enter an email and an 8+ character password" at the toast stack — one
   * message covering two fields, in the corner of the screen, pointing at neither of them.
   */
  const validate = () => {
    const next: { email?: string; password?: string } = {};
    if (!email.trim()) next.email = "Enter your email address";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = "That does not look like an email address";
    if (!password) next.password = "Enter your password";
    else if (mode === "signup" && password.length < 8) next.password = "Use at least 8 characters";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    if (busy || !validate()) return;
    setBusy(true);
    try {
      const status =
        mode === "login"
          ? await cloudLogin(email.trim(), password)
          : await cloudSignup(email.trim(), password);
      toast(mode === "login" ? "Logged in" : "Account created");
      onLoggedIn(status);
      onClose();
    } catch (e) {
      // The server's message is the useful one — "That email is already registered" beats
      // anything this component could invent — so it goes against the form, not the corner.
      setErrors({ password: String(e).replace(/^Error:\s*/, "") });
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (next: "login" | "signup") => {
    setMode(next);
    // Yesterday's complaint about a different form is noise.
    setErrors({});
  };

  return (
    <div className="overlay-bg" onClick={() => !busy && onClose()}>
      <div className="modal auth" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{mode === "login" ? "Log in" : "Create account"}</h3>
          <button className="x" onClick={onClose} aria-label="Close" title="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          {/* Said before the email field, not after the payment screen. Someone who reaches
              this modal got here by clicking Upload, and a bare email/password form invites
              the assumption that signing up is what unlocks it. Naming the price, the quota
              and what happens to the files afterwards is cheaper than an angry refund. */}
          <div className="auth-note">
            <p>
              Capture Studio is free and works without an account. An account is only for
              <b> cloud upload and shareable links</b>, which is a paid plan.
            </p>
            <p className="hint">
              Plans start at {cheapest} and are priced by how much storage you want — pick a
              size after signing in. Uploads are kept for as long as the plan is active; if it
              ends, they stay online {graceDays} more days and are then deleted. Captures on
              your own computer are never touched.
            </p>
          </div>

          {/* A segmented control, not filter chips. These are two states of one form, and the
              chip row read as "narrow the list below" — the same thing it means everywhere
              else in the app. */}
          <div className="seg" role="tablist" aria-label="Log in or create an account">
            <button
              role="tab"
              aria-selected={mode === "login"}
              className={mode === "login" ? "on" : ""}
              onClick={() => switchTo("login")}
            >
              Log in
            </button>
            <button
              role="tab"
              aria-selected={mode === "signup"}
              className={mode === "signup" ? "on" : ""}
              onClick={() => switchTo("signup")}
            >
              Sign up
            </button>
          </div>

          <div className={`field ${errors.email ? "bad" : ""}`}>
            <label htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              ref={emailRef}
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              aria-invalid={!!errors.email}
              placeholder="you@example.com"
            />
            {errors.email && <div className="field-err">{errors.email}</div>}
          </div>

          <div className={`field ${errors.password ? "bad" : ""}`}>
            <label htmlFor="auth-password">Password</label>
            <div className="input-affix">
              <input
                id="auth-password"
                type={reveal ? "text" : "password"}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                aria-invalid={!!errors.password}
                placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
              />
              {/* Typing a password you cannot see, into a form that rejects it for being too
                  short, is a bad enough loop to be worth a button. */}
              <button
                type="button"
                className="affix-btn"
                onClick={() => setReveal((r) => !r)}
                aria-label={reveal ? "Hide password" : "Show password"}
                title={reveal ? "Hide password" : "Show password"}
              >
                {reveal ? "Hide" : "Show"}
              </button>
            </div>
            {errors.password && <div className="field-err">{errors.password}</div>}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? <i className="spin" /> : null} {mode === "login" ? "Log in" : "Create account"}
          </button>
        </div>
      </div>
    </div>
  );
}

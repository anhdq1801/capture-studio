import { useEffect, useState } from "react";
import { AccountStatus, Pricing, cloudLogin, cloudSignup, getPricing } from "../lib/api";
import { useEscapeKey } from "./Modal";

interface Props {
  onClose: () => void;
  onLoggedIn: (status: AccountStatus) => void;
  toast: (t: string, k?: "ok" | "err" | "info") => void;
}

export function AccountModal({ onClose, onLoggedIn, toast }: Props) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  useEscapeKey(onClose, !busy);

  useEffect(() => {
    // Unauthenticated on the server — the price has to be visible to someone who does not
    // have an account yet, which is exactly who is reading this modal.
    getPricing().then(setPricing).catch(() => setPricing(null));
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

  const submit = async () => {
    if (!email || password.length < 8) {
      toast("Enter an email and an 8+ character password", "err");
      return;
    }
    setBusy(true);
    try {
      const status =
        mode === "login" ? await cloudLogin(email, password) : await cloudSignup(email, password);
      toast(mode === "login" ? "Logged in" : "Account created");
      onLoggedIn(status);
      onClose();
    } catch (e) {
      toast(String(e), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay-bg" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
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
          <div
            className="box"
            style={{
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "12px 14px",
              marginBottom: 14,
            }}
          >
            <div style={{ marginBottom: 6 }}>
              Capture Studio is free and works without an account. An account is only for
              <b> cloud upload and shareable links</b>, which is a paid plan.
            </div>
            <div className="hint" style={{ marginTop: 0 }}>
              Plans start at {cheapest} and are priced by how much storage you want — pick a
              size after signing in. Uploads are kept for as long as the plan is active; if it
              ends, they stay online {graceDays} more days and are then deleted. Captures on
              your own computer are never touched.
            </div>
          </div>

          <div className="chips">
            <button
              className={`chip ${mode === "login" ? "active" : ""}`}
              onClick={() => setMode("login")}
            >
              Log in
            </button>
            <button
              className={`chip ${mode === "signup" ? "active" : ""}`}
              onClick={() => setMode("signup")}
            >
              Sign up
            </button>
          </div>

          <div className="field">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className="field">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8+ characters"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? <i className="spin" /> : null} {mode === "login" ? "Log in" : "Sign up"}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import {
  AccountStatus,
  CodecOption,
  MonitorInfo,
  PlanInterval,
  Pricing,
  PricingTier,
  RESOLUTIONS,
  IMAGE_FORMATS,
  ImageFormat,
  AppSettings,
  Resolution,
  getLibraryDir,
  getAppSettings,
  setAppSettings,
  listVideoCodecs,
  listOcrLanguages,
  OcrLanguage,
  LicenseStatus,
  getLicenseStatus,
  activateLicense,
  removeLicense,
  checkFfmpeg,
  screenPermissionGranted,
  requestScreenPermission,
  openScreenPermissionSettings,
  restartApp,
  getAutostart,
  setAutostart,
  getAccountStatus,
  cloudLogout,
  deleteAccount,
  getPricing,
  createPaypalSubscription,
  createPayosPayment,
} from "../lib/api";
import { formatBytes } from "../lib/format";
import { SHORTCUT_ROWS } from "../lib/actions";
import { ShortcutRecorder } from "./ShortcutRecorder";
import { Toggle } from "./Modal";
import { QrCode } from "./QrCode";
import { COMMERCE_ENABLED } from "../lib/features";
import { DONATE_URL } from "../lib/links";

/**
 * Settings used to be one long scroll. Splitting it means the thing you came to change is on
 * screen when the tab opens, instead of somewhere below the fold.
 */
const TABS = [
  { id: "general", label: "General" },
  { id: "recording", label: "Recording" },
  { id: "text", label: "Text" },
  { id: "account", label: "Account" },
] as const;
export type Tab = (typeof TABS)[number]["id"];

export function Settings({
  monitors,
  account,
  onOpenLogin,
  onAccountChange,
  focusTab,
  onFocusHandled,
  toast,
}: {
  monitors: MonitorInfo[];
  account: AccountStatus | null;
  onOpenLogin: () => void;
  onAccountChange: (status: AccountStatus | null) => void;
  /** A tab to jump to, set by whoever sent the user here — cleared once honoured, so the
   *  same destination can be requested again later. */
  focusTab?: Tab | null;
  onFocusHandled?: () => void;
  toast: (t: string, k?: "ok" | "err" | "info") => void;
}) {
  const [tab, setTab] = useState<Tab>("general");

  useEffect(() => {
    if (!focusTab) return;
    setTab(focusTab);
    onFocusHandled?.();
  }, [focusTab, onFocusHandled]);
  const [dir, setDir] = useState("");
  const [ffmpeg, setFfmpeg] = useState<boolean | null>(null);
  const [autostart, setAutostartState] = useState(false);
  const [interval, setInterval_] = useState<PlanInterval>("monthly");
  const [pricing, setPricing] = useState<Pricing | null>(null);
  /** The tier being bought, which is not necessarily the one currently owned. */
  const [tierId, setTierId] = useState<string | null>(null);
  const [rec, setRec] = useState<AppSettings | null>(null);
  const [codecs, setCodecs] = useState<CodecOption[]>([]);
  const [ocrLangs, setOcrLangs] = useState<OcrLanguage[]>([]);
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [screenPerm, setScreenPerm] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [activating, setActivating] = useState(false);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    getLibraryDir().then(setDir).catch(() => {});
    checkFfmpeg().then(setFfmpeg).catch(() => setFfmpeg(false));
    getAutostart().then(setAutostartState).catch(() => {});
    getAppSettings().then(setRec).catch(() => {});
    listVideoCodecs().then(setCodecs).catch(() => setCodecs([]));
    // Empty on a platform with no system recogniser, which hides the whole section.
    listOcrLanguages().then(setOcrLangs).catch(() => setOcrLangs([]));
    getLicenseStatus().then(setLicense).catch(() => {});
    screenPermissionGranted().then(setScreenPerm).catch(() => setScreenPerm(true));
    // Prices come from the server; a build that shipped its own copy would keep quoting them
    // after they changed.
    getPricing().then(setPricing).catch(() => setPricing(null));
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const saveRec = async (patch: Partial<AppSettings>) => {
    if (!rec) return;
    const next = { ...rec, ...patch };
    setRec(next);
    try {
      await setAppSettings(next);
    } catch (e) {
      toast(String(e), "err");
    }
  };

  // Order matters to the recogniser, so a newly enabled language goes to the end of the
  // list rather than being re-sorted into the picker's own display order.
  const toggleOcrLang = (id: string) => {
    if (!rec) return;
    const on = rec.ocrLanguages.includes(id);
    saveRec({
      ocrLanguages: on
        ? rec.ocrLanguages.filter((l) => l !== id)
        : [...rec.ocrLanguages, id],
    });
  };

  /**
   * The system dialog only appears the first time a binary asks, so this cannot rely on it:
   * ask, and open the pane directly whenever that produces nothing.
   */
  const fixScreenPerm = async () => {
    let ok = await screenPermissionGranted().catch(() => false);
    if (!ok) ok = await requestScreenPermission().catch(() => false);
    setScreenPerm(ok);
    if (!ok) {
      await openScreenPermissionSettings().catch(() => {});
      toast("Turn Capture Studio on in the list, then restart the app", "info");
    }
  };

  const activate = async () => {
    if (activating || !keyInput.trim()) return;
    setActivating(true);
    try {
      // The Rust side verifies before storing, so a bad key never reaches disk and the error
      // it throws is the message worth showing.
      setLicense(await activateLicense(keyInput));
      setKeyInput("");
      toast("Licence activated — thank you");
    } catch (e) {
      toast(String(e).replace(/^Error:\s*/, ""), "err");
    } finally {
      setActivating(false);
    }
  };

  const deactivate = async () => {
    try {
      setLicense(await removeLicense());
      toast("Licence removed from this computer");
    } catch (e) {
      toast(String(e), "err");
    }
  };

  const toggleAutostart = async () => {
    const next = !autostart;
    try {
      await setAutostart(next);
      setAutostartState(next);
      toast(next ? "Will launch at startup" : "Startup launch disabled");
    } catch (e) {
      toast(String(e), "err");
    }
  };

  const refreshStatus = async () => {
    try {
      const status = await getAccountStatus();
      onAccountChange(status);
      toast(status?.subscriptionActive ? "Subscription active" : "Status refreshed");
    } catch (e) {
      toast(String(e), "err");
    }
  };

  // After opening a checkout page, short-poll for the webhook-driven activation so the UI
  // updates on its own in the common case — the "Refresh status" button above is the fallback.
  const pollForActive = () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    let tries = 0;
    pollRef.current = window.setInterval(async () => {
      tries++;
      const status = await getAccountStatus().catch(() => null);
      if (status?.subscriptionActive) {
        onAccountChange(status);
        toast("Subscription active");
        window.clearInterval(pollRef.current!);
        pollRef.current = null;
      } else if (tries >= 24) {
        window.clearInterval(pollRef.current!);
        pollRef.current = null;
      }
    }, 5000);
  };

  // Default the picker to the plan already owned, so "Change plan" opens on the current tier
  // rather than on whichever one happens to be first in the list.
  useEffect(() => {
    if (tierId || !pricing?.tiers.length) return;
    const owned = pricing.tiers.find((t) => t.id === account?.tier);
    setTierId(owned?.id ?? pricing.tiers[0].id);
    if (account?.planInterval) setInterval_(account.planInterval);
  }, [pricing, account, tierId]);

  const priceOf = (t: PricingTier) => (interval === "annual" ? t.annual : t.monthly);
  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const vnd = (amount: number) => `${amount.toLocaleString("vi-VN")}₫`;
  const selectedTier = pricing?.tiers.find((t) => t.id === tierId) ?? null;

  const subscribe = async (provider: "paypal" | "payos") => {
    if (!tierId) return;
    setPurchasing(`sub-${provider}`);
    try {
      const url =
        provider === "paypal"
          ? await createPaypalSubscription(tierId, interval)
          : await createPayosPayment(tierId, interval);
      await openUrl(url);
      pollForActive();
    } catch (e) {
      toast(String(e), "err");
    } finally {
      setPurchasing(null);
    }
  };

  const logout = async () => {
    try {
      await cloudLogout();
      onAccountChange(null);
      toast("Logged out");
    } catch (e) {
      toast(String(e), "err");
    }
  };

  /**
   * Two steps, and the second one names what is about to be lost rather than asking "are you
   * sure". The wording says "cloud copies" every time, because the thing people actually fear
   * here is losing the screenshots on their own disk, and those are never touched.
   */
  const [closing, setClosing] = useState(false);
  const closeAccount = async () => {
    const stored = account ? formatBytes(account.storageUsedBytes) : "your uploads";
    const ok = await confirmDialog(
      `This deletes your cloud account, every file you have uploaded (${stored}) and every link you have shared. Links you have already sent to other people will stop working. Screenshots in your local library stay on this computer.\n\nThis cannot be undone.`,
      { title: "Delete cloud account?", kind: "warning", okLabel: "Delete everything", cancelLabel: "Keep my account" }
    ).catch(() => false);
    if (!ok) return;

    setClosing(true);
    try {
      await deleteAccount();
      onAccountChange(null);
      toast("Cloud account deleted");
    } catch (e) {
      toast(String(e), "err");
    } finally {
      setClosing(false);
    }
  };

  return (
    <>
      <div className="topbar">
        <h2>Settings</h2>
        <div className="spacer" />
        <div className="seg" role="tablist" aria-label="Settings sections">
          {TABS.filter((t) => COMMERCE_ENABLED || t.id !== "account").map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="content" style={{ maxWidth: 720 }}>
        {tab === "general" && (
          <>
        <div className="field">
          <label>Screen Recording permission</label>
          <div
            className="box"
            style={{
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "12px 14px",
            }}
          >
            {screenPerm === null ? (
              <>Checking…</>
            ) : screenPerm ? (
              <span style={{ color: "var(--success)" }}>
                ✓ Granted — captures include window content
              </span>
            ) : (
              <>
                <div style={{ color: "var(--danger)" }}>
                  ✗ Not granted — captures will contain only the desktop wallpaper
                </div>
                <div className="hint" style={{ marginTop: 0 }}>
                  macOS does not refuse a screenshot taken without this permission; it removes
                  every window from it first. Turn Capture Studio on in the list, then restart
                  the app — a permission granted while it is running only takes effect on the
                  next launch.
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button className="btn sm" onClick={fixScreenPerm}>
                    Open System Settings
                  </button>
                  <button className="btn ghost sm" onClick={() => restartApp()}>
                    Restart Capture Studio
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Nothing is on sale in this build, so there is no key to paste and no reminder to
            turn off — the app is simply free. See lib/features.ts. */}
        {COMMERCE_ENABLED && (
        <div className="field">
          <label>Licence</label>
          {license?.licensed ? (
            <div
              className="box"
              style={{
                background: "var(--bg-elev)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: "12px 14px",
              }}
            >
              <div style={{ color: "var(--success)", marginBottom: 6 }}>
                ✓ Licensed to {license.name}
              </div>
              <div className="hint" style={{ marginTop: 0 }}>
                {license.kind === "commercial" ? "Commercial use" : "Personal supporter"} ·
                issued {license.issued}
              </div>
              <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={deactivate}>
                Remove from this computer
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 10 }}>
                <input
                  type="text"
                  value={keyInput}
                  placeholder="Paste your licence key"
                  spellCheck={false}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && activate()}
                />
                <button
                  className="btn"
                  onClick={activate}
                  disabled={activating || !keyInput.trim()}
                >
                  {activating ? <i className="spin" /> : "Activate"}
                </button>
              </div>
              <div className="hint">
                Capture Studio is free for personal use, with every feature included — a
                licence covers using it at work and turns off the occasional reminder. Cloud
                upload is billed separately under the Account tab.
              </div>
            </>
          )}
        </div>
        )}

        <div className="field">
          <label>Library folder</label>
          <div style={{ display: "flex", gap: 10 }}>
            <input type="text" value={dir} readOnly />
            <button
              className="btn"
              onClick={() => openPath(dir).catch((e) => toast(String(e), "err"))}
            >
              Open
            </button>
          </div>
          <div className="hint">All screenshots and recordings are stored here.</div>
        </div>

        <div className="field">
          <label>Screenshot format</label>
          <div className="chips">
            {IMAGE_FORMATS.map((f) => (
              <button
                key={f.id}
                className={`chip ${rec?.imageFormat === f.id ? "active" : ""}`}
                onClick={() => saveRec({ imageFormat: f.id as ImageFormat })}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="hint">
            {IMAGE_FORMATS.find((f) => f.id === rec?.imageFormat)?.note}{" "}
            Applies to new captures — screenshots already in your library keep the format they
            were saved in.
          </div>
        </div>

        <div className="field">
          <div className="switch-row">
            <span className="lbl">Launch at startup</span>
            <Toggle on={autostart} onChange={toggleAutostart} label="Launch at startup" />
          </div>
        </div>

        <div className="field">
          <label>Global shortcuts</label>
          <ShortcutRecorder rows={SHORTCUT_ROWS} toast={toast} />
        </div>

        <div className="field">
          <label>Displays</label>
          <div className="meta-list" style={{ borderTop: "none", marginTop: 0 }}>
            {monitors.map((m) => (
              <div key={m.id}>
                <b>{m.name}</b> {m.isPrimary ? "· primary" : ""} — {m.width}×{m.height} @{" "}
                {m.scaleFactor}x
              </div>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Support Capture Studio</label>
          <div
            className="box"
            style={{
              display: "flex",
              gap: 16,
              alignItems: "center",
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "14px 16px",
            }}
          >
            {/* The QR is here so the phone in your hand can pay without the desktop having to
                hand a link over to it — point the camera at the screen and that is the whole
                flow. The button covers the case where the browser is the easier route. */}
            <QrCode value={DONATE_URL} size={180} title="Donate via PayPal" />
            <div style={{ minWidth: 0 }}>
              <div style={{ marginBottom: 4 }}>Buy the author a cup of coffee ☕</div>
              <div className="hint" style={{ marginTop: 0 }}>
                Capture Studio is free, with every feature included. If it saves you time,
                a coffee keeps it being worked on. Scan the code with your phone, or open
                PayPal here.
              </div>
              <button
                className="btn sm"
                style={{ marginTop: 10 }}
                onClick={() => openUrl(DONATE_URL).catch((e) => toast(String(e), "err"))}
              >
                Donate with PayPal
              </button>
            </div>
          </div>
        </div>
          </>
        )}

        {tab === "recording" && (
          <>
        <div className="field">
          <label>Screen recorder (ffmpeg)</label>
          <div
            className="box"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "12px 14px",
            }}
          >
            {ffmpeg === null ? (
              <>Checking…</>
            ) : ffmpeg ? (
              <span style={{ color: "var(--success)" }}>✓ ffmpeg detected — recording ready</span>
            ) : (
              <span style={{ color: "var(--danger)" }}>
                ✗ ffmpeg not found — install it to enable screen recording
              </span>
            )}
          </div>
        </div>

        {rec && (
          <>
            <div className="field">
              <label>Recording resolution</label>
              <div className="chips">
                {RESOLUTIONS.map((r) => (
                  <button
                    key={r.id}
                    className={`chip ${rec.resolution === r.id ? "active" : ""}`}
                    onClick={() => saveRec({ resolution: r.id as Resolution })}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <div className="hint">
                Recordings are only ever scaled down, never up — picking 4K on a 1080p
                display still records 1080p.
              </div>
            </div>

            <div className="field">
              <label>Recording format</label>
              <div className="chips">
                {codecs.map((c) => (
                  <button
                    key={c.id}
                    className={`chip ${rec.codec === c.id ? "active" : ""}`}
                    disabled={!c.available}
                    title={c.note}
                    onClick={() => saveRec({ codec: c.id })}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="hint">
                {codecs.find((c) => c.id === rec.codec)?.note ??
                  "Newer codecs make much smaller files for the same picture."}
              </div>
              {/* The preview player is a webview, and WebKit decodes neither of these. The
                  files themselves are fine in VLC or any modern player — it is only playback
                  inside Capture Studio that stops working, which is surprising enough to be
                  worth saying before the recording is made rather than after. */}
              {(rec.codec === "av1" || rec.codec === "vp9") && (
                <div className="hint warn">
                  Heads up — {rec.codec === "av1" ? "AV1" : "VP9"} recordings won't play inside
                  Capture Studio's preview. They still save correctly and open in VLC, IINA or
                  any modern player. Pick H.264 or HEVC if you want to review clips in the app.
                </div>
              )}
            </div>

          </>
        )}
          </>
        )}

        {tab === "text" && (
          <>
            {ocrLangs.length === 0 && (
              <div className="hint">
                This build has no system text recogniser available.
              </div>
            )}
            {rec && ocrLangs.length > 0 && (
              <div className="field">
                <label>Text recognition languages</label>
                <div className="chips">
                  {ocrLangs.map((l) => (
                    <button
                      key={l.id}
                      className={`chip ${rec.ocrLanguages.includes(l.id) ? "active" : ""}`}
                      onClick={() => toggleOcrLang(l.id)}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
                <div className="hint">
                  Pick every language you capture — the recogniser takes several at once and
                  treats the order you switch them on as priority. Recognition runs on macOS's
                  own engine, offline, so nothing leaves this machine.
                </div>
                {rec.ocrLanguages.length === 0 && (
                  <div className="hint warn">
                    With no language selected, Capture Text falls back to English.
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {COMMERCE_ENABLED && tab === "account" && (
        <div className="field">
          <label>Account &amp; Cloud Upload</label>
          {!account ? (
            <div className="box" style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
              <div className="hint" style={{ marginBottom: 10 }}>
                Log in to upload captures to the cloud and get shareable links.
              </div>
              <button className="btn" onClick={onOpenLogin}>
                Log in / Sign up
              </button>
            </div>
          ) : (
            <div className="box" style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span>{account.email}</span>
                <button className="btn ghost" onClick={logout}>
                  Log out
                </button>
              </div>

              {account.subscriptionActive && (
                <>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ color: "var(--success)" }}>
                      ✓ {pricing?.tiers.find((t) => t.id === account.tier)?.label ??
                        formatBytes(account.storageQuotaBytes)}{" "}
                      · {account.planInterval === "annual" ? "Annual" : "Monthly"}
                    </span>
                    {account.provider === "payos" ? (
                      <span> · expires {account.currentPeriodEnd?.slice(0, 10)}</span>
                    ) : (
                      <span> · renews {account.currentPeriodEnd?.slice(0, 10)}</span>
                    )}
                  </div>
                  <div className="hint" style={{ marginBottom: 6 }}>
                    Storage: {formatBytes(account.storageUsedBytes)} of{" "}
                    {formatBytes(account.storageQuotaBytes)} used
                  </div>
                  {/* Stated up front, and read from the server so it always matches the
                      number the cleanup job actually enforces. */}
                  {account.lapseGraceDays > 0 && (
                    <div className="hint" style={{ marginBottom: 8 }}>
                      Shared links keep working for {account.lapseGraceDays} days after a
                      subscription ends, then the cloud copies are deleted. Your local
                      captures are never touched.
                    </div>
                  )}
                </>
              )}

              {!pricing ? (
                <div className="hint">Loading plans…</div>
              ) : (
                <>
                  <div className="chips" style={{ marginBottom: 10 }}>
                    <button
                      className={`chip ${interval === "monthly" ? "active" : ""}`}
                      onClick={() => setInterval_("monthly")}
                    >
                      Monthly
                    </button>
                    <button
                      className={`chip ${interval === "annual" ? "active" : ""}`}
                      onClick={() => setInterval_("annual")}
                    >
                      Annual
                    </button>
                  </div>

                  {/* One row per tier: storage is what is being bought, so it is what the
                      list is keyed on, with the price of the selected interval beside it. */}
                  <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
                    {pricing.tiers.map((t) => {
                      const p = priceOf(t);
                      const owned = account.subscriptionActive && account.tier === t.id;
                      return (
                        <button
                          key={t.id}
                          className={`chip ${tierId === t.id ? "active" : ""}`}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            width: "100%",
                            textAlign: "left",
                          }}
                          onClick={() => setTierId(t.id)}
                        >
                          <span>
                            <b>{t.label}</b>
                            {owned && <span className="hint"> · current</span>}
                          </span>
                          <span>
                            {usd(p.usdCents)} / {vnd(p.vndAmount)}
                            {interval === "annual" && (
                              <span className="hint">
                                {" "}
                                · {usd(Math.round(p.usdCents / 12))}/mo
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* PayPal bills a subscription until it is cancelled. Starting a second one
                      for a different tier does not replace the first — both keep charging —
                      so that route is closed off rather than left as a trap. */}
                  {account.subscriptionActive &&
                    account.provider === "paypal" &&
                    account.tier !== tierId && (
                      <div className="hint" style={{ marginBottom: 10, color: "var(--warn)" }}>
                        Cancel your current PayPal subscription first, then subscribe to{" "}
                        {selectedTier?.label}. Starting a second one would bill you for both.
                      </div>
                    )}

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      className="btn primary"
                      onClick={() => subscribe("paypal")}
                      disabled={
                        !!purchasing ||
                        !tierId ||
                        (account.subscriptionActive &&
                          account.provider === "paypal" &&
                          account.tier !== tierId)
                      }
                    >
                      {purchasing === "sub-paypal" ? (
                        <i className="spin" />
                      ) : account.subscriptionActive ? (
                        "Renew with PayPal"
                      ) : (
                        "Subscribe with PayPal"
                      )}
                    </button>
                    <button
                      className="btn primary"
                      onClick={() => subscribe("payos")}
                      disabled={!!purchasing || !tierId}
                    >
                      {purchasing === "sub-payos" ? (
                        <i className="spin" />
                      ) : account.subscriptionActive && account.tier !== tierId ? (
                        `Switch to ${selectedTier?.label} (PayOS)`
                      ) : account.subscriptionActive ? (
                        "Renew with PayOS (VN)"
                      ) : (
                        "Subscribe with PayOS (VN)"
                      )}
                    </button>
                  </div>
                </>
              )}

              <button className="btn ghost" style={{ marginTop: 10 }} onClick={refreshStatus}>
                I've paid — refresh status
              </button>

              {/* Kept at the bottom, behind its own divider, and never beside Log out — the
                  two are one careless click apart and only one of them is reversible. */}
              <div
                style={{
                  borderTop: "1px solid var(--border)",
                  marginTop: 18,
                  paddingTop: 14,
                }}
              >
                <button className="btn ghost sm" onClick={closeAccount} disabled={closing}>
                  {closing ? <i className="spin" /> : "Delete cloud account"}
                </button>
                <div className="hint" style={{ marginTop: 6 }}>
                  Removes your uploads and shared links from our servers. Screenshots on this
                  computer are not affected.
                </div>
              </div>
            </div>
          )}
        </div>
        )}

        <div className="hint" style={{ marginTop: 24 }}>
          Capture Studio v0.1 · Tauri + Rust · cross-platform (macOS & Windows)
        </div>
      </div>
    </>
  );
}

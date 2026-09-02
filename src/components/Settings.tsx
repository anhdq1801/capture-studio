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
  setClipboardText,
  listVideoCodecs,
  listOcrLanguages,
  tesseractAvailable,
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
import { getVersion } from "@tauri-apps/api/app";
import { isMac, isWindows } from "../lib/platform";

/**
 * Whether two BCP-47 tags name the same language, ignoring region.
 *
 * The settings file is shared across platforms but the recognisers are not, and they spell the
 * same language differently: macOS Vision lists Vietnamese as `vi-VT`, Windows as `vi`. Compared
 * whole, a saved `vi-VT` leaves the `vi` chip looking switched off while it is in fact the
 * language in use — the picker would be describing a different setting from the one that runs.
 */
const sameLang = (a: string, b: string) =>
  a.split(/[-_]/)[0].toLowerCase() === b.split(/[-_]/)[0].toLowerCase();

const ocrLangOn = (saved: string[], id: string) => saved.some((l) => sameLang(l, id));
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
  const [tessOk, setTessOk] = useState(true);
  // Asked of the bundle rather than written here. It read "v0.1" through three releases,
  // because a number typed into a string has nothing keeping it honest.
  const [version, setVersion] = useState("");
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
    tesseractAvailable().then(setTessOk).catch(() => setTessOk(false));
    getVersion().then(setVersion).catch(() => {});
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
  /** Re-ask both engines what they can do — after installing Tesseract, or adding a language. */
  const reloadOcr = () => {
    listOcrLanguages().then(setOcrLangs).catch(() => setOcrLangs([]));
    tesseractAvailable().then(setTessOk).catch(() => setTessOk(false));
  };

  const toggleOcrLang = (id: string) => {
    if (!rec) return;
    const on = ocrLangOn(rec.ocrLanguages, id);
    saveRec({
      ocrLanguages: on
        ? rec.ocrLanguages.filter((l) => !sameLang(l, id))
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
      <div className="content" style={{ maxWidth: tab === "general" ? 1140 : 720 }}>
        {tab === "general" && (
          <div className="settings-cols">
            <div className="settings-main">
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

            </div>

            {/* Kept beside the settings rather than under them: at the bottom of a long
                scroll it was the one thing nobody reached, while the space it needed was
                sitting empty the whole way down. */}
            <aside className="settings-aside">
        <div className="field">
                <label>Support Capture Studio</label>
                <div
                  className="box"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 12,
                    background: "var(--bg-elev)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: "16px",
                    textAlign: "center",
                  }}
                >
                  {/* The QR is here so the phone in your hand can pay without the desktop having to
                      hand a link over to it — point the camera at the screen and that is the whole
                      flow. The button covers the case where the browser is the easier route.
                      Stacked, and large: side by side it had to share the width with the text and
                      came out too small for a phone camera to lock onto, which left the one thing
                      it exists for not working. */}
                  <QrCode value={DONATE_URL} size={232} title="Donate via PayPal" />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ marginBottom: 4 }}>Buy the author a cup of coffee ☕</div>
                    <div className="hint" style={{ marginTop: 0 }}>
                      Capture Studio is free, with every feature included. If it saves you time,
                      a coffee keeps it being worked on. Scan the code, or open PayPal below.
                    </div>
                    {/* Set apart from the paragraph above it on purpose. Buried in the grey run
                        of text, the one line that answers "am I committing to $3?" read as more
                        blurb and went unread — which leaves a suggested amount looking like a
                        price. */}
                    <div className="donate-note">$3 is only a suggestion — you can change it on the PayPal page.</div>
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
            </aside>
          </div>
        )}

        {tab === "recording" && (
          <>
        <div className="field">
          <label>Screen recorder (ffmpeg)</label>
          <div
            className="box"
            style={{
              display: ffmpeg === false ? "block" : "flex",
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
              <FfmpegMissing toast={toast} onFound={() => setFfmpeg(true)} />
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
                {isWindows
                  ? "Windows has the recogniser but no language installed for it. Open Settings > Time & language > Language & region, click the three dots beside a language, choose Language options, and add Optical character recognition."
                  : "This build has no system text recogniser available."}
              </div>
            )}
            {rec && ocrLangs.length > 0 && (
              <div className="field">
                <label>Text recognition languages</label>
                <div className="chips">
                  {ocrLangs.map((l) => (
                    <button
                      key={l.id}
                      className={`chip ${ocrLangOn(rec.ocrLanguages, l.id) ? "active" : ""}`}
                      onClick={() => toggleOcrLang(l.id)}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
                <div className="hint">
                  {isMac
                    ? "Pick every language you capture — the recogniser takes several at once and treats the order you switch them on as priority."
                    : "Entries marked Tesseract are read by Tesseract, which takes several at once; the rest are read by the system engine, which takes one and uses the first you switched on. Picking any Tesseract language puts Tesseract in charge."}{" "}
                  Recognition runs on this machine, offline, so nothing leaves it.
                </div>
                {rec.ocrLanguages.length === 0 && (
                  <div className="hint warn">
                    With no language selected, Capture Text falls back to English.
                  </div>
                )}
                {!isMac && (
                  <div className="hint">
                    The system engine reports no confidence score, so with it the panel cannot
                    mark the lines worth double-checking. Tesseract does score every word, and
                    the marking comes back whenever it is the one reading.
                  </div>
                )}
                {!isMac && <TesseractHelp installed={tessOk} toast={toast} onFound={reloadOcr} />}
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
          Capture Studio {version ? `v${version}` : ""} · Tauri + Rust · cross-platform (macOS &amp; Windows)
        </div>
      </div>
    </>
  );
}

/**
 * What to do about a missing ffmpeg, rather than only the news that it is missing.
 *
 * The person reading this is inside the app, at the moment recording failed — sending them to
 * a README on GitHub asks them to leave, find the repo and search it, which most will not do.
 * It matters most on Windows: there is no Homebrew there, and the alternative to a command
 * they can copy is downloading a zip and editing PATH by hand.
 *
 * "Check again" exists because the install happens in another window; without it the only way
 * to clear this panel is to restart the app, which reads as the install having failed.
 */
/**
 * How to get a language the system recogniser does not have.
 *
 * Windows ships OCR models for a fixed list of languages and Vietnamese is not on it. Without
 * Tesseract, a Vietnamese user on Windows gets the English recogniser guessing at every
 * diacritic — text that looks like a broken font rather than an unsupported language, which is
 * the worst of both: wrong, and wrong in a way that hides its own cause.
 *
 * Shown whether or not Tesseract is installed, because installing it is only half the job: the
 * installer adds English and nothing else unless asked, and `winget` runs it silently so the
 * page that asks never appears. Hiding this once the binary is found leaves the user who most
 * needs it — Tesseract present, their language absent — with nothing to read.
 */
function TesseractHelp({
  installed,
  toast,
  onFound,
}: {
  installed: boolean;
  toast: (t: string, k?: "ok" | "err" | "info") => void;
  onFound: () => void;
}) {
  const [checking, setChecking] = useState(false);

  // winget ships with Windows 10 and 11, so this needs nothing installed first.
  const command = isWindows
    ? "winget install UB-Mannheim.TesseractOCR"
    : "sudo apt install tesseract-ocr tesseract-ocr-vie";

  // Naming the program to open, not just the command. A command with no shell named is how a
  // PowerShell line ends up pasted into Command Prompt, where it fails for reasons that look
  // nothing like "wrong window".
  const where = isWindows
    ? "Press Win + X, choose Terminal (or Windows PowerShell), then paste this in:"
    : "In a terminal:";

  const recheck = async () => {
    setChecking(true);
    try {
      if (await tesseractAvailable()) {
        onFound();
        toast("Tesseract found — its languages are in the list now");
      } else {
        toast("Still not finding it. Open a new terminal and check tesseract --version works.", "info");
      }
    } catch (e) {
      toast(String(e), "err");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      style={{
        marginTop: 12,
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "12px 14px",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Missing a language?</div>
      <div className="hint">
        {installed
          ? "Tesseract is installed, but it only reads the languages whose data files are present — it adds English and nothing else unless asked. Vietnamese is not one Windows itself can read, so it has to come from here."
          : "This machine’s built-in recogniser only reads the languages listed above. Vietnamese is not one Windows ships, so reading it needs Tesseract — a separate free engine, installed once. Recognition stays offline either way."}
      </div>

      {installed && isWindows ? (
        <>
          <div className="hint" style={{ marginTop: 10 }}>
            The quickest fix is to drop the language file in beside the ones already there.
            Download <code>vie.traineddata</code>, then put it in:
          </div>
          <Command
            text={"C:\\Program Files\\Tesseract-OCR\\tessdata"}
            toast={toast}
          />
          <div className="hint" style={{ marginTop: 8 }}>
            Copying into that folder needs an administrator prompt — Windows will ask. Then come
            back and press Check again. Re-running the installer and ticking Vietnamese under{" "}
            <em>Additional language data</em> does the same thing.
          </div>
        </>
      ) : (
        <>
          <div className="hint" style={{ marginTop: 10 }}>{where}</div>
          <Command text={command} toast={toast} />
          {isWindows && (
            <div className="hint" style={{ marginTop: 8 }}>
              The installer asks which languages to add, under <em>Additional language data</em>{" "}
              — tick the ones you need. Left alone it installs English only, and{" "}
              <code>winget</code> runs it silently, so that page never appears: expect to add
              Vietnamese yourself afterwards.
            </div>
          )}
        </>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button className="btn sm" onClick={recheck} disabled={checking}>
          {checking ? <i className="spin" /> : "Check again"}
        </button>
        <button
          className="btn ghost sm"
          onClick={() =>
            openUrl(
              installed
                ? "https://github.com/tesseract-ocr/tessdata/raw/main/vie.traineddata"
                : "https://github.com/UB-Mannheim/tesseract/wiki"
            ).catch((e) => toast(String(e), "err"))
          }
        >
          {installed ? "Download vie.traineddata" : "Download page"}
        </button>
      </div>
    </div>
  );
}

/** A command or path, monospaced, with the copy button that makes it usable. */
function Command({
  text,
  toast,
}: {
  text: string;
  toast: (t: string, k?: "ok" | "err" | "info") => void;
}) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
      <code
        style={{
          flex: 1,
          minWidth: 0,
          overflowX: "auto",
          whiteSpace: "nowrap",
          background: "var(--bg-elev-2)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "8px 10px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}
      >
        {text}
      </code>
      <button
        className="btn sm"
        onClick={() =>
          setClipboardText(text)
            .then(() => toast("Copied"))
            .catch((e) => toast(String(e), "err"))
        }
      >
        Copy
      </button>
    </div>
  );
}

function FfmpegMissing({
  toast,
  onFound,
}: {
  toast: (t: string, k?: "ok" | "err" | "info") => void;
  onFound: () => void;
}) {
  const [checking, setChecking] = useState(false);

  // winget ships with Windows 10 and 11, so it is the one route that needs nothing installed
  // first. The others are listed below rather than offered as the headline.
  const command = isMac ? "brew install ffmpeg" : "winget install ffmpeg";
  // Which program to open, not just what to type. A line of shell with no shell named is how a
  // PowerShell command ends up in Command Prompt, failing in a way that looks like a broken
  // command rather than the wrong window.
  const where = isMac
    ? "Open Terminal (⌘Space, type Terminal), then paste this in:"
    : isWindows
      ? "Press Win + X, choose Terminal (or Windows PowerShell), then paste this in:"
      : "In a terminal:";
  const alternatives = isMac
    ? "MacPorts (port install ffmpeg) works too, as does a build from ffmpeg.org."
    : isWindows
      ? "Chocolatey (choco install ffmpeg) and Scoop (scoop install ffmpeg) work too, as does unpacking a build from ffmpeg.org yourself."
      : "Your distribution's package manager will have it — apt, dnf or pacman.";

  const recheck = async () => {
    setChecking(true);
    try {
      if (await checkFfmpeg()) {
        onFound();
        toast("ffmpeg found — recording is ready");
      } else {
        toast("Still not finding it. Open a new terminal and check ffmpeg -version works.", "info");
      }
    } catch (e) {
      toast(String(e), "err");
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <div style={{ color: "var(--danger)" }}>✗ ffmpeg not found — screen recording is disabled</div>
      <div className="hint" style={{ marginTop: 6 }}>
        Everything else works without it: screenshots, annotation, text recognition, scrolling
        capture and the optimiser. Recording is the only feature that needs it.
      </div>

      <div className="hint" style={{ marginTop: 10 }}>{where}</div>
      <Command text={command} toast={toast} />

      <div className="hint" style={{ marginTop: 8 }}>{alternatives}</div>

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn sm" onClick={recheck} disabled={checking}>
          {checking ? <i className="spin" /> : "Check again"}
        </button>
        <button
          className="btn ghost sm"
          onClick={() =>
            openUrl("https://ffmpeg.org/download.html").catch((e) => toast(String(e), "err"))
          }
        >
          Download page
        </button>
      </div>
    </>
  );
}

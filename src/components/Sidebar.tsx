import { useEffect, useRef, useState } from "react";
import { MonitorInfo } from "../lib/api";
import { ACTIONS } from "../lib/actions";
import { ShortcutId, comboFor, formatAccelerator, useShortcuts } from "../lib/shortcuts";
import { UiIcon, UiIconName } from "./Icons";
import { View } from "../App";

interface Props {
  view: View;
  onView: (v: View) => void;
  monitors: MonitorInfo[];
  busy: string | null;
  /** null while still checking; false disables recording with an explanation. */
  ffmpegReady: boolean | null;
  /** null while still checking; false means captures would come back as bare wallpaper. */
  screenReady: boolean | null;
  onFixScreenPermission: () => void;
  onCaptureFull: (monitorId: number | null) => void;
  onCaptureRegion: () => void;
  onCaptureWindow: () => void;
  onCaptureScroll: () => void;
  onCaptureText: () => void;
  onCaptureDelayed: () => void;
  recording: boolean;
  onRecord: () => void;
  onOpenFile: () => void;
  onClipboard: () => void;
}

export function Sidebar({
  view,
  onView,
  monitors,
  busy,
  ffmpegReady,
  screenReady,
  onFixScreenPermission,
  onCaptureFull,
  onCaptureRegion,
  onCaptureWindow,
  onCaptureScroll,
  onCaptureText,
  onCaptureDelayed,
  recording,
  onRecord,
  onOpenFile,
  onClipboard,
}: Props) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const primaryId = monitors.find((m) => m.isPrimary)?.id ?? null;
  const capturing = busy === "capture";
  // Read live, so rebinding one in Settings relabels these badges instead of leaving them
  // advertising a combination that no longer does anything.
  const shortcuts = useShortcuts();
  const kbd = (id: ShortcutId) => {
    const combo = comboFor(shortcuts, id);
    // Nothing to show for an action the user has deliberately unbound.
    return combo ? <kbd className="side-kbd">{formatAccelerator(combo)}</kbd> : null;
  };

  // Every capture entry looks and behaves the same, including where its spinner appears —
  // previously only "Full screen" showed one, so the other modes looked inert while their
  // overlay was coming up.
  const CaptureBtn = ({
    action,
    onClick,
  }: {
    action: { label: string; icon: UiIconName; shortcut?: ShortcutId };
    onClick: () => void;
  }) => (
    <button className="side-btn" onClick={onClick} disabled={capturing}>
      <span className="ico">
        {capturing ? <i className="spin" /> : <UiIcon name={action.icon} />}
      </span>
      <span className="side-btn-label">{action.label}</span>
      {action.shortcut && kbd(action.shortcut)}
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo">◎</div>
        <div>
          <h1>Capture Studio</h1>
          <span>Shoot · Note · Record</span>
        </div>
      </div>

      <div className="side-scroll">
        <div className="side-label">Capture</div>
        {/* Stated before anything is captured. The failure mode it describes — a screenshot
            containing nothing but the desktop picture — looks like a broken app, not a
            missing permission, so it has to be named on screen rather than left to be
            deduced from the result. */}
        {screenReady === false && (
          <div className="side-note">
            Screen Recording is off — captures will show only the wallpaper.{" "}
            <button className="side-note-action" onClick={onFixScreenPermission}>
              Fix this
            </button>
          </div>
        )}
        <div className="dropdown" ref={ref}>
          <CaptureBtn action={ACTIONS.captureRegion} onClick={onCaptureRegion} />
          <CaptureBtn action={ACTIONS.captureFull} onClick={() => onCaptureFull(primaryId)} />
          <CaptureBtn action={ACTIONS.captureWindow} onClick={onCaptureWindow} />
          <CaptureBtn action={ACTIONS.captureScroll} onClick={onCaptureScroll} />
          <CaptureBtn action={ACTIONS.captureText} onClick={onCaptureText} />
          <CaptureBtn action={ACTIONS.captureDelayed} onClick={onCaptureDelayed} />
          {monitors.length > 1 && (
            <>
              <button className="side-btn" onClick={() => setMenu((m) => !m)}>
                <span className="ico">
                  <UiIcon name="display" />
                </span>
                <span className="side-btn-label">Choose display…</span>
              </button>
              {menu && (
                <div className="dropdown-menu">
                  {monitors.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        setMenu(false);
                        onCaptureFull(m.id);
                      }}
                    >
                      <span className="dd-name">{m.name}</span>
                      <span className="dd-sub">
                        {m.width}×{m.height}
                        {m.isPrimary ? " · primary" : ""}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="side-label">Record</div>
        <button
          className={`side-btn ${recording ? "recording" : ""}`}
          onClick={onRecord}
          disabled={ffmpegReady === false && !recording}
          title={ffmpegReady === false ? "Requires ffmpeg — see Settings" : undefined}
        >
          <span className="ico">
            <UiIcon name={recording ? "stop" : ACTIONS.record.icon} />
          </span>
          <span className="side-btn-label">
            {recording ? "Stop recording" : ACTIONS.record.label}
          </span>
          {!recording && kbd(ACTIONS.record.shortcut)}
        </button>
        {ffmpegReady === false && (
          <div className="side-note">ffmpeg not found — recording is unavailable.</div>
        )}

        <div className="side-label">Tools</div>
        <button
          className={`side-btn ${view === "optimize" ? "active" : ""}`}
          onClick={() => onView("optimize")}
        >
          <span className="ico">
            <UiIcon name="compress" />
          </span>
          <span className="side-btn-label">Optimize images</span>
        </button>

        {/* "Import" said nothing about what it was for. These two bring an image that
            already exists into the library so it can be annotated or optimised. */}
        <div className="side-label">Add existing image</div>
        <button className="side-btn" onClick={onOpenFile}>
          <span className="ico">
            <UiIcon name={ACTIONS.openFile.icon} />
          </span>
          <span className="side-btn-label">{ACTIONS.openFile.label}</span>
        </button>
        <button className="side-btn" onClick={onClipboard}>
          <span className="ico">
            <UiIcon name={ACTIONS.clipboard.icon} />
          </span>
          <span className="side-btn-label">{ACTIONS.clipboard.label}</span>
          {kbd(ACTIONS.clipboard.shortcut)}
        </button>
        <div className="side-note dim">
          Adds a picture you already have to the library, ready to annotate.
        </div>
      </div>

      {/* Navigation is pinned so it stays reachable however long the action list grows. */}
      <nav className="side-nav">
        <button
          className={`side-btn ${view === "library" ? "active" : ""}`}
          onClick={() => onView("library")}
        >
          <span className="ico">
            <UiIcon name="library" />
          </span>
          <span className="side-btn-label">Library</span>
        </button>
        <button
          className={`side-btn ${view === "settings" ? "active" : ""}`}
          onClick={() => onView("settings")}
        >
          <span className="ico">
            <UiIcon name="settings" />
          </span>
          <span className="side-btn-label">Settings</span>
        </button>
      </nav>
    </aside>
  );
}

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  CaptureDevices,
  CodecOption,
  MonitorInfo,
  RESOLUTIONS,
  AppSettings,
  RecordOptions,
  getAppSettings,
  listCaptureDevices,
  listVideoCodecs,
  setAppSettings,
  startRecording,
} from "../lib/api";
import { openRegionOverlay } from "../lib/overlay";
import { isWindows } from "../lib/platform";
import { showRegionHint, hideRegionHint } from "../lib/regionhint";
import { Toggle } from "./Modal";
import { UiIcon } from "./Icons";
import { useEscapeKey } from "./Modal";

interface Props {
  monitors: MonitorInfo[];
  onClose: () => void;
  onStarted: () => void;
  toast: (t: string, k?: "ok" | "err" | "info") => void;
}

export function RecordModal({ monitors, onClose, onStarted, toast }: Props) {
  const [devices, setDevices] = useState<CaptureDevices | null>(null);
  const [screen, setScreen] = useState("");
  const [audio, setAudio] = useState(""); // "" = no audio
  const [fps, setFps] = useState(30);
  const [cursor, setCursor] = useState(true);
  const [region, setRegion] = useState<[number, number, number, number] | null>(null);
  // Which display the region was drawn on. Needed to turn a monitor-relative rectangle
  // into the desktop coordinate the cursor samples are measured in.
  const [regionMonitor, setRegionMonitor] = useState<MonitorInfo | null>(null);
  const [follow, setFollow] = useState(false);
  const [area, setArea] = useState<"full" | "window" | "area">("full");
  const startedRef = useRef(false);
  const [rec, setRec] = useState<AppSettings | null>(null);
  const [codecs, setCodecs] = useState<CodecOption[]>([]);
  const [starting, setStarting] = useState(false);
  useEscapeKey(onClose, !starting);

  useEffect(() => {
    listCaptureDevices()
      .then((d) => {
        setDevices(d);
        const preferred =
          d.screens.find((s) => /screen/i.test(s.name)) ?? d.screens[0];
        if (preferred) setScreen(preferred.index);
      })
      .catch((e) => toast(String(e), "err"));
    getAppSettings()
      .then((cfg) => {
        setRec(cfg);
        setFollow(cfg.followCursor);
      })
      .catch(() => {});
    listVideoCodecs().then(setCodecs).catch(() => setCodecs([]));
  }, [toast]);

  useEffect(() => {
    const un = listen<{ rect: [number, number, number, number]; monitorId: number | null }>(
      "region-selected",
      (e) => {
        const { rect, monitorId } = e.payload;
        setRegion(rect);
        setRegionMonitor(monitors.find((m) => m.id === monitorId) ?? null);
        // Outline the chosen area on screen so the selection is visible, not just a number.
        showRegionHint(
          monitors.find((m) => m.id === monitorId) ?? null,
          rect,
          `${rect[2]} × ${rect[3]}`
        ).catch(() => {});
      }
    );
    return () => {
      un.then((f) => f());
    };
  }, [monitors]);

  // The outline belongs to this dialog's lifetime unless a recording actually starts, in
  // which case `onStarted` hands it over to the recording session.
  useEffect(() => {
    return () => {
      if (!startedRef.current) hideRegionHint().catch(() => {});
    };
  }, []);

  /**
   * Where video pixel (0,0) sits on the desktop, so cursor samples can be placed in the frame.
   *
   * Mirrors what the two capture backends actually do rather than what would be tidiest:
   * avfoundation hands over one display and the region is cropped inside it, so the origin is
   * that display's corner plus the rectangle; gdigrab's `-i desktop` hands over the whole
   * virtual desktop and takes its offset in desktop coordinates, so the rectangle already *is*
   * the origin. Getting this wrong does not produce a wrong zoom — the Rust side notices its
   * samples landing outside the frame and leaves the video alone.
   */
  const zoomGeometry = (): Pick<RecordOptions, "origin" | "captureSize"> => {
    if (region) {
      const [rx, ry, rw, rh] = region;
      const base = isWindows
        ? ([0, 0] as const)
        : ([regionMonitor?.x ?? 0, regionMonitor?.y ?? 0] as const);
      return { origin: [base[0] + rx, base[1] + ry], captureSize: [rw, rh] };
    }
    // Whole screen. On Windows that is every display at once, whose origin is the top-left of
    // the leftmost and topmost of them and may be negative.
    if (isWindows) {
      const x = Math.min(...monitors.map((m) => m.x));
      const y = Math.min(...monitors.map((m) => m.y));
      const w = Math.max(...monitors.map((m) => m.x + m.width)) - x;
      const h = Math.max(...monitors.map((m) => m.y + m.height)) - y;
      return { origin: [x, y], captureSize: [w, h] };
    }
    const m = monitors.find((mo) => mo.isPrimary) ?? monitors[0];
    return m
      ? { origin: [m.x, m.y], captureSize: [m.width, m.height] }
      : {};
  };

  const start = async () => {
    setStarting(true);
    try {
      await startRecording({
        screenIndex: screen || undefined,
        audioDevice: audio || undefined,
        fps,
        captureCursor: cursor,
        region: region ?? undefined,
        followCursor: follow,
        ...(follow ? zoomGeometry() : {}),
      });
      startedRef.current = true;
      // Remembered on use rather than on toggle: flicking the switch and then cancelling should
      // not change what the next recording does. Failure is ignored — the recording has already
      // started and is not worth interrupting over a preference.
      if (rec && rec.followCursor !== follow) {
        setAppSettings({ ...rec, followCursor: follow }).catch(() => {});
      }
      toast("Recording started");
      onStarted();
    } catch (e) {
      toast(String(e), "err");
      setStarting(false);
    }
  };

  const noFfmpeg = devices && !devices.ffmpegAvailable;
  // Dismissing the overlay without choosing leaves the mode set but no rectangle — starting
  // now would quietly record the whole screen instead of what was asked for.
  const needsSelection = area !== "full" && !region;

  return (
    <div className="overlay-bg" onClick={() => !starting && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Screen recording</h3>
          <button className="x" onClick={onClose} aria-label="Close" title="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          {noFfmpeg ? (
            <div className="hint" style={{ fontSize: 13, color: "var(--danger)" }}>
              ffmpeg was not found on your system. Install it (macOS:{" "}
              <code>brew install ffmpeg</code>, Windows: add ffmpeg to PATH) and reopen
              this dialog.
            </div>
          ) : (
            <>
              {devices && devices.screens.length > 1 && (
                <div className="field">
                  <label>Screen</label>
                  <select value={screen} onChange={(e) => setScreen(e.target.value)}>
                    {devices.screens.map((s) => (
                      <option key={s.index} value={s.index}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="field">
                <label>Audio source</label>
                <select value={audio} onChange={(e) => setAudio(e.target.value)}>
                  <option value="">No audio</option>
                  {devices?.audio.map((a) => (
                    <option key={a.index} value={a.index}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <div className="hint">
                  System audio needs a loopback device (macOS: BlackHole; Windows:
                  Stereo Mix / virtual-audio-capturer). Microphones appear here directly.
                </div>
              </div>

              <div className="field">
                <label>What to record</label>
                <div className="chips">
                  <button
                    className={`chip ${area === "full" ? "active" : ""}`}
                    onClick={() => {
                      setArea("full");
                      setRegion(null);
                      hideRegionHint().catch(() => {});
                    }}
                  >
                    <UiIcon name="screen" size={14} /> Full screen
                  </button>
                  <button
                    className={`chip ${area === "window" ? "active" : ""}`}
                    onClick={() => {
                      setArea("window");
                      openRegionOverlay("record", monitors, "window");
                    }}
                  >
                    <UiIcon name="window" size={14} /> A window…
                  </button>
                  <button
                    className={`chip ${area === "area" ? "active" : ""}`}
                    onClick={() => {
                      setArea("area");
                      openRegionOverlay("record", monitors, "area");
                    }}
                  >
                    <UiIcon name="area" size={14} /> An area…
                  </button>
                </div>
                <div className="hint">
                  {area === "full"
                    ? "Records the whole display."
                    : region
                      ? `Selected ${region[2]}×${region[3]} px. Click again to reselect.`
                      : area === "window"
                        ? "Click the window you want to record."
                        : "Drag out the area you want to record."}
                </div>
              </div>

              {rec && (
                <div className="field">
                  <label>Output</label>
                  <div className="chips">
                    {/* Reporting a value, not offering a choice — styled so it doesn't
                        read as a selected option people will try to click. */}
                    <span className="chip readonly">
                      {RESOLUTIONS.find((r) => r.id === rec.resolution)?.label ?? rec.resolution}
                    </span>
                    <span className="chip readonly">
                      {codecs.find((c) => c.id === rec.codec)?.label ?? rec.codec}
                    </span>
                  </div>
                  <div className="hint">
                    Change the resolution and format in Settings.
                  </div>
                </div>
              )}

              <div className="field">
                <label>Frame rate — {fps} fps</label>
                <div className="range-row">
                  <input
                    type="range"
                    min={15}
                    max={60}
                    step={5}
                    value={fps}
                    onChange={(e) => setFps(Number(e.target.value))}
                  />
                  <span className="val">{fps}</span>
                </div>
              </div>

              <div className="switch-row">
                <span className="lbl">Capture cursor</span>
                <Toggle
                  on={cursor}
                  onChange={() => setCursor((v) => !v)}
                  label="Capture cursor"
                />
              </div>
              <div className="row">
                <span className="lbl">Zoom to cursor</span>
                <Toggle
                  on={follow}
                  onChange={() => setFollow((v) => !v)}
                  label="Zoom to cursor"
                />
              </div>
              <div className="hint" style={{ marginTop: -4 }}>
                Finds the places you stopped and settled, and eases in on each one. It does not
                track the pointer continuously — a frame that chases every hand movement is
                unwatchable. Costs a second encode when the recording ends.
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={starting}>
            Cancel
          </button>
          <button
            className="btn rec"
            onClick={start}
            disabled={!!noFfmpeg || starting || needsSelection}
          >
            {starting
              ? "Starting…"
              : needsSelection
                ? area === "window"
                  ? "Pick a window first"
                  : "Pick an area first"
                : "Start recording"}
          </button>
        </div>
      </div>
    </div>
  );
}

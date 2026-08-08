import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  CaptureDevices,
  CodecOption,
  MonitorInfo,
  RESOLUTIONS,
  AppSettings,
  getAppSettings,
  listCaptureDevices,
  listVideoCodecs,
  startRecording,
} from "../lib/api";
import { openRegionOverlay } from "../lib/overlay";
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
    getAppSettings().then(setRec).catch(() => {});
    listVideoCodecs().then(setCodecs).catch(() => setCodecs([]));
  }, [toast]);

  useEffect(() => {
    const un = listen<{ rect: [number, number, number, number]; monitorId: number | null }>(
      "region-selected",
      (e) => {
        const { rect, monitorId } = e.payload;
        setRegion(rect);
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

  const start = async () => {
    setStarting(true);
    try {
      await startRecording({
        screenIndex: screen || undefined,
        audioDevice: audio || undefined,
        fps,
        captureCursor: cursor,
        region: region ?? undefined,
      });
      startedRef.current = true;
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

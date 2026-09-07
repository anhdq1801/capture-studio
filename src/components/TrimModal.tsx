import { useCallback, useEffect, useRef, useState } from "react";
import { MediaItem, itemSrc, trimVideo } from "../lib/api";
import { Toggle, useEscapeKey } from "./Modal";

interface Props {
  item: MediaItem;
  onClose: () => void;
  onDone: () => void;
  toast: (t: string, k?: "ok" | "err" | "info") => void;
}

/**
 * `m:ss.d`, and never blank.
 *
 * `formatDuration` is the library's own and cannot be used here: it rounds to whole seconds,
 * which is coarser than the thing being chosen, and it returns "" for zero — so an In point at
 * the very start would render as an empty label.
 */
function stamp(ms: number): string {
  const t = Math.max(0, ms) / 1000;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

/** Which handle a drag is moving, or the playhead. */
type Grab = "start" | "end" | "seek" | null;

/**
 * Cut a recording down to a range.
 *
 * The preview is the real `<video>` element rather than a strip of extracted frames. A filmstrip
 * looks more like a video editor, but every thumbnail is another ffmpeg run before anything can
 * be shown, and the thing being chosen here is a *moment* — which is exactly what scrubbing a
 * video already shows, immediately and at full resolution.
 */
export function TrimModal({ item, onClose, onDone, toast }: Props) {
  const [src, setSrc] = useState("");
  const total = item.durationMs ?? 0;
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(total);
  const [at, setAt] = useState(0);
  const [replace, setReplace] = useState(false);
  const [running, setRunning] = useState(false);
  const [grab, setGrab] = useState<Grab>(null);
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEscapeKey(onClose, !running);

  useEffect(() => {
    itemSrc(item).then(setSrc).catch(() => setSrc(""));
  }, [item]);

  /**
   * The recorded duration is measured by the app's own clock, not read back off the file, so it
   * can be a frame or two out. Once the browser has decoded the file it knows better, and an end
   * handle sitting past the real end can never be reached by dragging.
   */
  const onMeta = () => {
    const real = (video.current?.duration ?? 0) * 1000;
    if (!isFinite(real) || real <= 0) return;
    setEnd((e) => (e === total || e > real ? real : e));
  };

  const span = Math.max(1, (video.current?.duration ?? 0) * 1000 || total);
  const pct = (ms: number) => `${Math.max(0, Math.min(100, (ms / span) * 100))}%`;

  const seek = useCallback((ms: number) => {
    setAt(ms);
    if (video.current) video.current.currentTime = ms / 1000;
  }, []);

  const msAt = useCallback(
    (clientX: number) => {
      const r = bar.current?.getBoundingClientRect();
      if (!r || r.width === 0) return 0;
      return Math.max(0, Math.min(span, ((clientX - r.left) / r.width) * span));
    },
    [span]
  );

  // Bound to the window rather than to the bar: a drag that runs off the end of the track has
  // to keep tracking, and pointer events stop arriving at the element once the cursor leaves it.
  useEffect(() => {
    if (!grab) return;
    const move = (e: PointerEvent) => {
      const ms = msAt(e.clientX);
      if (grab === "start") {
        setStart(Math.min(ms, end - 200));
        seek(Math.min(ms, end - 200));
      } else if (grab === "end") {
        setEnd(Math.max(ms, start + 200));
        seek(Math.max(ms, start + 200));
      } else {
        seek(ms);
      }
    };
    const up = () => setGrab(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [grab, start, end, msAt, seek]);

  const run = async () => {
    setRunning(true);
    try {
      await trimVideo(item.id, start, end, replace);
      await onDone();
      toast(replace ? "Recording trimmed" : "Trimmed copy saved");
      onClose();
    } catch (e) {
      toast(String(e), "err");
    } finally {
      setRunning(false);
    }
  };

  const kept = end - start;
  const cut = Math.max(0, span - kept);

  return (
    <div className="overlay-bg" onClick={() => !running && onClose()}>
      <div className="modal trim-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Trim recording</h3>
          <button className="x" onClick={onClose} aria-label="Close" title="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="trim-stage">
            {src && (
              <video
                ref={video}
                src={src}
                onLoadedMetadata={onMeta}
                onTimeUpdate={(e) => {
                  const ms = e.currentTarget.currentTime * 1000;
                  setAt(ms);
                  // Playback is confined to the kept range, so pressing play previews the cut
                  // rather than the original.
                  if (ms >= end) {
                    e.currentTarget.pause();
                    e.currentTarget.currentTime = start / 1000;
                  }
                }}
                controls
              />
            )}
          </div>

          <div
            className="trim-bar"
            ref={bar}
            onPointerDown={(e) => {
              if (running) return;
              seek(msAt(e.clientX));
              setGrab("seek");
            }}
          >
            {/* Everything outside the handles, dimmed — the part that goes away. */}
            <div className="trim-cut" style={{ left: 0, width: pct(start) }} />
            <div className="trim-cut" style={{ left: pct(end), right: 0 }} />
            <div
              className="trim-keep"
              style={{ left: pct(start), width: pct(end - start) }}
            />
            <div className="trim-play" style={{ left: pct(at) }} />
            <div
              className="trim-handle"
              style={{ left: pct(start) }}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (!running) setGrab("start");
              }}
            />
            <div
              className="trim-handle end"
              style={{ left: pct(end) }}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (!running) setGrab("end");
              }}
            />
          </div>

          <div className="trim-times">
            <span>
              <b>In</b> {stamp(start)}
            </span>
            <span>
              <b>Out</b> {stamp(end)}
            </span>
            <span>
              <b>Keeping</b> {stamp(kept)}
              {cut > 500 ? ` · cutting ${stamp(cut)}` : ""}
            </span>
          </div>

          <div className="field">
            <div className="switch-row">
              <span className="lbl">Overwrite the original</span>
              <Toggle
                on={replace}
                onChange={() => setReplace((v) => !v)}
                label="Overwrite the original"
              />
            </div>
            <div className="hint">
              {replace
                ? "The footage outside the handles is gone for good."
                : "Saves the trim as a new recording and leaves this one alone."}
            </div>
          </div>

          <div className="hint">
            Re-encoded rather than cut on the nearest keyframe, so it starts and ends on the
            frames you chose — which takes a moment for a long clip.
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={running}>
            Cancel
          </button>
          <button className="btn primary" onClick={run} disabled={running || kept < 200}>
            {running ? <i className="spin" /> : `Trim to ${stamp(kept)}`}
          </button>
        </div>
      </div>
    </div>
  );
}

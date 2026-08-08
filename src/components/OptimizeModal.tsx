import { useState } from "react";
import { MediaItem, OptimizeResult, optimizeImage } from "../lib/api";
import { formatBytes, percentSaved } from "../lib/format";
import { Toggle } from "./Modal";
import { useEscapeKey } from "./Modal";

interface Props {
  item: MediaItem;
  onClose: () => void;
  onDone: () => void;
  toast: (t: string, k?: "ok" | "err" | "info") => void;
}

const FORMATS = [
  { key: "webp", label: "WebP", hint: "Best compression" },
  { key: "jpeg", label: "JPEG", hint: "Universal" },
  { key: "png", label: "PNG", hint: "Lossless" },
];

export function OptimizeModal({ item, onClose, onDone, toast }: Props) {
  const [format, setFormat] = useState("webp");
  const [quality, setQuality] = useState(80);
  const [limitWidth, setLimitWidth] = useState(false);
  const [maxWidth, setMaxWidth] = useState(1920);
  const [replace, setReplace] = useState(false);
  const [running, setRunning] = useState(false);
  useEscapeKey(onClose, !running);
  const [result, setResult] = useState<OptimizeResult | null>(null);

  const run = async () => {
    setRunning(true);
    setResult(null);
    try {
      const r = await optimizeImage(
        item.id,
        format,
        quality,
        limitWidth ? maxWidth : null,
        replace
      );
      setResult(r);
      await onDone();
      // Re-encoding can legitimately produce a *larger* file (PNG from a JPEG source, or a
      // high-quality WebP); saying "saved -18%" in a green banner is worse than useless.
      const pct = percentSaved(r.originalSize, r.newSize);
      toast(
        pct > 0
          ? `Saved ${pct}% (${format.toUpperCase()})`
          : `${format.toUpperCase()} came out ${Math.abs(pct)}% larger`,
        pct > 0 ? "ok" : "info"
      );
    } catch (e) {
      toast(String(e), "err");
    } finally {
      setRunning(false);
    }
  };

  const isLossless = format === "png";

  return (
    <div className="overlay-bg" onClick={() => !running && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Optimize image size</h3>
          <button className="x" onClick={onClose} aria-label="Close" title="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>Output format</label>
            <div className="chips">
              {FORMATS.map((f) => (
                <button
                  key={f.key}
                  className={`chip ${format === f.key ? "active" : ""}`}
                  onClick={() => setFormat(f.key)}
                >
                  {f.label} · {f.hint}
                </button>
              ))}
            </div>
          </div>

          {!isLossless && (
            <div className="field">
              <label>Quality</label>
              <div className="range-row">
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                />
                <span className="val">{quality}</span>
              </div>
              <div className="hint">
                Lower quality = smaller file. 75–85 is a good balance for screenshots.
              </div>
            </div>
          )}

          <div className="field">
            <div className="switch-row">
              <span className="lbl">Limit max width</span>
              <Toggle
                on={limitWidth}
                onChange={() => setLimitWidth((v) => !v)}
                label="Limit max width"
              />
            </div>
            {limitWidth && (
              <div className="range-row">
                <input
                  type="range"
                  min={640}
                  max={3840}
                  step={80}
                  value={maxWidth}
                  onChange={(e) => setMaxWidth(Number(e.target.value))}
                />
                <span className="val">{maxWidth}px</span>
              </div>
            )}
          </div>

          <div className="field">
            <div className="switch-row">
              <span className="lbl">
                Replace original
                <div className="hint" style={{ marginTop: 2 }}>
                  {replace ? "Overwrites this item" : "Keeps original, adds a copy"}
                </div>
              </span>
              <Toggle
                on={replace}
                onChange={() => setReplace((v) => !v)}
                label="Replace original"
              />
            </div>
          </div>

          <div className="compare">
            <div className="box">
              <div className="k">Original</div>
              <div className="v">{formatBytes(item.sizeBytes)}</div>
            </div>
            <div className={`box ${result && result.newSize < item.sizeBytes ? "win" : ""}`}>
              <div className="k">Optimized</div>
              <div className="v">{result ? formatBytes(result.newSize) : "—"}</div>
            </div>
          </div>
          {result &&
            (result.newSize < result.originalSize ? (
              <div className="saved-banner">
                ↓ {percentSaved(result.originalSize, result.newSize)}% smaller ·{" "}
                {formatBytes(result.originalSize - result.newSize)} saved
              </div>
            ) : (
              <div className="saved-banner worse">
                ↑ {Math.abs(percentSaved(result.originalSize, result.newSize))}% larger ·{" "}
                {formatBytes(result.newSize - result.originalSize)} added — try a different
                format or a lower quality.
              </div>
            ))}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={run} disabled={running}>
            {running ? <i className="spin" /> : "🪄"} Optimize
          </button>
        </div>
      </div>
    </div>
  );
}

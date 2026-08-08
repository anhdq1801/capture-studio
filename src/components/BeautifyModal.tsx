import { useEffect, useRef, useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import { MediaItem, importPng, itemPath, setClipboardPng } from "../lib/api";
import {
  ASPECTS,
  AspectId,
  BACKGROUNDS,
  BeautifyOptions,
  DEFAULTS,
  renderBeautified,
} from "../lib/beautify";
import { useEscapeKey } from "./Modal";
import { Toggle } from "./Modal";

export function BeautifyModal({
  item,
  onClose,
  onSaved,
  toast,
}: {
  item: MediaItem;
  onClose: () => void;
  onSaved: () => void;
  toast: (t: string, k?: "ok" | "err" | "info") => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<ImageBitmap | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opts, setOpts] = useState<BeautifyOptions>(DEFAULTS);
  useEscapeKey(onClose, !busy);

  // Read through the fs plugin rather than an asset URL: the canvas has to stay untainted
  // so `toDataURL` works for saving and copying.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await itemPath(item.id);
        const bytes = await readFile(p);
        const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
        const bmp = await createImageBitmap(blob);
        if (cancelled) {
          bmp.close();
          return;
        }
        imgRef.current = bmp;
        setReady(true);
      } catch (e) {
        toast(String(e), "err");
      }
    })();
    return () => {
      cancelled = true;
      imgRef.current?.close();
      imgRef.current = null;
    };
  }, [item.id, toast]);

  useEffect(() => {
    if (ready && canvasRef.current && imgRef.current) {
      renderBeautified(canvasRef.current, imgRef.current, opts);
    }
  }, [ready, opts]);

  const set = <K extends keyof BeautifyOptions>(k: K, v: BeautifyOptions[K]) =>
    setOpts((o) => ({ ...o, [k]: v }));

  const exportPng = () => canvasRef.current?.toDataURL("image/png") ?? "";

  const save = async () => {
    const data = exportPng();
    if (!data || busy) return;
    setBusy(true);
    try {
      // Saved as a new item — the original capture is left untouched.
      await importPng(data);
      await onSaved();
      toast("Saved to library");
      onClose();
    } catch (e) {
      toast(String(e), "err");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    const data = exportPng();
    if (!data) return;
    try {
      await setClipboardPng(data);
      toast("Copied to clipboard");
    } catch (e) {
      toast(String(e), "err");
    }
  };

  const out = canvasRef.current;

  return (
    <div className="overlay-bg" onClick={() => !busy && onClose()}>
      <div
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-label="Beautify"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>Beautify</h3>
          <button className="x" onClick={onClose} aria-label="Close" title="Close">
            ×
          </button>
        </div>

        <div className="modal-body beautify-body">
          <div className="beautify-preview">
            {/* Rendered at full resolution and scaled down by CSS, so the preview is the
                export, not an approximation of it. */}
            <canvas ref={canvasRef} />
          </div>

          <div className="beautify-controls">
            <div className="field">
              <label>Background</label>
              <div className="swatches">
                {BACKGROUNDS.map((b) => (
                  <button
                    key={b.id}
                    className={`bg-swatch ${opts.background.id === b.id ? "on" : ""}`}
                    title={b.label}
                    aria-label={b.label}
                    aria-pressed={opts.background.id === b.id}
                    onClick={() => set("background", b)}
                    style={{
                      background:
                        b.colors.length === 0
                          ? "repeating-conic-gradient(#3a3f4d 0% 25%, #22262f 0% 50%) 50%/10px 10px"
                          : b.colors.length === 1
                            ? b.colors[0]
                            : `linear-gradient(${b.angle ?? 135}deg, ${b.colors.join(", ")})`,
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="field">
              <label>Padding — {Math.round(opts.padding * 100)}%</label>
              <div className="range-row">
                <input
                  type="range"
                  min={0}
                  max={30}
                  value={Math.round(opts.padding * 100)}
                  onChange={(e) => set("padding", Number(e.target.value) / 100)}
                />
                <span className="val">{Math.round(opts.padding * 100)}%</span>
              </div>
            </div>

            <div className="field">
              <label>Corner radius — {opts.radius}px</label>
              <div className="range-row">
                <input
                  type="range"
                  min={0}
                  max={64}
                  value={opts.radius}
                  onChange={(e) => set("radius", Number(e.target.value))}
                />
                <span className="val">{opts.radius}</span>
              </div>
            </div>

            <div className="field">
              <label>Shape</label>
              <div className="chips">
                {ASPECTS.map((a) => (
                  <button
                    key={a.id}
                    className={`chip ${opts.aspect === a.id ? "active" : ""}`}
                    onClick={() => set("aspect", a.id as AspectId)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              <div className="hint">
                A fixed shape only ever grows the canvas — the screenshot is never cropped.
              </div>
            </div>

            <div className="field">
              <div className="switch-row">
                <span className="lbl">Drop shadow</span>
                <Toggle
                  on={opts.shadow}
                  onChange={() => set("shadow", !opts.shadow)}
                  label="Drop shadow"
                />
              </div>
            </div>

            <div className="field">
              <div className="hint">
                Output {out ? `${out.width}×${out.height}` : "—"} · original{" "}
                {item.width}×{item.height}
              </div>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn" onClick={copy} disabled={!ready || busy}>
            Copy
          </button>
          <button className="btn primary" onClick={save} disabled={!ready || busy}>
            {busy ? "Saving…" : "Save as new image"}
          </button>
        </div>
      </div>
    </div>
  );
}

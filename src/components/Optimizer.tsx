import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { BatchFile, BatchProgress, optimizeFiles, scanImages } from "../lib/api";
import { formatBytes } from "../lib/format";
import { Toggle } from "./Modal";
import { UiIcon } from "./Icons";

const FORMATS = [
  { id: "webp", label: "WebP", note: "Best size at the same quality." },
  { id: "jpeg", label: "JPEG", note: "Universal, no transparency." },
  { id: "png", label: "PNG", note: "Lossless; quality slider is ignored." },
];

interface Row extends BatchProgress {
  id: number;
}

export function Optimizer({
  toast,
}: {
  toast: (t: string, k?: "ok" | "err" | "info") => void;
}) {
  const [files, setFiles] = useState<BatchFile[]>([]);
  const [outDir, setOutDir] = useState("");
  const [format, setFormat] = useState("webp");
  const [quality, setQuality] = useState(80);
  const [limitWidth, setLimitWidth] = useState(false);
  const [maxWidth, setMaxWidth] = useState(1920);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const rowId = useRef(0);

  useEffect(() => {
    const unProgress = listen<BatchProgress>("optimize-progress", (e) => {
      setRows((r) => [{ ...e.payload, id: ++rowId.current }, ...r]);
    });
    const unDone = listen<number>("optimize-done", () => setRunning(false));
    return () => {
      unProgress.then((f) => f());
      unDone.then((f) => f());
    };
  }, []);

  // Both pickers funnel through the same scan so a folder and a hand-picked file behave
  // identically, and duplicates across several picks collapse to one entry.
  const addPaths = async (paths: string[]) => {
    try {
      const found = await scanImages(paths);
      if (found.length === 0) {
        toast("No images found there", "info");
        return;
      }
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.path));
        const added = found.filter((f) => !seen.has(f.path));
        if (added.length === 0) toast("Those images are already in the list", "info");
        return [...prev, ...added];
      });
    } catch (e) {
      toast(String(e), "err");
    }
  };

  const addFiles = async () => {
    const picked = await openDialog({
      multiple: true,
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"] },
      ],
    }).catch((e) => {
      toast(String(e), "err");
      return null;
    });
    if (Array.isArray(picked) && picked.length) await addPaths(picked);
  };

  const addFolder = async () => {
    const picked = await openDialog({ directory: true, multiple: false }).catch((e) => {
      toast(String(e), "err");
      return null;
    });
    if (typeof picked === "string") await addPaths([picked]);
  };

  const pickOutDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false }).catch((e) => {
      toast(String(e), "err");
      return null;
    });
    if (typeof picked === "string") setOutDir(picked);
  };

  const run = async () => {
    if (!files.length || !outDir || running) return;
    setRows([]);
    setRunning(true);
    try {
      await optimizeFiles(
        files.map((f) => f.path),
        outDir,
        format,
        quality,
        limitWidth ? maxWidth : null
      );
    } catch (e) {
      setRunning(false);
      toast(String(e), "err");
    }
  };

  const totalIn = files.reduce((a, f) => a + f.sizeBytes, 0);
  const finished = rows.filter((r) => !r.error);
  const failed = rows.filter((r) => r.error);
  const savedIn = finished.reduce((a, r) => a + r.originalSize, 0);
  const savedOut = finished.reduce((a, r) => a + r.newSize, 0);
  const done = rows.length;
  const pct = files.length ? Math.round((done / files.length) * 100) : 0;

  return (
    <>
      <div className="topbar">
        <h2>Optimize images</h2>
        <span className="count">
          {files.length ? `${files.length} files · ${formatBytes(totalIn)}` : "No files yet"}
        </span>
        <div className="spacer" />
        {files.length > 0 && !running && (
          <button className="btn ghost" onClick={() => { setFiles([]); setRows([]); }}>
            Clear list
          </button>
        )}
        <button
          className="btn primary"
          onClick={run}
          disabled={running || !files.length || !outDir}
          title={
            !files.length
              ? "Add images first"
              : !outDir
                ? "Choose a destination folder first"
                : undefined
          }
        >
          {running
            ? `Optimizing ${done}/${files.length}…`
            : files.length
              ? `Optimize ${files.length}`
              : "Optimize"}
        </button>
      </div>

      {/* Pinned under the header: with a long file list the progress used to be far below
          the fold, so a running batch looked like nothing was happening. */}
      {(running || rows.length > 0) && (
        <div className="run-strip">
          <div className="progress">
            <div className="bar" style={{ width: `${pct}%` }} />
          </div>
          <div className="run-line">
            <span>
              {running ? `${done} of ${files.length}` : `Finished ${done}`}
              {failed.length > 0 && ` · ${failed.length} failed`}
            </span>
            {finished.length > 0 && (
              <span className={savedOut > savedIn ? "worse-text" : "win-text"}>
                {formatBytes(savedIn)} → {formatBytes(savedOut)}
              </span>
            )}
            {!running && outDir && (
              <button
                className="btn ghost sm"
                onClick={() => openPath(outDir).catch((e) => toast(String(e), "err"))}
              >
                Open folder
              </button>
            )}
          </div>
        </div>
      )}

      <div className="content" style={{ maxWidth: 860 }}>
        <div className="field">
          <label>1 · Choose images</label>
          <div className="chips">
            <button className="chip" onClick={addFiles} disabled={running}>
              <UiIcon name="file" size={14} /> Add images…
            </button>
            <button className="chip" onClick={addFolder} disabled={running}>
              <UiIcon name="folder" size={14} /> Add a folder…
            </button>
          </div>
          <div className="hint">
            Folders are searched recursively. Adding the same image twice is ignored.
          </div>
        </div>

        {files.length > 0 && (
          <div className="field">
            <div className="filelist">
              {files.map((f) => (
                <div key={f.path} className="filerow">
                  <span className="fr-name" title={f.path}>
                    {f.name}
                  </span>
                  <span className="fr-size">{formatBytes(f.sizeBytes)}</span>
                  {!running && (
                    <button
                      className="fr-x"
                      aria-label={`Remove ${f.name}`}
                      title="Remove"
                      onClick={() => setFiles((p) => p.filter((x) => x.path !== f.path))}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <label>2 · Export to</label>
          <div style={{ display: "flex", gap: 10 }}>
            <input
              type="text"
              value={outDir}
              readOnly
              placeholder="Pick a destination folder…"
            />
            <button className="btn" onClick={pickOutDir} disabled={running}>
              Choose…
            </button>
          </div>
          <div className="hint">
            Originals are never modified. A name clash in this folder gets a numbered suffix
            rather than overwriting anything.
          </div>
        </div>

        <div className="field">
          <label>3 · Output format</label>
          <div className="chips">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                className={`chip ${format === f.id ? "active" : ""}`}
                onClick={() => setFormat(f.id)}
                disabled={running}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="hint">{FORMATS.find((f) => f.id === format)?.note}</div>
        </div>

        {format !== "png" && (
          <div className="field">
            <label>Quality — {quality}</label>
            <div className="range-row">
              <input
                type="range"
                min={30}
                max={100}
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
                disabled={running}
              />
              <span className="val">{quality}</span>
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
                min={320}
                max={5120}
                step={80}
                value={maxWidth}
                onChange={(e) => setMaxWidth(Number(e.target.value))}
                disabled={running}
              />
              <span className="val">{maxWidth}px</span>
            </div>
          )}
          <div className="hint">Images narrower than this are left at their own size.</div>
        </div>

        {rows.length > 0 && (
          <div className="field">
            <label>Results</label>
            <div className="filelist">
              {rows.map((r) => (
                <div key={r.id} className="filerow">
                  <span className="fr-name">{r.name}</span>
                  {r.error ? (
                    <span className="fr-size" style={{ color: "var(--danger)" }}>
                      {r.error}
                    </span>
                  ) : (
                    <span className="fr-size">
                      {formatBytes(r.originalSize)} → {formatBytes(r.newSize)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

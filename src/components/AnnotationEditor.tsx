import { useEffect, useRef, useState, useCallback } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  MediaItem,
  deleteItem,
  itemPath,
  keepItem,
  saveAnnotated,
  setClipboardPng,
  uploadItem,
} from "../lib/api";
import { EditIcon, IconName } from "./EditIcons";

type Tool =
  | "select"
  | "arrow"
  | "line"
  | "rect"
  | "ellipse"
  | "pen"
  | "highlight"
  | "text"
  | "counter"
  | "blur";

interface StrokeShape {
  tool: "pen" | "highlight";
  color: string;
  width: number;
  pts: [number, number][];
}
interface GeoShape {
  tool: "line" | "arrow" | "rect" | "ellipse" | "blur";
  color: string;
  width: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface TextShape {
  tool: "text";
  color: string;
  size: number;
  x: number;
  y: number;
  text: string;
}
interface CounterShape {
  tool: "counter";
  color: string;
  size: number;
  x: number;
  y: number;
  n: number;
}
type Shape = StrokeShape | GeoShape | TextShape | CounterShape;

const TOOLS: { key: Tool; icon: IconName; label: string }[] = [
  { key: "select", icon: "cursor", label: "Select" },
  { key: "arrow", icon: "arrow", label: "Arrow" },
  { key: "line", icon: "line", label: "Line" },
  { key: "rect", icon: "rect", label: "Rectangle" },
  { key: "ellipse", icon: "ellipse", label: "Ellipse" },
  { key: "pen", icon: "pen", label: "Pen" },
  { key: "highlight", icon: "marker", label: "Highlighter" },
  { key: "text", icon: "text", label: "Text" },
  { key: "counter", icon: "counter", label: "Step number" },
  { key: "blur", icon: "blur", label: "Blur / redact" },
];
const COLORS = ["#ff3b3b", "#ffcc00", "#2ecc71", "#3b82f6", "#ffffff", "#111111"];

export function AnnotationEditor({
  item,
  subscriptionActive,
  onClose,
  onSaved,
  onNeedSubscription,
  toast,
}: {
  item: MediaItem;
  subscriptionActive: boolean;
  onClose: () => void;
  onSaved: () => void;
  onNeedSubscription: () => void;
  toast: (t: string, k?: "ok" | "err" | "info") => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<ImageBitmap | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tool, setTool] = useState<Tool>("arrow");
  const [color, setColor] = useState("#ff3b3b");
  const [width, setWidth] = useState(6);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [hovering, setHovering] = useState(false);
  // Live drag state for the Select tool: which shape, and where the grab started.
  const dragShape = useRef<{ index: number; startX: number; startY: number; original: Shape } | null>(
    null
  );
  const [editing, setEditing] = useState<{
    x: number;
    y: number;
    sx: number;
    sy: number;
    scale: number;
  } | null>(
    null
  );
  const [textValue, setTextValue] = useState("");
  const [zoom, setZoom] = useState(100);
  const [uploading, setUploading] = useState(false);
  const drawingRef = useRef(false);

  // Load the source image as a blob (keeps the canvas untainted for export).
  //
  // Decoded via `createImageBitmap` rather than an `<img>` + object URL, for two reasons. It
  // rejects on failure, so a capture that can't be decoded says so instead of leaving a blank
  // canvas behind — `img.onload` alone has no error path and fails silently. And the bitmap has
  // an explicit `close()`, so each editor session releases its decoded pixels when it ends
  // instead of leaving them for the webview's image cache to hold onto across a whole session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await itemPath(item.id);
        const bytes = await readFile(p);
        const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
        const bmp = await createImageBitmap(blob);
        // Closing on a late arrival matters: without it an editor closed mid-load leaks its
        // whole decoded bitmap, with nothing left holding a reference to free it.
        if (cancelled) {
          bmp.close();
          return;
        }
        imgRef.current = bmp;
        setLoaded(true);
      } catch (e) {
        toast(`Couldn't open that capture for editing — ${e}`, "err");
      }
    })();
    // Last resort against a silent blank canvas: if neither the decode nor its error path has
    // reported back by now, something upstream is wedged rather than slow — reading a local
    // file, even a 4K one, is far quicker than this.
    const watchdog = window.setTimeout(() => {
      if (!cancelled && !imgRef.current) {
        toast("That capture is taking too long to open — try reopening it", "err");
      }
    }, 6000);
    return () => {
      cancelled = true;
      window.clearTimeout(watchdog);
      imgRef.current?.close();
      imgRef.current = null;
    };
  }, [item.id, toast]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const im = imgRef.current;
    if (!canvas || !im) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
    const all = draft ? [...shapes, draft] : shapes;
    for (const s of all) drawShape(ctx, s, im);

    // Marching-ants box around the selected annotation.
    if (selected !== null && shapes[selected]) {
      const b = shapeBounds(ctx, shapes[selected]);
      ctx.save();
      ctx.strokeStyle = "#6d5efc";
      ctx.lineWidth = Math.max(1.5, canvas.width / 900);
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
      ctx.restore();
    }
  }, [shapes, draft, selected]);

  // Paint, then paint again once the window is genuinely on screen.
  //
  // Every capture hides the main window and shows it again to open this editor. On a quick
  // drag the whole round trip takes a couple of hundred milliseconds, and the first paint can
  // land while the webview is still marked off-screen — macOS stops compositing an ordered-out
  // window, so those canvas writes go nowhere and nothing re-issues them afterwards. The result
  // is a correctly sized, completely empty canvas over a capture file that is perfectly fine,
  // which is exactly what a fast Capture Area produced. Dragging slowly gave the hide/show pair
  // time to settle, which is why holding the selection for a second or two "fixed" it.
  //
  // Redrawing is cheap — one `drawImage` plus the annotations — so it is repeated whenever the
  // canvas could plausibly have lost its contents rather than trying to detect the exact moment.
  useEffect(() => {
    if (!loaded) return;
    redraw();
    const frame = requestAnimationFrame(redraw);
    const repaint = () => {
      if (!document.hidden) redraw();
    };
    document.addEventListener("visibilitychange", repaint);
    window.addEventListener("focus", repaint);
    window.addEventListener("pageshow", repaint);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", repaint);
      window.removeEventListener("focus", repaint);
      window.removeEventListener("pageshow", repaint);
    };
  }, [loaded, redraw]);

  // The editor was the one dialog with no keyboard exit and no undo shortcut — unusual for
  // a Shottr-style tool and undiscoverable. Escape closes (discarding a draft, as the
  // toolbar's Close does); ⌘Z / Ctrl+Z steps back through the annotations; ⌘C copies the
  // annotated image, which is what a screenshot tool is usually opened to do.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Don't hijack keys while the inline text-annotation input has focus.
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (selected !== null) setSelected(null);
        else close();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        // Deliberately taking ⌘C even when a shape is selected. There is no shape clipboard
        // to copy into, so the alternative is a shortcut that silently does nothing on the
        // one selection the user is most likely to have made.
        e.preventDefault();
        copy();
      } else if (selected !== null && (e.key === "Backspace" || e.key === "Delete")) {
        e.preventDefault();
        setShapes((prev) => prev.filter((_, i) => i !== selected));
        setSelected(null);
      } else if (selected !== null && e.key.startsWith("Arrow")) {
        e.preventDefault();
        // Shift for coarse steps, matching how design tools nudge.
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        setShapes((prev) => prev.map((sh, i) => (i === selected ? moveShape(sh, dx, dy) : sh)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The editor owns its own window now, and that window's title-bar close button is outside
  // React. It cancels the native close and sends this instead, so both routes out of the
  // editor run the same discard-the-draft path.
  useEffect(() => {
    const un = listen("editor-close-request", () => {
      close();
    });
    return () => {
      un.then((f) => f());
    };
  });

  // Focus the inline text box after it has actually mounted and the browser has finished
  // its own focus handling for the click that opened it.
  useEffect(() => {
    if (!editing) return;
    const id = requestAnimationFrame(() => textInputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [editing]);

  // Track displayed zoom %.
  useEffect(() => {
    const measure = () => {
      const c = canvasRef.current;
      if (c && c.width) setZoom(Math.round((c.getBoundingClientRect().width / c.width) * 100));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, [loaded]);

  const toCanvas = (e: React.PointerEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const wrap = wrapRef.current;
    const wrect = wrap?.getBoundingClientRect();
    // Canvas pixels per CSS pixel — the canvas is displayed scaled to fit.
    const scale = rect.width && canvas.width ? rect.width / canvas.width : 1;
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
      // The inline text input is absolutely positioned inside the (scrollable, centred)
      // canvas wrapper, so its coordinates must be measured against that wrapper — not
      // against the canvas, which sits inset from it.
      sx: wrect ? e.clientX - wrect.left + (wrap?.scrollLeft ?? 0) : e.clientX - rect.left,
      sy: wrect ? e.clientY - wrect.top + (wrap?.scrollTop ?? 0) : e.clientY - rect.top,
      scale,
    };
  };

  const nextCounter = shapes.filter((s) => s.tool === "counter").length + 1;

  /** Topmost shape under a canvas-space point, or null. */
  const hitTest = (x: number, y: number): number | null => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return null;
    // Back to front: the most recently drawn annotation wins, matching what's on top.
    for (let i = shapes.length - 1; i >= 0; i--) {
      const b = shapeBounds(ctx, shapes[i]);
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
    }
    return null;
  };

  const onDown = (e: React.PointerEvent) => {
    if (!loaded || editing) return;
    if (tool === "select") {
      const { x, y } = toCanvas(e);
      const hit = hitTest(x, y);
      setSelected(hit);
      if (hit !== null) {
        dragShape.current = { index: hit, startX: x, startY: y, original: shapes[hit] };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }
      return;
    }
    const { x, y, sx, sy, scale } = toCanvas(e);
    if (tool === "text") {
      // Stop the default focus handling for this press; the input is focused explicitly
      // once it has mounted (see the effect below).
      e.preventDefault();
      setEditing({ x, y, sx, sy, scale });
      setTextValue("");
      return;
    }
    if (tool === "counter") {
      setShapes((s) => [
        ...s,
        { tool: "counter", color, size: Math.max(22, width * 4), x, y, n: nextCounter },
      ]);
      return;
    }
    drawingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (tool === "pen" || tool === "highlight") {
      setDraft({ tool, color, width: tool === "highlight" ? width * 3 : width, pts: [[x, y]] });
    } else {
      setDraft({ tool, color, width, x0: x, y0: y, x1: x, y1: y });
    }
  };

  const onMove = (e: React.PointerEvent) => {
    if (tool === "select") {
      const { x, y } = toCanvas(e);
      const d = dragShape.current;
      if (!d) {
        // Hover feedback so it's obvious which marks can be grabbed.
        setHovering(hitTest(x, y) !== null);
        return;
      }
      const moved = moveShape(d.original, x - d.startX, y - d.startY);
      setShapes((prev) => prev.map((s, i) => (i === d.index ? moved : s)));
      return;
    }
    if (!drawingRef.current || !draft) return;
    const { x, y } = toCanvas(e);
    if (draft.tool === "pen" || draft.tool === "highlight") {
      setDraft({ ...draft, pts: [...draft.pts, [x, y]] });
    } else if (draft.tool !== "text" && draft.tool !== "counter") {
      setDraft({ ...(draft as GeoShape), x1: x, y1: y });
    }
  };

  const onUp = () => {
    if (tool === "select") {
      dragShape.current = null;
      return;
    }
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (draft) {
      setShapes((s) => [...s, draft]);
      setDraft(null);
    }
  };

  // Canvas-pixel font size for a text annotation, derived from the stroke-width slider.
  const textSize = Math.max(18, width * 4);

  // Enter commits, and the input then unmounts — which can also fire `onBlur`. Without
  // this guard that second call would add the same annotation twice.
  const committing = useRef(false);
  const commitText = () => {
    if (committing.current) return;
    committing.current = true;
    if (editing && textValue.trim()) {
      setShapes((s) => {
        const next: Shape[] = [
          ...s,
          { tool: "text", color, size: textSize, x: editing.x, y: editing.y, text: textValue },
        ];
        setSelected(next.length - 1);
        return next;
      });
      setTool("select");
    }
    setEditing(null);
    setTextValue("");
    // Released on the next tick, once the input is gone.
    setTimeout(() => {
      committing.current = false;
    }, 0);
  };

  const undo = () => {
    setSelected(null);
    setShapes((s) => s.slice(0, -1));
  };
  const clear = () => {
    setSelected(null);
    setShapes([]);
  };

  const exportPng = () => canvasRef.current?.toDataURL("image/png") ?? "";

  /**
   * Commit what is on the canvas to the item's file. Shared by Save and by the upgrade exit,
   * which has exactly the same obligation: not to lose the user's work.
   */
  const persist = async () => {
    // An untouched capture is kept byte-for-byte; re-encoding it through the canvas
    // would only cost quality and time for no change.
    if (shapes.length === 0) {
      await keepItem(item.id);
      return true;
    }
    const dataUrl = exportPng();
    if (!dataUrl) return false;
    await saveAnnotated(item.id, dataUrl);
    return true;
  };

  const save = async () => {
    try {
      if (!(await persist())) return;
      await onSaved();
      toast(item.draft ? "Saved to library" : "Annotations saved");
      onClose();
    } catch (e) {
      toast(String(e), "err");
    }
  };

  /**
   * Throw the capture away entirely. A draft was never in the library, so this is the
   * natural counterpart to Save; for an item already in the library it is a real delete,
   * hence the confirmation.
   */
  const discard = async () => {
    // A draft was never in the library, so discarding it needs no ceremony; deleting a
    // saved item does.
    if (
      !item.draft &&
      !(await confirmDialog("Delete this item from the library?", {
        title: "Delete",
        kind: "warning",
      }))
    ) {
      return;
    }
    try {
      await deleteItem(item.id);
      await onSaved();
      toast(item.draft ? "Capture discarded" : "Deleted");
      onClose();
    } catch (e) {
      toast(String(e), "err");
    }
  };

  // Closing without saving discards a draft — it only ever existed on disk so the editor
  // had something to open, and keeping it would be the auto-save this flow avoids.
  const close = async () => {
    if (item.draft) {
      try {
        await deleteItem(item.id);
        await onSaved();
      } catch {
        /* nothing useful to do if cleanup fails */
      }
    }
    onClose();
  };

  const copy = async () => {
    const dataUrl = exportPng();
    if (!dataUrl) return;
    try {
      await setClipboardPng(dataUrl);
      toast("Copied to clipboard");
    } catch (e) {
      toast(String(e), "err");
    }
  };

  const upload = async () => {
    if (uploading) return;
    if (!subscriptionActive) {
      // Clicking upload means "keep this and share it". Handing that to the paywall with the
      // editor torn down behind it would answer by destroying the work: the annotations only
      // exist on the canvas until saved, and a draft is deleted outright when the editor
      // closes. So commit first, then send the user on — whatever they decide about paying,
      // the capture is in the library when they come back.
      try {
        if (await persist()) await onSaved();
      } catch {
        /* Saving is best-effort here; the upgrade prompt still has to appear. */
      }
      onNeedSubscription();
      return;
    }
    const dataUrl = exportPng();
    if (!dataUrl) return;
    setUploading(true);
    try {
      // Persist the current annotations first so the cloud copy matches what's on screen.
      await saveAnnotated(item.id, dataUrl);
      await uploadItem(item.id);
      await onSaved();
      toast("Uploaded to cloud");
    } catch (e) {
      const msg = String(e);
      if (msg.includes("quota")) {
        toast("Storage quota exceeded — buy more storage in Settings", "err");
      } else if (msg.includes("subscription")) {
        onNeedSubscription();
      } else {
        toast(msg, "err");
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="overlay-bg">
      <div className="editor">
        {/* ---- Shottr-style toolbar ---- */}
        <div className="edit-toolbar">
          <div className="tool-group">
            <TB
              icon="cursor"
              label="Select / move"
              active={tool === "select"}
              onClick={() => setTool("select")}
            />
            <span className="tool-sep" />
            {TOOLS.slice(1).map((t) => (
              <TB
                key={t.key}
                icon={t.icon}
                label={t.label}
                active={tool === t.key}
                onClick={() => {
                  setSelected(null);
                  setTool(t.key);
                }}
              />
            ))}
          </div>

          <span className="tool-sep" />

          <div className="tool-group">
            {COLORS.map((c) => (
              <button
                key={c}
                className="swatch"
                onClick={() => setColor(c)}
                title={c}
                style={{
                  background: c,
                  outline: color === c ? "2px solid var(--accent-hi)" : "1px solid var(--border)",
                }}
              />
            ))}
          </div>

          <div className="tool-group" style={{ gap: 8 }}>
            <input
              type="range"
              min={2}
              max={20}
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
              style={{ width: 74 }}
              title="Stroke width"
            />
          </div>

          <div className="spacer" />

          <div className="tool-info">
            <span className="hex" title="Active color">
              <i style={{ background: color }} />
              {color.toUpperCase()}
            </span>
            <span title="Image size">
              {item.width}×{item.height}
            </span>
            <span title="Zoom">{zoom}%</span>
          </div>

          <span className="tool-sep" />

          <div className="tool-group">
            <TB icon="undo" label="Undo" onClick={undo} />
            <TB icon="eraser" label="Clear annotations" onClick={clear} />
            <TB
              icon="trash"
              label={item.draft ? "Discard capture" : "Delete from library"}
              onClick={discard}
            />
            <TB icon="copy" label="Copy to clipboard" onClick={copy} />
            <TB
              icon="save"
              label={item.draft ? "Save to library" : "Save"}
              onClick={save}
              primary
            />
            <TB
              icon="cloud"
              label={
                uploading
                  ? "Uploading…"
                  : subscriptionActive
                  ? "Upload to Cloud"
                  : "Upload to Cloud (Subscribe)"
              }
              onClick={upload}
            />
            <TB
              icon="close"
              label={item.draft ? "Close without saving" : "Close"}
              onClick={close}
            />
          </div>
        </div>

        {/* ---- Canvas ---- */}
        <div className="edit-canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            width={item.width || 1280}
            height={item.height || 800}
            style={{
              cursor:
                tool === "text"
                  ? "text"
                  : tool === "select"
                    ? hovering
                      ? "move"
                      : "default"
                    : "crosshair",
              touchAction: "none",
            }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
          />
          {editing && (
            <input
              ref={textInputRef}
              autoFocus
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitText();
                if (e.key === "Escape") setEditing(null);
              }}
              placeholder="Type…"
              style={{
                position: "absolute",
                left: editing.sx,
                top: editing.sy,
                // Match the annotation that will be drawn: same family and weight, and the
                // canvas-pixel size converted to screen pixels at the current zoom.
                font: `600 ${Math.max(11, textSize * editing.scale)}px -apple-system, "Segoe UI", sans-serif`,
                lineHeight: 1.15,
                minWidth: 120,
                width: `${Math.max(8, textValue.length + 4)}ch`,
                maxWidth: "90%",
                background: "rgba(0,0,0,0.55)",
                color,
                border: `1px dashed ${color}`,
                outline: "none",
                padding: 0,
                borderRadius: 3,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TB({
  icon,
  label,
  active,
  primary,
  onClick,
}: {
  icon: IconName;
  label: string;
  active?: boolean;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`tool-btn ${active ? "active" : ""} ${primary ? "primary" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
    >
      <EditIcon name={icon} />
    </button>
  );
}

function drawShape(ctx: CanvasRenderingContext2D, s: Shape, im: ImageBitmap) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (s.tool === "pen" || s.tool === "highlight") {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    if (s.tool === "highlight") ctx.globalAlpha = 0.35;
    ctx.beginPath();
    s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (s.tool === "text") {
    ctx.save();
    ctx.fillStyle = s.color;
    ctx.font = `600 ${s.size}px -apple-system, "Segoe UI", sans-serif`;
    ctx.textBaseline = "top";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 3;
    ctx.fillText(s.text, s.x, s.y);
    ctx.restore();
    return;
  }

  if (s.tool === "counter") {
    ctx.save();
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 4;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = pickContrast(s.color);
    ctx.font = `700 ${Math.round(s.size * 1.1)}px -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(s.n), s.x, s.y + 1);
    ctx.restore();
    return;
  }

  const g = s as GeoShape;
  const x0 = Math.min(g.x0, g.x1);
  const y0 = Math.min(g.y0, g.y1);
  const w = Math.abs(g.x1 - g.x0);
  const h = Math.abs(g.y1 - g.y0);

  if (g.tool === "blur") {
    if (w < 2 || h < 2) return;
    // pixelate: downscale the base region then draw it back without smoothing.
    const factor = 0.07;
    const tmp = document.createElement("canvas");
    tmp.width = Math.max(1, Math.round(w * factor));
    tmp.height = Math.max(1, Math.round(h * factor));
    const tctx = tmp.getContext("2d")!;
    tctx.drawImage(im, x0, y0, w, h, 0, 0, tmp.width, tmp.height);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x0, y0, w, h);
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.strokeStyle = g.color;
  ctx.lineWidth = g.width;
  if (g.tool === "rect") {
    ctx.strokeRect(x0, y0, w, h);
  } else if (g.tool === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(x0 + w / 2, y0 + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(g.x0, g.y0);
    ctx.lineTo(g.x1, g.y1);
    ctx.stroke();
    if (g.tool === "arrow") {
      const ang = Math.atan2(g.y1 - g.y0, g.x1 - g.x0);
      const len = Math.max(12, g.width * 3);
      ctx.beginPath();
      ctx.moveTo(g.x1, g.y1);
      ctx.lineTo(g.x1 - len * Math.cos(ang - Math.PI / 6), g.y1 - len * Math.sin(ang - Math.PI / 6));
      ctx.moveTo(g.x1, g.y1);
      ctx.lineTo(g.x1 - len * Math.cos(ang + Math.PI / 6), g.y1 - len * Math.sin(ang + Math.PI / 6));
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Axis-aligned bounds of a shape in canvas pixels, used for hit-testing and for drawing the
 * selection outline. Strokes and lines get a little slack so thin marks stay grabbable.
 */
function shapeBounds(
  ctx: CanvasRenderingContext2D,
  s: Shape
): { x: number; y: number; w: number; h: number } {
  if (s.tool === "text") {
    ctx.save();
    ctx.font = `600 ${s.size}px -apple-system, "Segoe UI", sans-serif`;
    const w = ctx.measureText(s.text).width;
    ctx.restore();
    return { x: s.x, y: s.y, w, h: s.size * 1.2 };
  }
  if (s.tool === "counter") {
    return { x: s.x - s.size, y: s.y - s.size, w: s.size * 2, h: s.size * 2 };
  }
  if (s.tool === "pen" || s.tool === "highlight") {
    const xs = s.pts.map((p) => p[0]);
    const ys = s.pts.map((p) => p[1]);
    const pad = s.width / 2 + 6;
    const x0 = Math.min(...xs) - pad;
    const y0 = Math.min(...ys) - pad;
    return { x: x0, y: y0, w: Math.max(...xs) + pad - x0, h: Math.max(...ys) + pad - y0 };
  }
  // Everything else is a two-point geometric shape. Checked positively so the compiler
  // narrows the union here rather than relying on the earlier branches to exclude it.
  if (
    s.tool === "line" ||
    s.tool === "arrow" ||
    s.tool === "rect" ||
    s.tool === "ellipse" ||
    s.tool === "blur"
  ) {
    const pad = s.width / 2 + 6;
    const x0 = Math.min(s.x0, s.x1) - pad;
    const y0 = Math.min(s.y0, s.y1) - pad;
    return {
      x: x0,
      y: y0,
      w: Math.abs(s.x1 - s.x0) + pad * 2,
      h: Math.abs(s.y1 - s.y0) + pad * 2,
    };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

/** Shift a shape by a delta, whatever coordinate fields it happens to use. */
function moveShape(s: Shape, dx: number, dy: number): Shape {
  if (s.tool === "pen" || s.tool === "highlight") {
    return { ...s, pts: s.pts.map(([px, py]) => [px + dx, py + dy] as [number, number]) };
  }
  if (s.tool === "text" || s.tool === "counter") {
    return { ...s, x: s.x + dx, y: s.y + dy };
  }
  if (
    s.tool === "line" ||
    s.tool === "arrow" ||
    s.tool === "rect" ||
    s.tool === "ellipse" ||
    s.tool === "blur"
  ) {
    return { ...s, x0: s.x0 + dx, y0: s.y0 + dy, x1: s.x1 + dx, y1: s.y1 + dy };
  }
  return s;
}


function pickContrast(hex: string): string {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? "#111" : "#fff";
}

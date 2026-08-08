import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WindowInfo, captureRegion, captureWindow, listWindows } from "./lib/api";

type Mode = "shot" | "record" | "scroll" | "text";
type Pick = "area" | "window" | "both";

// There is one overlay window per display, each created for a fixed monitor, so the monitor
// identity, its scale factor and its origin are baked into the URL and never change.
const params = new URLSearchParams(window.location.search);
const monitorId = params.get("monitor") ? Number(params.get("monitor")) : null;
const scaleFactor = Number(params.get("scale")) || 1;
const originX = Number(params.get("mx")) || 0;
const originY = Number(params.get("my")) || 0;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Global physical window bounds -> this overlay's local CSS pixels. */
function toLocal(w: WindowInfo): Rect {
  return {
    x: (w.x - originX) / scaleFactor,
    y: (w.y - originY) / scaleFactor,
    w: w.width / scaleFactor,
    h: w.height / scaleFactor,
  };
}

function Overlay() {
  // Only the capture mode varies per use, since the windows are kept warm and reused.
  const [mode, setMode] = useState<Mode>("shot");
  const [pick, setPick] = useState<Pick>("area");
  const [sel, setSel] = useState<Rect | null>(null);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [hovered, setHovered] = useState<WindowInfo | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const windowsRef = useRef(windows);
  windowsRef.current = windows;

  const reset = useCallback(() => {
    setSel(null);
    setHovered(null);
    dragging.current = false;
    start.current = null;
  }, []);

  useEffect(() => {
    const unInit = listen<{ mode: Mode; pick: Pick }>("overlay-init", (e) => {
      setMode(e.payload.mode);
      setPick(e.payload.pick);
      reset();
      if (e.payload.pick !== "area") {
        // Refetch every time: windows move, open and close between captures.
        listWindows()
          .then(setWindows)
          .catch(() => setWindows([]));
      } else {
        setWindows([]);
      }
    });
    // Any one overlay finishing or cancelling dismisses all of them, so the user never has
    // to close leftover crosshairs on the other displays.
    const unDismiss = listen("overlay-dismiss", () => {
      reset();
      getCurrentWindow().hide();
    });
    return () => {
      unInit.then((f) => f());
      unDismiss.then((f) => f());
    };
  }, [reset]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // `overlay-cancelled` is separate from `overlay-dismiss`: dismiss fires on every exit
      // including a successful selection, but only a cancel means the main window should come
      // back — on a successful capture the editor brings it back itself.
      if (e.key === "Escape") {
        emit("overlay-dismiss");
        emit("overlay-cancelled", { reason: "escape" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Front-most window containing this point, in local CSS coordinates. */
  const windowAt = (cx: number, cy: number): WindowInfo | null => {
    for (const w of windowsRef.current) {
      const r = toLocal(w);
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) return w;
    }
    return null;
  };

  /** Below this drag distance the gesture counts as a click, i.e. "pick the window". */
  const DRAG_SLOP = 5;

  const canPickWindow = pick !== "area";
  const canDragArea = pick !== "window";

  /** Keep a drag inside this display: the crop is per-monitor, so is the selection. */
  const clampX = (v: number) => Math.max(0, Math.min(v, window.innerWidth));
  const clampY = (v: number) => Math.max(0, Math.min(v, window.innerHeight));

  const down = (e: React.PointerEvent) => {
    // Without this, a drag that leaves this overlay's bounds — off the edge of the screen, or
    // onto the next display's overlay — stops delivering events here, so `up` never fires and
    // the capture is silently dropped. Capturing the pointer keeps the gesture with the
    // overlay it started on, which is also the display the crop is relative to.
    //
    // Guarded, because these windows are reused rather than recreated: a capture that ended
    // with the window being hidden mid-gesture can leave the element still holding capture for
    // a pointer that no longer exists, and calling setPointerCapture again on top of that
    // throws. The throw aborts this handler, so `start.current` never gets set and the whole
    // drag silently does nothing — for the rest of the session, on every capture.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* Not fatal: without capture a drag inside this display still works normally. */
    }
    dragging.current = true;
    start.current = { x: e.clientX, y: e.clientY };
    // When only an area can be picked there is no window highlight to preserve, so the
    // selection rectangle can appear on the very first pixel of the press.
    if (pickRef.current === "area") {
      setSel({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
    }
  };

  const move = (e: React.PointerEvent) => {
    if (!dragging.current || !start.current) {
      // Not dragging: the window highlight follows the cursor wherever windows are pickable.
      if (pickRef.current !== "area") setHovered(windowAt(e.clientX, e.clientY));
      return;
    }
    if (pickRef.current === "window") return;
    const w = Math.abs(clampX(e.clientX) - start.current.x);
    const h = Math.abs(clampY(e.clientY) - start.current.y);
    // Where both are possible, a real drag overrides the window highlight so the user can
    // still grab an arbitrary area (a scrollable pane inside a window, say).
    if (pickRef.current !== "area" && w < DRAG_SLOP && h < DRAG_SLOP) return;
    setHovered(null);
    setSel({
      x: Math.min(start.current.x, clampX(e.clientX)),
      y: Math.min(start.current.y, clampY(e.clientY)),
      w,
      h,
    });
  };

  /**
   * Hand the pointer back explicitly instead of relying on the implicit release at pointerup.
   *
   * This window is hidden in the same tick that a gesture finishes, and a window that goes away
   * mid-release can leave the element holding capture for a dead pointer. Because the overlays
   * are kept warm and reused, that stale state survives into the next capture.
   */
  const releaseCapture = (e: React.PointerEvent) => {
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* Already released, or the pointer is gone. Nothing to do. */
    }
  };

  /** The gesture was taken away from us — window hidden, display change, Escape. */
  const cancel = (e: React.PointerEvent) => {
    releaseCapture(e);
    dragging.current = false;
    start.current = null;
    setSel(null);
  };

  const up = async (e: React.PointerEvent) => {
    releaseCapture(e);
    dragging.current = false;
    const mode = modeRef.current;

    // Measured from the pointer itself, never from the `sel` state.
    //
    // `sel` is written by `move`, and pointermove is a *continuous* event, so React is free to
    // defer that re-render. On a quick drag the pointerup handler still belongs to a render
    // that never saw the final size — it read `{w: 0, h: 0}` from `down`, decided the gesture
    // was too small to count, and silently cancelled. That is the intermittent "Capture Area
    // did nothing": it depended on how fast the drag was, not on what was selected.
    // `start.current` and the event coordinates are both synchronous and always current.
    const from = start.current;
    const toX = clampX(e.clientX);
    const toY = clampY(e.clientY);
    const w = from ? Math.abs(toX - from.x) : 0;
    const h = from ? Math.abs(toY - from.y) : 0;
    const dragged = !!from && w >= DRAG_SLOP && h >= DRAG_SLOP;

    // A click (rather than a drag) in a window-picking mode means "use this whole window".
    let rect: [number, number, number, number] | null = null;
    let pickedWindow: WindowInfo | null = null;
    if (dragged && from) {
      // CSS px -> this monitor's physical pixels, which is what the Rust side crops in.
      rect = [
        Math.round(Math.min(from.x, toX) * scaleFactor),
        Math.round(Math.min(from.y, toY) * scaleFactor),
        Math.round(w * scaleFactor),
        Math.round(h * scaleFactor),
      ];
    } else if (pickRef.current !== "area") {
      pickedWindow = windowAt(e.clientX, e.clientY);
      if (pickedWindow) {
        // Window bounds are global physical pixels; the Rust crop is relative to this
        // monitor, so shift by the display origin and clamp to its bounds.
        const x = Math.max(0, pickedWindow.x - originX);
        const y = Math.max(0, pickedWindow.y - originY);
        rect = [x, y, pickedWindow.width, pickedWindow.height];
      }
    }

    await emit("overlay-dismiss");
    if (!rect) {
      // Nothing captured. This used to be entirely silent, which made it impossible to tell
      // "I drew too small a box" apart from "the overlay never saw my drag at all" — the
      // difference between a user mistake and a bug. The reason is reported so the app can say
      // so, and so a failure report identifies itself.
      const reason = !from
        ? "no-gesture"
        : pickRef.current !== "area" && !pickedWindow
          ? "no-window"
          : "too-small";
      await emit("overlay-cancelled", { reason });
      return;
    }

    if (mode === "record") {
      await emit("region-selected", { rect, monitorId });
      return;
    }

    if (mode === "text") {
      // Text recognition needs the pixels, but the user wants the words — the main window
      // does the OCR and puts the result on the clipboard; nothing is saved to the library.
      await emit("text-region-selected", { rect, monitorId });
      return;
    }

    if (mode === "scroll") {
      // The main window owns the scrolling session; it needs the region in the same
      // physical-pixel space the Rust side re-grabs from.
      await emit("scroll-region-selected", { rect, monitorId });
      return;
    }

    // Let the overlay actually leave the screen before grabbing, so none of its own chrome
    // ends up in the shot.
    await new Promise((r) => setTimeout(r, 90));
    try {
      // A whole-window pick goes through the window capture path, which follows the window's
      // real shape (rounded corners, shadow) instead of a plain rectangle off the display.
      const item = pickedWindow
        ? await captureWindow(pickedWindow.id)
        : await captureRegion(monitorId, rect[0], rect[1], rect[2], rect[3]);
      await emit("captured", item);
    } catch (err) {
      await emit("capture-error", String(err));
    }
  };

  const hoverRect = hovered ? toLocal(hovered) : null;
  // Scrolling capture gets its own colour so it is never mistaken for a plain capture.
  // Each mode gets its own colour so the crosshair itself says what is about to happen —
  // the selection rectangle looks identical otherwise.
  const accent =
    mode === "scroll" ? "#f0883e" : mode === "text" ? "#3ddc97" : "#6d5efc";
  const accentFill =
    mode === "scroll"
      ? "rgba(240,136,62,0.14)"
      : mode === "text"
        ? "rgba(61,220,151,0.14)"
        : "rgba(109,94,252,0.14)";
  const verb =
    mode === "record"
      ? "record"
      : mode === "scroll"
        ? "scroll-capture"
        : mode === "text"
          ? "copy text from"
          : "capture";
  const hint = !canDragArea
    ? `Click a window to ${verb} it`
    : !canPickWindow
      ? `Drag an area to ${verb}`
      : `Click a window to ${verb} it, or drag an area`;

  return (
    // The window stays visually see-through: no dim veil and no frozen-frame image, so the
    // crosshair is usable on the very first frame with nothing to wait for. The 1%-opaque
    // fill only guarantees the window hit-tests pointer events — a fully transparent
    // surface can let clicks fall through to whatever is underneath.
    <div
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.01)",
        cursor: hovered ? "pointer" : "crosshair",
      }}
    >
      {hoverRect && (
        <div
          style={{
            position: "fixed",
            left: hoverRect.x,
            top: hoverRect.y,
            width: hoverRect.w,
            height: hoverRect.h,
            border: `2px solid ${accent}`,
            background: accentFill,
            pointerEvents: "none",
          }}
        />
      )}
      {hovered && hoverRect && (
        <div
          style={{
            ...labelStyle,
            left: hoverRect.x,
            top: Math.max(0, hoverRect.y - 26),
            background: accent,
          }}
        >
          {hovered.appName}
          {hovered.title ? ` — ${hovered.title}` : ""}
        </div>
      )}
      {sel && (
        <>
          <div
            style={{
              position: "fixed",
              left: sel.x,
              top: sel.y,
              width: sel.w,
              height: sel.h,
              border: `2px solid ${accent}`,
              // A faint tint keeps the selection readable over any wallpaper without
              // darkening the rest of the screen.
              background: accentFill,
            }}
          />
          <div
            style={{
              ...labelStyle,
              left: sel.x,
              top: Math.max(0, sel.y - 26),
              background: accent,
            }}
          >
            {Math.round(sel.w * scaleFactor)} × {Math.round(sel.h * scaleFactor)}
          </div>
        </>
      )}
      {!sel && (
        <div
          style={{
            position: "fixed",
            top: 18,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(0,0,0,0.72)",
            color: "#fff",
            padding: "7px 16px",
            borderRadius: 20,
            fontSize: 12.5,
            fontFamily: "-apple-system, sans-serif",
            pointerEvents: "none",
          }}
        >
          {hint} · Esc to cancel
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  position: "fixed",
  background: "#6d5efc",
  color: "#fff",
  fontSize: 12,
  padding: "2px 8px",
  borderRadius: 5,
  fontFamily: "-apple-system, sans-serif",
  maxWidth: 420,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  pointerEvents: "none",
};

ReactDOM.createRoot(document.getElementById("overlay-root") as HTMLElement).render(
  <React.StrictMode>
    <Overlay />
  </React.StrictMode>
);

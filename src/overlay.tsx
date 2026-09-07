import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  WindowInfo,
  captureRegion,
  captureRegions,
  captureWindow,
  getAppSettings,
  listWindows,
  setAppSettings,
} from "./lib/api";

type Mode = "shot" | "multishot" | "record" | "scroll" | "text";
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
  // Regions already committed in a multi-region capture, in this overlay's CSS pixels. Held
  // per overlay because a crop is relative to one display: a set spanning two monitors would
  // have no single origin to be relative to.
  const [rects, setRects] = useState<Rect[]>([]);
  // Set once Enter is pressed with regions pending: the overlay stays up and asks the
  // one-sheet / separate-files question over the selections it is about to capture.
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(false);
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
  const rectsRef = useRef(rects);
  rectsRef.current = rects;
  const askingRef = useRef(asking);
  askingRef.current = asking;
  // A remembered answer skips the dialog. Re-read per capture rather than cached for the
  // session: these windows live for the life of the app, so a preference cleared in Settings
  // has to reach an overlay created long before the change.
  const savedChoice = useRef("");

  const reset = useCallback(() => {
    setSel(null);
    setHovered(null);
    setRects([]);
    setAsking(false);
    setBusy(false);
    setRemember(false);
    dragging.current = false;
    start.current = null;
  }, []);

  /**
   * Take the pending regions and leave.
   *
   * The rectangles are read off the ref and converted before anything is dismissed: dismissing
   * runs `reset()` in this same window, so a `rects` read afterwards would be empty.
   */
  const finish = useCallback(async (combine: boolean, rememberIt: boolean) => {
    const list = rectsRef.current.map((r) => ({
      x: Math.round(r.x * scaleFactor),
      y: Math.round(r.y * scaleFactor),
      width: Math.round(r.w * scaleFactor),
      height: Math.round(r.h * scaleFactor),
    }));
    if (!list.length) return;
    setBusy(true);
    if (rememberIt) {
      try {
        const current = await getAppSettings();
        await setAppSettings({
          ...current,
          multiRegionSave: combine ? "combined" : "separate",
        });
      } catch {
        /* A preference that will not save is not a reason to throw away the capture. */
      }
    }
    await emit("overlay-dismiss");
    // Same reason as the single-region path: let the overlay actually leave the screen before
    // the grab, or its own chrome lands in every one of the crops.
    await new Promise((r) => setTimeout(r, 90));
    try {
      const items = await captureRegions(monitorId, list, combine);
      // Deliberately not `captured`: that event opens the annotation editor for its payload,
      // and a set of five would open five editor windows on top of each other.
      await emit("captured-many", items);
    } catch (err) {
      await emit("capture-error", String(err));
    }
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
      savedChoice.current = "";
      if (e.payload.mode === "multishot") {
        getAppSettings()
          .then((cfg) => {
            savedChoice.current = cfg.multiRegionSave || "";
          })
          .catch(() => {
            /* Unreadable settings just means the dialog asks, which is the default anyway. */
          });
      }
    });
    // Broadcast rather than handled where the key was pressed: keyboard focus sits on one
    // overlay, but the regions may have been drawn on another display's. Every overlay hears
    // this and only the one actually holding regions acts on it.
    const unConfirm = listen("multishot-confirm", () => {
      if (!rectsRef.current.length || askingRef.current) return;
      const saved = savedChoice.current;
      if (saved === "combined" || saved === "separate") {
        finish(saved === "combined", false);
        return;
      }
      setAsking(true);
    });
    // Any one overlay finishing or cancelling dismisses all of them, so the user never has
    // to close leftover crosshairs on the other displays.
    const unDismiss = listen("overlay-dismiss", () => {
      reset();
      getCurrentWindow().hide();
    });
    return () => {
      unInit.then((f) => f());
      unConfirm.then((f) => f());
      unDismiss.then((f) => f());
    };
  }, [reset, finish]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // `overlay-cancelled` is separate from `overlay-dismiss`: dismiss fires on every exit
      // including a successful selection, but only a cancel means the main window should come
      // back — on a successful capture the editor brings it back itself.
      if (e.key === "Escape") {
        emit("overlay-dismiss");
        emit("overlay-cancelled", { reason: "escape" });
        return;
      }
      if (modeRef.current !== "multishot" || askingRef.current) return;
      if (e.key === "Enter") {
        e.preventDefault();
        emit("multishot-confirm");
        return;
      }
      // Undo one region rather than the whole set. Escape already throws everything away, and
      // needing a fresh start because the fourth of five rectangles came out wrong would make
      // the mode not worth using.
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        setRects((r) => r.slice(0, -1));
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
    // The dialog is a child of this same surface, so without this a press aimed at one of its
    // buttons would also start drawing a new region behind it.
    if (askingRef.current || busy) return;
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
    if (askingRef.current || busy) return;
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
    if (askingRef.current || busy) return;
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

    // Multi-region collects instead of finishing: the overlay stays up, and only Enter ends it.
    // A too-small drag is dropped in silence here rather than reported, because in this mode it
    // is almost always a stray click between two real selections, not a failed capture.
    if (mode === "multishot") {
      setSel(null);
      if (dragged && from) {
        setRects((r) => [
          ...r,
          { x: Math.min(from.x, toX), y: Math.min(from.y, toY), w, h },
        ]);
      }
      return;
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
  const multi = mode === "multishot";
  const hint = multi
    ? rects.length === 0
      ? "Drag each area you want · Enter when done"
      : `${rects.length} area${rects.length > 1 ? "s" : ""} · drag another · Enter to save · Backspace to undo`
    : !canDragArea
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
      {rects.map((r, i) => (
        <React.Fragment key={i}>
          <div
            style={{
              position: "fixed",
              left: r.x,
              top: r.y,
              width: r.w,
              height: r.h,
              border: `2px solid ${accent}`,
              background: accentFill,
              pointerEvents: "none",
            }}
          />
          {/* Numbered because the order is not cosmetic: it is the order they stack in on a
              combined sheet, and it is the drawing order rather than anything positional. */}
          <div
            style={{
              ...labelStyle,
              left: r.x + 4,
              top: r.y + 4,
              background: accent,
              minWidth: 16,
              textAlign: "center",
            }}
          >
            {i + 1}
          </div>
        </React.Fragment>
      ))}
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
      {asking && (
        // Rendered inside the overlay rather than in a window of its own: a new window would
        // have to be created, positioned on the right display and focused while a borderless
        // always-on-top surface already covers the screen, and it would land behind it as often
        // as not.
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "-apple-system, sans-serif",
          }}
        >
          <div
            style={{
              background: "#1c1f26",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 14,
              padding: "22px 24px",
              width: 380,
              color: "#fff",
              boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              Save {rects.length} areas how?
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, opacity: 0.72, marginTop: 8 }}>
              One image stacks them top to bottom in the order you drew them. Separate images
              keeps each one its own file.
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button
                disabled={busy}
                onClick={() => finish(false, remember)}
                style={dialogBtn(accent)}
              >
                {rects.length} separate images
              </button>
              <button
                disabled={busy}
                onClick={() => finish(true, remember)}
                style={dialogBtn()}
              >
                One combined image
              </button>
            </div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 16,
                fontSize: 12,
                opacity: 0.72,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Always do this — stop asking
            </label>
            {/* The way back matters as much as the two answers: the regions are still on
                screen and adding a sixth should not mean starting over. */}
            <div style={{ fontSize: 11.5, opacity: 0.5, marginTop: 12 }}>
              Esc cancels · click Back to keep selecting
            </div>
            <button
              disabled={busy}
              onClick={() => setAsking(false)}
              style={{ ...dialogBtn(), marginTop: 10, width: "100%" }}
            >
              Back
            </button>
          </div>
        </div>
      )}
      {!sel && !asking && (
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

/** Buttons for the save-as dialog. Local to this window: the overlay loads no stylesheet. */
function dialogBtn(fill?: string): React.CSSProperties {
  return {
    flex: 1,
    padding: "9px 12px",
    borderRadius: 9,
    border: fill ? "1px solid transparent" : "1px solid rgba(255,255,255,0.18)",
    background: fill ?? "rgba(255,255,255,0.06)",
    color: "#fff",
    fontSize: 12.5,
    fontFamily: "-apple-system, sans-serif",
    cursor: "pointer",
  };
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

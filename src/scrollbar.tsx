import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { scrollStep } from "./lib/api";

/** How often the region is re-grabbed while the user scrolls. */
const TICK_MS = 400;

function ScrollBar() {
  const [height, setHeight] = useState(0);
  const [frames, setFrames] = useState(0);
  const [stalled, setStalled] = useState(false);
  const [done, setDone] = useState(false);
  const busy = useRef(false);
  const doneRef = useRef(false);

  // Poll on a timer rather than reacting to scroll events — the content being captured
  // belongs to another application, so there is nothing here to listen to.
  useEffect(() => {
    const t = window.setInterval(async () => {
      if (busy.current || doneRef.current) return;
      busy.current = true;
      try {
        const s = await scrollStep();
        setFrames(s.frames);
        setHeight(s.height);
        setStalled(s.added === 0);
      } catch {
        // The session can end from the main window (finish/cancel) between ticks.
      } finally {
        busy.current = false;
      }
    }, TICK_MS);
    return () => window.clearInterval(t);
  }, []);

  const finish = async () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setDone(true);
    await emit("scroll-finish-request", {});
  };

  const cancel = async () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setDone(true);
    await emit("scroll-cancel-request", {});
  };

  return (
    <div
      onPointerDown={(e) => {
        // Let the user drag the borderless bar by its background.
        if ((e.target as HTMLElement).closest("button")) return;
        getCurrentWindow().startDragging();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: "100%",
        boxSizing: "border-box",
        padding: "0 12px",
        borderRadius: 12,
        background: "rgba(24,24,28,0.94)",
        border: "1px solid rgba(255,255,255,0.08)",
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        color: "#fff",
        cursor: "default",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
          {done ? "Finishing…" : stalled ? "Keep scrolling…" : "Capturing…"}
        </div>
        <div style={{ fontSize: 11, opacity: 0.62, fontVariantNumeric: "tabular-nums" }}>
          {frames} frames · {height}px tall
        </div>
      </div>
      <button onClick={cancel} disabled={done} style={btn("rgba(255,255,255,0.12)")}>
        Cancel
      </button>
      <button onClick={finish} disabled={done} style={btn("#6d5efc")}>
        Done
      </button>
    </div>
  );
}

const btn = (bg: string): React.CSSProperties => ({
  border: "none",
  borderRadius: 7,
  background: bg,
  color: "#fff",
  fontSize: 12.5,
  fontWeight: 600,
  padding: "6px 12px",
  cursor: "pointer",
  flexShrink: 0,
});

ReactDOM.createRoot(document.getElementById("scrollbar-root") as HTMLElement).render(
  <React.StrictMode>
    <ScrollBar />
  </React.StrictMode>
);

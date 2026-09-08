import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { pauseRecording, resumeRecording, recordingState } from "./lib/api";

const params = new URLSearchParams(window.location.search);
const since = Number(params.get("since")) || Date.now();

function StopBar() {
  const [seconds, setSeconds] = useState(() => Math.floor((Date.now() - since) / 1000));
  const [stopping, setStopping] = useState(false);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);

  // Polled rather than counted locally: once a pause has happened the wall clock and the
  // recorded length are different numbers, and the recorder is the one that knows which is
  // which. Half a second of drift on a timer nobody is reading to the frame is not worth a
  // second source of truth that can disagree with the file.
  useEffect(() => {
    const t = window.setInterval(async () => {
      try {
        const s = await recordingState();
        if (!s.recording) return;
        setSeconds(Math.floor(s.elapsedMs / 1000));
        setPaused(s.paused);
      } catch {
        /* A stop already in flight; the window is about to close anyway. */
      }
    }, 500);
    return () => window.clearInterval(t);
  }, []);

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    await emit("stop-recording-request", {});
  };

  // Invoked straight from here rather than routed through the main window like stop is: the
  // app's own state does not change on a pause, so there is nothing for it to hear about.
  const togglePause = async () => {
    if (busy || stopping) return;
    setBusy(true);
    try {
      if (paused) {
        await resumeRecording();
        setPaused(false);
      } else {
        await pauseRecording();
        setPaused(true);
      }
    } catch {
      /* Left to the next poll to correct. */
    } finally {
      setBusy(false);
    }
  };

  const mmss = `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;

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
        justifyContent: "space-between",
        gap: 10,
        height: "100%",
        boxSizing: "border-box",
        padding: "0 12px",
        borderRadius: 12,
        background: "rgba(24,24,28,0.92)",
        border: "1px solid rgba(255,255,255,0.08)",
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        color: "#fff",
        cursor: "default",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            // The pulse is what says "this is running". Holding it still while paused is the
            // clearest signal the bar can give that nothing is being recorded right now.
            background: paused ? "#8a8a90" : "#ff4d4f",
            boxShadow: "0 0 0 0 rgba(255,77,79,0.6)",
            animation: paused ? "none" : "pulse 1.4s ease-in-out infinite",
          }}
        />
        <span
          style={{
            fontSize: 15,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            color: paused ? "#a0a0a6" : "#fff",
          }}
        >
          {mmss}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          onClick={togglePause}
          disabled={busy || stopping}
          title={paused ? "Resume recording" : "Pause recording"}
          style={{
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: 7,
            background: "rgba(255,255,255,0.08)",
            color: "#fff",
            fontSize: 12.5,
            fontWeight: 600,
            padding: "6px 10px",
            cursor: busy || stopping ? "default" : "pointer",
            opacity: busy || stopping ? 0.5 : 1,
          }}
        >
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>
        <button
          onClick={stop}
          disabled={stopping}
          style={{
            border: "none",
            borderRadius: 7,
            background: "#ff4d4f",
            color: "#fff",
            fontSize: 12.5,
            fontWeight: 600,
            padding: "6px 10px",
            cursor: stopping ? "default" : "pointer",
            opacity: stopping ? 0.6 : 1,
          }}
        >
          {stopping ? "…" : "⏹ Stop"}
        </button>
      </div>
      <style>{`
        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(255,77,79,0.55); }
          70% { box-shadow: 0 0 0 6px rgba(255,77,79,0); }
          100% { box-shadow: 0 0 0 0 rgba(255,77,79,0); }
        }
      `}</style>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("stopbar-root") as HTMLElement).render(
  <React.StrictMode>
    <StopBar />
  </React.StrictMode>
);

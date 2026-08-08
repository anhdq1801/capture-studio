import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const params = new URLSearchParams(window.location.search);
const since = Number(params.get("since")) || Date.now();

function StopBar() {
  const [seconds, setSeconds] = useState(() => Math.floor((Date.now() - since) / 1000));
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    const t = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - since) / 1000));
    }, 500);
    return () => window.clearInterval(t);
  }, []);

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    await emit("stop-recording-request", {});
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
            background: "#ff4d4f",
            boxShadow: "0 0 0 0 rgba(255,77,79,0.6)",
            animation: "pulse 1.4s ease-in-out infinite",
          }}
        />
        <span style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
          {mmss}
        </span>
      </div>
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

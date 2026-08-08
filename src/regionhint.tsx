import React from "react";
import ReactDOM from "react-dom/client";

/**
 * A click-through outline marking the area that will be recorded.
 *
 * The window is inflated by `BORDER` logical pixels on every side and the frame is drawn in
 * that margin, so the whole outline sits strictly *outside* the rectangle ffmpeg crops to —
 * otherwise the marker would be baked into the recording it is describing.
 */
const params = new URLSearchParams(window.location.search);
const BORDER = Number(params.get("border")) || 3;
const label = params.get("label") ?? "";

function RegionHint() {
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          border: `${BORDER}px solid #6d5efc`,
          borderRadius: 2,
          boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
          boxSizing: "border-box",
        }}
      />
      {label && (
        <div
          style={{
            position: "absolute",
            top: -24,
            left: 0,
            background: "#6d5efc",
            color: "#fff",
            fontSize: 11.5,
            fontWeight: 600,
            padding: "2px 7px",
            borderRadius: 4,
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("regionhint-root") as HTMLElement).render(
  <React.StrictMode>
    <RegionHint />
  </React.StrictMode>
);

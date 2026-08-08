export interface ToastMsg {
  id: number;
  text: string;
  kind: "ok" | "err" | "info";
}

export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: ToastMsg[];
  onDismiss: (id: number) => void;
}) {
  return (
    // Toasts are the app's only error channel, so screen readers have to hear them.
    // Errors interrupt; successes wait their turn.
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind}`}
          role={t.kind === "err" ? "alert" : undefined}
        >
          <span className="toast-text">{t.text}</span>
          {/* Errors stay until dismissed — a raw ffmpeg or filesystem message is often
              longer than the 3.4s the others get, and there is no log to go back to. */}
          {t.kind === "err" && (
            <button
              className="toast-x"
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss error"
              title="Dismiss"
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

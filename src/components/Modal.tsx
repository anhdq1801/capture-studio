import { ReactNode, useEffect, useRef } from "react";

/**
 * Shared shell for the app's dialogs.
 *
 * Every modal used to be a bare div: no Escape handling, no focus management, and an
 * unlabelled "×" glyph. Backdrop clicks also bypassed in-flight guards — you could dismiss
 * the record dialog while it was starting a recording — so dismissal is now something the
 * busy state can switch off.
 */
export function Modal({
  title,
  onClose,
  dismissable = true,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  /** Set false while an operation is in flight so Escape/backdrop can't abandon it. */
  dismissable?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismissable, onClose]);

  // Move focus into the dialog so the keyboard lands somewhere sensible on open.
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>(
      "input, select, textarea, button:not([disabled])"
    );
    first?.focus();
  }, []);

  return (
    <div
      className="overlay-bg"
      onClick={() => dismissable && onClose()}
      role="presentation"
    >
      <div
        ref={ref}
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="x" onClick={onClose} aria-label="Close" title="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Close on Escape. `enabled` is false while an operation is in flight, so a stray keypress
 * can't abandon a recording that is mid-start or an optimise that is mid-run.
 */
export function useEscapeKey(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, onClose]);
}

/** Accessible on/off switch — the previous `<div onClick>` was invisible to the keyboard. */
export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`toggle ${on ? "on" : ""}`}
      onClick={onChange}
    >
      <span className="knob" />
    </button>
  );
}

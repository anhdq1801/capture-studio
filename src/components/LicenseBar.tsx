import { LicenseStatus } from "../lib/api";

/**
 * The one place the app ever asks to be paid for.
 *
 * A slim strip in the main window, shown after a month of real use and at most weekly after
 * that. Deliberately not a modal, not a countdown, and never anything that appears during a
 * capture — the moment someone is taking a screenshot is the moment they are working, and
 * interrupting it would make the app worse than the money is worth.
 */
export function LicenseBar({
  status,
  onBuy,
  onEnterKey,
  onDismiss,
}: {
  status: LicenseStatus;
  onBuy: () => void;
  onEnterKey: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="license-bar" role="status">
      <span className="lb-text">
        You've been using Capture Studio for {status.daysUsed} days. It stays free for personal
        use — a licence is for using it at work, and it turns this message off.
      </span>
      <button className="btn sm" onClick={onEnterKey}>
        I have a key
      </button>
      <button className="btn sm primary" onClick={onBuy}>
        Get a licence
      </button>
      <button className="lb-x" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
        ×
      </button>
    </div>
  );
}

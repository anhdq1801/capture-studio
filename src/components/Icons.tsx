import { ReactElement } from "react";

/**
 * Line icons for the app chrome.
 *
 * All drawn on the same 24×24 grid with a single stroke weight so they sit together evenly —
 * emoji were rendering at each platform's own size, weight and colour, which read as a
 * different visual language from the rest of the UI and couldn't inherit the text colour.
 */
export type UiIconName =
  | "area"
  | "screen"
  | "window"
  | "scroll"
  | "text"
  | "timer"
  | "record"
  | "stop"
  | "display"
  | "file"
  | "clipboard"
  | "library"
  | "compress"
  | "settings"
  | "folder";

const PATHS: Record<UiIconName, ReactElement> = {
  // Crop corners — the region-select gesture.
  area: (
    <>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8" />
      <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8" />
      <path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16" />
      <path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
    </>
  ),
  screen: (
    <>
      <rect x="3" y="4.5" width="18" height="12.5" rx="1.8" />
      <path d="M9 20.5h6" />
    </>
  ),
  window: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="1.8" />
      <path d="M3 9h18" />
      <path d="M6.4 6.75h.01M9 6.75h.01" />
    </>
  ),
  scroll: (
    <>
      <path d="M12 3.5v17" />
      <path d="M8.5 7 12 3.5 15.5 7" />
      <path d="M8.5 17 12 20.5 15.5 17" />
      <path d="M4 12h3M17 12h3" />
    </>
  ),
  // A capital "T" inside crop corners — recognising text out of a selected area.
  text: (
    <>
      <path d="M4 7.5V5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v2" />
      <path d="M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2" />
      <path d="M8.5 9h7M12 9v6.5" />
    </>
  ),
  timer: (
    <>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9.5V13l2.5 1.5" />
      <path d="M9.5 2.5h5" />
    </>
  ),
  record: <circle cx="12" cy="12" r="5.5" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.6" />,
  display: (
    <>
      <rect x="2.5" y="5" width="19" height="11.5" rx="1.6" />
      <path d="M8 20h8M12 16.5V20" />
    </>
  ),
  file: (
    <>
      <path d="M13.5 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z" />
      <path d="M13.5 3.5v5h5" />
    </>
  ),
  clipboard: (
    <>
      <path d="M9 4.5H7.5A1.5 1.5 0 0 0 6 6v13a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V6a1.5 1.5 0 0 0-1.5-1.5H15" />
      <rect x="9" y="2.5" width="6" height="4" rx="1.2" />
    </>
  ),
  library: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.4" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.4" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.4" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.4" />
    </>
  ),
  // Arrows squeezing inward — compression.
  compress: (
    <>
      <path d="M4 4.5 9 9.5M9 4.5v5h-5" />
      <path d="M20 4.5 15 9.5M15 4.5v5h5" />
      <path d="M4 19.5 9 14.5M9 19.5v-5h-5" />
      <path d="M20 19.5 15 14.5M15 19.5v-5h5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.6 1.6 0 0 0 15 19.4a1.6 1.6 0 0 0-1 1.47V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.6 15a1.6 1.6 0 0 0-1.47-1H3a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 9 4.6a1.6 1.6 0 0 0 1-1.47V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 19.4 9v.09a1.6 1.6 0 0 0 1.47 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </>
  ),
  folder: (
    <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z" />
  ),
};

export function UiIcon({ name, size = 17 }: { name: UiIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

import { UiIconName } from "../components/Icons";

/**
 * One name per action, used by the sidebar, Settings and the record dialog.
 *
 * These labels previously drifted apart — the tray said "Capture Area", the sidebar said
 * "Select region" and the record dialog said "An area…" for the same idea, so nothing a user
 * learned in one surface helped them in another. The tray's wording (in `lib.rs`) is the
 * canonical set and is mirrored here.
 */

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

/**
 * Render a capture shortcut the way this platform writes it. The Rust side binds
 * `CommandOrControl+Shift+<key>`, which is ⇧⌘ on macOS and Ctrl+Shift elsewhere — showing
 * Mac glyphs to a Windows user describes keys that do not exist there.
 */
export const shortcut = (key: string) => (isMac ? `⇧⌘${key}` : `Ctrl+Shift+${key}`);

export interface ActionLabel {
  label: string;
  icon: UiIconName;
  key?: string;
}

export const ACTIONS = {
  captureRegion: { label: "Capture Area", icon: "area", key: "2" },
  captureFull: { label: "Capture Screen", icon: "screen", key: "1" },
  captureWindow: { label: "Capture Window", icon: "window", key: "3" },
  captureScroll: { label: "Scrolling Capture", icon: "scroll", key: "4" },
  captureText: { label: "Capture Text (OCR)", icon: "text", key: "6" },
  captureDelayed: { label: "Delayed Screenshot (3s)", icon: "timer" },
  record: { label: "Screen Recording", icon: "record", key: "5" },
  openFile: { label: "Open an image file…", icon: "file" },
  clipboard: { label: "Paste image from clipboard", icon: "clipboard", key: "V" },
} satisfies Record<string, ActionLabel>;

/**
 * The shortcuts Settings lists, derived from the same table the buttons use. Ordered the way
 * the sidebar and tray present them, so the list reads as a map of the UI.
 */
export const SHORTCUT_LIST = (
  [
    "captureRegion",
    "captureFull",
    "captureWindow",
    "captureScroll",
    "captureText",
    "record",
    "clipboard",
  ] as const
).map((k) => [ACTIONS[k].label, shortcut(ACTIONS[k].key)] as [string, string]);

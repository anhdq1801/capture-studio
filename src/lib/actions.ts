import { UiIconName } from "../components/Icons";
import { ShortcutId } from "./shortcuts";

/**
 * One name per action, used by the sidebar, Settings and the record dialog.
 *
 * These labels previously drifted apart — the tray said "Capture Area", the sidebar said
 * "Select region" and the record dialog said "An area…" for the same idea, so nothing a user
 * learned in one surface helped them in another. The tray's wording (in `lib.rs`) is the
 * canonical set and is mirrored here.
 */

export interface ActionLabel {
  label: string;
  icon: UiIconName;
  /** The id this action's global shortcut is stored under, for the actions that have one. */
  shortcut?: ShortcutId;
}

export const ACTIONS = {
  captureRegion: { label: "Capture Area", icon: "area", shortcut: "capture-region" },
  captureFull: { label: "Capture Screen", icon: "screen", shortcut: "capture-full" },
  captureWindow: { label: "Capture Window", icon: "window", shortcut: "capture-window" },
  captureScroll: { label: "Scrolling Capture", icon: "scroll", shortcut: "capture-scroll" },
  captureText: { label: "Capture Text (OCR)", icon: "text", shortcut: "capture-text" },
  captureDelayed: { label: "Delayed Screenshot (3s)", icon: "timer" },
  record: { label: "Screen Recording", icon: "record", shortcut: "record" },
  openFile: { label: "Open an image file…", icon: "file" },
  clipboard: { label: "Paste image from clipboard", icon: "clipboard", shortcut: "clipboard" },
} satisfies Record<string, ActionLabel>;

/**
 * The bindable actions in the order Settings lists them, which is the order the sidebar and
 * tray present them in — so the list reads as a map of the UI rather than an alphabet.
 */
export const SHORTCUT_ROWS: { id: ShortcutId; label: string }[] = (
  [
    "captureRegion",
    "captureFull",
    "captureWindow",
    "captureScroll",
    "captureText",
    "record",
    "clipboard",
  ] as const
).map((k) => ({ id: ACTIONS[k].shortcut, label: ACTIONS[k].label }));

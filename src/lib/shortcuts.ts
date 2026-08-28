import { useSyncExternalStore } from "react";
import { getAppSettings, setShortcuts as setShortcutsCmd } from "./api";
import { isMac } from "./platform";

/**
 * The shortcut ids, and the combination each ships with. Mirrors `settings::SHORTCUTS` on the
 * Rust side, which is the authority — this copy exists so the sidebar can label a button before
 * settings have loaded, not so the two can disagree.
 */
export const SHORTCUT_DEFAULTS = {
  "capture-region": "Control+Shift+2",
  "capture-full": "Control+Shift+1",
  "capture-window": "Control+Shift+3",
  "capture-scroll": "Control+Shift+4",
  record: "Control+Shift+5",
  "capture-text": "Control+Shift+6",
  clipboard: "Control+Shift+V",
} as const;

export type ShortcutId = keyof typeof SHORTCUT_DEFAULTS;
export type ShortcutMap = Record<string, string>;

export const SHORTCUT_IDS = Object.keys(SHORTCUT_DEFAULTS) as ShortcutId[];


/**
 * Every surface that prints a shortcut reads from here.
 *
 * The alternative — each component holding its own copy of the settings — is how the sidebar
 * ends up promising ⌃⇧2 for the rest of the session after the user has rebound it in Settings.
 * A module-level store is enough: there is one set of shortcuts per app, not per subtree.
 */
let current: ShortcutMap = { ...SHORTCUT_DEFAULTS };
const listeners = new Set<() => void>();

function publish(next: ShortcutMap) {
  current = next;
  listeners.forEach((l) => l());
}

/** Subscribe to the live map. Re-renders whichever components print a shortcut. */
export function useShortcuts(): ShortcutMap {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current
  );
}

/** What `id` is bound to right now — the user's choice, or the shipped default. */
export function comboFor(map: ShortcutMap, id: ShortcutId): string {
  const chosen = map[id];
  // Present but empty is a deliberate "unbound"; missing means never touched. Same rule as
  // the Rust side, so a settings file that predates an action keeps that action's default.
  return chosen === undefined ? SHORTCUT_DEFAULTS[id] : chosen;
}

export async function loadShortcuts(): Promise<void> {
  const settings = await getAppSettings();
  publish({ ...SHORTCUT_DEFAULTS, ...settings.shortcuts });
}

/**
 * Persist and rebind. Resolves to the ids the system refused, which the caller is expected to
 * show — the change is otherwise saved and looks successful while doing nothing.
 */
export async function saveShortcuts(next: ShortcutMap): Promise<string[]> {
  const failed = await setShortcutsCmd(next);
  publish(next);
  return failed;
}

/** Keys that are a modifier in their own right and can never be the main key of a shortcut. */
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

/**
 * Codes the Rust accelerator parser understands, which is a subset of what a keyboard can
 * produce — `IntlBackslash` and the media keys among the misses. Anything outside this is
 * rejected while the user is still holding the keys down, rather than being stored and
 * silently failing to register later.
 */
const NAMED_CODES = new Set([
  "Backquote", "Backslash", "BracketLeft", "BracketRight", "Comma", "Equal", "Minus",
  "Period", "Quote", "Semicolon", "Slash", "Backspace", "CapsLock", "Enter", "Space",
  "Tab", "Delete", "End", "Home", "Insert", "PageDown", "PageUp", "PrintScreen",
  "ScrollLock", "Pause", "NumLock", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp",
]);

function isSupportedCode(code: string): boolean {
  return (
    /^Key[A-Z]$/.test(code) ||
    /^Digit[0-9]$/.test(code) ||
    /^F([1-9]|1[0-9]|2[0-4])$/.test(code) ||
    /^Numpad/.test(code) ||
    NAMED_CODES.has(code)
  );
}

/**
 * Turn a keypress into an accelerator, or null if it is not usable as a global shortcut.
 *
 * Built from `event.code` rather than `event.key`, because the Rust parser speaks the same
 * physical-key names — and because `key` changes with the keyboard layout and with Shift, so
 * a Vietnamese or French layout would otherwise store a combination that never fires.
 */
export function acceleratorFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES.test(e.code) || !isSupportedCode(e.code)) return null;
  const mods: string[] = [];
  // ⌘ on macOS, Ctrl elsewhere — the one token that means "the platform's command key".
  if (isMac ? e.metaKey : e.ctrlKey) mods.push("CommandOrControl");
  if (isMac ? e.ctrlKey : e.metaKey) mods.push(isMac ? "Control" : "Super");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  // Shift alone is not enough: ⇧A is a capital A, and binding it globally would take the key
  // away from every other app. A function key is the exception, being no use for typing.
  const usable = mods.some((m) => m !== "Shift") || /^F\d/.test(e.code);
  if (!usable) return null;
  return [...mods, e.code].join("+");
}

const GLYPHS: Record<string, string> = {
  CommandOrControl: isMac ? "⌘" : "Ctrl+",
  CmdOrCtrl: isMac ? "⌘" : "Ctrl+",
  Command: "⌘",
  Cmd: "⌘",
  Super: isMac ? "⌘" : "Win+",
  Control: isMac ? "⌃" : "Ctrl+",
  Ctrl: isMac ? "⌃" : "Ctrl+",
  Alt: isMac ? "⌥" : "Alt+",
  Option: "⌥",
  Shift: isMac ? "⇧" : "Shift+",
};

/** macOS orders the glyphs ⌃⌥⇧⌘ regardless of how the accelerator was written. */
const MAC_ORDER = ["⌃", "⌥", "⇧", "⌘"];

const KEY_LABELS: Record<string, string> = {
  Space: "Space",
  Enter: isMac ? "↩" : "Enter",
  Tab: "⇥",
  Backspace: isMac ? "⌫" : "Backspace",
  Delete: isMac ? "⌦" : "Del",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Quote: "'",
  Semicolon: ";",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  PageUp: isMac ? "⇞" : "PgUp",
  PageDown: isMac ? "⇟" : "PgDn",
  Home: isMac ? "↖" : "Home",
  End: isMac ? "↘" : "End",
};

/**
 * Render an accelerator the way this platform writes it: ⌃⇧2 on macOS, Ctrl+Shift+2 elsewhere.
 * Showing Mac glyphs to a Windows user describes keys that do not exist there.
 */
export function formatAccelerator(combo: string): string {
  if (!combo) return "";
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map((m) => GLYPHS[m] ?? `${m}+`);
  if (isMac) mods.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
  const label =
    KEY_LABELS[key] ??
    key.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num ");
  return mods.join("") + label;
}

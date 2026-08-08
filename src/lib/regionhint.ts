import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { MonitorInfo } from "./api";

/** Logical pixels the outline is drawn in, entirely outside the selected rectangle. */
const BORDER = 3;

/**
 * Mark the selected recording area on screen so the user can see what they picked.
 *
 * The window sits just outside the selection and ignores the cursor, so it neither blocks
 * the app being recorded nor appears in the recording itself.
 */
export async function showRegionHint(
  monitor: MonitorInfo | null,
  rect: [number, number, number, number],
  label = ""
): Promise<void> {
  await hideRegionHint();

  const s = monitor?.scaleFactor || 1;
  const [rx, ry, rw, rh] = rect;
  // Selection is in physical pixels relative to its monitor; windows are placed in logical
  // units in global desktop space.
  const x = (monitor?.x ?? 0) / s + rx / s - BORDER;
  const y = (monitor?.y ?? 0) / s + ry / s - BORDER;
  const w = rw / s + BORDER * 2;
  const h = rh / s + BORDER * 2;

  const params = new URLSearchParams({ border: String(BORDER), label });
  const win = new WebviewWindow("regionhint", {
    url: `regionhint.html?${params.toString()}`,
    x,
    y,
    width: w,
    height: h,
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    shadow: false,
    focus: false,
    title: "Selected area",
    visibleOnAllWorkspaces: true,
  });
  // WebviewWindow's constructor doesn't throw on failure — creation errors only surface via
  // this event. Without listening for it, a failed hint silently does nothing.
  await new Promise<void>((resolve, reject) => {
    win.once("tauri://created", () => resolve());
    win.once("tauri://error", (e) => reject(new Error(String(e.payload))));
  });
  // Position again explicitly: the creation options are applied before the window knows
  // which display it landed on, so a multi-monitor setup can otherwise place it off by the
  // wrong scale factor.
  await win.setPosition(new LogicalPosition(x, y));
  await win.setSize(new LogicalSize(w, h));
  // Without this the outline would swallow clicks meant for the app being recorded.
  await win.setIgnoreCursorEvents(true);
}

export async function hideRegionHint(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("regionhint");
  if (existing) {
    try {
      await existing.close();
    } catch {
      /* ignore */
    }
  }
}

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { MonitorInfo } from "./api";

const WIDTH = 268;
const HEIGHT = 54;
const MARGIN = 24;

/**
 * Open the floating scrolling-capture control bar, kept clear of the region being captured
 * so it never ends up stitched into the result.
 */
export async function openScrollBar(
  monitor: MonitorInfo | null,
  region: [number, number, number, number]
): Promise<void> {
  await closeScrollBar();

  const s = monitor?.scaleFactor || 1;
  // Region arrives in physical pixels relative to the monitor; the bar is placed in logical
  // units in global desktop space.
  const [rx, ry, rw, rh] = region;
  const monLeft = (monitor?.x ?? 0) / s;
  const monTop = (monitor?.y ?? 0) / s;
  const monW = (monitor?.width ?? 1280) / s;
  const monH = (monitor?.height ?? 800) / s;
  const regLeft = rx / s;
  const regTop = ry / s;
  const regRight = (rx + rw) / s;
  const regBottom = (ry + rh) / s;

  // The bar is a real on-screen window, so anywhere it overlaps the captured region it would
  // be stitched into the result. Try each gap around the region in turn and only fall back to
  // overlapping when the region leaves no room at all.
  let x = (monW - WIDTH) / 2;
  let y: number;
  if (monH - regBottom >= HEIGHT + MARGIN * 2) {
    y = regBottom + MARGIN;
  } else if (regTop >= HEIGHT + MARGIN * 2) {
    y = regTop - HEIGHT - MARGIN;
  } else if (monW - regRight >= WIDTH + MARGIN * 2) {
    x = regRight + MARGIN;
    y = Math.min(monH - HEIGHT - MARGIN, regTop + MARGIN);
  } else if (regLeft >= WIDTH + MARGIN * 2) {
    x = regLeft - WIDTH - MARGIN;
    y = Math.min(monH - HEIGHT - MARGIN, regTop + MARGIN);
  } else {
    y = Math.max(MARGIN, monH - HEIGHT - MARGIN);
  }

  const win = new WebviewWindow("scrollbar", {
    url: "scrollbar.html",
    x: monLeft + x,
    y: monTop + y,
    width: WIDTH,
    height: HEIGHT,
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    shadow: false,
    focus: false,
    title: "Scrolling capture",
    visibleOnAllWorkspaces: true,
  });
  // WebviewWindow's constructor doesn't throw on failure — creation errors only surface via
  // this event. Without listening for it, a failed bar silently does nothing.
  await new Promise<void>((resolve, reject) => {
    win.once("tauri://created", () => resolve());
    win.once("tauri://error", (e) => reject(new Error(String(e.payload))));
  });
  await win.setPosition(new LogicalPosition(monLeft + x, monTop + y));
}

export async function closeScrollBar(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("scrollbar");
  if (existing) {
    try {
      await existing.close();
    } catch {
      /* ignore */
    }
  }
}

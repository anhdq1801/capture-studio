import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { emit } from "@tauri-apps/api/event";
import { MonitorInfo } from "./api";

/** What happens to the selection once it's made. */
export type OverlayMode = "shot" | "record" | "scroll" | "text";
/**
 * How the selection is made. Kept separate from the mode so every mode can offer either
 * gesture — "click a window" and "drag an area" are independent of what we do with the
 * result, and making it an explicit choice beats leaving the user to discover the gesture.
 */
export type OverlayPick = "area" | "window" | "both";

const label = (monitorId: number) => `overlay-${monitorId}`;

const creating = new Map<number, Promise<WebviewWindow>>();

// One overlay per display: a single window can't cover a multi-monitor setup in a way the
// per-monitor Rust crop understands, and each display can have its own scale factor. Giving
// every monitor its own overlay means the crosshair is available on all of them and the
// selection coordinates are already relative to the right display.
//
// Overlays are also expensive to spin up (new WKWebView + the whole JS bundle), so they are
// created once and kept alive, hidden, between captures rather than recreated each time.
async function getOverlayWindow(monitor: MonitorInfo): Promise<WebviewWindow> {
  const existing = await WebviewWindow.getByLabel(label(monitor.id));
  if (existing) return existing;
  const pending = creating.get(monitor.id);
  if (pending) return pending;

  const params = new URLSearchParams({
    monitor: String(monitor.id),
    scale: String(monitor.scaleFactor),
    // Physical origin of this display, so window-pick mode can map global window bounds
    // into this overlay's own coordinate space.
    mx: String(monitor.x),
    my: String(monitor.y),
  });
  const p = new Promise<WebviewWindow>((resolve, reject) => {
    const win = new WebviewWindow(label(monitor.id), {
      url: `overlay.html?${params.toString()}`,
      visible: false,
      // Deliberately NOT `fullscreen: true` — macOS gives every native-fullscreen window its
      // own Space and animates a desktop switch to it. Instead, size/position a plain borderless
      // window to exactly cover the target monitor's bounds, which stays on the current Space.
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      shadow: false,
      focus: false,
      title: "Select region",
      // Without this, macOS still tends to treat a borderless always-on-top window covering the
      // whole screen as "fullscreen-like" and gives it a dedicated Space, animating a desktop
      // switch to show it. Staying visible on all workspaces keeps it on the current Space.
      visibleOnAllWorkspaces: true,
    });
    // WebviewWindow's constructor doesn't throw on failure — creation errors only surface via
    // this event. Without listening for it, a failed overlay silently does nothing.
    win.once("tauri://created", () => resolve(win));
    win.once("tauri://error", (e) => reject(new Error(String(e.payload))));
  });
  creating.set(monitor.id, p);
  return p;
}

// Monitor bounds arrive in physical pixels; window placement is expressed in logical units
// so the overlay covers the whole display on a Retina/HiDPI screen too, not a fraction of it.
async function placeOnMonitor(win: WebviewWindow, monitor: MonitorInfo): Promise<void> {
  const s = monitor.scaleFactor || 1;
  await win.setPosition(new LogicalPosition(monitor.x / s, monitor.y / s));
  await win.setSize(new LogicalSize(monitor.width / s, monitor.height / s));
}

/**
 * Build the overlays ahead of time, at app startup, so the first "Capture Area" is as instant
 * as every later one. Without this the first capture still pays the full webview-startup cost
 * while the user stares at nothing.
 */
export async function prewarmRegionOverlays(monitors: MonitorInfo[]): Promise<void> {
  await Promise.all(
    monitors.map(async (m) => {
      const win = await getOverlayWindow(m);
      await placeOnMonitor(win, m);
    })
  );
}

export async function openRegionOverlay(
  mode: OverlayMode,
  monitors: MonitorInfo[],
  pick: OverlayPick = "area"
): Promise<void> {
  if (monitors.length === 0) return;
  // Tell every overlay what this capture is for before showing them, so whichever display the
  // user drags on is already in the right mode.
  await emit("overlay-init", { mode, pick });
  await Promise.all(
    monitors.map(async (m) => {
      const win = await getOverlayWindow(m);
      await placeOnMonitor(win, m);
      await win.show();
    })
  );
  // Focus one of them so Escape works immediately; the others still take pointer input.
  const first = await WebviewWindow.getByLabel(label(monitors[0].id));
  await first?.setFocus();
}

/** Hide (not close) every overlay so they stay warm for the next capture. */
export async function closeRegionOverlays(): Promise<void> {
  await emit("overlay-dismiss");
}

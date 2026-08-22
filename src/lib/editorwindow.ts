import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen } from "@tauri-apps/api/event";
import { MediaItem } from "./api";

const LABEL = "editor";

/**
 * The annotation editor lives in its own window rather than inside the app's.
 *
 * A capture started from the menu bar used to drag the whole application on screen with it —
 * sidebar, library, whatever screen you had last been on — to show one image. The editor is the
 * only thing anyone wants at that moment, and the app has no business appearing behind it.
 *
 * Kept alive and hidden between captures rather than closed. Spinning up a WKWebView and the JS
 * bundle takes long enough to notice, and this window opens after *every* screenshot; the
 * overlays are pooled for the same reason.
 */

/**
 * The item is handed over by event, never in the window's URL.
 *
 * Passing an id and letting the editor look it up does not work: a fresh capture is a *draft*,
 * and `get_library` filters drafts out — they are not library items until they are saved. So
 * the one case this window exists for is the one case the lookup fails, and the editor comes up
 * blank. Sending the whole item sidesteps that, and makes the first open and every later open
 * the same path.
 */
let pending: MediaItem | null = null;
let bridge: Promise<unknown> | null = null;

/** Deliver the pending item as soon as the editor says it is listening. */
function ensureBridge() {
  if (bridge) return bridge;
  bridge = listen("editor-ready", async () => {
    if (!pending) return;
    const item = pending;
    pending = null;
    await emit("editor-open", item);
  });
  return bridge;
}

let creating: Promise<WebviewWindow> | null = null;

export async function openEditorWindow(item: MediaItem): Promise<void> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    // The editor shows itself once it has the capture, so there is no frame in which this
    // window is on screen still displaying the previous one.
    await emit("editor-open", item);
    return;
  }
  if (creating) {
    pending = item;
    await creating;
    return;
  }

  // Listener first, item second, window last: the editor announces itself the moment it mounts,
  // and that can happen before anything after `new WebviewWindow` has run.
  await ensureBridge();
  pending = item;

  creating = new Promise<WebviewWindow>((resolve, reject) => {
    const win = new WebviewWindow(LABEL, {
      url: "editor.html",
      width: 1180,
      height: 800,
      minWidth: 720,
      minHeight: 520,
      center: true,
      title: "Edit capture",
      // Created hidden and shown by the editor once it has something to draw. Otherwise the
      // window is on screen for as long as a WKWebView takes to boot, showing nothing.
      visible: false,
      // Same reason the overlays need it: a capture triggered from the menu bar leaves this
      // app in the background, and macOS spends an inactive app's first click on activating
      // it rather than passing it to the page. Without this the first drag on the canvas is
      // swallowed — the exact bug the crosshair had.
      acceptFirstMouse: true,
    });
    // WebviewWindow's constructor doesn't throw on failure — creation errors only surface via
    // this event. Without listening for it, a failed editor silently does nothing.
    win.once("tauri://created", () => resolve(win));
    win.once("tauri://error", (e) => reject(new Error(String(e.payload))));
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

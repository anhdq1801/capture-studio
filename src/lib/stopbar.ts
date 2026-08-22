import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

const WIDTH = 200;
const HEIGHT = 52;

/** Open the small always-on-top recording control bar, positioned top-center. */
export async function openStopBar(since: number): Promise<void> {
  await closeStopBar();
  const win = new WebviewWindow("stopbar", {
    url: `stopbar.html?since=${since}`,
    width: WIDTH,
    height: HEIGHT,
    minWidth: WIDTH,
    minHeight: HEIGHT,
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    shadow: false,
    focus: false,
    // This bar exists to be clicked while another app is frontmost — that is the whole point of
    // recording. An inactive app's window swallows its first click to activate itself unless the
    // webview accepts it, which would cost every stop a second click.
    acceptFirstMouse: true,
    center: true,
    title: "Recording",
  });
  // WebviewWindow's constructor doesn't throw on failure — creation errors only surface via
  // this event. Without listening for it, a failed stop-bar silently does nothing.
  await new Promise<void>((resolve, reject) => {
    win.once("tauri://created", () => resolve());
    win.once("tauri://error", (e) => reject(new Error(String(e.payload))));
  });
}

export async function closeStopBar(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("stopbar");
  if (existing) {
    try {
      await existing.close();
    } catch {
      /* ignore */
    }
  }
}

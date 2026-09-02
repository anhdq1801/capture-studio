import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * Getting our own windows off the screen before grabbing it.
 *
 * The main window has always been hidden for a capture. The editor and the text panel were not:
 * they started life inside the main window and became windows of their own later, and the code
 * that clears the screen was never told. So a region drawn next to an open editor captured the
 * editor — showing the *previous* capture, inside the new one.
 *
 * The overlays are deliberately absent from this list. They have to stay on screen; the overlay
 * hides itself at the last moment, after the selection is made.
 */
const IN_THE_WAY = ["editor", "textpanel"] as const;

/** Hides any of ours that are showing, and reports which — so only those come back. */
export async function hideOwnWindows(): Promise<string[]> {
  const hidden: string[] = [];
  for (const label of IN_THE_WAY) {
    const win = await WebviewWindow.getByLabel(label).catch(() => null);
    if (!win) continue;
    if (await win.isVisible().catch(() => false)) {
      await win.hide().catch(() => {});
      hidden.push(label);
    }
  }
  return hidden;
}

/**
 * Puts back what `hideOwnWindows` took away.
 *
 * `except` names the window that is about to be handed new content. Showing it here would put
 * the *old* capture on screen for the frame before the new one arrives, which is the flicker
 * this whole arrangement exists to avoid — that window shows itself when it has something to
 * show.
 */
export async function showOwnWindows(labels: string[], except?: string): Promise<void> {
  for (const label of labels) {
    if (label === except) continue;
    const win = await WebviewWindow.getByLabel(label).catch(() => null);
    await win?.show().catch(() => {});
  }
}

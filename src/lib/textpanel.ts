import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition, availableMonitors } from "@tauri-apps/api/window";
import { Paragraph } from "./paragraphs";

const WIDTH = 460;
const MIN_HEIGHT = 180;
const MAX_HEIGHT = 560;
/** Kept clear of the region so the panel never covers the thing that was just read. */
const GAP = 12;

/**
 * Show what Capture Text recognised, next to where it was recognised.
 *
 * Positioned by the selection rather than centred: the user's eyes are already at that part of
 * the screen, and a panel in the middle of the display makes them find it again. When the
 * region sits too low or too far right for the panel to fit beside it, it flips to the other
 * side rather than hanging off the edge.
 */
export async function openTextPanel(
  paragraphs: Paragraph[],
  /** The recognised region in logical screen coordinates: x, y, width, height. */
  region: [number, number, number, number] | null
): Promise<void> {
  await closeTextPanel();

  // Rough, and deliberately so — the real height depends on wrapping, which only the webview
  // knows. Two lines per paragraph is the common case and errs towards a panel that is a little
  // too tall rather than one that hides its own last line.
  const lines = paragraphs.reduce((n, p) => n + Math.ceil(p.text.length / 62) + 1, 0);
  const height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, 96 + lines * 21));

  const payload = encodeURIComponent(JSON.stringify(paragraphs));
  // The label has to appear in `src-tauri/capabilities/default.json` under `windows`, or the
  // window opens with no permissions at all and every Tauri call from inside it fails quietly —
  // close, pin and copy all do nothing, with no error to say why. JSON takes no comments, so
  // the reminder lives here, next to the line that creates the window.
  const win = new WebviewWindow("textpanel", {
    url: `textpanel.html?paragraphs=${payload}`,
    width: WIDTH,
    height,
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    shadow: true,
    // Not focused: this appears over whatever the user was reading, and taking focus would pull
    // their cursor out of it. Clicking into the text is what starts an edit.
    focus: false,
    // Without this the first click — the one that would put the caret in a word to correct it —
    // is swallowed to activate the app instead, and every correction costs two clicks.
    acceptFirstMouse: true,
    title: "Extracted text",
  });

  win.once("tauri://error", (e) => console.error("text panel failed to open", e));

  if (region) {
    // The rect arrives in PHYSICAL pixels — see the note on `to_physical` in capture.rs, which
    // normalises everything crossing the IPC boundary. The window's own width and height were
    // given in logical units, so the two only compare after one is converted. Placing the panel
    // with the raw numbers works on a 1x display and silently doubles every offset on a Retina
    // one, which is exactly the kind of bug that never shows up on the machine it was written on.
    const monitors = await availableMonitors().catch(() => []);
    const [rx, ry, rw] = region;
    const cx = rx + rw / 2;
    const screen =
      monitors.find(
        (m) =>
          cx >= m.position.x &&
          cx < m.position.x + m.size.width &&
          ry >= m.position.y &&
          ry < m.position.y + m.size.height
      ) ?? monitors[0];

    const scale = screen?.scaleFactor ?? 1;
    const panelW = WIDTH * scale;
    const panelH = height * scale;
    const gap = GAP * scale;

    let x = rx + rw + gap;
    let y = ry;

    if (screen) {
      const right = screen.position.x + screen.size.width;
      const bottom = screen.position.y + screen.size.height;
      // Beside the region if it fits, otherwise flipped to its left; then clamped so a region
      // near an edge cannot push the panel off the display.
      if (x + panelW > right) x = rx - panelW - gap;
      x = Math.max(screen.position.x + gap, Math.min(x, right - panelW - gap));
      y = Math.max(screen.position.y + gap, Math.min(y, bottom - panelH - gap));
    }
    await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y))).catch(() => {});
  } else {
    await win.center().catch(() => {});
  }
}

export async function closeTextPanel(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("textpanel");
  if (existing) await existing.close().catch(() => {});
}

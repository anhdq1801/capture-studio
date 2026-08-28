/**
 * Which desktop this build is running on.
 *
 * The webview is the only thing that knows, and two unrelated places now need the answer —
 * shortcut rendering (⌘ or Ctrl) and the ffmpeg install instructions, which are a different
 * command on every platform. A second copy of the sniffing would be a second thing to get
 * wrong.
 */
const platform = typeof navigator !== "undefined" ? navigator.platform ?? "" : "";

export const isMac = /Mac|iPhone|iPad/.test(platform);
export const isWindows = /Win/.test(platform);

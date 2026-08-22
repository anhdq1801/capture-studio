import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";

export interface MediaItem {
  id: string;
  kind: "screenshot" | "recording";
  fileName: string;
  createdAt: string;
  note: string;
  width: number;
  height: number;
  sizeBytes: number;
  durationMs?: number;
  /** Poster frame of a recording, as a file name inside the library folder. */
  thumbName?: string;
  /** A capture that has not been saved into the library yet. */
  draft?: boolean;
  cloudUrl?: string;
  uploadedAt?: string;
}

export interface MonitorInfo {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  isPrimary: boolean;
}

/** An on-screen window, with bounds in physical pixels in global desktop coordinates. */
export interface WindowInfo {
  id: number;
  title: string;
  appName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
}

export interface ScrollStatus {
  frames: number;
  height: number;
  added: number;
}

export interface DeviceEntry {
  index: string;
  name: string;
}

export interface CaptureDevices {
  screens: DeviceEntry[];
  audio: DeviceEntry[];
  ffmpegAvailable: boolean;
}

export interface OptimizeResult {
  originalSize: number;
  newSize: number;
  width: number;
  height: number;
  format: string;
  item: MediaItem;
}

export interface RecordOptions {
  screenIndex?: string;
  audioDevice?: string;
  fps?: number;
  captureCursor?: boolean;
  region?: [number, number, number, number];
  codec?: string;
  resolution?: string;
}

/** Output height preset; "source" keeps the display's native resolution. */
export type Resolution = "source" | "2160" | "1440" | "1080" | "720" | "480";

export const RESOLUTIONS: { id: Resolution; label: string }[] = [
  { id: "source", label: "Source" },
  { id: "2160", label: "4K · 2160p" },
  { id: "1440", label: "2K · 1440p" },
  { id: "1080", label: "1080p" },
  { id: "720", label: "720p" },
  { id: "480", label: "480p" },
];

export interface AppSettings {
  resolution: Resolution;
  codec: string;
  /** BCP-47 tags in priority order, e.g. ["vi-VT", "en-US"]. */
  ocrLanguages: string[];
  /** Accelerator per shortcut id, e.g. `{"capture-region": "CommandOrControl+Shift+2"}`. */
  shortcuts: Record<string, string>;
}

export interface CodecOption {
  id: string;
  label: string;
  ext: string;
  available: boolean;
  note: string;
}

// ---- Library ----
export const getLibrary = () => invoke<MediaItem[]>("get_library");
export const getLibraryDir = () => invoke<string>("get_library_dir");
export const itemPath = (id: string) => invoke<string>("item_path", { id });
export const updateNote = (id: string, note: string) =>
  invoke<MediaItem>("update_note", { id, note });
export const deleteItem = (id: string) => invoke<boolean>("delete_item", { id });
export const deleteItems = (ids: string[]) => invoke<number>("delete_items", { ids });
export const revealItem = (id: string) => invoke<void>("reveal_item", { id });

// ---- Screen-recording permission ----
/**
 * Whether a capture will contain window content. Without the permission macOS still returns
 * an image — the desktop picture with every window removed — so this has to be checked
 * before capturing rather than inferred from the result. Never prompts; safe to poll.
 */
export const screenPermissionGranted = () => invoke<boolean>("screen_permission_granted");
/** Show the system prompt. Resolves to the state afterwards. */
export const requestScreenPermission = () => invoke<boolean>("request_screen_permission");
export const openScreenPermissionSettings = () =>
  invoke<void>("open_screen_permission_settings");
/** A grant made in System Settings only reaches a process that starts after it. */
export const restartApp = () => invoke<void>("restart_app");

// ---- Capture ----
export const listMonitors = () => invoke<MonitorInfo[]>("list_monitors");
export const captureMonitor = (monitorId?: number) =>
  invoke<MediaItem>("capture_monitor", { monitorId: monitorId ?? null });
export const captureRegion = (
  monitorId: number | null,
  x: number,
  y: number,
  width: number,
  height: number
) =>
  invoke<MediaItem>("capture_region", {
    monitorId,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
export const saveAnnotated = (id: string, pngBase64: string) =>
  invoke<MediaItem>("save_annotated", { id, pngBase64 });
/** Keep a draft capture as-is, without re-encoding it through the annotation canvas. */
export const keepItem = (id: string) => invoke<MediaItem>("keep_item", { id });

// ---- Window capture ----
export const listWindows = () => invoke<WindowInfo[]>("list_windows");
export const captureWindow = (windowId: number) =>
  invoke<MediaItem>("capture_window", { windowId });

// ---- Scrolling capture ----
export const scrollStart = (
  monitorId: number | null,
  x: number,
  y: number,
  width: number,
  height: number
) =>
  invoke<ScrollStatus>("scroll_start", {
    monitorId,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
export const scrollStep = () => invoke<ScrollStatus>("scroll_step");
export const scrollFinish = () => invoke<MediaItem>("scroll_finish");
export const scrollCancel = () => invoke<void>("scroll_cancel");

export interface ScreenGrab {
  base64: string;
  width: number;
  height: number;
  scaleFactor: number;
}
export const grabScreen = (monitorId: number | null) =>
  invoke<ScreenGrab>("grab_screen", { monitorId });
export const importPng = (pngBase64: string) =>
  invoke<MediaItem>("import_png", { pngBase64 });
export const importFile = (path: string) =>
  invoke<MediaItem>("import_file", { path });
export const importFromClipboard = () =>
  invoke<MediaItem>("import_from_clipboard");
export const setClipboardPng = (pngBase64: string) =>
  invoke<void>("set_clipboard_png", { pngBase64 });
export const setClipboardText = (text: string) =>
  invoke<void>("set_clipboard_text", { text });

// ---- Autostart ----
export const getAutostart = () => invoke<boolean>("get_autostart");
export const setAutostart = (enabled: boolean) =>
  invoke<void>("set_autostart", { enabled });

// ---- Optimize ----
export const optimizeImage = (
  id: string,
  format: string,
  quality: number,
  maxWidth: number | null,
  replace: boolean
) =>
  invoke<OptimizeResult>("optimize_image", {
    id,
    format,
    quality,
    maxWidth,
    replace,
  });

// ---- Batch image optimiser ----
export interface BatchFile {
  path: string;
  name: string;
  sizeBytes: number;
}

export interface BatchProgress {
  done: number;
  total: number;
  name: string;
  originalSize: number;
  /** 0 when `error` is set. */
  newSize: number;
  error?: string;
}

/** Expand files and folders into a flat list of images (folders are walked recursively). */
export const scanImages = (paths: string[]) => invoke<BatchFile[]>("scan_images", { paths });

/**
 * Kick off a batch. Returns as soon as the work is queued — progress arrives as
 * `optimize-progress` events, followed by a single `optimize-done`.
 */
export const optimizeFiles = (
  files: string[],
  outDir: string,
  format: string,
  quality: number,
  maxWidth: number | null
) => invoke<void>("optimize_files", { files, outDir, format, quality, maxWidth });

// ---- Recording ----
export const checkFfmpeg = () => invoke<boolean>("check_ffmpeg");
export const listCaptureDevices = () => invoke<CaptureDevices>("list_capture_devices");
export const startRecording = (opts: RecordOptions) =>
  invoke<void>("start_recording", { opts });
export const stopRecording = () => invoke<MediaItem>("stop_recording");
export const isRecording = () => invoke<boolean>("is_recording");
export const listVideoCodecs = () => invoke<CodecOption[]>("list_video_codecs");
/** Absolute path of a recording's poster frame, generated on first ask. */
export const ensureThumbnail = (id: string) =>
  invoke<string | null>("ensure_thumbnail", { id });
// ---- Licence ----
export interface LicenseStatus {
  licensed: boolean;
  name?: string;
  /** "personal" | "commercial" */
  kind?: string;
  issued?: string;
  daysUsed: number;
  /** Unlicensed, past the grace period, and due another reminder. */
  shouldNudge: boolean;
}

export const getLicenseStatus = () => invoke<LicenseStatus>("get_license_status");
export const activateLicense = (key: string) =>
  invoke<LicenseStatus>("activate_license", { key });
export const removeLicense = () => invoke<LicenseStatus>("remove_license");
export const snoozeLicenseNudge = () => invoke<void>("snooze_license_nudge");

// ---- Text recognition ----
export interface OcrLine {
  text: string;
  confidence: number;
}

export interface OcrResult {
  text: string;
  lines: OcrLine[];
  /** Lines the recogniser was unsure about — worth flagging rather than trusting silently. */
  lowConfidence: number;
}

export interface OcrLanguage {
  id: string;
  label: string;
}

export const ocrAvailable = () => invoke<boolean>("ocr_available");
export const listOcrLanguages = () => invoke<OcrLanguage[]>("list_ocr_languages");
/** Read text straight off the screen. Nothing is saved to the library. */
export const ocrRegion = (
  monitorId: number | null,
  x: number,
  y: number,
  width: number,
  height: number
) =>
  invoke<OcrResult>("ocr_region", {
    monitorId,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
export const ocrItem = (id: string) => invoke<OcrResult>("ocr_item", { id });

export const getAppSettings = () => invoke<AppSettings>("get_app_settings");
export const setAppSettings = (settings: AppSettings) =>
  invoke<AppSettings>("set_app_settings", { settings });
/** Persist and rebind the global shortcuts. Resolves to the ids the system refused. */
export const setShortcuts = (shortcuts: Record<string, string>) =>
  invoke<string[]>("set_shortcuts", { shortcuts });
/**
 * Release the global shortcuts while Settings listens for a new key combination, so pressing
 * one that is already bound is read rather than firing its capture.
 */
export const pauseShortcuts = (paused: boolean) =>
  invoke<void>("pause_shortcuts", { paused });

// ---- Account / Cloud ----
export type PlanInterval = "monthly" | "annual";

/** What one tier costs for one interval. VND is a price, not a conversion of the USD one. */
export interface TierPrice {
  usdCents: number;
  vndAmount: number;
}

export interface PricingTier {
  id: string;
  label: string;
  bytes: number;
  monthly: TierPrice;
  annual: TierPrice;
}

/**
 * The plan ladder, fetched from the server rather than compiled in — a price baked into a
 * desktop build cannot be corrected without shipping another build.
 */
export interface Pricing {
  tiers: PricingTier[];
  lapseGraceDays: number;
}

export interface AccountStatus {
  email: string;
  subscriptionActive: boolean;
  planInterval: PlanInterval | null;
  /** Storage tier id, or null for an account that has never subscribed. */
  tier: string | null;
  currentPeriodEnd: string | null;
  provider: "paypal" | "payos" | null;
  storageUsedBytes: number;
  storageQuotaBytes: number;
  /** Days after a lapsed subscription before cloud files are deleted. */
  lapseGraceDays: number;
}

export const cloudSignup = (email: string, password: string) =>
  invoke<AccountStatus>("cloud_signup", { email, password });
export const cloudLogin = (email: string, password: string) =>
  invoke<AccountStatus>("cloud_login", { email, password });
export const cloudLogout = () => invoke<void>("cloud_logout");
export const getAccountStatus = () => invoke<AccountStatus | null>("get_account_status");
/**
 * Close the account and erase the cloud copies, the links to them, and the email address.
 * Irreversible. The local library is not affected.
 */
export const deleteAccount = () => invoke<void>("delete_account");
export const getPricing = () => invoke<Pricing>("get_pricing");
export const createPaypalSubscription = (tier: string, interval: PlanInterval) =>
  invoke<string>("create_paypal_subscription", { tier, interval });
export const createPayosPayment = (tier: string, interval: PlanInterval) =>
  invoke<string>("create_payos_payment", { tier, interval });

// ---- Cloud upload ----
export const uploadItem = (id: string) => invoke<MediaItem>("upload_item", { id });

// ---- Helpers ----
/** Build a webview-loadable URL for a library file, cache-busted by size. */
export async function itemSrc(item: MediaItem): Promise<string> {
  const p = await itemPath(item.id);
  return `${convertFileSrc(p)}?v=${item.sizeBytes}`;
}

/**
 * A still picture for a library card. Screenshots are their own thumbnail; recordings get a
 * poster frame extracted by ffmpeg, because a `<video>` element shows nothing until it is
 * played and left every recording looking like the same blank card.
 */
export async function previewSrc(item: MediaItem): Promise<string> {
  if (item.kind !== "recording") return itemSrc(item);
  const p = await ensureThumbnail(item.id);
  return p ? convertFileSrc(p) : "";
}

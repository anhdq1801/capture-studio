use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A single item in the capture library (a screenshot or a screen recording).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub kind: String, // "screenshot" | "recording"
    pub file_name: String,
    pub created_at: String, // human readable local time
    pub note: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Poster frame for a recording, as a file name inside the library directory. Screenshots
    /// are their own thumbnail and leave this empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb_name: Option<String>,
    /// A freshly taken capture that the user has not chosen to keep yet. Drafts are written
    /// to disk (the editor loads the image from there) but are hidden from the library and
    /// swept away on the next launch if they were never saved.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub draft: bool,
    /// Public R2 link, set once this item has been uploaded via the cloud feature.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uploaded_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
    pub is_primary: bool,
}

/// An on-screen window the user can pick for a window capture. Bounds are in physical
/// pixels in global desktop coordinates, matching `MonitorInfo`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: u32,
    pub title: String,
    pub app_name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// Stacking order; higher is closer to the front.
    pub z: i32,
}

/// Progress of an in-flight scrolling capture.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScrollStatus {
    /// Frames merged into the stitched image so far.
    pub frames: u32,
    /// Height of the stitched image in physical pixels.
    pub height: u32,
    /// Rows contributed by the most recent frame; 0 means nothing new was found.
    pub added: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeResult {
    pub original_size: u64,
    pub new_size: u64,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub item: MediaItem,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDevices {
    pub screens: Vec<DeviceEntry>,
    pub audio: Vec<DeviceEntry>,
    pub ffmpeg_available: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    pub index: String,
    pub name: String,
}

/// Options passed from the frontend to start a screen recording.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordOptions {
    /// avfoundation screen device index (macOS) — ignored on Windows.
    pub screen_index: Option<String>,
    /// audio device index/name; None = no audio.
    pub audio_device: Option<String>,
    pub fps: Option<u32>,
    pub capture_cursor: Option<bool>,
    /// optional crop region in physical pixels: [x, y, w, h]
    pub region: Option<[i32; 4]>,
    /// Override the saved codec for this recording only.
    pub codec: Option<String>,
    /// Override the saved output resolution for this recording only.
    pub resolution: Option<String>,
}

/// One image queued in the batch optimiser.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchFile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
}

/// Emitted once per file while a batch runs.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchProgress {
    pub done: u32,
    pub total: u32,
    pub name: String,
    pub original_size: u64,
    /// 0 when `error` is set.
    pub new_size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Everything persisted in `settings.json`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// "source" | "2160" | "1440" | "1080" | "720" | "480" — target output height.
    pub resolution: String,
    /// "h264" | "hevc" | "av1" | "vp9"
    pub codec: String,
    /// Languages text recognition should try, in priority order (BCP-47 tags such as
    /// `vi-VT`, `en-US`). `#[serde(default)]` so a settings file written before OCR existed
    /// still loads.
    #[serde(default = "default_ocr_languages")]
    pub ocr_languages: Vec<String>,
    /// The global shortcut for each capture action, keyed by the ids in `settings::SHORTCUTS`
    /// and written the way Tauri parses accelerators (`Control+Shift+2`).
    ///
    /// A key that is present but empty means the user deliberately unbound that action; a key
    /// that is missing entirely means they have never touched it and it keeps its shipped
    /// default. Keeping those two apart is what lets a new action arrive in a later version
    /// with its default intact, in a settings file written before it existed.
    #[serde(default = "crate::settings::default_shortcuts")]
    pub shortcuts: HashMap<String, String>,
    /// `"png"` | `"jpg"` — the file type new captures are written as.
    ///
    /// Only ever consulted when a capture is first written. Items already in the library keep
    /// the extension they were saved under, so changing this cannot invalidate the paths of
    /// files the user has already shared, linked or opened elsewhere.
    #[serde(default = "default_image_format")]
    pub image_format: String,
}

fn default_ocr_languages() -> Vec<String> {
    vec!["en-US".into()]
}

/// PNG by default: it is lossless, and a screenshot's first job is to be an exact record of
/// what was on screen. JPEG is offered for the people whose captures are headed somewhere with
/// an upload limit, as a deliberate trade rather than a silent one.
fn default_image_format() -> String {
    "png".into()
}

/// One recognised line of text.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OcrLine {
    pub text: String,
    /// 0..1 from the recogniser. Low values mark lines worth eyeballing rather than trusting.
    pub confidence: f32,
    /// Where the line sat in the image, normalised 0..1 with the origin at the bottom left —
    /// Vision's own convention, passed through rather than converted so there is one place to
    /// reason about it. Kept because a flat list of lines cannot say where a paragraph ended:
    /// that is a question about the vertical gaps between them.
    pub y: f32,
    pub height: f32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    /// Every line joined with newlines — what goes on the clipboard.
    pub text: String,
    pub lines: Vec<OcrLine>,
    /// Lines the recogniser was unsure about, so the UI can warn instead of quietly
    /// handing over text that may be wrong.
    pub low_confidence: u32,
}

/// A language the OS recogniser supports, for the settings picker.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OcrLanguage {
    /// BCP-47 tag passed back to the recogniser.
    pub id: String,
    /// Human-readable name in the user's own locale.
    pub label: String,
}

/// A video codec the installed ffmpeg can actually use, for the settings picker.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CodecOption {
    pub id: String,
    pub label: String,
    /// Container extension the codec is written into.
    pub ext: String,
    /// Whether the local ffmpeg build has an encoder for it.
    pub available: bool,
    pub note: String,
}

/// Mirrors the backend's `GET /account/status` response.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub email: String,
    pub subscription_active: bool,
    pub plan_interval: Option<String>, // "monthly" | "annual"
    /// Storage tier id ("5gb", "25gb", …), or None for an account with no subscription.
    /// Defaulted for the same reason as `lapse_grace_days`.
    #[serde(default)]
    pub tier: Option<String>,
    pub current_period_end: Option<String>,
    pub provider: Option<String>, // "paypal" | "payos"
    pub storage_used_bytes: u64,
    pub storage_quota_bytes: u64,
    /// Days after a lapsed subscription before cloud files are swept. Defaulted so an older
    /// server that doesn't send it still deserialises.
    #[serde(default)]
    pub lapse_grace_days: u32,
}

/// What one storage tier costs for one billing interval.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TierPrice {
    pub usd_cents: u32,
    /// Whole dong. VND has no minor unit, so this is not `usd_cents` in another currency.
    pub vnd_amount: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PricingTier {
    pub id: String,
    pub label: String,
    pub bytes: u64,
    pub monthly: TierPrice,
    pub annual: TierPrice,
}

/// Mirrors `GET /pricing`.
///
/// Fetched rather than compiled in: a price baked into a desktop build cannot be corrected
/// without shipping another build, and the copy the server charges is the only one that
/// counts.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Pricing {
    pub tiers: Vec<PricingTier>,
    #[serde(default)]
    pub lapse_grace_days: u32,
}

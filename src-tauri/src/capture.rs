use crate::library::{file_size, LibraryState};
use crate::models::{MediaItem, MonitorInfo, WindowInfo};
use crate::settings::SettingsState;
use base64::{engine::general_purpose::STANDARD, Engine};
use image::imageops;
use serde::Serialize;
use std::io::Cursor;
use tauri::State;
use xcap::{Monitor, Window};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenGrab {
    pub base64: String,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
}

/// Capture a full monitor into an in-memory PNG data URL (nothing saved to disk).
/// Used by the region-selection overlay as a frozen backdrop.
#[tauri::command]
pub fn grab_screen(monitor_id: Option<u32>) -> Result<ScreenGrab, String> {
    let monitor = pick_monitor(monitor_id)?;
    let img = monitor.capture_image().map_err(|e| e.to_string())?;
    let (w, h) = (img.width(), img.height());
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(ScreenGrab {
        base64: format!("data:image/png;base64,{}", STANDARD.encode(&buf)),
        width: w,
        height: h,
        scale_factor: monitor.scale_factor().unwrap_or(1.0),
    })
}

/// Put a PNG (base64 data-URL body) onto the system clipboard as an image.
#[tauri::command]
pub fn set_clipboard_png(png_base64: String) -> Result<(), String> {
    let raw = png_base64
        .split_once(',')
        .map(|(_, b)| b)
        .unwrap_or(&png_base64);
    let bytes = STANDARD.decode(raw).map_err(|e| e.to_string())?;
    let img = image::load(Cursor::new(&bytes), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    let data = arboard::ImageData {
        width: w,
        height: h,
        bytes: std::borrow::Cow::Owned(img.into_raw()),
    };
    arboard::Clipboard::new()
        .map_err(|e| e.to_string())?
        .set_image(data)
        .map_err(|e| e.to_string())
}

/// Put plain text on the clipboard. Goes through arboard like the image path rather than the
/// webview's clipboard API, which is unreliable when the window isn't focused — and after a
/// Capture Text the focused thing is whatever app the user was reading.
#[tauri::command]
pub fn set_clipboard_text(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .map_err(|e| e.to_string())?
        .set_text(text)
        .map_err(|e| e.to_string())
}

/// Import an existing image file from disk into the library.
#[tauri::command]
pub fn import_file(
    state: State<LibraryState>,
    settings: State<SettingsState>,
    path: String,
) -> Result<MediaItem, String> {
    let img = image::open(&path).map_err(|e| e.to_string())?.to_rgba8();
    save_screenshot(&state, &settings, img)
}

/// Grab an image currently on the system clipboard and add it to the library.
#[tauri::command]
pub fn import_from_clipboard(
    state: State<LibraryState>,
    settings: State<SettingsState>,
) -> Result<MediaItem, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let data = clipboard
        .get_image()
        .map_err(|_| "No image found on the clipboard".to_string())?;
    let img = image::RgbaImage::from_raw(
        data.width as u32,
        data.height as u32,
        data.bytes.into_owned(),
    )
    .ok_or_else(|| "Invalid clipboard image".to_string())?;
    save_screenshot(&state, &settings, img)
}

/// Persist a PNG (base64 data-URL body) as a new screenshot item.
#[tauri::command]
pub fn import_png(
    state: State<LibraryState>,
    settings: State<SettingsState>,
    png_base64: String,
) -> Result<MediaItem, String> {
    let raw = png_base64
        .split_once(',')
        .map(|(_, b)| b)
        .unwrap_or(&png_base64);
    let bytes = STANDARD.decode(raw).map_err(|e| e.to_string())?;
    let img = image::load(Cursor::new(&bytes), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    save_screenshot(&state, &settings, img)
}

fn now_stamp() -> (String, String) {
    let now = chrono::Local::now();
    // id-friendly + human readable
    (
        now.format("%Y%m%d-%H%M%S%3f").to_string(),
        now.format("%Y-%m-%d %H:%M:%S").to_string(),
    )
}

/// macOS reports display and window geometry in points, Windows in physical pixels. Captured
/// images are always physical pixels, and so are the crop rectangles the frontend sends back,
/// so everything crossing the IPC boundary is normalised to physical pixels here — the
/// frontend then only ever divides by `scaleFactor` to get back to CSS/logical units.
#[allow(unused_variables)]
fn to_physical(v: i64, scale_factor: f32) -> i64 {
    #[cfg(target_os = "macos")]
    {
        (v as f32 * scale_factor).round() as i64
    }
    #[cfg(not(target_os = "macos"))]
    {
        v
    }
}

#[tauri::command]
pub fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for m in monitors {
        let sf = m.scale_factor().unwrap_or(1.0);
        out.push(MonitorInfo {
            id: m.id().map_err(|e| e.to_string())?,
            name: m.name().unwrap_or_else(|_| "Display".into()),
            x: to_physical(m.x().map_err(|e| e.to_string())? as i64, sf) as i32,
            y: to_physical(m.y().map_err(|e| e.to_string())? as i64, sf) as i32,
            width: to_physical(m.width().map_err(|e| e.to_string())? as i64, sf) as u32,
            height: to_physical(m.height().map_err(|e| e.to_string())? as i64, sf) as u32,
            scale_factor: sf,
            is_primary: m.is_primary().unwrap_or(false),
        });
    }
    Ok(out)
}

/// Owners whose windows are system chrome rather than something a user would pick.
///
/// The Dock in particular owns a window the exact size of the whole desktop (it draws the
/// wallpaper and desktop icons) and it sits *above* every ordinary application window in the
/// stacking order — so without this list a front-most-first hit-test matches it everywhere
/// and every pick silently becomes a full-screen capture.
const SYSTEM_OWNERS: &[&str] = &[
    "Dock",
    "Window Server",
    "Control Center",
    "Notification Center",
    "SystemUIServer",
    "Spotlight",
];

/// Titles of the auxiliary windows this app puts on screen during a capture.
///
/// Matched by title rather than by app name so the main window survives the filter. Kept in
/// step with the `title:` given to each `WebviewWindow` in `src/lib/*.ts`.
const OWN_HELPER_TITLES: &[&str] = &[
    "Select region",  // lib/overlay.ts
    "Recording",      // lib/stopbar.ts
    "Scrolling capture", // lib/scrollbar.ts
    "Selected area",  // lib/regionhint.ts
];

fn is_own_helper(app_name: &str, title: &str) -> bool {
    let ours = app_name == "capture-studio" || app_name == "Capture Studio";
    ours && OWN_HELPER_TITLES.contains(&title)
}

/// Windows the user could plausibly want to capture, front-most first.
///
/// The raw list from the OS is noisy — it includes menu-bar extras, the wallpaper layer and
/// zero-size helper windows — so anything untitled, minimized, tiny, system-owned, or one of
/// our own capture overlays is dropped before it reaches the picker.
#[tauri::command]
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let windows = Window::all().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for w in windows {
        if w.is_minimized().unwrap_or(false) {
            continue;
        }
        let (width, height) = (w.width().unwrap_or(0), w.height().unwrap_or(0));
        if width < 80 || height < 80 {
            continue;
        }
        let app_name = w.app_name().unwrap_or_default();
        let title = w.title().unwrap_or_default();
        if title.trim().is_empty() && app_name.trim().is_empty() {
            continue;
        }
        if SYSTEM_OWNERS.contains(&app_name.as_str()) {
            continue;
        }
        // Skip our own *helper* windows — the crosshair overlays, the recording stop bar, the
        // scrolling controls, the selected-area outline. They sit above everything and would
        // always win the hover hit-test, making every other window unpickable.
        //
        // The main window is deliberately left in the list. Capturing Capture Studio itself is
        // a reasonable thing to want (documentation, a bug report), and this path — xcap's
        // per-window capture — renders it correctly, unlike grabbing it out of a whole-monitor
        // screenshot. Excluding the whole app by name made that impossible.
        if is_own_helper(&app_name, &title) {
            continue;
        }
        // Window geometry comes back in the same units as its display's, so normalise it
        // against that display's scale factor rather than the primary's.
        let sf = w
            .current_monitor()
            .and_then(|m| m.scale_factor())
            .unwrap_or(1.0);
        out.push(WindowInfo {
            id: w.id().map_err(|e| e.to_string())?,
            title,
            app_name,
            x: to_physical(w.x().unwrap_or(0) as i64, sf) as i32,
            y: to_physical(w.y().unwrap_or(0) as i64, sf) as i32,
            width: to_physical(width as i64, sf) as u32,
            height: to_physical(height as i64, sf) as u32,
            z: w.z().unwrap_or(0),
        });
    }
    // Front-most first, so a hover hit-test can take the first match it finds.
    out.sort_by(|a, b| b.z.cmp(&a.z));
    Ok(out)
}

/// Capture a single window by the id reported from `list_windows`.
#[tauri::command]
pub fn capture_window(
    state: State<LibraryState>,
    settings: State<SettingsState>,
    window_id: u32,
) -> Result<MediaItem, String> {
    let windows = Window::all().map_err(|e| e.to_string())?;
    let target = windows
        .into_iter()
        .find(|w| w.id().map(|id| id == window_id).unwrap_or(false))
        .ok_or_else(|| "That window is no longer open".to_string())?;
    let img = target.capture_image().map_err(|e| e.to_string())?;
    save_draft(&state, &settings, img)
}

fn pick_monitor(monitor_id: Option<u32>) -> Result<Monitor, String> {
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    if let Some(id) = monitor_id {
        for m in &monitors {
            if m.id().map_err(|e| e.to_string())? == id {
                return Ok(m.clone());
            }
        }
    }
    // primary, else first
    for m in &monitors {
        if m.is_primary().unwrap_or(false) {
            return Ok(m.clone());
        }
    }
    monitors.into_iter().next().ok_or_else(|| "No monitor found".into())
}

/// JPEG quality for saved captures.
///
/// Screenshots are the worst case for JPEG: flat colour and small text, where ringing shows up
/// around glyph edges long before it would on a photograph. 92 keeps those artefacts invisible
/// at 1:1 while still cutting a typical capture to a fraction of its PNG size.
///
/// Fixed rather than exposed as a slider. The place to trade quality for bytes is the image
/// optimiser, which already has one and can be re-run against the saved file; a capture is
/// written once, and a quality setting that is too low is discovered only after the original
/// pixels are gone.
const JPEG_QUALITY: u8 = 92;

/// Which extension `format` means, ignoring anything unrecognised.
///
/// A settings file is a text file a user can edit, and an unknown value there must not cost
/// them the capture they just took — so it falls back to the lossless default rather than
/// erroring.
fn extension_for(format: &str) -> &'static str {
    if format.eq_ignore_ascii_case("jpg") || format.eq_ignore_ascii_case("jpeg") {
        "jpg"
    } else {
        "png"
    }
}

/// Encode a capture for writing to disk in the user's chosen format.
///
/// JPEG has no alpha channel and the `image` crate refuses RGBA input rather than guessing what
/// to do with it. Captures really do arrive with transparency — a window grab keeps the rounded
/// corners cut out — so the pixels are flattened first. Onto white, because a transparent corner
/// is a hole in a screenshot: white reads as paper, black reads as a rendering fault.
fn encode_image(img: &image::RgbaImage, ext: &str) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    if ext == "jpg" {
        let mut rgb = image::RgbImage::new(img.width(), img.height());
        for (x, y, px) in img.enumerate_pixels() {
            let a = px[3] as u32;
            // Straight alpha over white, rounded rather than truncated so a fully opaque pixel
            // survives the round trip unchanged.
            let over = |c: u8| ((c as u32 * a + 255 * (255 - a) + 127) / 255) as u8;
            rgb.put_pixel(x, y, image::Rgb([over(px[0]), over(px[1]), over(px[2])]));
        }
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY)
            .encode_image(&image::DynamicImage::ImageRgb8(rgb))
            .map_err(|e| e.to_string())?;
    } else {
        image::DynamicImage::ImageRgba8(img.clone())
            .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
    }
    Ok(buf)
}

/// The format new captures are saved in. Read and released before the library lock is taken,
/// so the two are never held at once.
fn chosen_extension(settings: &State<SettingsState>) -> &'static str {
    let format = settings
        .lock()
        .map(|s| s.image_format.clone())
        .unwrap_or_else(|_| "png".into());
    extension_for(&format)
}

fn save_screenshot(
    state: &State<LibraryState>,
    settings: &State<SettingsState>,
    img: image::RgbaImage,
) -> Result<MediaItem, String> {
    save_image(state, settings, img, false)
}

/// Same, but marked as a draft: written to disk so the editor can open it, yet kept out of
/// the library until the user actually saves it.
fn save_draft(
    state: &State<LibraryState>,
    settings: &State<SettingsState>,
    img: image::RgbaImage,
) -> Result<MediaItem, String> {
    save_image(state, settings, img, true)
}

fn save_image(
    state: &State<LibraryState>,
    settings: &State<SettingsState>,
    img: image::RgbaImage,
    draft: bool,
) -> Result<MediaItem, String> {
    let (id, created) = now_stamp();
    let ext = chosen_extension(settings);
    let file_name = format!("shot-{id}.{ext}");
    let (w, h) = (img.width(), img.height());

    // Encoded before the library lock is taken: JPEG on a 6K screenshot is tens of milliseconds
    // that every other library operation would otherwise wait on.
    let bytes = encode_image(&img, ext)?;

    let mut lib = state.lock().map_err(|e| e.to_string())?;
    let path = lib.path_of(&file_name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;

    let item = MediaItem {
        id: id.clone(),
        kind: "screenshot".into(),
        file_name,
        created_at: created,
        note: String::new(),
        width: w,
        height: h,
        size_bytes: file_size(&path),
        duration_ms: None,
        thumb_name: None,
        draft,
        cloud_url: None,
        uploaded_at: None,
    };
    lib.add(item.clone());
    Ok(item)
}

#[tauri::command]
pub fn capture_monitor(
    state: State<LibraryState>,
    settings: State<SettingsState>,
    monitor_id: Option<u32>,
) -> Result<MediaItem, String> {
    let monitor = pick_monitor(monitor_id)?;
    let img = monitor.capture_image().map_err(|e| e.to_string())?;
    save_draft(&state, &settings, img)
}

/// Grab one region of a monitor into memory without touching the library.
/// Shared with the scrolling capture, which re-grabs the same rectangle many times.
pub fn capture_region_image(
    monitor_id: Option<u32>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<image::RgbaImage, String> {
    let monitor = pick_monitor(monitor_id)?;
    let full = monitor.capture_image().map_err(|e| e.to_string())?;
    // Clamp to bounds to avoid panics.
    let x = x.min(full.width().saturating_sub(1));
    let y = y.min(full.height().saturating_sub(1));
    let w = width.min(full.width() - x);
    let h = height.min(full.height() - y);
    Ok(imageops::crop_imm(&full, x, y, w, h).to_image())
}

/// `save_draft` for other modules — the scrolling capture builds its image itself and only
/// needs the library-writing half.
pub fn save_draft_public(
    state: &State<LibraryState>,
    settings: &State<SettingsState>,
    img: image::RgbaImage,
) -> Result<MediaItem, String> {
    save_draft(state, settings, img)
}

/// Capture a rectangular region (physical pixels, relative to the monitor origin).
#[tauri::command]
pub fn capture_region(
    state: State<LibraryState>,
    settings: State<SettingsState>,
    monitor_id: Option<u32>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<MediaItem, String> {
    if width == 0 || height == 0 {
        return Err("Empty selection".into());
    }
    let cropped = capture_region_image(monitor_id, x, y, width, height)?;
    save_draft(&state, &settings, cropped)
}

/// Save an annotated PNG (base64 data-URL body) back over an existing item.
#[tauri::command]
pub fn save_annotated(
    state: State<LibraryState>,
    id: String,
    png_base64: String,
) -> Result<MediaItem, String> {
    let raw = png_base64
        .split_once(",")
        .map(|(_, b)| b)
        .unwrap_or(&png_base64);
    let bytes = STANDARD.decode(raw).map_err(|e| e.to_string())?;
    let img = image::load(Cursor::new(&bytes), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let (w, h) = (img.width(), img.height());

    let file_name = {
        let lib = state.lock().map_err(|e| e.to_string())?;
        let item = lib.get(&id).ok_or_else(|| "Item not found".to_string())?;
        item.file_name.clone()
    };

    // The canvas can only hand back a PNG, but the file on disk keeps whatever extension it was
    // created with — writing these bytes into a `.jpg` would leave a file whose name lies about
    // its contents, which every other tool that opens it by extension would then get wrong. So
    // re-encode when the two differ, and take the fast path when they don't.
    let ext = file_name.rsplit('.').next().unwrap_or("");
    let out = if extension_for(ext) == "jpg" {
        encode_image(&img.to_rgba8(), "jpg")?
    } else {
        bytes
    };

    let mut lib = state.lock().map_err(|e| e.to_string())?;
    // Existence is re-checked under this lock, not the one that read the file name: the encode
    // above happens with the library unlocked, and writing the file back for an item deleted in
    // the meantime would leave an orphan on disk that nothing in the library points at.
    if lib.get(&id).is_none() {
        return Err("Item not found".into());
    }
    let path = lib.path_of(&file_name);
    std::fs::write(&path, &out).map_err(|e| e.to_string())?;
    let size = file_size(&path);
    lib.update(&id, |it| {
        it.width = w;
        it.height = h;
        it.size_bytes = size;
        // Saving is what promotes a freshly taken capture into the library.
        it.draft = false;
    })
    .ok_or_else(|| "Update failed".to_string())
}

/// Keep a draft capture without editing it — the "Save" path when nothing was annotated.
#[tauri::command]
pub fn keep_item(state: State<LibraryState>, id: String) -> Result<MediaItem, String> {
    let mut lib = state.lock().map_err(|e| e.to_string())?;
    lib.update(&id, |it| it.draft = false)
        .ok_or_else(|| "Item not found".to_string())
}


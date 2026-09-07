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

/// Put a library item on the clipboard as an image.
///
/// Separate from `set_clipboard_png` because that one takes a base64 data URL, which would mean
/// reading the file in the webview and shipping a whole screenshot across the IPC boundary as
/// text — roughly a third bigger than the bytes it encodes — only to be decoded again here.
/// The file is already on disk and this side can read it.
#[tauri::command]
pub fn copy_item(state: State<LibraryState>, id: String) -> Result<(), String> {
    let path = {
        let lib = state.lock().map_err(|e| e.to_string())?;
        let item = lib.get(&id).ok_or_else(|| "Item not found".to_string())?;
        lib.path_of(&item.file_name)
    };
    let img = image::open(&path).map_err(|e| e.to_string())?.to_rgba8();
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
    // macOS's own screenshot service. It keeps an untitled window the size of the whole display
    // at the very top of the stacking order, so a front-most-first hit-test matched it before
    // anything else and every window pick silently became a full-screen one.
    "Screenshot",
    "Screenshot App",
    "Wallpaper",
    "ScreenSaverEngine",
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

/// Is this a backdrop layer rather than a window anyone means to pick?
///
/// Kept as a plain function of the values so it can be tested against the real numbers a
/// misbehaving system process produced, without needing a live window to hand.
///
/// Two rules. The name list catches the ones already known by name. The second catches the next
/// one whatever it turns out to be called: an **untitled** window that covers a whole display.
/// The missing title is what makes that safe — a browser in fullscreen also matches a display's
/// bounds exactly, and it always has a title.
///
/// `monitor` is the window's *own* display, not the primary: on a mixed-resolution setup those
/// differ, and a backdrop on the second screen would otherwise sail straight through.
fn is_backdrop(app_name: &str, title: &str, w: u32, h: u32, monitor: Option<(u32, u32)>) -> bool {
    if SYSTEM_OWNERS.contains(&app_name) {
        return true;
    }
    title.trim().is_empty() && monitor.is_some_and(|(mw, mh)| w >= mw && h >= mh)
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
        let own_monitor = w
            .current_monitor()
            .ok()
            .and_then(|m| Some((m.width().ok()?, m.height().ok()?)));
        if is_backdrop(&app_name, &title, width, height, own_monitor) {
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

/// Every display at once, laid out the way the desktop actually arranges them.
///
/// Not a horizontal strip of screenshots: displays sit at their real desktop coordinates, so a
/// monitor mounted above another comes out above it, and a stack of unequal heights keeps its
/// offsets. Anything not covered by a display — the L-shaped gaps an uneven arrangement leaves
/// — is filled rather than left transparent, since the saved format may be JPEG.
///
/// Each display is grabbed in turn, so this is not a single instant across all of them. There is
/// no API that grabs several displays atomically, and pretending otherwise by grabbing them
/// closer together would not change that.
#[tauri::command]
pub fn capture_all_monitors(
    state: State<LibraryState>,
    settings: State<SettingsState>,
) -> Result<MediaItem, String> {
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("No displays found.".into());
    }

    let mut shots: Vec<(i64, i64, image::RgbaImage)> = Vec::new();
    for m in &monitors {
        let sf = m.scale_factor().unwrap_or(1.0);
        let x = to_physical(m.x().map_err(|e| e.to_string())? as i64, sf);
        let y = to_physical(m.y().map_err(|e| e.to_string())? as i64, sf);
        // One unreadable display should not lose the others: a disconnected or asleep monitor
        // can still be listed while its capture fails.
        if let Ok(img) = m.capture_image() {
            shots.push((x, y, img));
        }
    }
    if shots.is_empty() {
        return Err("None of the displays could be captured.".into());
    }

    let min_x = shots.iter().map(|(x, _, _)| *x).min().unwrap_or(0);
    let min_y = shots.iter().map(|(_, y, _)| *y).min().unwrap_or(0);
    let max_x = shots
        .iter()
        .map(|(x, _, i)| x + i.width() as i64)
        .max()
        .unwrap_or(0);
    let max_y = shots
        .iter()
        .map(|(_, y, i)| y + i.height() as i64)
        .max()
        .unwrap_or(0);
    let (w, h) = ((max_x - min_x) as u32, (max_y - min_y) as u32);
    if w == 0 || h == 0 {
        return Err("The displays reported no usable area.".into());
    }

    let mut sheet = image::RgbaImage::from_pixel(w, h, SHEET_BG);
    for (x, y, img) in &shots {
        imageops::replace(&mut sheet, img, x - min_x, y - min_y);
    }
    save_draft(&state, &settings, sheet)
}

/// One rectangle of a multi-region capture, in this monitor's physical pixels.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// The backdrop a stitched sheet is laid out on.
///
/// The same value the annotation editor puts behind a canvas, so a sheet opened in the editor
/// sits on its own colour rather than on a slightly different grey. Opaque rather than
/// transparent because the saved format may be JPEG, which has no alpha to be transparent in.
const SHEET_BG: image::Rgba<u8> = image::Rgba([0x2b, 0x2f, 0x38, 0xff]);

/// Gap between regions on a stitched sheet, in pixels of the captured image.
const SHEET_GAP: u32 = 16;

/// Lay several crops out as one image: stacked vertically, left-aligned, on a flat backdrop.
///
/// Vertical and left-aligned because the crops are arbitrary sizes — a row would leave short
/// ones floating in a band of background, and a grid would mean guessing a column count that is
/// wrong for most selections. Reading order down the page is the one arrangement that survives
/// any mix of shapes.
///
/// Order is the order they were drawn in, deliberately not re-sorted by position: that order is
/// the only thing the user actually chose, and re-sorting would silently discard it.
fn stitch_sheet(crops: &[image::RgbaImage]) -> Result<image::RgbaImage, String> {
    let width = crops.iter().map(|c| c.width()).max().unwrap_or(0);
    let height: u32 = crops.iter().map(|c| c.height()).sum::<u32>()
        + SHEET_GAP * (crops.len().saturating_sub(1)) as u32;
    if width == 0 || height == 0 {
        return Err("Empty selection".into());
    }
    let mut sheet = image::RgbaImage::from_pixel(width, height, SHEET_BG);
    let mut y = 0;
    for crop in crops {
        imageops::replace(&mut sheet, crop, 0, y as i64);
        y += crop.height() + SHEET_GAP;
    }
    Ok(sheet)
}

/// Capture several regions of one monitor in a single grab.
///
/// The monitor is grabbed **once** and cropped N times. Calling `capture_region` in a loop would
/// re-grab the screen for every rectangle, which is both the slow part and — because the shots
/// would be milliseconds apart — a way to catch a moving cursor or a mid-animation frame in some
/// of the crops but not others. One grab makes the set genuinely simultaneous.
///
/// Saved non-draft, unlike the single-region path: drafts exist so the annotation editor can
/// open a capture before it is committed, and are pruned at startup if nothing commits them.
/// Nothing opens the editor here (N editors for one gesture is not a UI), so these have to be
/// real library entries from the moment they are written.
#[tauri::command]
pub fn capture_regions(
    state: State<LibraryState>,
    settings: State<SettingsState>,
    monitor_id: Option<u32>,
    rects: Vec<RegionRect>,
    combine: bool,
) -> Result<Vec<MediaItem>, String> {
    if rects.is_empty() {
        return Err("Empty selection".into());
    }
    let monitor = pick_monitor(monitor_id)?;
    let full = monitor.capture_image().map_err(|e| e.to_string())?;

    let mut crops: Vec<image::RgbaImage> = Vec::with_capacity(rects.len());
    for r in &rects {
        // Clamped rather than rejected: a drag that ended a pixel past the edge of the display
        // is a selection the user meant, not an error worth throwing the whole set away for.
        let x = r.x.min(full.width().saturating_sub(1));
        let y = r.y.min(full.height().saturating_sub(1));
        let w = r.width.min(full.width() - x);
        let h = r.height.min(full.height() - y);
        if w == 0 || h == 0 {
            continue;
        }
        crops.push(imageops::crop_imm(&full, x, y, w, h).to_image());
    }
    if crops.is_empty() {
        return Err("Empty selection".into());
    }

    if combine {
        return Ok(vec![save_image(&state, &settings, stitch_sheet(&crops)?, false)?]);
    }
    crops
        .into_iter()
        .map(|c| save_image(&state, &settings, c, false))
        .collect()
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


#[cfg(test)]
mod tests {
    use super::*;

    fn img(w: u32, h: u32, fill: u8) -> image::RgbaImage {
        image::RgbaImage::from_pixel(w, h, image::Rgba([fill, fill, fill, 0xff]))
    }

    #[test]
    fn sheet_is_as_wide_as_its_widest_crop() {
        let sheet = stitch_sheet(&[img(40, 10, 1), img(120, 10, 2), img(80, 10, 3)]).unwrap();
        assert_eq!(sheet.width(), 120);
    }

    #[test]
    fn gaps_go_between_crops_and_not_after_the_last() {
        // Three 10px-tall crops: 30px of content plus two gaps, never three.
        let sheet = stitch_sheet(&[img(20, 10, 1), img(20, 10, 2), img(20, 10, 3)]).unwrap();
        assert_eq!(sheet.height(), 30 + SHEET_GAP * 2);
    }

    #[test]
    fn a_single_crop_gets_no_gap_at_all() {
        let sheet = stitch_sheet(&[img(20, 10, 1)]).unwrap();
        assert_eq!((sheet.width(), sheet.height()), (20, 10));
    }

    #[test]
    fn crops_keep_their_order_and_their_pixels() {
        let sheet = stitch_sheet(&[img(20, 10, 0x11), img(20, 10, 0x22)]).unwrap();
        // First crop at the top, second below it past one gap.
        assert_eq!(sheet.get_pixel(0, 0)[0], 0x11);
        assert_eq!(sheet.get_pixel(0, 10 + SHEET_GAP)[0], 0x22);
        // The gap itself is backdrop, not a smear of either crop.
        assert_eq!(*sheet.get_pixel(0, 10), SHEET_BG);
    }

    #[test]
    fn narrow_crops_sit_on_backdrop_rather_than_being_stretched() {
        let sheet = stitch_sheet(&[img(20, 10, 0x11), img(60, 10, 0x22)]).unwrap();
        // Right of the narrow crop's own width, on its row.
        assert_eq!(*sheet.get_pixel(40, 5), SHEET_BG);
    }

    #[test]
    fn nothing_to_stitch_is_an_error_not_a_zero_sized_image() {
        assert!(stitch_sheet(&[]).is_err());
    }

    /// The exact window that made every window pick record the whole screen.
    ///
    /// macOS's screenshot service keeps an untitled, display-sized window at the very top of
    /// the stacking order. It has an app name, so the "untitled" check — which required the app
    /// name to be empty too — let it through, and a front-most-first hit-test then matched it
    /// before any real window no matter where the user clicked.
    #[test]
    fn the_screenshot_services_full_screen_layer_is_not_pickable() {
        assert!(is_backdrop("Screenshot", "", 3840, 2160, Some((3840, 2160))));
    }

    #[test]
    fn an_untitled_display_sized_layer_is_dropped_whatever_it_is_called() {
        assert!(is_backdrop("SomethingNewApple.app", "", 3840, 2160, Some((3840, 2160))));
    }

    #[test]
    fn a_fullscreen_app_window_is_still_pickable_because_it_has_a_title() {
        assert!(!is_backdrop("Google Chrome", "Releases · x", 3840, 2160, Some((3840, 2160))));
    }

    #[test]
    fn an_ordinary_untitled_window_smaller_than_its_display_survives() {
        assert!(!is_backdrop("Preview", "", 1200, 800, Some((3840, 2160))));
    }

    #[test]
    fn a_backdrop_is_judged_against_its_own_display_not_the_biggest_one() {
        // 1920x1080 covers a 1920x1080 second screen even though the main one is 4K.
        assert!(is_backdrop("Wallpaper2", "", 1920, 1080, Some((1920, 1080))));
    }

    #[test]
    fn a_window_on_no_known_display_is_kept_rather_than_guessed_away() {
        assert!(!is_backdrop("Preview", "", 3840, 2160, None));
    }
}

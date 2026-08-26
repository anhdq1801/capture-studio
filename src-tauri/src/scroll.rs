//! Scrolling capture: stitch a tall image out of repeated grabs of one fixed region while
//! the user scrolls the content underneath it.
//!
//! The frontend drives the loop — it starts a session, then polls `scroll_step` on a timer
//! while the user scrolls, and finally calls `scroll_finish`. Each step re-grabs the region
//! and works out how far the content moved by matching a strip from the bottom of what has
//! been stitched so far against the new frame, then appends only the rows below that match.

use crate::capture::{capture_region_image, save_draft_public};
use crate::library::LibraryState;
use crate::models::{MediaItem, ScrollStatus};
use image::RgbaImage;
use std::sync::Mutex;
use tauri::State;

/// Refuse to grow past this many rows, so a runaway session can't exhaust memory.
const MAX_HEIGHT: u32 = 32_000;
/// How many rows from the bottom of the stitched image are used as the match template.
const NEEDLE_ROWS: u32 = 72;
/// Mean per-channel difference (0-255) below which a candidate offset counts as a match.
/// Scrolled content re-renders almost identically, so a genuine match scores very low;
/// this leaves room for subpixel text rendering and compression-like noise.
const MATCH_THRESHOLD: f32 = 9.0;

pub struct ScrollSession {
    monitor_id: Option<u32>,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    stitched: RgbaImage,
    frames: u32,
}

pub type ScrollState = Mutex<Option<ScrollSession>>;

/// Average absolute channel difference between the bottom `rows` of `top` and the band of
/// `bottom` starting at `at`. Sampled rather than exhaustive — comparing every pixel of a
/// Retina-sized region on every candidate offset is far too slow to run on a timer.
fn band_diff(top: &RgbaImage, bottom: &RgbaImage, rows: u32, at: u32) -> f32 {
    let w = top.width().min(bottom.width());
    let x_step = (w / 160).max(1);
    let y_step = (rows / 18).max(1);
    let top_start = top.height() - rows;

    let mut total: u64 = 0;
    let mut count: u64 = 0;
    let mut dy = 0;
    while dy < rows {
        let ty = top_start + dy;
        let by = at + dy;
        let mut x = 0;
        while x < w {
            let tp = top.get_pixel(x, ty).0;
            let bp = bottom.get_pixel(x, by).0;
            total += (tp[0] as i32 - bp[0] as i32).unsigned_abs() as u64
                + (tp[1] as i32 - bp[1] as i32).unsigned_abs() as u64
                + (tp[2] as i32 - bp[2] as i32).unsigned_abs() as u64;
            count += 3;
            x += x_step;
        }
        dy += y_step;
    }
    if count == 0 {
        return f32::MAX;
    }
    total as f32 / count as f32
}

/// Merge `frame` into `stitched`, returning how many new rows it contributed.
///
/// Returns 0 both when the user hasn't scrolled (the frame is already fully covered) and
/// when no overlap could be found at all — the caller can't act differently on those two
/// cases anyway, it just keeps polling.
fn append_frame(stitched: &mut RgbaImage, frame: &RgbaImage) -> u32 {
    if frame.width() != stitched.width() {
        return 0;
    }
    let rows = NEEDLE_ROWS.min(stitched.height()).min(frame.height() / 2);
    if rows == 0 {
        return 0;
    }

    let mut best = (f32::MAX, 0u32);
    let limit = frame.height() - rows;
    for at in 0..=limit {
        let d = band_diff(stitched, frame, rows, at);
        if d < best.0 {
            best = (d, at);
        }
        // An exact match can't be beaten, so stop hunting.
        if d == 0.0 {
            break;
        }
    }
    if best.0 > MATCH_THRESHOLD {
        return 0;
    }

    let new_rows = frame.height() - (best.1 + rows);
    if new_rows == 0 {
        return 0;
    }
    let old_h = stitched.height();
    if old_h + new_rows > MAX_HEIGHT {
        return 0;
    }

    let mut grown = RgbaImage::new(stitched.width(), old_h + new_rows);
    for y in 0..old_h {
        for x in 0..stitched.width() {
            grown.put_pixel(x, y, *stitched.get_pixel(x, y));
        }
    }
    let src_start = best.1 + rows;
    for dy in 0..new_rows {
        for x in 0..stitched.width() {
            grown.put_pixel(x, old_h + dy, *frame.get_pixel(x, src_start + dy));
        }
    }
    *stitched = grown;
    new_rows
}

#[tauri::command]
pub fn scroll_start(
    scroll: State<ScrollState>,
    monitor_id: Option<u32>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<ScrollStatus, String> {
    if width == 0 || height == 0 {
        return Err("Empty selection".into());
    }
    let first = capture_region_image(monitor_id, x, y, width, height)?;
    let status = ScrollStatus {
        frames: 1,
        height: first.height(),
        added: first.height(),
    };
    let mut guard = scroll.lock().map_err(|e| e.to_string())?;
    *guard = Some(ScrollSession {
        monitor_id,
        x,
        y,
        w: width,
        h: height,
        stitched: first,
        frames: 1,
    });
    Ok(status)
}

/// Grab the region again and merge whatever is new into the stitched image.
#[tauri::command]
pub fn scroll_step(scroll: State<ScrollState>) -> Result<ScrollStatus, String> {
    let (monitor_id, x, y, w, h) = {
        let guard = scroll.lock().map_err(|e| e.to_string())?;
        let s = guard
            .as_ref()
            .ok_or_else(|| "No scrolling capture in progress".to_string())?;
        (s.monitor_id, s.x, s.y, s.w, s.h)
    };
    // Grab outside the lock: the capture is the slow part and holding the mutex across it
    // would stall `scroll_finish`/`scroll_cancel` behind it.
    let frame = capture_region_image(monitor_id, x, y, w, h)?;

    let mut guard = scroll.lock().map_err(|e| e.to_string())?;
    let s = guard
        .as_mut()
        .ok_or_else(|| "No scrolling capture in progress".to_string())?;
    let added = append_frame(&mut s.stitched, &frame);
    if added > 0 {
        s.frames += 1;
    }
    Ok(ScrollStatus {
        frames: s.frames,
        height: s.stitched.height(),
        added,
    })
}

#[tauri::command]
pub fn scroll_finish(
    lib: State<LibraryState>,
    settings: State<crate::settings::SettingsState>,
    scroll: State<ScrollState>,
) -> Result<MediaItem, String> {
    let session = {
        let mut guard = scroll.lock().map_err(|e| e.to_string())?;
        guard
            .take()
            .ok_or_else(|| "No scrolling capture in progress".to_string())?
    };
    save_draft_public(&lib, &settings, session.stitched)
}

#[tauri::command]
pub fn scroll_cancel(scroll: State<ScrollState>) -> Result<(), String> {
    let mut guard = scroll.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

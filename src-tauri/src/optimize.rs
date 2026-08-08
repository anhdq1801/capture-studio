use crate::library::{file_size, LibraryState};
use crate::models::{BatchFile, BatchProgress, MediaItem, OptimizeResult};
use image::imageops::FilterType;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use tauri::{Emitter, State};

/// Extensions the batch optimiser will pick up when scanning a folder.
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"];

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Downscale (never upscale) and re-encode one image. Shared by the single-item optimiser
/// and the batch tool so both always produce identical output for identical settings.
fn encode(
    img: image::DynamicImage,
    format: &str,
    quality: u8,
    max_width: Option<u32>,
) -> Result<(Vec<u8>, &'static str, u32, u32), String> {
    let mut img = img;
    if let Some(mw) = max_width {
        if img.width() > mw {
            let ratio = mw as f32 / img.width() as f32;
            let nh = (img.height() as f32 * ratio).round() as u32;
            img = img.resize(mw, nh.max(1), FilterType::Lanczos3);
        }
    }
    let (w, h) = (img.width(), img.height());
    let q = quality.clamp(1, 100);
    let (bytes, ext): (Vec<u8>, &'static str) = match format {
        "webp" => {
            let encoder = webp::Encoder::from_image(&img).map_err(|e| e.to_string())?;
            (encoder.encode(q as f32).to_vec(), "webp")
        }
        "jpeg" | "jpg" => {
            let rgb = img.to_rgb8();
            let mut buf = Vec::new();
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, q);
            enc.encode_image(&rgb).map_err(|e| e.to_string())?;
            (buf, "jpg")
        }
        "png" => {
            let mut raw = Vec::new();
            img.write_to(&mut Cursor::new(&mut raw), image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            let opts = oxipng::Options::from_preset(4);
            let optimized =
                oxipng::optimize_from_memory(&raw, &opts).map_err(|e| e.to_string())?;
            (optimized, "png")
        }
        other => return Err(format!("Unsupported format: {other}")),
    };
    Ok((bytes, ext, w, h))
}

/// Expand the user's picks into a concrete file list: files are taken as-is, folders are
/// walked recursively, and anything that isn't an image is dropped.
#[tauri::command]
pub fn scan_images(paths: Vec<String>) -> Result<Vec<BatchFile>, String> {
    let mut out: Vec<BatchFile> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    fn walk(dir: &Path, out: &mut Vec<BatchFile>, seen: &mut std::collections::HashSet<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                walk(&p, out, seen);
            } else if is_image(&p) {
                push(&p, out, seen);
            }
        }
    }

    fn push(p: &Path, out: &mut Vec<BatchFile>, seen: &mut std::collections::HashSet<PathBuf>) {
        let canonical = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        if !seen.insert(canonical) {
            return;
        }
        out.push(BatchFile {
            path: p.to_string_lossy().to_string(),
            name: p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            size_bytes: file_size(p),
        });
    }

    for raw in paths {
        let p = PathBuf::from(&raw);
        if p.is_dir() {
            walk(&p, &mut out, &mut seen);
        } else if is_image(&p) {
            push(&p, &mut out, &mut seen);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Pick a free filename in `dir`, so a batch never silently overwrites its own output or
/// something already sitting in the destination folder.
fn free_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.{ext}"));
    let mut n = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}-{n}.{ext}"));
        n += 1;
    }
    candidate
}

/// Re-encode many images into `out_dir`, reporting progress as it goes.
///
/// Returns immediately and does the work on its own thread: encoding hundreds of images is
/// far too slow to block the command, and the UI needs per-file progress rather than one
/// long freeze followed by a result.
#[tauri::command]
pub fn optimize_files(
    app: tauri::AppHandle,
    files: Vec<String>,
    out_dir: String,
    format: String,
    quality: u8,
    max_width: Option<u32>,
) -> Result<(), String> {
    let out = PathBuf::from(&out_dir);
    std::fs::create_dir_all(&out).map_err(|e| format!("Cannot use that output folder: {e}"))?;

    std::thread::spawn(move || {
        let total = files.len() as u32;
        for (i, f) in files.iter().enumerate() {
            let src = PathBuf::from(f);
            let name = src
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let original_size = file_size(&src);

            let result = image::open(&src)
                .map_err(|e| e.to_string())
                .and_then(|img| encode(img, &format, quality, max_width))
                .and_then(|(bytes, ext, _, _)| {
                    let stem = src
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| "image".into());
                    let dest = free_path(&out, &stem, ext);
                    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
                    Ok(file_size(&dest))
                });

            let progress = match result {
                Ok(new_size) => BatchProgress {
                    done: i as u32 + 1,
                    total,
                    name,
                    original_size,
                    new_size,
                    error: None,
                },
                Err(e) => BatchProgress {
                    done: i as u32 + 1,
                    total,
                    name,
                    original_size,
                    new_size: 0,
                    error: Some(e),
                },
            };
            let _ = app.emit("optimize-progress", progress);
        }
        let _ = app.emit("optimize-done", total);
    });
    Ok(())
}

/// Re-encode an existing screenshot to shrink its file size.
///
/// `format`  = "webp" | "jpeg" | "png"
/// `quality` = 1..=100 (ignored for lossless png)
/// `max_width` = optional downscale cap (keeps aspect ratio)
/// `replace` = overwrite the original item, else create a new copy
#[tauri::command]
pub fn optimize_image(
    state: State<LibraryState>,
    id: String,
    format: String,
    quality: u8,
    max_width: Option<u32>,
    replace: bool,
) -> Result<OptimizeResult, String> {
    let (src_path, src_item, dir) = {
        let lib = state.lock().map_err(|e| e.to_string())?;
        let item = lib.get(&id).ok_or_else(|| "Item not found".to_string())?;
        (lib.path_of(&item.file_name), item, lib.dir.clone())
    };
    let original_size = file_size(&src_path);

    let img = image::open(&src_path).map_err(|e| e.to_string())?;
    let (bytes, ext, w, h) = encode(img, &format, quality, max_width)?;

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%3f").to_string();
    let base = src_item
        .file_name
        .rsplit_once('.')
        .map(|(b, _)| b.to_string())
        .unwrap_or_else(|| src_item.file_name.clone());
    let out_name = if replace {
        format!("{base}.{ext}")
    } else {
        format!("{base}-opt-{stamp}.{ext}")
    };
    let out_path = dir.join(&out_name);
    std::fs::write(&out_path, &bytes).map_err(|e| e.to_string())?;
    let new_size = file_size(&out_path);

    let mut lib = state.lock().map_err(|e| e.to_string())?;
    let item = if replace {
        // remove old file if the name/extension changed
        if src_item.file_name != out_name {
            let _ = std::fs::remove_file(dir.join(&src_item.file_name));
        }
        lib.update(&id, |it| {
            it.file_name = out_name.clone();
            it.width = w;
            it.height = h;
            it.size_bytes = new_size;
        })
        .ok_or_else(|| "Update failed".to_string())?
    } else {
        let new_item = MediaItem {
            id: format!("opt-{stamp}"),
            kind: "screenshot".into(),
            file_name: out_name.clone(),
            created_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            note: src_item.note.clone(),
            width: w,
            height: h,
            size_bytes: new_size,
            duration_ms: None,
            thumb_name: None,
            draft: false,
            cloud_url: None,
            uploaded_at: None,
        };
        lib.add(new_item.clone());
        new_item
    };

    Ok(OptimizeResult {
        original_size,
        new_size,
        width: w,
        height: h,
        format: ext.to_string(),
        item,
    })
}

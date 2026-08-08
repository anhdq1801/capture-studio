use crate::library::{file_size, LibraryState};
use crate::models::{CaptureDevices, CodecOption, DeviceEntry, MediaItem, RecordOptions};
use crate::settings::SettingsState;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::State;

pub struct RecordingSession {
    child: Child,
    id: String,
    file_name: String,
    started: chrono::DateTime<chrono::Local>,
    width: u32,
    height: u32,
}

pub type RecorderState = Mutex<Option<RecordingSession>>;

#[cfg(windows)]
const FFMPEG_EXE: &str = "ffmpeg.exe";
#[cfg(not(windows))]
const FFMPEG_EXE: &str = "ffmpeg";

/// Does this path run and report a version?
fn ffmpeg_works(path: &Path) -> bool {
    Command::new(path)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Where ffmpeg lives on this machine, or `None` if it is genuinely missing.
///
/// A bare `Command::new("ffmpeg")` only resolves when the process inherits a shell PATH.
/// A bundled `.app` launched from Finder or a LaunchAgent inherits launchd's bare PATH
/// instead, which contains none of the package-manager prefixes — so a perfectly good
/// Homebrew ffmpeg reads as "not installed". The known install prefixes are probed
/// directly to cover that case.
fn resolve_ffmpeg() -> Option<PathBuf> {
    // An explicit override wins, so a user with an unusual install can still point at it.
    if let Some(raw) = std::env::var_os("CAPTURE_STUDIO_FFMPEG") {
        let path = PathBuf::from(raw);
        if ffmpeg_works(&path) {
            return Some(path);
        }
    }

    // A copy shipped next to our own binary, if this build ever bundles one.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join(FFMPEG_EXE);
            if sidecar.is_file() && ffmpeg_works(&sidecar) {
                return Some(sidecar);
            }
        }
    }

    // Whatever PATH we did inherit — correct when launched from a terminal.
    let bare = PathBuf::from(FFMPEG_EXE);
    if ffmpeg_works(&bare) {
        return Some(bare);
    }

    #[cfg(target_os = "macos")]
    let candidates: &[&str] = &[
        "/opt/homebrew/bin/ffmpeg", // Homebrew on Apple silicon
        "/usr/local/bin/ffmpeg",    // Homebrew on Intel
        "/opt/local/bin/ffmpeg",    // MacPorts
        "/usr/bin/ffmpeg",
    ];
    #[cfg(target_os = "windows")]
    let candidates: &[&str] = &[
        r"C:\ffmpeg\bin\ffmpeg.exe",
        r"C:\ProgramData\chocolatey\bin\ffmpeg.exe",
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
    ];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let candidates: &[&str] = &["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/snap/bin/ffmpeg"];

    for candidate in candidates {
        let path = Path::new(candidate);
        if path.is_file() && ffmpeg_works(path) {
            return Some(path.to_path_buf());
        }
    }

    // Homebrew and winget both drop per-user installs outside the prefixes above.
    if let Some(home) = dirs::home_dir() {
        let user_paths = [
            home.join(".local/bin").join(FFMPEG_EXE),
            home.join("bin").join(FFMPEG_EXE),
            home.join("AppData/Local/Microsoft/WinGet/Links").join(FFMPEG_EXE),
        ];
        for path in user_paths {
            if path.is_file() && ffmpeg_works(&path) {
                return Some(path);
            }
        }
    }

    None
}

/// Resolution is cached: each probe spawns a process, and this is hit on every device
/// listing, encoder query and recording start.
fn ffmpeg_path() -> Option<&'static PathBuf> {
    static RESOLVED: OnceLock<Option<PathBuf>> = OnceLock::new();
    RESOLVED.get_or_init(resolve_ffmpeg).as_ref()
}

fn ffmpeg() -> Command {
    match ffmpeg_path() {
        Some(path) => Command::new(path),
        // Unreachable in practice — callers check availability first — but a command that
        // fails to spawn is a better fallback than a panic.
        None => Command::new(FFMPEG_EXE),
    }
}

#[tauri::command]
pub fn check_ffmpeg() -> bool {
    ffmpeg_path().is_some()
}

/// Parse `[N] Name` device lines out of ffmpeg's device listing.
fn parse_avf_devices(stderr: &str) -> (Vec<DeviceEntry>, Vec<DeviceEntry>) {
    let mut screens = Vec::new();
    let mut audio = Vec::new();
    let mut section = 0; // 1 = video, 2 = audio
    for line in stderr.lines() {
        if line.contains("AVFoundation video devices") {
            section = 1;
            continue;
        }
        if line.contains("AVFoundation audio devices") {
            section = 2;
            continue;
        }
        // lines look like: [AVFoundation ...] [1] Capture screen 0
        if let Some((index, name)) = last_bracket_index(line) {
            let entry = DeviceEntry { index, name };
            match section {
                1 => screens.push(entry),
                2 => audio.push(entry),
                _ => {}
            }
        }
    }
    (screens, audio)
}

fn last_bracket_index(line: &str) -> Option<(String, String)> {
    // find last occurrence of "[<num>] "
    let bytes = line.as_bytes();
    let mut result = None;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            if let Some(close) = line[i..].find(']') {
                let inner = &line[i + 1..i + close];
                if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit()) {
                    let name = line[i + close + 1..].trim().to_string();
                    if !name.is_empty() {
                        result = Some((inner.to_string(), name));
                    }
                }
                i = i + close + 1;
                continue;
            }
        }
        i += 1;
    }
    result
}

#[tauri::command]
pub fn list_capture_devices() -> CaptureDevices {
    let available = check_ffmpeg();
    if !available {
        return CaptureDevices {
            screens: vec![],
            audio: vec![],
            ffmpeg_available: false,
        };
    }

    #[cfg(target_os = "macos")]
    {
        let out = ffmpeg()
            .args(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""])
            .output();
        if let Ok(o) = out {
            let stderr = String::from_utf8_lossy(&o.stderr);
            let (screens, audio) = parse_avf_devices(&stderr);
            return CaptureDevices { screens, audio, ffmpeg_available: true };
        }
    }

    #[cfg(target_os = "windows")]
    {
        // gdigrab always captures the desktop — expose a single logical screen.
        let mut audio = Vec::new();
        let out = ffmpeg()
            .args(["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"])
            .output();
        if let Ok(o) = out {
            let stderr = String::from_utf8_lossy(&o.stderr);
            for line in stderr.lines() {
                if line.contains("(audio)") {
                    if let Some(start) = line.find('"') {
                        if let Some(end) = line[start + 1..].find('"') {
                            let name = line[start + 1..start + 1 + end].to_string();
                            audio.push(DeviceEntry { index: name.clone(), name });
                        }
                    }
                }
            }
        }
        return CaptureDevices {
            screens: vec![DeviceEntry { index: "desktop".into(), name: "Entire desktop".into() }],
            audio,
            ffmpeg_available: true,
        };
    }

    #[allow(unreachable_code)]
    CaptureDevices { screens: vec![], audio: vec![], ffmpeg_available: available }
}

/// Encoder names this ffmpeg build reports, used to decide which codecs to offer.
fn available_encoders() -> String {
    ffmpeg()
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

/// Pick the concrete ffmpeg encoder for a codec id, preferring hardware where it exists.
///
/// HEVC and AV1 are the reason this is worth doing at all: they roughly halve the file size
/// of the same screen recording versus H.264, but which encoders a given ffmpeg build ships
/// varies a lot, so anything missing is offered as unavailable rather than failing at record
/// time.
fn encoder_for(codec: &str, encoders: &str) -> Option<&'static str> {
    let has = |name: &str| encoders.contains(name);
    match codec {
        "h264" => {
            if has("libx264") {
                Some("libx264")
            } else if has("h264_videotoolbox") {
                Some("h264_videotoolbox")
            } else {
                None
            }
        }
        "hevc" => {
            // Hardware HEVC keeps up with 4K screen capture in realtime; libx265 usually
            // does not, so it is only the fallback.
            if cfg!(target_os = "macos") && has("hevc_videotoolbox") {
                Some("hevc_videotoolbox")
            } else if has("libx265") {
                Some("libx265")
            } else if has("hevc_nvenc") {
                Some("hevc_nvenc")
            } else {
                None
            }
        }
        "av1" => {
            if has("libsvtav1") {
                Some("libsvtav1")
            } else if has("libaom-av1") {
                Some("libaom-av1")
            } else {
                None
            }
        }
        "vp9" => has("libvpx-vp9").then_some("libvpx-vp9"),
        _ => None,
    }
}

fn container_for(codec: &str) -> &'static str {
    match codec {
        "vp9" => "webm",
        _ => "mp4",
    }
}

#[tauri::command]
pub fn list_video_codecs() -> Vec<CodecOption> {
    let encoders = available_encoders();
    let specs = [
        ("h264", "H.264 · MP4", "Plays everywhere. Largest files."),
        ("hevc", "H.265 / HEVC · MP4", "About half the size of H.264."),
        ("av1", "AV1 · MP4", "Smallest files, slowest to encode."),
        ("vp9", "VP9 · WebM", "Small files, great for the web."),
    ];
    specs
        .iter()
        .map(|(id, label, note)| {
            let enc = encoder_for(id, &encoders);
            CodecOption {
                id: (*id).into(),
                label: (*label).into(),
                ext: container_for(id).into(),
                available: enc.is_some(),
                note: match enc {
                    Some(e) => format!("{note} ({e})"),
                    None => "Not supported by your ffmpeg build".into(),
                },
            }
        })
        .collect()
}

/// Downscale to a target height, never upscale, keeping the aspect ratio and forcing both
/// dimensions even (every codec here needs that for yuv420p).
///
/// The commas inside `min(...)` are escaped because ffmpeg splits a filtergraph on commas.
fn scale_filter(target_h: u32) -> String {
    format!("scale=-2:trunc(min(ih\\,{target_h})/2)*2")
}

/// Video bitrate for the hardware encoders, which take a rate rather than a quality target.
fn bitrate_for(height: u32) -> &'static str {
    match height {
        h if h >= 2160 => "16M",
        h if h >= 1440 => "9M",
        h if h >= 1080 => "5M",
        h if h >= 720 => "2500k",
        _ => "1200k",
    }
}

/// Read the real dimensions ffmpeg produced, rather than guessing from the crop rectangle —
/// with a resolution preset the output is deliberately not the same size as the source.
fn probe_dimensions(path: &std::path::Path) -> Option<(u32, u32)> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=s=x:p=0",
        ])
        .arg(path)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let (w, h) = text.trim().split_once('x')?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

/// File name a recording's poster frame gets, alongside the video in the library directory.
fn thumb_name_for(file_name: &str) -> String {
    let stem = std::path::Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.to_string());
    format!("{stem}.thumb.jpg")
}

/// Pull one frame out of a recording and write it as a JPEG poster.
///
/// The library used to render each recording with a bare `<video>` tag, which paints nothing
/// in a WKWebView until the clip is played — so every recording looked like the same empty
/// card and there was no way to tell them apart. A real poster file also sidesteps codecs the
/// webview may not decode at all (AV1, and VP9 on older systems), so a card looks the same
/// whichever format the recording was encoded with.
fn make_thumbnail(video: &std::path::Path, out: &std::path::Path, duration_ms: u64) -> bool {
    // A screen recording usually opens on the instant the user hit record — often a menu
    // closing or a still-empty window — so a frame slightly in is more representative. Capped
    // so it can never land past the end of a short clip.
    let seek = (duration_ms as f64 / 1000.0 * 0.15).clamp(0.0, 2.0);
    // Seeking near the end of a very short recording can still land on no frame at all;
    // frame zero always exists, so it is the fallback.
    for ss in [seek, 0.0] {
        let ok = ffmpeg()
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args(["-ss", &format!("{ss:.2}")])
            .arg("-i")
            .arg(video)
            .args(["-frames:v", "1"])
            .args(["-vf", &scale_filter(THUMB_HEIGHT)])
            .args(["-q:v", "4"])
            .arg(out)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok && out.exists() && file_size(out) > 0 {
            return true;
        }
        if (ss - 0.0).abs() < f64::EPSILON {
            break;
        }
    }
    false
}

/// Tall enough to stay sharp on a retina library card, small enough to decode instantly.
const THUMB_HEIGHT: u32 = 480;

/// Return the poster path for a recording, generating it if it is missing.
///
/// Recordings made before posters existed have none, and a library folder can be cleaned up
/// by hand, so the gallery asks for one per item rather than assuming `thumbName` is valid.
#[tauri::command]
pub fn ensure_thumbnail(
    lib_state: State<LibraryState>,
    id: String,
) -> Result<Option<String>, String> {
    // Everything ffmpeg needs is read out first: generating a poster takes long enough that
    // holding the library lock across it would stall every other command.
    let (dir, video, thumb, duration_ms) = {
        let lib = lib_state.lock().map_err(|e| e.to_string())?;
        let item = match lib.get(&id) {
            Some(it) if it.kind == "recording" => it,
            _ => return Ok(None),
        };
        let thumb = item.thumb_name.clone().unwrap_or_else(|| thumb_name_for(&item.file_name));
        (
            lib.dir.clone(),
            lib.path_of(&item.file_name),
            thumb,
            item.duration_ms.unwrap_or(0),
        )
    };

    let thumb_path = dir.join(&thumb);
    if !(thumb_path.exists() && file_size(&thumb_path) > 0)
        && !make_thumbnail(&video, &thumb_path, duration_ms)
    {
        return Ok(None);
    }

    lib_state
        .lock()
        .map_err(|e| e.to_string())?
        .update(&id, |it| it.thumb_name = Some(thumb.clone()));
    Ok(Some(thumb_path.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn start_recording(
    lib_state: State<LibraryState>,
    rec_state: State<RecorderState>,
    settings_state: State<SettingsState>,
    opts: RecordOptions,
) -> Result<(), String> {
    {
        let guard = rec_state.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("A recording is already in progress".into());
        }
    }

    // Per-recording overrides win, otherwise fall back to what Settings has stored.
    let saved = settings_state.lock().map_err(|e| e.to_string())?.clone();
    let codec = opts.codec.clone().unwrap_or(saved.codec);
    let resolution = opts.resolution.clone().unwrap_or(saved.resolution);

    let encoders = available_encoders();
    let encoder = encoder_for(&codec, &encoders).ok_or_else(|| {
        format!("Your ffmpeg build has no encoder for {codec}. Pick another format in Settings.")
    })?;
    let ext = container_for(&codec);

    let (dir, file_name, out_path) = {
        let lib = lib_state.lock().map_err(|e| e.to_string())?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let file_name = format!("rec-{stamp}.{ext}");
        (lib.dir.clone(), file_name.clone(), lib.path_of(&file_name))
    };

    let fps = opts.fps.unwrap_or(30);
    let cursor = opts.capture_cursor.unwrap_or(true);
    let (mut width, mut height) = (0u32, 0u32);
    if let Some([_, _, w, h]) = opts.region {
        width = w.max(0) as u32;
        height = h.max(0) as u32;
    }
    let target_h: Option<u32> = resolution.parse::<u32>().ok();

    let mut cmd = ffmpeg();
    cmd.arg("-y").arg("-hide_banner").arg("-loglevel").arg("error");

    #[cfg(target_os = "macos")]
    {
        let screen = opts.screen_index.clone().unwrap_or_else(|| "1".into());
        let input = match &opts.audio_device {
            Some(a) if !a.is_empty() => format!("{screen}:{a}"),
            _ => format!("{screen}:none"),
        };
        cmd.args(["-f", "avfoundation"])
            .args(["-capture_cursor", if cursor { "1" } else { "0" }])
            .args(["-framerate", &fps.to_string()])
            .args(["-i", &input]);
        // avfoundation always hands over the whole display, so a region (or a picked
        // window's bounds) becomes a crop filter chained ahead of any downscale.
        let mut filters: Vec<String> = Vec::new();
        if let Some([x, y, w, h]) = opts.region {
            filters.push(format!("crop={w}:{h}:{x}:{y}"));
        }
        if let Some(th) = target_h {
            filters.push(scale_filter(th));
        }
        if !filters.is_empty() {
            cmd.args(["-vf", &filters.join(",")]);
        }
    }

    #[cfg(target_os = "windows")]
    {
        cmd.args(["-f", "gdigrab"])
            .args(["-framerate", &fps.to_string()])
            .args(["-draw_mouse", if cursor { "1" } else { "0" }]);
        if let Some([x, y, w, h]) = opts.region {
            cmd.args(["-offset_x", &x.to_string()])
                .args(["-offset_y", &y.to_string()])
                .args(["-video_size", &format!("{w}x{h}")]);
        }
        cmd.args(["-i", "desktop"]);
        if let Some(a) = &opts.audio_device {
            if !a.is_empty() {
                cmd.args(["-f", "dshow", "-i", &format!("audio={a}")]);
            }
        }
        // gdigrab already cropped via -offset_x/-video_size, so only the downscale is left.
        if let Some(th) = target_h {
            cmd.args(["-vf", &scale_filter(th)]);
        }
    }

    // ---- Encoding ----
    cmd.args(["-c:v", encoder]);
    let out_h = target_h.unwrap_or(if height > 0 { height } else { 1080 });
    match encoder {
        // Hardware encoders take a bitrate rather than a quality target.
        e if e.ends_with("_videotoolbox") || e.ends_with("_nvenc") => {
            cmd.args(["-b:v", bitrate_for(out_h)]);
        }
        "libx264" => {
            cmd.args(["-preset", "veryfast", "-crf", "23"]);
        }
        "libx265" => {
            cmd.args(["-preset", "veryfast", "-crf", "28"]);
        }
        "libsvtav1" => {
            // preset 8 is the fast end of SVT-AV1; anything slower can't keep up live.
            cmd.args(["-preset", "8", "-crf", "35"]);
        }
        "libaom-av1" => {
            cmd.args(["-cpu-used", "8", "-crf", "35", "-b:v", "0"]);
        }
        "libvpx-vp9" => {
            cmd.args(["-deadline", "realtime", "-cpu-used", "5", "-row-mt", "1"])
                .args(["-crf", "34", "-b:v", "0"]);
        }
        _ => {}
    }
    // QuickTime only recognises HEVC in MP4 when it carries the hvc1 tag.
    if codec == "hevc" {
        cmd.args(["-tag:v", "hvc1"]);
    }
    if codec != "vp9" {
        cmd.args(["-pix_fmt", "yuv420p"]);
    }

    let has_audio = opts.audio_device.as_ref().map(|a| !a.is_empty()).unwrap_or(false);
    if has_audio {
        if codec == "vp9" {
            cmd.args(["-c:a", "libopus", "-b:a", "128k"]);
        } else {
            cmd.args(["-c:a", "aac", "-b:a", "128k"]);
        }
    }
    cmd.arg(&out_path);

    let log_path = dir.join("last-record.log");
    let log = std::fs::File::create(&log_path).ok();

    cmd.stdin(Stdio::piped());
    if let Some(f) = log {
        cmd.stderr(Stdio::from(f));
    } else {
        cmd.stderr(Stdio::null());
    }
    cmd.stdout(Stdio::null());

    let child = cmd.spawn().map_err(|e| format!("Failed to start ffmpeg: {e}"))?;

    let session = RecordingSession {
        child,
        id: format!("rec-{}", chrono::Local::now().format("%Y%m%d-%H%M%S%3f")),
        file_name,
        started: chrono::Local::now(),
        width,
        height,
    };
    *rec_state.lock().map_err(|e| e.to_string())? = Some(session);
    Ok(())
}

#[tauri::command]
pub fn stop_recording(
    lib_state: State<LibraryState>,
    rec_state: State<RecorderState>,
) -> Result<MediaItem, String> {
    let mut session = {
        let mut guard = rec_state.lock().map_err(|e| e.to_string())?;
        guard.take().ok_or_else(|| "No recording in progress".to_string())?
    };

    // Ask ffmpeg to finish encoding gracefully.
    if let Some(mut stdin) = session.child.stdin.take() {
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }
    let status = session.child.wait().map_err(|e| e.to_string())?;

    let duration_ms = (chrono::Local::now() - session.started).num_milliseconds().max(0) as u64;

    let (path, exists) = {
        let lib = lib_state.lock().map_err(|e| e.to_string())?;
        let p = lib.path_of(&session.file_name);
        let exists = p.exists() && file_size(&p) > 0;
        (p, exists)
    };

    if !exists {
        let log = {
            let lib = lib_state.lock().map_err(|e| e.to_string())?;
            std::fs::read_to_string(lib.dir.join("last-record.log")).unwrap_or_default()
        };
        return Err(format!(
            "Recording failed (ffmpeg exit {:?}). {}",
            status.code(),
            log.lines().last().unwrap_or("")
        ));
    }

    // The crop rectangle is only a guess at the output size once a resolution preset scales
    // it — and it is 0×0 for a full-screen recording — so read the truth back off the file.
    let (width, height) =
        probe_dimensions(&path).unwrap_or((session.width, session.height));

    // Generated here rather than lazily from the gallery so a recording has a picture the
    // moment it lands in the library.
    let thumb = thumb_name_for(&session.file_name);
    let thumb_name =
        make_thumbnail(&path, &path.with_file_name(&thumb), duration_ms).then_some(thumb);

    let item = MediaItem {
        id: session.id.clone(),
        kind: "recording".into(),
        file_name: session.file_name.clone(),
        created_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        note: String::new(),
        width,
        height,
        size_bytes: file_size(&path),
        duration_ms: Some(duration_ms),
        thumb_name,
        draft: false,
        cloud_url: None,
        uploaded_at: None,
    };

    let mut lib = lib_state.lock().map_err(|e| e.to_string())?;
    lib.add(item.clone());
    Ok(item)
}

#[tauri::command]
pub fn is_recording(rec_state: State<RecorderState>) -> bool {
    rec_state.lock().map(|g| g.is_some()).unwrap_or(false)
}

use crate::library::{file_size, LibraryState};
use crate::models::{CaptureDevices, CodecOption, DeviceEntry, MediaItem, RecordOptions};
use crate::settings::SettingsState;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::State;

pub struct RecordingSession {
    child: Child,
    id: String,
    file_name: String,
    started: chrono::DateTime<chrono::Local>,
    width: u32,
    height: u32,
    /// Where the cursor was, sampled while recording. Empty unless cursor-follow was asked for.
    cursor: Arc<Mutex<Vec<CursorSample>>>,
    /// Set on stop so the sampling thread ends instead of outliving the recording.
    sampling: Arc<AtomicBool>,
    /// Everything the zoom pass needs to place those samples in the encoded frame.
    zoom: Option<ZoomInput>,
    /// Frame rate the recording was made at. The zoom pass re-encodes and would otherwise
    /// resample a 60 fps capture down to zoompan's default.
    fps: u32,
}

/// One cursor reading: milliseconds since the recording started, and desktop physical position.
#[derive(Clone, Copy)]
pub struct CursorSample {
    t_ms: u64,
    x: i32,
    y: i32,
}

#[derive(Clone, Copy)]
struct ZoomInput {
    /// Desktop coordinate that lands on video pixel (0,0).
    origin: (i32, i32),
    /// Captured size before any downscale; 0 means "read it off the finished file instead".
    capture: (u32, u32),
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
            // Scoop keeps its shims here; without this a scoop install reads as "not found".
            home.join("scoop/shims").join(FFMPEG_EXE),
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

/// How often the cursor is read while recording.
const CURSOR_HZ: u64 = 20;

/// One stretch where the cursor stayed put: hold this centre from `t0` to `t1` seconds.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ZoomSeg {
    t0: f64,
    t1: f64,
    cx: f64,
    cy: f64,
}

/// A run of nearby dwells covered by a single sustained zoom.
///
/// The camera goes in once at the start, **pans** between the dwells without ever coming back
/// out, and pulls out once at the end. Zooming out and straight back in between two dwells a
/// second apart is what made the first version pump in and out for the length of a recording —
/// working at a screen means settle, move, settle, and treating each settle as its own zoom
/// turns an ordinary working rhythm into constant camera movement.
#[derive(Debug, Clone, PartialEq)]
struct ZoomPass {
    dwells: Vec<ZoomSeg>,
}

impl ZoomPass {
    fn t0(&self) -> f64 {
        self.dwells.first().map(|d| d.t0).unwrap_or(0.0)
    }
    fn t1(&self) -> f64 {
        self.dwells.last().map(|d| d.t1).unwrap_or(0.0)
    }
}

/// How far the cursor may wander and still count as staying put, as a fraction of frame width.
const DWELL_RADIUS: f64 = 0.12;
/// Above this speed — as a fraction of frame width per second — the cursor is travelling rather
/// than working, and nothing there is worth cutting in on.
const STILL_SPEED_FRAC: f64 = 0.06;
/// Half-width of the window a sample's speed is measured over. Too short and a single jittery
/// reading reads as movement; too long and the start of a real move is blamed on the dwell
/// before it.
const SPEED_WINDOW_S: f64 = 0.25;
/// A dwell shorter than this is not worth zooming for — the move in and out would be most of it.
const MIN_DWELL_S: f64 = 1.8;
/// Dwells separated by less than this stay inside one zoom and are panned between. Longer than
/// that and the recording has genuinely moved on, so pulling out and showing the whole screen
/// again is the honest thing to do.
const JOIN_GAP_S: f64 = 5.0;
/// A pan further than this share of the frame is worse than a zoom out: at full zoom the picture
/// would race past for most of a second with nothing legible in it.
const MAX_PAN_FRAC: f64 = 0.55;
/// Seconds spent easing in, and again easing out.
const RAMP_S: f64 = 0.5;
/// How far in to go. Past roughly 2x, text that was legible at full size starts to soften,
/// because the pixels being magnified are all there ever were.
const ZOOM: f64 = 1.75;
/// Nothing is zoomed unless at least this share of samples landed inside the frame — a low hit
/// rate means the origin we mapped through was wrong, and zooming would be zooming somewhere
/// arbitrary. Degrading to an untouched video is the safe failure.
const MIN_INSIDE: f64 = 0.6;

/// Reduce a cursor track to the handful of places worth zooming in on.
///
/// Following the cursor continuously is the obvious reading of "follow the cursor" and it is
/// unwatchable: every stray hand movement swings the whole frame. What reads as deliberate is
/// what a human editor does — cut in where something is happening, sit still, pull back out. So
/// the track is searched for stretches where the cursor stayed in one area, and only those
/// become zooms.
fn zoom_passes(samples: &[CursorSample], w: f64, h: f64, duration_s: f64) -> Vec<ZoomPass> {
    if samples.len() < 2 || duration_s < 4.0 || w <= 0.0 || h <= 0.0 {
        return Vec::new();
    }
    let inside = samples
        .iter()
        .filter(|s| {
            (s.x as f64) >= 0.0 && (s.x as f64) < w && (s.y as f64) >= 0.0 && (s.y as f64) < h
        })
        .count();
    if (inside as f64) / (samples.len() as f64) < MIN_INSIDE {
        return Vec::new();
    }

    let span = w * DWELL_RADIUS * 2.0;

    // Classify every sample as moving or still *before* grouping anything.
    //
    // Grouping first and judging the group afterwards is what the two earlier attempts did, and
    // both failed the same way: a run grown until its bounding box bursts always ends somewhere
    // in the middle of the movement that burst it, so the run is part dwell and part transit and
    // no test applied to it as a whole can say which. Speed is a property of a single sample's
    // neighbourhood, so it draws the boundary in the right place and the grouping afterwards is
    // trivial.
    let still_speed = w * STILL_SPEED_FRAC;
    let at = |k: usize| (samples[k].t_ms as f64 / 1000.0, samples[k].x as f64, samples[k].y as f64);
    let still: Vec<bool> = (0..samples.len())
        .map(|k| {
            let (tk, _, _) = at(k);
            // Widened by time rather than by sample count so a dropped sample does not read as
            // a sudden jump.
            let mut a = k;
            while a > 0 && at(a).0 > tk - SPEED_WINDOW_S {
                a -= 1;
            }
            let mut b = k;
            while b + 1 < samples.len() && at(b).0 < tk + SPEED_WINDOW_S {
                b += 1;
            }
            let ((ta, xa, ya), (tb, xb, yb)) = (at(a), at(b));
            let dt = tb - ta;
            dt <= 0.0 || (xb - xa).hypot(yb - ya) / dt < still_speed
        })
        .collect();

    let mut segs: Vec<ZoomSeg> = Vec::new();
    let mut run: Option<(usize, (f64, f64), (f64, f64), (f64, f64), f64)> = None;
    let close = |run: &mut Option<(usize, (f64, f64), (f64, f64), (f64, f64), f64)>,
                     last: usize,
                     segs: &mut Vec<ZoomSeg>| {
        if let Some((first, _, _, sum, n)) = run.take() {
            let t0 = samples[first].t_ms as f64 / 1000.0;
            let t1 = samples[last].t_ms as f64 / 1000.0;
            if t1 - t0 >= MIN_DWELL_S && n > 0.0 {
                segs.push(ZoomSeg { t0, t1, cx: sum.0 / n, cy: sum.1 / n });
            }
        }
    };

    for k in 0..samples.len() {
        let (_, x, y) = at(k);
        if !still[k] {
            close(&mut run, k.saturating_sub(1), &mut segs);
            continue;
        }
        match run.as_mut() {
            // Still, but far enough from where this run started that it is a new place: a
            // cursor can creep a long way without ever exceeding the speed threshold.
            Some((_, lo, hi, _, _)) if hi.0.max(x) - lo.0.min(x) > span || hi.1.max(y) - lo.1.min(y) > span => {
                close(&mut run, k.saturating_sub(1), &mut segs);
                run = Some((k, (x, y), (x, y), (x, y), 1.0));
            }
            Some((_, lo, hi, sum, n)) => {
                *lo = (lo.0.min(x), lo.1.min(y));
                *hi = (hi.0.max(x), hi.1.max(y));
                *sum = (sum.0 + x, sum.1 + y);
                *n += 1.0;
            }
            None => run = Some((k, (x, y), (x, y), (x, y), 1.0)),
        }
    }
    close(&mut run, samples.len() - 1, &mut segs);

    // Too short to outlast its own ramps: it would never reach full zoom and would read as a
    // twitch rather than as a move.
    segs.retain(|d| d.t1 - d.t0 >= 0.6);

    // Group what is left into passages. A gap short enough to pan across stays inside the
    // current passage; anything longer, or further than the eye will follow at full zoom,
    // starts a new one.
    let max_pan = w * MAX_PAN_FRAC;
    let mut passes: Vec<ZoomPass> = Vec::new();
    for d in segs {
        let joins = passes.last().is_some_and(|p| {
            let last = p.dwells.last().expect("a pass is never built empty");
            d.t0 - last.t1 < JOIN_GAP_S
                && (d.cx - last.cx).hypot(d.cy - last.cy) <= max_pan
        });
        if joins {
            passes.last_mut().expect("just checked").dwells.push(d);
        } else {
            passes.push(ZoomPass { dwells: vec![d] });
        }
    }
    // A whole passage still has to be worth the trip in and out.
    passes.retain(|p| p.t1() - p.t0() >= RAMP_S * 2.0 + 0.4);
    passes
}

/// Build the `zoompan` expression for a set of passages.
///
/// Passages are summed rather than nested: they never overlap, so each term is zero outside its
/// own window, and a flat sum avoids an `if()` nested once per passage. `smoothstep` on a
/// trapezoid gives the ease in and out; a linear ramp starts and stops with a visible jerk.
///
/// Inside a passage the zoom is held flat and only the **centre** moves, easing from one dwell
/// to the next across the gap between them. That is the whole point of a passage: the camera
/// pans rather than dropping back out to full frame and coming in again.
///
/// `x`/`y` are the viewport's top-left, so they follow from the centre and the `zoom` value
/// zoompan has already computed for the frame. Clamping them keeps the viewport inside the
/// frame — without it a centre near an edge shows black.
fn zoom_filter(passes: &[ZoomPass], out_w: u32, out_h: u32, fps: u32) -> String {
    let (mut z, mut cx, mut cy) = (String::from("1"), String::new(), String::new());
    for p in passes {
        let (t0, t1) = (p.t0(), p.t1());
        let up = format!("clip((it-{t0:.3})/{RAMP_S:.3},0,1)");
        let down = format!("clip(({t1:.3}-it)/{RAMP_S:.3},0,1)");
        let trap = format!("({up}*{down})");
        let ease = format!("({trap}*{trap}*(3-2*{trap}))");
        let gate = format!("between(it,{t0:.3},{t1:.3})*{ease}");
        z.push_str(&format!("+{gate}*{:.4}", ZOOM - 1.0));

        // The centre path: the first dwell's centre, plus one eased step per move to the next.
        // Each step is 0 before its gap, 1 after it, so they accumulate into a path that sits
        // still on each dwell and travels only in between.
        let first = &p.dwells[0];
        let (mut px, mut py) = (format!("{:.1}", first.cx), format!("{:.1}", first.cy));
        for pair in p.dwells.windows(2) {
            let (from, to) = (&pair[0], &pair[1]);
            // A pan needs a little time even when the dwells nearly touch, or the picture jumps.
            let span = (to.t0 - from.t1).max(0.35);
            let s = format!("clip((it-{:.3})/{span:.3},0,1)", from.t1);
            let step = format!("({s}*{s}*(3-2*{s}))");
            px.push_str(&format!("+{step}*{:.1}", to.cx - from.cx));
            py.push_str(&format!("+{step}*{:.1}", to.cy - from.cy));
        }
        // Multiplied by the same ease as the zoom, so the centre is back at the middle of the
        // frame exactly when the zoom reaches 1 and `x` lands on 0 rather than being clamped there.
        cx.push_str(&format!("+{gate}*(({px})-iw/2)"));
        cy.push_str(&format!("+{gate}*(({py})-ih/2)"));
    }
    let x = format!("max(0,min(iw-iw/zoom,(iw/2{cx})-iw/zoom/2))");
    let y = format!("max(0,min(ih-ih/zoom,(ih/2{cy})-ih/zoom/2))");
    format!("zoompan=z='{z}':x='{x}':y='{y}':d=1:s={out_w}x{out_h}:fps={fps}")
}

/// Re-encode `src` with the zoom applied, returning true only if a finished file came back.
///
/// Deliberately best-effort: every failure path leaves the original recording exactly as it
/// was. A zoom is a nicety, and losing a recording to it would be an appalling trade.
fn render_zoom(src: &Path, filter: &str, fps: u32) -> bool {
    let tmp = src.with_extension("zoom.tmp.mp4");
    let ok = ffmpeg()
        .args(["-y", "-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(src)
        .args(["-vf", filter])
        .args(["-r", &fps.to_string()])
        .args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"])
        .args(["-pix_fmt", "yuv420p"])
        // Audio is copied rather than re-encoded: the filter never touches it, and a second
        // AAC pass would cost quality for nothing.
        .args(["-c:a", "copy"])
        .arg(&tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok && tmp.exists() && file_size(&tmp) > 0 && std::fs::rename(&tmp, src).is_ok() {
        return true;
    }
    let _ = std::fs::remove_file(&tmp);
    false
}

#[tauri::command]
pub fn start_recording(
    app: tauri::AppHandle,
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

    // Cursor-follow needs to know where video pixel (0,0) is on the desktop. Without that the
    // samples cannot be placed in the frame, so the option is simply not honoured rather than
    // honoured against a guess.
    let zoom = opts
        .follow_cursor
        .unwrap_or(false)
        .then(|| opts.origin)
        .flatten()
        .map(|[ox, oy]| ZoomInput {
            origin: (ox, oy),
            capture: opts
                .capture_size
                .map(|[w, h]| (w, h))
                .unwrap_or((width, height)),
        });

    let cursor: Arc<Mutex<Vec<CursorSample>>> = Arc::new(Mutex::new(Vec::new()));
    let sampling = Arc::new(AtomicBool::new(zoom.is_some()));
    if zoom.is_some() {
        // Polled on a thread of its own rather than hooked into the OS event stream: a global
        // mouse hook needs Accessibility permission on macOS, which is a second scary system
        // prompt for a cosmetic feature. Polling needs no permission at all and 20 Hz is far
        // more resolution than a zoom that moves once every few seconds can use.
        let (samples, run, handle) = (cursor.clone(), sampling.clone(), app.clone());
        let began = std::time::Instant::now();
        std::thread::spawn(move || {
            let step = std::time::Duration::from_millis(1000 / CURSOR_HZ);
            while run.load(Ordering::Relaxed) {
                if let Ok(pos) = handle.cursor_position() {
                    if let Ok(mut v) = samples.lock() {
                        v.push(CursorSample {
                            t_ms: began.elapsed().as_millis() as u64,
                            x: pos.x as i32,
                            y: pos.y as i32,
                        });
                    }
                }
                std::thread::sleep(step);
            }
        });
    }

    let session = RecordingSession {
        child,
        id: format!("rec-{}", chrono::Local::now().format("%Y%m%d-%H%M%S%3f")),
        file_name,
        started: chrono::Local::now(),
        width,
        height,
        cursor,
        sampling,
        zoom,
        fps,
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

    // Stopped before the wait below, not after: ffmpeg can take a second or two to flush, and
    // cursor readings from after the last recorded frame would point the zoom at wherever the
    // hand happened to move while the user waited.
    session.sampling.store(false, Ordering::Relaxed);

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

    // The zoom pass runs before the thumbnail, so the poster frame is taken from the video the
    // user will actually watch rather than from the untouched one.
    if let Some(zi) = session.zoom {
        // Samples are in desktop coordinates; the video's are relative to the captured area and
        // then shrunk by whatever resolution preset applied.
        let cap_w = if zi.capture.0 > 0 { zi.capture.0 } else { width };
        let scale = if cap_w > 0 { width as f64 / cap_w as f64 } else { 1.0 };
        let samples: Vec<CursorSample> = session
            .cursor
            .lock()
            .map(|v| {
                v.iter()
                    .map(|s| CursorSample {
                        t_ms: s.t_ms,
                        x: (((s.x - zi.origin.0) as f64) * scale).round() as i32,
                        y: (((s.y - zi.origin.1) as f64) * scale).round() as i32,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let passes = zoom_passes(
            &samples,
            width as f64,
            height as f64,
            duration_ms as f64 / 1000.0,
        );
        if !passes.is_empty() {
            // Return value ignored on purpose: a zoom that could not be rendered leaves the
            // original recording untouched, which is a worse video but never a lost one.
            let filter = zoom_filter(&passes, width, height, session.fps);
            let _ = render_zoom(&path, &filter, session.fps);
        }
    }

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

/// Cut a recording down to `[start_ms, end_ms)`.
///
/// Re-encodes rather than stream-copying. `-c copy` can only cut on keyframes, which at the
/// 2-second GOP these recordings are written with means the cut lands up to two seconds away
/// from where the user put it — and the difference is invisible until they play it back. A
/// re-encode costs time and one generation of quality and lands on the frame they chose.
///
/// `replace` mirrors `optimize_image`: false writes a new library item and leaves the original
/// alone, true overwrites in place. Trimming throws away footage that cannot be recovered, so
/// the caller decides rather than this function assuming.
#[tauri::command]
pub fn trim_video(
    lib_state: State<LibraryState>,
    settings_state: State<SettingsState>,
    id: String,
    start_ms: u64,
    end_ms: u64,
    replace: bool,
) -> Result<MediaItem, String> {
    if end_ms <= start_ms {
        return Err("The end of the trim has to come after its start.".into());
    }
    let duration_ms = end_ms - start_ms;
    if duration_ms < 200 {
        return Err("That trim is shorter than a fifth of a second.".into());
    }

    let (src_path, item, dir) = {
        let lib = lib_state.lock().map_err(|e| e.to_string())?;
        let item = lib.get(&id).ok_or_else(|| "Item not found".to_string())?;
        (lib.path_of(&item.file_name), item, lib.dir.clone())
    };
    if item.kind != "recording" {
        return Err("Only recordings can be trimmed.".into());
    }

    let saved = settings_state.lock().map_err(|e| e.to_string())?.clone();
    let encoders = available_encoders();
    // Keep whatever container the recording already uses: the extension is in the item's file
    // name and in any link the user has already shared.
    let ext = item
        .file_name
        .rsplit_once('.')
        .map(|(_, e)| e.to_string())
        .unwrap_or_else(|| "mp4".into());
    let encoder = encoder_for(&saved.codec, &encoders)
        .filter(|_| container_for(&saved.codec) == ext)
        .or_else(|| encoder_for("h264", &encoders))
        .ok_or_else(|| "Your ffmpeg build has no usable video encoder.".to_string())?;

    let base = item
        .file_name
        .rsplit_once('.')
        .map(|(b, _)| b.to_string())
        .unwrap_or_else(|| item.file_name.clone());
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%3f").to_string();
    // Always written beside the original first. Encoding straight over the source would leave a
    // half-written file if ffmpeg died, and the original would be gone either way.
    let tmp_path = dir.join(format!("{base}-trim-{stamp}.tmp.{ext}"));

    let secs = |ms: u64| format!("{}.{:03}", ms / 1000, ms % 1000);
    let mut cmd = ffmpeg();
    cmd.args(["-y", "-hide_banner", "-loglevel", "error"])
        .args(["-ss", &secs(start_ms)])
        .arg("-i")
        .arg(&src_path)
        .args(["-t", &secs(duration_ms)])
        .args(["-c:v", encoder]);
    match encoder {
        e if e.ends_with("_videotoolbox") || e.ends_with("_nvenc") => {
            cmd.args(["-b:v", bitrate_for(item.height.max(720))]);
        }
        "libx265" => {
            cmd.args(["-preset", "veryfast", "-crf", "28"]);
        }
        "libsvtav1" => {
            cmd.args(["-preset", "8", "-crf", "35"]);
        }
        "libvpx-vp9" => {
            cmd.args(["-deadline", "good", "-cpu-used", "3", "-crf", "34", "-b:v", "0"]);
        }
        _ => {
            cmd.args(["-preset", "veryfast", "-crf", "21"]);
        }
    }
    if ext == "mp4" {
        cmd.args(["-pix_fmt", "yuv420p"]);
    }
    // Re-encoded rather than copied: a stream copy starting mid-packet leaves the audio a
    // fraction ahead of the picture for the whole clip.
    cmd.args(["-c:a", "aac", "-b:a", "128k"]);
    cmd.arg(&tmp_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let ok = cmd.status().map(|s| s.success()).unwrap_or(false);
    if !ok || !tmp_path.exists() || file_size(&tmp_path) == 0 {
        let _ = std::fs::remove_file(&tmp_path);
        return Err("ffmpeg could not write the trimmed clip.".into());
    }

    let (out_name, out_id) = if replace {
        (item.file_name.clone(), item.id.clone())
    } else {
        (format!("{base}-trim-{stamp}.{ext}"), format!("rec-{stamp}"))
    };
    let out_path = dir.join(&out_name);
    std::fs::rename(&tmp_path, &out_path).map_err(|e| e.to_string())?;

    let (width, height) = probe_dimensions(&out_path).unwrap_or((item.width, item.height));
    // The poster frame is regenerated: the old one was taken from a moment that may no longer
    // be in the clip at all.
    let thumb = thumb_name_for(&out_name);
    let thumb_name =
        make_thumbnail(&out_path, &dir.join(&thumb), duration_ms).then_some(thumb);

    let trimmed = MediaItem {
        id: out_id,
        kind: "recording".into(),
        file_name: out_name,
        created_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        note: item.note.clone(),
        width,
        height,
        size_bytes: file_size(&out_path),
        duration_ms: Some(duration_ms),
        thumb_name,
        draft: false,
        // A trim is a different file from the one that was uploaded, so it carries no link.
        cloud_url: None,
        uploaded_at: None,
    };
    lib_state
        .lock()
        .map_err(|e| e.to_string())?
        .add(trimmed.clone());
    Ok(trimmed)
}

#[tauri::command]
pub fn is_recording(rec_state: State<RecorderState>) -> bool {
    rec_state.lock().map(|g| g.is_some()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A cursor parked at one spot for `secs`, sampled at the real rate.
    fn dwell(from_s: f64, secs: f64, x: i32, y: i32) -> Vec<CursorSample> {
        let step = 1000 / CURSOR_HZ;
        let n = ((secs * 1000.0) as u64 / step).max(1);
        (0..n)
            .map(|i| CursorSample { t_ms: (from_s * 1000.0) as u64 + i * step, x, y })
            .collect()
    }

    /// A cursor sweeping across the frame — movement, never settling.
    fn sweep(from_s: f64, secs: f64, x0: i32, x1: i32) -> Vec<CursorSample> {
        let step = 1000 / CURSOR_HZ;
        let n = ((secs * 1000.0) as u64 / step).max(1);
        (0..n)
            .map(|i| CursorSample {
                t_ms: (from_s * 1000.0) as u64 + i * step,
                x: x0 + ((x1 - x0) * i as i32) / n as i32,
                y: 400,
            })
            .collect()
    }

    #[test]
    fn a_cursor_that_settles_becomes_one_zoom_on_that_spot() {
        let p = zoom_passes(&dwell(0.0, 6.0, 300, 200), 1920.0, 1080.0, 6.0);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].dwells.len(), 1);
        assert!((p[0].dwells[0].cx - 300.0).abs() < 1.0, "cx = {}", p[0].dwells[0].cx);
    }

    #[test]
    fn a_cursor_that_never_settles_gets_no_zoom_at_all() {
        let p = zoom_passes(&sweep(0.0, 10.0, 0, 1900), 1920.0, 1080.0, 10.0);
        assert!(p.is_empty(), "expected nothing, got {p:?}");
    }

    /// The regression this whole rewrite exists for.
    ///
    /// Settle, move, settle is the ordinary rhythm of working at a screen. Treating each settle
    /// as its own zoom pumped the camera all the way out and straight back in between them, for
    /// the length of the recording.
    #[test]
    fn two_nearby_dwells_share_one_zoom_and_pan_between_them() {
        let mut t = dwell(0.0, 4.0, 200, 200);
        t.extend(sweep(4.0, 2.0, 200, 900));
        t.extend(dwell(6.0, 4.0, 900, 300));
        let p = zoom_passes(&t, 1920.0, 1080.0, 10.0);
        assert_eq!(p.len(), 1, "one passage, not two zooms: {p:?}");
        assert_eq!(p[0].dwells.len(), 2, "both dwells inside it: {p:?}");
        assert!(p[0].dwells[0].cx < p[0].dwells[1].cx);
    }

    #[test]
    fn dwells_far_apart_in_time_do_get_separate_zooms() {
        // Out and back, so the cursor is genuinely moving for eight seconds yet ends up near
        // where it began. Sweeping only a short distance over that long would be *slow*, not
        // moving, and would correctly read as one very patient dwell.
        let mut t = dwell(0.0, 4.0, 300, 300);
        t.extend(sweep(4.0, 4.0, 300, 900));
        t.extend(sweep(8.0, 4.0, 900, 300));
        t.extend(dwell(12.0, 4.0, 400, 300));
        let p = zoom_passes(&t, 1920.0, 1080.0, 16.0);
        assert_eq!(p.len(), 2, "an 8s gap means the recording moved on: {p:?}");
    }

    #[test]
    fn a_pan_across_most_of_the_screen_breaks_the_passage_instead() {
        // Close in time, but far enough apart that panning at full zoom would race past.
        let mut t = dwell(0.0, 4.0, 100, 500);
        t.extend(sweep(4.0, 2.0, 100, 1800));
        t.extend(dwell(6.0, 4.0, 1800, 500));
        let p = zoom_passes(&t, 1920.0, 1080.0, 10.0);
        assert_eq!(p.len(), 2, "too far to pan, so pull out instead: {p:?}");
    }

    #[test]
    fn samples_that_land_outside_the_frame_disable_zooming_entirely() {
        let p = zoom_passes(&dwell(0.0, 6.0, -4000, -4000), 1920.0, 1080.0, 6.0);
        assert!(p.is_empty(), "a bad origin must degrade to no zoom, got {p:?}");
    }

    #[test]
    fn a_recording_too_short_to_zoom_in_and_out_of_is_left_alone() {
        let p = zoom_passes(&dwell(0.0, 3.0, 300, 300), 1920.0, 1080.0, 3.0);
        assert!(p.is_empty(), "{p:?}");
    }

    #[test]
    fn the_filter_holds_zoom_at_one_outside_every_passage() {
        let p = [ZoomPass { dwells: vec![ZoomSeg { t0: 2.0, t1: 6.0, cx: 400.0, cy: 300.0 }] }];
        let f = zoom_filter(&p, 1280, 720, 30);
        assert!(f.starts_with("zoompan=z='1+between(it,2.000,6.000)"), "{f}");
        assert!(f.contains(":s=1280x720:fps=30"), "{f}");
        assert!(f.contains("max(0,min(iw-iw/zoom"), "{f}");
        assert!(f.contains("max(0,min(ih-ih/zoom"), "{f}");
    }

    #[test]
    fn one_passage_means_one_zoom_gate_however_many_dwells_it_holds() {
        let p = [ZoomPass {
            dwells: vec![
                ZoomSeg { t0: 1.0, t1: 4.0, cx: 100.0, cy: 100.0 },
                ZoomSeg { t0: 6.0, t1: 9.0, cx: 700.0, cy: 400.0 },
            ],
        }];
        let f = zoom_filter(&p, 1280, 720, 30);
        // The zoom expression gates once — the camera goes in and out a single time.
        let z = f.split(":x=").next().unwrap();
        assert_eq!(z.matches("between(it,").count(), 1, "one gate in z: {z}");
        // And the centre travels: the second dwell contributes a step term.
        assert!(f.contains("+700.0-100.0") || f.contains("*600.0"), "pan step missing: {f}");
        assert!(!f.contains("if("), "nesting per passage is what the sum exists to avoid");
    }

    #[test]
    fn passages_are_summed_not_nested() {
        let p = [
            ZoomPass { dwells: vec![ZoomSeg { t0: 1.0, t1: 5.0, cx: 100.0, cy: 100.0 }] },
            ZoomPass { dwells: vec![ZoomSeg { t0: 12.0, t1: 16.0, cx: 900.0, cy: 500.0 }] },
        ];
        let f = zoom_filter(&p, 1280, 720, 30);
        assert_eq!(f.matches("between(it,").count(), 6, "2 per expression, 3 expressions");
    }
}


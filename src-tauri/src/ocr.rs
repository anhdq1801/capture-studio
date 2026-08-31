//! Text recognition, running entirely on the operating system's own engine.
//!
//! On macOS that is Vision (`VNRecognizeTextRequest`), the same recogniser behind Live Text; on
//! Windows it is `Windows.Media.Ocr`, which ships with the OS and recognises whichever languages
//! the user has installed. Bundling Tesseract instead would mean carrying the library and a
//! traineddata file per language — tens of megabytes onto a 16 MB app — to get worse results on
//! screen text than either system engine already gives for free.
//!
//! Both backends take encoded image bytes and let the OS decode them, rather than handing over a
//! pixel buffer: no manual stride, pixel-format or colour-space plumbing to get subtly wrong.
//! They differ in what they can report, and the difference is not hidden — Vision scores every
//! line, Windows scores none, so the "check this line" warnings only appear on macOS.

use crate::capture::capture_region_image;
use crate::library::LibraryState;
use crate::models::{OcrLanguage, OcrLine, OcrResult};
use crate::settings::SettingsState;
use tauri::State;

/// Below this, Vision is telling us it is guessing. Surfaced to the user rather than hidden,
/// because silently returning plausible-looking wrong text is worse than saying "check this".
const LOW_CONFIDENCE: f32 = 0.5;

fn encode_png(img: &image::RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img.clone())
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(buf.into_inner())
}

#[cfg(target_os = "macos")]
mod backend {
    use super::{OcrLanguage, OcrLine, OcrResult, LOW_CONFIDENCE};
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
    };

    /// Display name for a BCP-47 tag, asked of Foundation so the list reads in whatever
    /// language the user's system is set to rather than hard-coded English.
    fn display_name(tag: &str) -> String {
        use objc2_foundation::NSLocale;
        let locale = NSLocale::currentLocale();

        let full = locale
            .localizedStringForLocaleIdentifier(&NSString::from_str(tag))
            .to_string();
        if !full.is_empty() {
            return full;
        }

        // Vision's tags are not all valid locale identifiers — Vietnamese is listed as
        // `vi-VT`, and `VT` is not a real region code, so Foundation resolves the whole
        // identifier to nothing and the raw tag leaks into the UI. The language subtag on its
        // own still resolves ("vi" -> "Vietnamese"), which is the name worth showing anyway.
        let lang = tag.split(['-', '_']).next().unwrap_or(tag);
        let short = locale
            .localizedStringForLanguageCode(&NSString::from_str(lang))
            .map(|s| s.to_string())
            .unwrap_or_default();
        if short.is_empty() {
            tag.to_string()
        } else {
            short
        }
    }

    /// The tags this machine's Vision actually recognises. Level-dependent, so the caller has
    /// to have set the recognition level before asking.
    fn supported(req: &VNRecognizeTextRequest) -> Vec<String> {
        unsafe { req.supportedRecognitionLanguagesAndReturnError() }
            .map(|list| list.iter().map(|s| s.to_string()).collect())
            .unwrap_or_default()
    }

    pub fn available() -> bool {
        true
    }

    pub fn languages() -> Result<Vec<OcrLanguage>, String> {
        let req = VNRecognizeTextRequest::new();
        req.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        Ok(supported(&req)
            .into_iter()
            .map(|id| OcrLanguage { label: display_name(&id), id })
            .collect())
    }

    pub fn recognize(png: &[u8], langs: &[String]) -> Result<OcrResult, String> {
        let req = VNRecognizeTextRequest::new();
        // `Accurate` over `Fast`: this runs on a still screenshot the user is waiting on, not
        // on a video stream, so correctness is worth the extra few hundred milliseconds.
        req.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        req.setUsesLanguageCorrection(true);

        // Only pass tags this machine actually supports. Vietnamese ships as a default, but
        // Vision only gained it in a recent macOS — handing an older system an unknown tag
        // makes the whole request fail rather than degrade, so an unsupported language has to
        // be dropped here instead. Passing none leaves Vision on its own default.
        let ok = supported(&req);
        let wanted: Vec<&String> = langs.iter().filter(|l| ok.contains(l)).collect();
        if !wanted.is_empty() {
            let ns: Vec<_> = wanted.iter().map(|l| NSString::from_str(l)).collect();
            req.setRecognitionLanguages(&NSArray::from_retained_slice(&ns));
        }

        let data = NSData::with_bytes(png);
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &NSDictionary::new(),
        );
        let requests = NSArray::from_slice(&[req.as_ref() as &VNRequest]);
        handler
            .performRequests_error(&requests)
            .map_err(|e| e.localizedDescription().to_string())?;

        let mut lines = Vec::new();
        if let Some(results) = req.results() {
            for obs in results.iter() {
                // One candidate is enough: the alternates only matter for spell-correction UI,
                // and the top one is what Live Text itself uses.
                if let Some(best) = obs.topCandidates(1).iter().next() {
                    let text = best.string().to_string();
                    if text.is_empty() {
                        continue;
                    }
                    // SAFETY: reading a geometry property off an observation Vision handed
                    // back and that is still alive for this iteration.
                    let bb = unsafe { obs.boundingBox() };
                    lines.push(OcrLine {
                        text,
                        confidence: best.confidence(),
                        y: bb.origin.y as f32,
                        height: bb.size.height as f32,
                    });
                }
            }
        }

        let low = lines.iter().filter(|l| l.confidence < LOW_CONFIDENCE).count() as u32;
        Ok(OcrResult {
            text: lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n"),
            lines,
            low_confidence: low,
        })
    }
}

#[cfg(windows)]
mod winocr {
    use super::{OcrLanguage, OcrLine, OcrResult};
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapDecoder, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

    const NO_ENGINE: &str = "Windows has no text-recognition language installed. Open Settings > \
         Time & language > Language & region, click the three dots next to a language, choose \
         \"Language options\", and add \"Optical character recognition\".";

    fn err(e: windows::core::Error) -> String {
        e.message()
    }

    /// Runs `f` on a thread this module owns, in a multithreaded apartment.
    ///
    /// WinRT will not activate a class on a thread where COM was never initialised, and blocking
    /// on an async operation from a single-threaded apartment deadlocks outright. Tauri promises
    /// neither about the thread a command lands on, so rather than inspect the caller's apartment
    /// and hope, this borrows nothing and sets up its own.
    fn on_mta<T: Send>(f: impl FnOnce() -> Result<T, String> + Send) -> Result<T, String> {
        std::thread::scope(|s| {
            s.spawn(|| {
                // Err here means the thread was already an STA, which we did not create and must
                // not tear down — so the uninit below is paired only with an init that took.
                let owned = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
                let out = f();
                if owned {
                    unsafe { RoUninitialize() }
                }
                out
            })
            .join()
            .unwrap_or_else(|_| Err("Text recognition failed unexpectedly.".into()))
        })
    }

    /// Encoded bytes -> `SoftwareBitmap`, by way of an in-memory WinRT stream because a stream is
    /// the only thing `BitmapDecoder` will read from.
    ///
    /// The no-argument `GetSoftwareBitmapAsync` hands back BGRA8 premultiplied, which is exactly
    /// what `OcrEngine` accepts, so there is no pixel conversion step here.
    fn decode(bytes: &[u8]) -> Result<SoftwareBitmap, String> {
        let stream = InMemoryRandomAccessStream::new().map_err(err)?;
        let writer = DataWriter::CreateDataWriter(&stream).map_err(err)?;
        writer.WriteBytes(bytes).map_err(err)?;
        writer.StoreAsync().map_err(err)?.join().map_err(err)?;
        writer.FlushAsync().map_err(err)?.join().map_err(err)?;
        // Detached, or dropping the writer closes the stream we are about to read back.
        writer.DetachStream().map_err(err)?;
        stream.Seek(0).map_err(err)?;

        let decoder = BitmapDecoder::CreateAsync(&stream)
            .map_err(err)?
            .join()
            .map_err(err)?;
        decoder
            .GetSoftwareBitmapAsync()
            .map_err(err)?
            .join()
            .map_err(err)
    }

    /// The language part of a BCP-47 tag, lowercased, so `vi-VT` and `vi` both give `vi`.
    fn primary(tag: &str) -> String {
        tag.split(['-', '_']).next().unwrap_or(tag).to_ascii_lowercase()
    }

    /// One engine, one language — unlike Vision, which takes a list and sorts it out itself.
    /// The user's preference order decides, and anything they picked that this machine has no
    /// recognizer for is skipped rather than treated as an error.
    ///
    /// Whole tags are compared first, then only their language part, because the settings file
    /// is shared between platforms and holds Vision's spelling of a language rather than
    /// Windows's. Vision calls Vietnamese `vi-VT` — a region code that does not exist — where
    /// Windows calls it `vi`. Matching on the whole tag drops it, falls through to the next
    /// language in the list, and reads Vietnamese with the English recogniser: every
    /// unaccented letter right and every accented one wrong, which looks like a broken
    /// character encoding rather than the wrong engine.
    fn engine_for(langs: &[String]) -> Result<OcrEngine, String> {
        let available: Vec<Language> = OcrEngine::AvailableRecognizerLanguages()
            .map(|list| list.into_iter().collect())
            .unwrap_or_default();

        for tag in langs {
            if let Ok(lang) = Language::CreateLanguage(&HSTRING::from(tag.as_str())) {
                if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
                    return Ok(engine);
                }
            }
            let wanted = primary(tag);
            for lang in &available {
                let Ok(have) = lang.LanguageTag() else { continue };
                if primary(&have.to_string()) == wanted {
                    if let Ok(engine) = OcrEngine::TryCreateFromLanguage(lang) {
                        return Ok(engine);
                    }
                }
            }
        }
        OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_| NO_ENGINE.to_string())
    }

    pub fn languages() -> Result<Vec<OcrLanguage>, String> {
        on_mta(|| {
            let mut out = Vec::new();
            for lang in OcrEngine::AvailableRecognizerLanguages()
                .map_err(err)?
                .into_iter()
            {
                out.push(OcrLanguage {
                    id: lang.LanguageTag().map_err(err)?.to_string(),
                    // Already localised to the user's display language, matching what the macOS
                    // side asks Foundation for.
                    label: lang.DisplayName().map_err(err)?.to_string(),
                });
            }
            Ok(out)
        })
    }

    pub fn recognize(bytes: &[u8], langs: &[String]) -> Result<OcrResult, String> {
        on_mta(|| {
            let bitmap = decode(bytes)?;
            let image_height = bitmap.PixelHeight().map_err(err)? as f32;
            let engine = engine_for(langs)?;
            let result = engine
                .RecognizeAsync(&bitmap)
                .map_err(err)?
                .join()
                .map_err(err)?;

            let mut lines = Vec::new();
            for line in result.Lines().map_err(err)?.into_iter() {
                let text = line.Text().map_err(err)?.to_string();
                if text.trim().is_empty() {
                    continue;
                }

                // Windows gives a rectangle per word and none for the line, so the line's box is
                // the union of its words'. Those rectangles are in pixels with the origin at the
                // top left; `OcrLine` is defined in Vision's terms — normalised, origin bottom
                // left — so the conversion happens here rather than leaving two conventions for
                // the paragraph grouper to tell apart.
                let (mut top, mut bottom) = (f32::MAX, f32::MIN);
                for word in line.Words().map_err(err)?.into_iter() {
                    if let Ok(r) = word.BoundingRect() {
                        top = top.min(r.Y);
                        bottom = bottom.max(r.Y + r.Height);
                    }
                }
                let boxed = bottom > top && image_height > 0.0;

                lines.push(OcrLine {
                    text,
                    // Windows OCR reports no per-line confidence at all. Rather than invent a
                    // number, every line is marked certain: the panel then shows no warnings on
                    // Windows, which is honest, where a guessed score would mark the wrong ones.
                    confidence: 1.0,
                    y: if boxed { 1.0 - bottom / image_height } else { 0.0 },
                    height: if boxed { (bottom - top) / image_height } else { 0.0 },
                });
            }

            Ok(OcrResult {
                text: lines
                    .iter()
                    .map(|l| l.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
                lines,
                low_confidence: 0,
            })
        })
    }
}

/// Tesseract, when the user has installed it themselves.
///
/// This exists because the system recognisers do not cover everyone. Windows ships OCR models
/// for a fixed set of languages and Vietnamese is not among them, so a Vietnamese user on
/// Windows gets either the English recogniser guessing at every diacritic or nothing at all.
/// Tesseract does have a Vietnamese model, and it is the only offline way to read that text.
///
/// It is found rather than bundled, exactly as ffmpeg is: shipping it would add the library and
/// a model file per language to every download, including the macOS one that will never run it,
/// and the app already asks the user to install one external tool for recording. Whoever needs
/// this can install it; whoever does not pays nothing.
#[cfg(not(target_os = "macos"))]
mod tesseract {
    use super::{OcrLanguage, OcrLine, OcrResult};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::OnceLock;

    #[cfg(windows)]
    const EXE: &str = "tesseract.exe";
    #[cfg(not(windows))]
    const EXE: &str = "tesseract";

    /// Names for the traineddata files, which are ISO 639-2 codes rather than the BCP-47 tags
    /// the system recognisers use. Anything not listed still appears, under its own code —
    /// better a picker entry reading `kat` than a language silently missing from the list.
    const NAMES: &[(&str, &str)] = &[
        ("eng", "English"), ("vie", "Vietnamese"),
        ("chi_sim", "Chinese (Simplified)"), ("chi_tra", "Chinese (Traditional)"),
        ("jpn", "Japanese"), ("kor", "Korean"), ("tha", "Thai"),
        ("fra", "French"), ("deu", "German"), ("spa", "Spanish"), ("por", "Portuguese"),
        ("ita", "Italian"), ("nld", "Dutch"), ("rus", "Russian"), ("ukr", "Ukrainian"),
        ("pol", "Polish"), ("ces", "Czech"), ("tur", "Turkish"), ("ell", "Greek"),
        ("ara", "Arabic"), ("heb", "Hebrew"), ("hin", "Hindi"), ("ind", "Indonesian"),
        ("msa", "Malay"), ("swe", "Swedish"), ("dan", "Danish"), ("fin", "Finnish"),
        ("nor", "Norwegian"), ("ron", "Romanian"), ("hun", "Hungarian"),
    ];

    fn base(path: &Path) -> Command {
        let mut cmd = Command::new(path);
        // Without this every recognition flashes a console window over whatever the user was
        // reading. The capture itself is silent; the tool that reads it should be too.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd
    }

    fn works(path: &Path) -> bool {
        base(path)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Where tesseract lives, or `None` if it is genuinely not installed.
    ///
    /// Probed the same way as ffmpeg and for the same reason: a bundled app launched from the
    /// Finder or the Start menu inherits a bare PATH with none of the package-manager prefixes
    /// on it, so a perfectly good install reads as missing unless the usual places are checked
    /// directly.
    fn resolve() -> Option<PathBuf> {
        if let Some(raw) = std::env::var_os("CAPTURE_STUDIO_TESSERACT") {
            let path = PathBuf::from(raw);
            if works(&path) {
                return Some(path);
            }
        }

        let bare = PathBuf::from(EXE);
        if works(&bare) {
            return Some(bare);
        }

        #[cfg(windows)]
        let candidates: &[&str] = &[
            r"C:\Program Files\Tesseract-OCR\tesseract.exe",
            r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
            r"C:\ProgramData\chocolatey\bin\tesseract.exe",
        ];
        #[cfg(not(windows))]
        let candidates: &[&str] = &[
            "/usr/bin/tesseract",
            "/usr/local/bin/tesseract",
            "/snap/bin/tesseract",
        ];

        for candidate in candidates {
            let path = Path::new(candidate);
            if path.is_file() && works(path) {
                return Some(path.to_path_buf());
            }
        }

        if let Some(home) = dirs::home_dir() {
            for path in [
                home.join(".local/bin").join(EXE),
                home.join("AppData/Local/Microsoft/WinGet/Links").join(EXE),
                home.join("AppData/Local/Programs/Tesseract-OCR").join(EXE),
                home.join("scoop/shims").join(EXE),
            ] {
                if path.is_file() && works(&path) {
                    return Some(path);
                }
            }
        }

        None
    }

    /// Cached: resolving spawns a process, and this is consulted on every recognition and every
    /// time the settings panel opens.
    pub fn path() -> Option<&'static PathBuf> {
        static RESOLVED: OnceLock<Option<PathBuf>> = OnceLock::new();
        RESOLVED.get_or_init(resolve).as_ref()
    }

    /// The traineddata files actually present. Installing tesseract does not install every
    /// language: on Windows the installer offers them as tick-boxes, and a user who did not
    /// tick Vietnamese has the binary but not the model.
    pub fn languages() -> Vec<String> {
        static CACHED: OnceLock<Vec<String>> = OnceLock::new();
        CACHED
            .get_or_init(|| {
                let Some(path) = path() else { return Vec::new() };
                let Ok(out) = base(path).arg("--list-langs").output() else {
                    return Vec::new();
                };
                // The first line is a header ("List of available languages...") and `osd` is
                // an orientation-detection model, not a language anyone can pick.
                String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .skip(1)
                    .map(str::trim)
                    .filter(|l| !l.is_empty() && *l != "osd")
                    .map(str::to_string)
                    .collect()
            })
            .clone()
    }

    pub fn options() -> Vec<OcrLanguage> {
        languages()
            .into_iter()
            .map(|id| {
                let name = NAMES
                    .iter()
                    .find(|(code, _)| *code == id)
                    .map(|(_, name)| (*name).to_string())
                    .unwrap_or_else(|| id.clone());
                // Named as coming from Tesseract because both engines can appear in the same
                // list, and which one runs changes both the accuracy and whether uncertain
                // lines get flagged.
                OcrLanguage { label: format!("{name} · Tesseract"), id }
            })
            .collect()
    }

    /// One TSV row per word, grouped back into lines.
    ///
    /// `tesseract` writes text-only output with no geometry, and the paragraph grouping needs
    /// to know where each line sat. The TSV mode gives a bounding box and a confidence per
    /// word, which is more than the Windows engine offers — so where this backend runs, the
    /// "check this line" marking works again.
    fn parse_tsv(tsv: &str, image_height: f32) -> Vec<OcrLine> {
        struct Group {
            words: Vec<String>,
            conf: f32,
            n: f32,
            top: f32,
            bottom: f32,
        }
        let mut order: Vec<(u32, u32, u32)> = Vec::new();
        let mut groups: std::collections::HashMap<(u32, u32, u32), Group> = Default::default();

        for row in tsv.lines().skip(1) {
            let f: Vec<&str> = row.split('\t').collect();
            if f.len() < 12 || f[0] != "5" {
                continue;
            }
            let text = f[11].trim();
            let conf: f32 = f[10].parse().unwrap_or(-1.0);
            // A negative confidence marks a box tesseract found but read nothing in.
            if text.is_empty() || conf < 0.0 {
                continue;
            }
            let (Ok(block), Ok(par), Ok(line)) =
                (f[2].parse::<u32>(), f[3].parse::<u32>(), f[4].parse::<u32>())
            else {
                continue;
            };
            // Columns 6..9 are left, top, width, height in that order — the vertical pair is
            // 7 and 9, and reading 6 instead of 7 silently substitutes the horizontal position
            // for the vertical one, which still produces plausible numbers.
            let (Ok(top), Ok(height)) = (f[7].parse::<f32>(), f[9].parse::<f32>()) else {
                continue;
            };

            let key = (block, par, line);
            let group = groups.entry(key).or_insert_with(|| {
                order.push(key);
                Group { words: Vec::new(), conf: 0.0, n: 0.0, top: f32::MAX, bottom: f32::MIN }
            });
            group.words.push(text.to_string());
            group.conf += conf;
            group.n += 1.0;
            group.top = group.top.min(top);
            group.bottom = group.bottom.max(top + height);
        }

        order
            .into_iter()
            .filter_map(|key| groups.remove(&key))
            .filter(|g| g.n > 0.0)
            .map(|g| {
                let boxed = g.bottom > g.top && image_height > 0.0;
                OcrLine {
                    text: g.words.join(" "),
                    // Tesseract scores each word 0..100; `OcrLine` is defined 0..1, and the
                    // line is only as trustworthy as its words average out to be.
                    confidence: (g.conf / g.n / 100.0).clamp(0.0, 1.0),
                    // Pixels from the top, converted to Vision's convention — normalised, with
                    // the origin at the bottom — so every backend hands the paragraph grouper
                    // the same coordinate system.
                    y: if boxed { 1.0 - g.bottom / image_height } else { 0.0 },
                    height: if boxed { (g.bottom - g.top) / image_height } else { 0.0 },
                }
            })
            .collect()
    }

    /// Which of the user's chosen languages this install can actually read, in their order.
    pub fn wanted(langs: &[String]) -> Vec<String> {
        let have = languages();
        langs.iter().filter(|l| have.contains(l)).cloned().collect()
    }

    pub fn recognize(bytes: &[u8], langs: &[String]) -> Result<OcrResult, String> {
        let path = path().ok_or("Tesseract is not installed.")?;
        let picked = wanted(langs);
        if picked.is_empty() {
            return Err("No Tesseract language selected.".into());
        }

        let height = image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| e.to_string())?
            .into_dimensions()
            .map_err(|e| e.to_string())?
            .1 as f32;

        let mut child = base(path)
            // `-` twice: read the image from stdin, write the result to stdout, so nothing
            // touches the disk. `tsv` is the output mode, and has to come last.
            .args(["-", "-", "-l", &picked.join("+"), "--psm", "3", "tsv"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not run Tesseract: {e}"))?;

        // Written from another thread: a screenshot is larger than the pipe buffer, so writing
        // it all before starting to read deadlocks — tesseract blocks writing output that
        // nobody is draining while we block writing input it is not reading.
        let mut stdin = child.stdin.take().ok_or("Tesseract refused input")?;
        let image = bytes.to_vec();
        let writer = std::thread::spawn(move || stdin.write_all(&image));

        let out = child
            .wait_with_output()
            .map_err(|e| format!("Tesseract failed: {e}"))?;
        let _ = writer.join();

        if !out.status.success() {
            let why = String::from_utf8_lossy(&out.stderr);
            let why = why.trim();
            return Err(if why.is_empty() {
                "Tesseract could not read that image.".to_string()
            } else {
                format!("Tesseract: {why}")
            });
        }

        let lines = parse_tsv(&String::from_utf8_lossy(&out.stdout), height);
        let low = lines
            .iter()
            .filter(|l| l.confidence < super::LOW_CONFIDENCE)
            .count() as u32;
        Ok(OcrResult {
            text: lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n"),
            lines,
            low_confidence: low,
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod backend {
    use super::{tesseract, OcrLanguage, OcrResult};

    pub fn available() -> bool {
        cfg!(windows) || tesseract::path().is_some()
    }

    /// Both engines in one list, each entry saying which it belongs to.
    ///
    /// They are not interchangeable: the system engine covers a fixed set of languages and
    /// scores nothing, Tesseract covers whatever the user installed and scores every word. The
    /// picker is where that choice gets made, so it has to show both rather than silently
    /// preferring one.
    pub fn languages() -> Result<Vec<OcrLanguage>, String> {
        #[allow(unused_mut)]
        let mut out: Vec<OcrLanguage> = Vec::new();
        #[cfg(windows)]
        out.extend(super::winocr::languages().unwrap_or_default());
        out.extend(tesseract::options());
        Ok(out)
    }

    pub fn recognize(bytes: &[u8], langs: &[String]) -> Result<OcrResult, String> {
        // Tesseract first when the user picked one of its languages. They installed it on
        // purpose, it reads languages the system engine has no model for at all, and it is the
        // only one of the two that reports confidence.
        if !tesseract::wanted(langs).is_empty() {
            return tesseract::recognize(bytes, langs);
        }
        #[cfg(windows)]
        {
            super::winocr::recognize(bytes, langs)
        }
        #[cfg(not(windows))]
        {
            let _ = (bytes, langs);
            Err("Text recognition on this platform needs Tesseract. Install it, then pick one \
                 of its languages in Settings."
                .into())
        }
    }
}

/// Recognise text in an encoded image (PNG/JPEG bytes).
///
/// The seam between "get the pixels" and "read the words": the two commands below differ only
/// in where the bytes come from.
fn recognize_bytes(bytes: &[u8], langs: &[String]) -> Result<OcrResult, String> {
    backend::recognize(bytes, langs)
}

/// Whether this build can recognise text at all, so the UI can hide the feature rather than
/// offer a button that only ever errors.
///
/// True on Windows even when no recognizer language pack is installed: the engine is there, the
/// user simply has to add a language, and `recognize` says so in words they can act on. Hiding
/// the feature instead would leave them nothing to read. Elsewhere it depends on whether the
/// user has installed Tesseract, which is a question only answerable at runtime.
#[tauri::command]
pub fn ocr_available() -> bool {
    backend::available()
}

/// Whether the optional Tesseract engine is installed, so Settings can offer to explain how to
/// get it rather than leaving a user wondering why their language is not in the list.
#[tauri::command]
pub fn tesseract_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        false
    }
    #[cfg(not(target_os = "macos"))]
    {
        tesseract::path().is_some()
    }
}

#[tauri::command]
pub fn list_ocr_languages() -> Result<Vec<OcrLanguage>, String> {
    backend::languages()
}

fn configured_languages(settings: &State<SettingsState>) -> Vec<String> {
    settings
        .lock()
        .map(|s| s.ocr_languages.clone())
        .unwrap_or_else(|_| vec!["en-US".into()])
}

/// Read text straight off the screen, without saving a capture.
///
/// This is the whole point of the "Capture Text" flow: the user wants the words, not a
/// picture of the words, so nothing is written to the library at all.
#[tauri::command]
pub fn ocr_region(
    settings: State<SettingsState>,
    monitor_id: Option<u32>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<OcrResult, String> {
    if width == 0 || height == 0 {
        return Err("Empty selection".into());
    }
    let img = capture_region_image(monitor_id, x, y, width, height)?;
    let png = encode_png(&img)?;
    recognize_bytes(&png, &configured_languages(&settings))
}

/// Recognise text in an image already in the library.
#[tauri::command]
pub fn ocr_item(
    lib_state: State<LibraryState>,
    settings: State<SettingsState>,
    id: String,
) -> Result<OcrResult, String> {
    let path = {
        let lib = lib_state.lock().map_err(|e| e.to_string())?;
        let item = lib.get(&id).ok_or_else(|| "Item not found".to_string())?;
        if item.kind != "screenshot" {
            return Err("Text recognition only works on images.".into());
        }
        lib.path_of(&item.file_name)
    };
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    recognize_bytes(&bytes, &configured_languages(&settings))
}

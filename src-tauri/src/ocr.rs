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
mod backend {
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

    /// One engine, one language — unlike Vision, which takes a list and sorts it out itself.
    /// The user's preference order decides, and anything they picked that this machine has no
    /// recognizer for is skipped rather than treated as an error.
    fn engine_for(langs: &[String]) -> Result<OcrEngine, String> {
        for tag in langs {
            let Ok(lang) = Language::CreateLanguage(&HSTRING::from(tag.as_str())) else {
                continue;
            };
            if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
                return Ok(engine);
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

#[cfg(not(any(target_os = "macos", windows)))]
mod backend {
    use super::{OcrLanguage, OcrResult};

    const UNSUPPORTED: &str =
        "Text recognition uses the operating system's own engine, and this build has none for \
         this platform.";

    pub fn languages() -> Result<Vec<OcrLanguage>, String> {
        Ok(Vec::new())
    }

    pub fn recognize(_bytes: &[u8], _langs: &[String]) -> Result<OcrResult, String> {
        Err(UNSUPPORTED.into())
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
/// the feature instead would leave them nothing to read.
#[tauri::command]
pub fn ocr_available() -> bool {
    cfg!(any(target_os = "macos", windows))
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

//! Text recognition, running entirely on the operating system's own engine.
//!
//! On macOS that is Vision (`VNRecognizeTextRequest`), the same recogniser behind Live Text.
//! Using it instead of bundling Tesseract keeps this offline, adds no model files to a 27 MB
//! app bundle, and gets Apple's accuracy — including Vietnamese, which Vision has supported
//! since it grew past its original handful of Latin languages.
//!
//! Images are handed to Vision as encoded PNG bytes via `initWithData:options:` rather than
//! by constructing a `CGImage` by hand: Vision decodes the data itself, so there is no manual
//! pixel-format, stride or colour-space plumbing to get subtly wrong.

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

#[cfg(not(target_os = "macos"))]
mod backend {
    use super::{OcrLanguage, OcrResult};

    const UNSUPPORTED: &str =
        "Text recognition is only available on macOS in this build — it uses the system's \
         built-in Vision engine rather than a bundled one.";

    pub fn languages() -> Result<Vec<OcrLanguage>, String> {
        Ok(Vec::new())
    }

    pub fn recognize(_png: &[u8], _langs: &[String]) -> Result<OcrResult, String> {
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
#[tauri::command]
pub fn ocr_available() -> bool {
    cfg!(target_os = "macos")
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

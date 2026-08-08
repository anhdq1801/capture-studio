//! Small persisted preferences file, kept next to the library so it travels with it.

use crate::library::default_library_dir;
use crate::models::AppSettings;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

pub type SettingsState = Mutex<AppSettings>;

fn settings_path() -> PathBuf {
    default_library_dir().join("settings.json")
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            // "source" keeps the display's native resolution.
            resolution: "source".into(),
            codec: "h264".into(),
            // Vision takes several languages at once and uses the order as priority, so the
            // common case for this user — Vietnamese UI with English technical text mixed in —
            // works without touching Settings at all.
            ocr_languages: vec!["vi-VT".into(), "en-US".into()],
        }
    }
}

pub fn load() -> AppSettings {
    fs::read_to_string(settings_path())
        .ok()
        .and_then(|s| serde_json::from_str::<AppSettings>(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_app_settings(state: State<SettingsState>) -> Result<AppSettings, String> {
    Ok(state.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
pub fn set_app_settings(
    state: State<SettingsState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let dir = default_library_dir();
    let _ = fs::create_dir_all(&dir);
    if let Ok(json) = serde_json::to_string_pretty(&settings) {
        let _ = fs::write(settings_path(), json);
    }
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    *guard = settings.clone();
    Ok(settings)
}

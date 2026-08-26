//! Small persisted preferences file, kept next to the library so it travels with it.

use crate::library::default_library_dir;
use crate::models::AppSettings;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

pub type SettingsState = Mutex<AppSettings>;

fn settings_path() -> PathBuf {
    default_library_dir().join("settings.json")
}

/// Every action that can carry a global shortcut: the id it is stored and displayed under, the
/// `tray-action` it fires, and the key it ships bound to.
///
/// One table, used by the registration, the tray menu and the Settings list alike, because the
/// three drifting apart is exactly how an app ends up advertising a shortcut it never bound.
/// The ids are the tray menu's own item ids so the menu can show whatever the user has chosen;
/// `record` is the one place they differ from the action, because clicking it in the menu opens
/// the window first while the shortcut only toggles.
pub const SHORTCUTS: [(&str, &str, &str); 7] = [
    ("capture-region", "capture-region", "2"),
    ("capture-full", "capture-full", "1"),
    ("capture-window", "capture-window", "3"),
    ("capture-scroll", "capture-scroll", "4"),
    ("record", "record-toggle", "5"),
    ("capture-text", "capture-text", "6"),
    ("clipboard", "clipboard", "V"),
];

/// Accelerator for a default capture shortcut.
///
/// Control rather than Command, because macOS owns ⇧⌘3 through ⇧⌘6 for its own screenshot
/// tools and wins every one of them — four of the seven defaults were dead on arrival. ⌃⇧ is
/// clear at the system level, and the token means Ctrl on Windows too, so one string covers
/// both platforms. (`Cmd` would not: it is macOS-only and the plugin fails to parse it
/// elsewhere.)
pub fn accel(key: &str) -> String {
    format!("Control+Shift+{key}")
}

pub fn default_shortcuts() -> HashMap<String, String> {
    SHORTCUTS
        .iter()
        .map(|(id, _, key)| ((*id).to_string(), accel(key)))
        .collect()
}

/// What `id` is actually bound to: the user's choice, or the shipped default when they have
/// never expressed one. See `AppSettings::shortcuts` for why absent and empty differ.
pub fn combo_for(shortcuts: &HashMap<String, String>, id: &str, default_key: &str) -> String {
    match shortcuts.get(id) {
        Some(chosen) => chosen.clone(),
        None => accel(default_key),
    }
}

/// Write settings to disk. Failures are ignored deliberately: a preference that cannot be
/// persisted should still apply to the running app rather than being refused outright.
pub fn save(settings: &AppSettings) {
    let dir = default_library_dir();
    let _ = fs::create_dir_all(&dir);
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        let _ = fs::write(settings_path(), json);
    }
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
            shortcuts: default_shortcuts(),
            image_format: "png".into(),
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
    mut settings: AppSettings,
) -> Result<AppSettings, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    // Shortcuts have their own command, because changing one has to rebind and rebuild the tray
    // menu as well as save. The copy that arrives here is whatever the Settings screen read when
    // it opened, so honouring it would undo a rebinding the moment the user changed the codec.
    settings.shortcuts = guard.shortcuts.clone();
    save(&settings);
    *guard = settings.clone();
    Ok(settings)
}


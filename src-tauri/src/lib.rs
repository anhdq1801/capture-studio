mod capture;
mod cloud;
mod library;
mod license;
mod models;
mod ocr;
mod optimize;
mod permissions;
mod recorder;
mod scroll;
mod settings;

use cloud::CloudState;
use library::{Library, LibraryState};
use license::LicenseState;
use models::MediaItem;
use recorder::RecorderState;
use scroll::ScrollState;
use settings::SettingsState;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IconMenuItem, Menu, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[tauri::command]
fn get_library(state: tauri::State<LibraryState>) -> Result<Vec<MediaItem>, String> {
    let lib = state.lock().map_err(|e| e.to_string())?;
    Ok(lib.sorted())
}

#[tauri::command]
fn get_library_dir(state: tauri::State<LibraryState>) -> Result<String, String> {
    let lib = state.lock().map_err(|e| e.to_string())?;
    Ok(lib.dir.to_string_lossy().to_string())
}

#[tauri::command]
fn item_path(state: tauri::State<LibraryState>, id: String) -> Result<String, String> {
    let lib = state.lock().map_err(|e| e.to_string())?;
    let item = lib.get(&id).ok_or_else(|| "Item not found".to_string())?;
    Ok(lib.path_of(&item.file_name).to_string_lossy().to_string())
}

#[tauri::command]
fn update_note(
    state: tauri::State<LibraryState>,
    id: String,
    note: String,
) -> Result<MediaItem, String> {
    let mut lib = state.lock().map_err(|e| e.to_string())?;
    lib.update(&id, |it| it.note = note)
        .ok_or_else(|| "Item not found".to_string())
}

/// Ids of the given items that have a cloud copy, read before they leave the index.
///
/// Once `Library::remove` has run the item is gone and there is no way left to know it was
/// ever uploaded — so the cloud copy would be stranded in the bucket, billed monthly, with
/// nothing pointing at it.
fn uploaded_among(lib: &library::Library, ids: &[String]) -> Vec<String> {
    ids.iter()
        .filter(|id| lib.get(id).is_some_and(|it| it.cloud_url.is_some()))
        .cloned()
        .collect()
}

/// Delete the cloud copies of `ids` without blocking the local delete.
///
/// Best-effort by design: the user asked to delete local files, and being offline or logged
/// out must not stop that. The server's nightly sweep is the backstop for whatever fails here.
fn reap_cloud_copies(cloud: &tauri::State<CloudState>, ids: Vec<String>) {
    if ids.is_empty() {
        return;
    }
    let Some(token) = cloud::current_token(cloud) else { return };
    tauri::async_runtime::spawn(async move {
        for id in ids {
            if let Err(e) = cloud::delete_cloud_copy(&token, &id).await {
                eprintln!("cloud delete for {id} failed: {e}");
            }
        }
    });
}

#[tauri::command]
fn delete_item(
    state: tauri::State<LibraryState>,
    cloud: tauri::State<CloudState>,
    id: String,
) -> Result<bool, String> {
    let mut lib = state.lock().map_err(|e| e.to_string())?;
    let uploaded = uploaded_among(&lib, std::slice::from_ref(&id));
    let removed = lib.remove(&id);
    drop(lib);
    if removed {
        reap_cloud_copies(&cloud, uploaded);
    }
    Ok(removed)
}

/// Delete several items at once, taking the library lock a single time so a multi-select
/// delete doesn't rewrite the index file once per item.
#[tauri::command]
fn delete_items(
    state: tauri::State<LibraryState>,
    cloud: tauri::State<CloudState>,
    ids: Vec<String>,
) -> Result<u32, String> {
    let mut lib = state.lock().map_err(|e| e.to_string())?;
    let uploaded = uploaded_among(&lib, &ids);
    let mut removed = 0;
    for id in ids {
        if lib.remove(&id) {
            removed += 1;
        }
    }
    drop(lib);
    reap_cloud_copies(&cloud, uploaded);
    Ok(removed)
}

#[tauri::command]
fn reveal_item(state: tauri::State<LibraryState>, id: String) -> Result<(), String> {
    let path = {
        let lib = state.lock().map_err(|e| e.to_string())?;
        let item = lib.get(&id).ok_or_else(|| "Item not found".to_string())?;
        lib.path_of(&item.file_name)
    };
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg("-R").arg(&path).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer")
        .arg("/select,")
        .arg(&path)
        .spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open")
        .arg(path.parent().unwrap_or(&path))
        .spawn();
    Ok(())
}

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
}

/// Bring the main window to the foreground (recreating it is not needed — we hide, not close).
fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Register every global shortcut from `shortcuts`, replacing whatever was registered before.
///
/// Returns the ids the system would not hand over. A combination another app already holds
/// cannot be registered, and that failure used to be discarded — so a shortcut the menu still
/// advertised simply did nothing, with nothing anywhere to say why. It is reported instead, and
/// the rest are still bound: one rejected combination must not cost the user the other six.
///
/// The list is not a guarantee, which is why Settings words its warning carefully. macOS hands
/// a hot key to whoever asked first only among apps that ask the same way; one holding ⌃⇧4
/// through an event tap shadows ours without this ever seeing an error.
fn apply_shortcuts(app: &tauri::AppHandle, shortcuts: &HashMap<String, String>) -> Vec<String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut failed = Vec::new();
    for (id, action, default_key) in settings::SHORTCUTS {
        let combo = settings::combo_for(shortcuts, id, default_key);
        // An entry the user cleared on purpose. Nothing to bind, and nothing wrong.
        if combo.is_empty() {
            continue;
        }
        let h = app.clone();
        if let Err(e) = gs.on_shortcut(combo.as_str(), move |_app, _sc, event| {
            if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                dispatch(&h, action);
            }
        }) {
            eprintln!("shortcut {combo} ({action}) could not be registered: {e}");
            failed.push(id.to_string());
        }
    }
    failed
}

/// Whether the tray menu should use the dark glyph set.
fn is_dark(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.theme().ok())
        .map(|t| t == tauri::Theme::Dark)
        .unwrap_or(false)
}

/// Rebuild the tray menu against the given appearance, and the current autostart state and
/// shortcuts.
///
/// All three are baked into the menu when it is built — the glyphs are plain bitmaps and the
/// accelerators plain text — so changing any of them means building the whole thing again. A
/// build that fails leaves the previous menu in place, which is the right outcome: a stale
/// accelerator beside an item is a much smaller problem than no tray menu at all.
///
/// The appearance is the one argument rather than another lookup because the caller that knows
/// it has changed is the `ThemeChanged` handler, which should not have to assume the window
/// already reports the new value.
fn rebuild_tray_menu(app: &tauri::AppHandle, dark: bool) {
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let shortcuts = app
        .state::<SettingsState>()
        .lock()
        .map(|s| s.shortcuts.clone())
        .unwrap_or_default();
    if let (Ok(menu), Some(tray)) = (
        build_tray_menu(app, dark, autostart_on, &shortcuts),
        app.tray_by_id("main-tray"),
    ) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Release every global shortcut while Settings is waiting for the user to press a new one, and
/// put them back afterwards.
///
/// A registered hot key is taken by the system before the focused app sees the keypress, so
/// without this the only combinations that could be recorded are the ones not already bound:
/// pressing ⌃⇧2 to move it somewhere else would fire a capture instead of being read.
#[tauri::command]
fn pause_shortcuts(
    app: tauri::AppHandle,
    state: tauri::State<SettingsState>,
    paused: bool,
) -> Result<(), String> {
    if paused {
        let _ = app.global_shortcut().unregister_all();
        return Ok(());
    }
    let guard = state.lock().map_err(|e| e.to_string())?;
    apply_shortcuts(&app, &guard.shortcuts);
    Ok(())
}

/// Rebind the global shortcuts and persist them.
///
/// Returns the ids that could not be registered, so Settings can mark those rows rather than
/// claiming a save that did not take effect. Two actions sharing a combination is rejected
/// outright instead: whichever lost the race would look broken for no visible reason.
#[tauri::command]
fn set_shortcuts(
    app: tauri::AppHandle,
    state: tauri::State<SettingsState>,
    shortcuts: HashMap<String, String>,
) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    for (id, _, default_key) in settings::SHORTCUTS {
        let combo = settings::combo_for(&shortcuts, id, default_key);
        if !combo.is_empty() && !seen.insert(combo.clone()) {
            return Err(format!("{combo} is already used by another action"));
        }
    }

    // Written and registered under one lock, so this cannot interleave with the `pause_shortcuts`
    // that Settings issues as it stops listening and end up re-registering the previous set on
    // top of the new one. The menu is rebuilt after the lock is released — it reads the same
    // state, and holding it across that call would deadlock.
    let (updated, failed) = {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard.shortcuts = shortcuts;
        let failed = apply_shortcuts(&app, &guard.shortcuts);
        (guard.clone(), failed)
    };
    settings::save(&updated);
    // So the menu stops advertising the combination the user just replaced.
    rebuild_tray_menu(&app, is_dark(&app));
    Ok(failed)
}

fn dispatch(app: &tauri::AppHandle, action: &str) {
    let _ = app.emit("tray-action", action);
}

/// One tray-menu glyph, in whichever set matches the current appearance.
///
/// Both sets are baked into the binary — 24 PNGs of about a kilobyte each — so switching costs
/// nothing at runtime and the menu never depends on files on disk. See `icons/menu/README.md`
/// for why there are two sets rather than one template image.
macro_rules! menu_icon {
    ($dark:expr, $name:literal) => {
        if $dark {
            include_bytes!(concat!("../icons/menu/dark/", $name, ".png")) as &[u8]
        } else {
            include_bytes!(concat!("../icons/menu/light/", $name, ".png")) as &[u8]
        }
    };
}

/// Build the tray menu against one appearance.
///
/// Rebuilt from scratch when the system switches between light and dark, because the glyphs are
/// plain bitmaps that do not adapt on their own. `autostart_on` is passed in rather than read
/// here so a rebuild can preserve the checkbox without re-querying the launch agent.
fn build_tray_menu<R: tauri::Runtime, M: Manager<R>>(
    app: &M,
    dark: bool,
    autostart_on: bool,
    shortcuts: &HashMap<String, String>,
) -> tauri::Result<Menu<R>> {
    // Every item carries a glyph. The menu is the app's primary surface — most captures start
    // here rather than in the window — and a column of identically shaped text is slow to scan
    // for the one action you want.
    let mi = |id: &str, label: &str, accel: Option<&str>, icon: &[u8]| {
        IconMenuItem::with_id(app, id, label, true, Some(Image::from_bytes(icon)?), accel)
    };
    // What to print down the right-hand edge. Read from the same settings the shortcuts are
    // registered from, so an item never promises a key combination that is no longer bound —
    // and shows nothing at all for an action the user has deliberately unbound.
    let sc = |id: &str, default_key: &str| {
        let combo = settings::combo_for(shortcuts, id, default_key);
        (!combo.is_empty()).then_some(combo)
    };
    let show = mi("show", "Open Capture Studio", None, menu_icon!(dark, "app"))?;
    let region = mi(
        "capture-region",
        "Capture Area",
        sc("capture-region", "2").as_deref(),
        menu_icon!(dark, "area"),
    )?;
    let full = mi(
        "capture-full",
        "Capture Screen",
        sc("capture-full", "1").as_deref(),
        menu_icon!(dark, "screen"),
    )?;
    let window = mi(
        "capture-window",
        "Capture Window",
        sc("capture-window", "3").as_deref(),
        menu_icon!(dark, "window"),
    )?;
    let scroll = mi(
        "capture-scroll",
        "Scrolling Capture",
        sc("capture-scroll", "4").as_deref(),
        menu_icon!(dark, "scroll"),
    )?;
    let text = mi(
        "capture-text",
        "Capture Text (OCR)",
        sc("capture-text", "6").as_deref(),
        menu_icon!(dark, "text"),
    )?;
    let record = mi(
        "record",
        "Screen Recording",
        sc("record", "5").as_deref(),
        menu_icon!(dark, "record"),
    )?;
    let delayed = mi(
        "capture-delayed",
        "Delayed Screenshot (3s)",
        None,
        menu_icon!(dark, "delayed"),
    )?;
    let open_file = mi(
        "open-file",
        "Open an Image File…",
        None,
        menu_icon!(dark, "openfile"),
    )?;
    let clipboard = mi(
        "clipboard",
        "Paste Image From Clipboard",
        sc("clipboard", "V").as_deref(),
        menu_icon!(dark, "clipboard"),
    )?;
    // Settings and Quit have no global binding, so showing an accelerator here would promise a
    // key combination that does nothing outside the menu.
    let settings = mi("settings", "Settings", None, menu_icon!(dark, "settings"))?;
    // No icon: a check item already owns the state column, and muda has no icon-plus-checkmark
    // item. macOS menus mix the two freely, so this is fine.
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Launch at Startup",
        true,
        autostart_on,
        None::<&str>,
    )?;
    let quit = mi("quit", "Quit Capture Studio", None, menu_icon!(dark, "quit"))?;
    let sep = || PredefinedMenuItem::separator(app);

    Menu::with_items(
        app,
        &[
            &show,
            &sep()?,
            &region,
            &full,
            &window,
            &scroll,
            &text,
            &record,
            &delayed,
            &sep()?,
            &open_file,
            &clipboard,
            &sep()?,
            &autostart,
            &settings,
            &sep()?,
            &quit,
        ],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage::<LibraryState>(Mutex::new(Library::load()))
        .manage::<RecorderState>(Mutex::new(None))
        .manage::<CloudState>(Mutex::new(cloud::load_session()))
        .manage::<ScrollState>(Mutex::new(None))
        .manage::<SettingsState>(Mutex::new(settings::load()))
        .manage::<LicenseState>(Mutex::new(license::load()))
        .setup(|app| {
            let handle = app.handle().clone();

            // Ensure the asset protocol can reach the library folder.
            let dir = library::default_library_dir();
            let _ = std::fs::create_dir_all(&dir);
            let _ = app.asset_protocol_scope().allow_directory(&dir, true);

            // ---- Tray menu ----
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
            // The glyphs beside each item are plain bitmaps, so the set has to match the system
            // appearance; `is_dark` is re-read and the menu rebuilt whenever that changes.
            let dark = is_dark(&handle);
            let shortcuts = app
                .state::<SettingsState>()
                .lock()
                .map(|s| s.shortcuts.clone())
                .unwrap_or_default();
            // A stored combination the menu cannot render must not take the tray down with it:
            // `?` here would mean a single bad accelerator in settings.json leaves the app with
            // no menu bar icon and no way to reach Settings to fix it.
            let menu = build_tray_menu(app, dark, autostart_on, &shortcuts)
                .or_else(|_| {
                    build_tray_menu(app, dark, autostart_on, &settings::default_shortcuts())
                })?;

            TrayIconBuilder::with_id("main-tray")
                // Not the app icon: that one is a full-colour tile meant for the Dock, and the
                // menu bar wants a flat silhouette. Marked as a template so macOS draws it white
                // on a dark menu bar and black on a light one — a hard-coded white icon
                // disappears in light mode.
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Capture Studio")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| {
                    let app = app.clone();
                    match event.id().as_ref() {
                        "show" => show_main(&app),
                        "settings" => {
                            show_main(&app);
                            dispatch(&app, "settings");
                        }
                        "capture-full" => dispatch(&app, "capture-full"),
                        "capture-region" => dispatch(&app, "capture-region"),
                        "capture-window" => dispatch(&app, "capture-window"),
                        "capture-scroll" => dispatch(&app, "capture-scroll"),
                        "capture-text" => dispatch(&app, "capture-text"),
                        "record" => {
                            show_main(&app);
                            dispatch(&app, "record");
                        }
                        "capture-delayed" => dispatch(&app, "capture-delayed"),
                        "open-file" => {
                            show_main(&app);
                            dispatch(&app, "open-file");
                        }
                        "clipboard" => dispatch(&app, "clipboard"),
                        "autostart" => {
                            let mgr = app.autolaunch();
                            let now = mgr.is_enabled().unwrap_or(false);
                            let _ = if now { mgr.disable() } else { mgr.enable() };
                            dispatch(&app, "autostart-changed");
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;

            // ---- Global shortcuts ----
            apply_shortcuts(&handle, &shortcuts);

            // ---- Close the main window to the tray instead of quitting ----
            if let Some(win) = app.get_webview_window("main") {
                let w = win.clone();
                let themed = app.handle().clone();
                win.on_window_event(move |event| match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                    // The menu glyphs are bitmaps in a fixed colour, so switching between light
                    // and dark mode would otherwise leave dark-on-dark or light-on-light icons.
                    // Rebuilding the whole menu is the only way to change them — muda exposes no
                    // way to replace an item's image in place.
                    WindowEvent::ThemeChanged(theme) => {
                        rebuild_tray_menu(&themed, *theme == tauri::Theme::Dark)
                    }
                    _ => {}
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_library,
            get_library_dir,
            item_path,
            update_note,
            delete_item,
            delete_items,
            reveal_item,
            get_autostart,
            set_autostart,
            set_shortcuts,
            pause_shortcuts,
            capture::list_monitors,
            capture::list_windows,
            capture::capture_monitor,
            capture::capture_region,
            capture::capture_window,
            capture::grab_screen,
            capture::import_png,
            capture::import_file,
            capture::import_from_clipboard,
            capture::set_clipboard_png,
            capture::set_clipboard_text,
            capture::save_annotated,
            capture::keep_item,
            scroll::scroll_start,
            scroll::scroll_step,
            scroll::scroll_finish,
            scroll::scroll_cancel,
            optimize::optimize_image,
            optimize::scan_images,
            optimize::optimize_files,
            permissions::screen_permission_granted,
            permissions::request_screen_permission,
            permissions::open_screen_permission_settings,
            permissions::restart_app,
            recorder::check_ffmpeg,
            recorder::list_capture_devices,
            recorder::start_recording,
            recorder::stop_recording,
            recorder::is_recording,
            recorder::list_video_codecs,
            recorder::ensure_thumbnail,
            license::get_license_status,
            license::activate_license,
            license::remove_license,
            license::snooze_license_nudge,
            ocr::ocr_available,
            ocr::tesseract_available,
            ocr::list_ocr_languages,
            ocr::ocr_region,
            ocr::ocr_item,
            settings::get_app_settings,
            settings::set_app_settings,
            cloud::cloud_signup,
            cloud::cloud_login,
            cloud::cloud_logout,
            cloud::get_account_status,
            cloud::delete_account,
            cloud::create_paypal_subscription,
            cloud::create_payos_payment,
            cloud::get_pricing,
            cloud::upload_item,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

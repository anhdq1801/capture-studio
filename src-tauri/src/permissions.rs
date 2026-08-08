//! Screen-recording permission, asked for up front instead of discovered afterwards.
//!
//! macOS does not fail a screen grab that lacks permission — it returns a picture of the
//! desktop with every window stripped out of it. The capture therefore "succeeds", and what
//! lands in the library is the wallpaper, which reads as a broken app rather than as a
//! missing permission. Nothing in the capture path can tell the two apart after the fact, so
//! the check has to happen before the shutter, which is what these commands are for.

#[cfg(target_os = "macos")]
mod platform {
    // Preflight reports the current state and never shows UI. Request shows the system
    // dialog, but only the first time it is called for a given binary: once the user has
    // answered — or once the entry exists at all — it returns the stored answer with no UI,
    // which is why callers still need a way into System Settings.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub fn granted() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    pub fn request() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }

    /// Deep-links to the exact pane, because "Privacy & Security → Screen & System Audio
    /// Recording" is several scrolls down a long list.
    pub fn open_settings() -> Result<(), String> {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

// Windows and Linux gate screen capture at install time, if at all — there is no runtime
// permission to check, so every answer here is "yes" and the UI stays out of the way.
#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn granted() -> bool {
        true
    }

    pub fn request() -> bool {
        true
    }

    pub fn open_settings() -> Result<(), String> {
        Ok(())
    }
}

/// Whether screen capture will actually return window content. Never prompts, so it is safe
/// to poll — on startup, and again whenever the window regains focus.
#[tauri::command]
pub fn screen_permission_granted() -> bool {
    platform::granted()
}

/// Ask the system to prompt. Returns the state afterwards; `false` means the dialog either
/// was declined or never appeared, and the caller should offer System Settings instead.
#[tauri::command]
pub fn request_screen_permission() -> bool {
    platform::request()
}

#[tauri::command]
pub fn open_screen_permission_settings() -> Result<(), String> {
    platform::open_settings()
}

/// macOS hands an already-running process the permission state it started with, so a grant
/// made in System Settings does not reach us until we come back up.
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart()
}

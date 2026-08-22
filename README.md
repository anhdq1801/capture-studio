# Capture Studio

Screenshots, screen recording, scrolling capture and text recognition for macOS — from the menu
bar, without a window in the way. Built with **Tauri v2 + React + Rust**.

---

## Download

> ### Apple Silicon only
>
> The released build is a plain `arm64` binary. **It does not run on Intel Macs** — Rosetta
> translates Intel → Apple Silicon, not the other way round, so an Intel Mac cannot run this no
> matter what. You need an M1 or later (any Mac sold from late 2020 onwards).
>
> The filename says so too: `Capture Studio_1.0.0_aarch64.dmg`.

Download the `.dmg` from [Releases](https://github.com/anhdq1801/capture-studio/releases).

### First run

**1. Install.** Open the `.dmg` and drag **Capture Studio** into Applications.

**2. Let macOS open it.** The first launch is blocked with *"Apple could not verify Capture Studio
is free of malware."* The app is signed, but not notarised by Apple, so macOS asks you to confirm
once:

> **System Settings › Privacy & Security** → scroll to the bottom → **Open Anyway** → launch the
> app again.

Right-clicking the app and choosing *Open* no longer works for this on macOS 15 and later; the
Settings route is the one that does.

**3. Grant Screen Recording, then restart the app.** macOS applies that permission only to a
*fresh launch*, so granting it does nothing to the app that is already running. Quit Capture
Studio completely and open it again.

Skipping the restart is the one mistake that looks like a broken app rather than a missing
permission: captures come back as the bare desktop wallpaper with every window stripped out,
because that is exactly what macOS hands to an app it has not authorised.

**4. For screen recording only, install ffmpeg.**

```bash
brew install ffmpeg
```

Screenshots, annotation, OCR, scrolling capture and the optimiser all work without it. The app
finds ffmpeg on its own — Homebrew, MacPorts or `PATH`, no configuration.

---

## Features

- **Capture Area, Screen, Window**, and a **3-second delayed** shot — from the menu bar, the
  sidebar, or a global shortcut.
- **Scrolling Capture** — stitch a page taller than the screen.
- **Capture Text (OCR)** — recognise text in a region straight to the clipboard, using the
  recogniser built into macOS. Vietnamese and English out of the box, no download, no API key.
- **Screen recording** — full screen or a region, microphone or loopback audio, adjustable frame
  rate and cursor capture, with a floating stop bar and a live timer. Outputs `.mp4`.
- **Annotation editor** — arrow, line, rectangle, ellipse, pen, highlighter, text,
  **step-numbers** and **blur/redact**, with a colour and stroke palette, live hex/size/zoom
  readout, undo, copy to clipboard and save-in-place.
- **Image optimiser** — re-encode to WebP / JPEG / PNG with a quality slider and optional
  downscale, showing before/after sizes. PNG goes through lossless `oxipng`.
- **Library** — a grid of everything captured, with notes, reveal-in-Finder and delete.
- **Import** — an existing image file, or whatever is on the clipboard.
- **Menu-bar app** — closing the window hides it to the tray rather than quitting. Optional
  launch at startup.
- **Upload to Cloud (optional, paid)** — the one feature that touches the network. See
  [Cloud upload](#cloud-upload-optional).

---

## Global shortcuts

Every one of these is **rebindable** in **Settings › General › Global shortcuts**. Click a
shortcut, press the keys you want; `Backspace` removes it, `Esc` cancels.

| Action | Default |
|--------|---------|
| Capture Area | ⇧⌘2 |
| Capture Screen | ⇧⌘1 |
| Capture Window | ⇧⌘3 |
| Scrolling Capture | ⇧⌘4 |
| Capture Text (OCR) | ⇧⌘6 |
| Screen Recording | ⇧⌘5 |
| Paste Image From Clipboard | ⇧⌘V |

They work anywhere, even with the window hidden in the menu bar.

> **Four of these defaults collide with macOS itself.** ⇧⌘3, ⇧⌘4, ⇧⌘5 and ⇧⌘6 belong to Apple's
> own screenshot tools, and macOS wins. If one of them does nothing, that is why — rebind it in
> Settings. The same goes for any combination another app already holds: Settings marks a row
> *in use elsewhere* when the system refuses it outright, but an app that grabs keys through an
> event tap shadows ours silently, so "nothing happens" is the symptom to watch for.

---

## Building from source

Needed on every platform:

- **Node.js** `^20.19.0` or `>=22.12.0` — Vite 7 does not run on Node 18.
- **Rust** (stable) — https://rustup.rs

```bash
npm install
npm run tauri dev      # run it
npm run tauri build    # produce a distributable
```

### macOS

Xcode Command Line Tools, which you almost certainly already have:

```bash
xcode-select --install
```

`npm run tauri build` produces `.app` and `.dmg` under
`src-tauri/target/release/bundle/`, built for whichever architecture the machine is.

To sign with your own certificate, change `bundle.macOS.signingIdentity` in
`src-tauri/tauri.conf.json`; to notarise, set `APPLE_ID`, `APPLE_PASSWORD` (an app-specific
password) and `APPLE_TEAM_ID` before building and Tauri handles the rest.

### Windows

> **Untested.** The Rust source has Windows paths throughout — screen capture, recording via
> `gdigrab`/`dshow`, reveal-in-Explorer — and the macOS-only dependencies are gated so they are
> never compiled elsewhere. But nobody has built or run this on Windows, so treat it as a
> starting point rather than a supported target. **Text recognition (OCR) is macOS-only** either
> way: it uses Apple's Vision framework, and off macOS the feature reports itself unavailable
> instead of appearing.

Install, in this order:

1. **Visual Studio Build Tools** — https://visualstudio.microsoft.com/visual-cpp-build-tools/
   In the installer, tick the **Desktop development with C++** workload. Rust's default Windows
   toolchain links through MSVC, so without this `cargo build` fails at the linker.
2. **Rust** — https://rustup.rs (take the default `x86_64-pc-windows-msvc` toolchain).
3. **Node.js** `20.19+` or `22.12+` — https://nodejs.org
4. **WebView2 Runtime** — already present on Windows 11 and current Windows 10. On an older
   machine, install the Evergreen runtime from
   https://developer.microsoft.com/microsoft-edge/webview2/
5. **ffmpeg**, only if you want screen recording. Download from https://ffmpeg.org and put
   `ffmpeg.exe` on `PATH`. The app also looks in `C:\ffmpeg\bin`, the Chocolatey shim directory
   and `C:\Program Files\ffmpeg\bin`, so a standard install needs no configuration.

Then:

```powershell
npm install
npm run tauri build
```

The installers land in `src-tauri\target\release\bundle\` — `.msi` (WiX) and `.exe` (NSIS).

Two things that will differ from macOS if you get it running: the global shortcuts bind
`Ctrl+Shift+…` instead of `⇧⌘…`, and capturing what you hear needs a loopback audio device
(Stereo Mix, or a virtual audio cable). Microphones work as they are.

---

## Architecture

| Layer | Tech |
|-------|------|
| Screenshot capture | Rust `xcap` |
| Image encode/optimize | Rust `image`, `webp` (libwebp), `oxipng` |
| Screen recording | system `ffmpeg` (avfoundation on macOS, gdigrab + dshow on Windows) |
| Text recognition | Apple Vision via `objc2-vision` (macOS only) |
| UI | React + TypeScript + Vite |
| Shell | Tauri v2 |

Captures live in `~/Pictures/CaptureStudio/`, indexed by `library.json`, with preferences in
`settings.json` beside it.

> **Continuing this project in another editor?** Read [`master-context.md`](master-context.md) —
> it documents the architecture, every backend command, the frontend data flow, the gotchas, and
> a prioritized list of next tasks.

---

## Cloud upload (optional)

Capture, annotation, recording and optimisation are free and fully offline — no account needed.
If you want a shareable link for an item, log in from **Settings › Account & Cloud Upload** and
subscribe (PayPal for card/international, PayOS for Vietnamese domestic payment); each plan
includes 3GB of storage with paid top-ups beyond that.

See [`server/README.md`](server/README.md) for deploying the backend (Cloudflare Workers + D1 +
R2). It must be deployed and `API_BASE` in `src-tauri/src/cloud.rs` updated before this feature
works.

---

## Roadmap

See [`master-context.md`](master-context.md) for full status. Outstanding:

- Individual annotation select/move/delete, and video trimming.
- Bundling ffmpeg so recording works without a separate install.
- A universal (Intel + Apple Silicon) build, and notarisation, so the `.dmg` opens without the
  Gatekeeper detour.
- Cloud upload is code-complete but the backend (`server/`) still needs deploying and its
  Cloudflare / PayPal / PayOS accounts configuring.

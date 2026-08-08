# Capture Studio

A cross-platform (macOS & Windows) desktop app to **capture screenshots, annotate them, record the screen, and shrink image file sizes** — built with **Tauri v2 + React + Rust**.

## Features

- **Screenshots** — full display, a specific monitor, or a drag-selected **region** (freeze-frame selector).
- **Annotation editor** — a Shottr-style toolbar: select, arrow, line, rectangle, ellipse, pen, highlighter, text, **step-numbers**, and **blur/redact**, with a color + stroke palette, live hex/size/zoom readout, undo/clear, **copy to clipboard**, and save-in-place.
- **Notes** — attach a text note to any capture.
- **Menu-bar app** — tray icon with quick actions and **global keyboard shortcuts** (⇧⌘1 screen, ⇧⌘2 area, ⇧⌘5 record, ⇧⌘V clipboard). Closing the window hides it to the tray instead of quitting. Optional **launch at startup**.
- **Screen recording (advanced)** — powered by `ffmpeg`: full screen or a selected region, microphone/loopback audio, adjustable frame rate, cursor capture, start/stop with a live timer. Output is `.mp4` (H.264).
- **Image optimization** — re-encode to **WebP / JPEG / PNG** with a quality slider and optional max-width downscale, with a live before/after size comparison. PNG uses lossless `oxipng`.
- **Import** — bring in an existing image file or the current clipboard image; **delayed (3s)** capture.
- **Library** — grid gallery of everything captured, with reveal-in-Finder/Explorer, delete, and per-item metadata.
- **Upload to Cloud (optional, paid)** — upload any item to get a public shareable link. Local
  capture/annotate/record/optimize stay free and fully offline; this is the one opt-in feature
  that talks to the network, gated behind a PayPal or PayOS (Vietnam) subscription. See
  [Cloud upload](#cloud-upload-optional) below.

> **Continuing this project in another editor?** Read [`master-context.md`](master-context.md) — it
> documents the architecture, every backend command, the frontend data flow, gotchas, and a
> prioritized list of next tasks.

## Architecture

| Layer | Tech |
|-------|------|
| Screenshot capture | Rust `xcap` (macOS + Windows) |
| Image encode/optimize | Rust `image`, `webp` (libwebp), `oxipng` |
| Screen recording | system `ffmpeg` (avfoundation on macOS, gdigrab+dshow on Windows) |
| UI | React + TypeScript + Vite |
| Shell | Tauri v2 |

Captures are stored in `~/Pictures/CaptureStudio/` with an index in `library.json`.

## Prerequisites

- Node.js 18+
- Rust (stable) — https://rustup.rs
- **ffmpeg** on `PATH` (required for recording)
  - macOS: `brew install ffmpeg`
  - Windows: download from ffmpeg.org and add to PATH

## Platform permissions

- **macOS** first run: grant **Screen Recording** permission in *System Settings → Privacy & Security → Screen Recording* for screenshots and recordings to work.
- **System audio**: capturing what you hear needs a loopback device — BlackHole (macOS) or Stereo Mix / virtual-audio-capturer (Windows). Microphones work out of the box.

## Development

```bash
npm install
npm run tauri dev      # run the app
npm run tauri build    # produce a distributable (.dmg / .app on macOS, .msi/.exe on Windows)
```

## Global shortcuts

| Action | Shortcut |
|--------|----------|
| Capture Screen | ⇧⌘1 |
| Capture Area | ⇧⌘2 |
| Screen Recording | ⇧⌘5 |
| Load From Clipboard | ⇧⌘V |

Shortcuts work anywhere, even when the window is hidden in the menu bar.

## Cloud upload (optional)

Local capture/annotate/record/optimize are always free and fully offline — no account needed. If
you want a shareable link for an item, log in from **Settings → Account & Cloud Upload** and
subscribe (PayPal for card/international, PayOS for Vietnamese domestic payment); each plan
includes 3GB of storage with paid top-ups available beyond that. See
[`server/README.md`](server/README.md) for deploying the backend (Cloudflare Workers + D1 + R2) —
it must be deployed and `src-tauri/src/cloud.rs`'s `API_BASE` updated before this feature works.

## Notes / roadmap

See [`master-context.md`](master-context.md) for the full status and next-task list. Highlights:

- Recording now hides the main window and shows a small floating stop-bar with a live timer; ⇧⌘5 is a true start/stop toggle.
- Individual annotation select/move/delete, video trimming, window-picker & scrolling capture, and bundling ffmpeg are planned.
- Cloud upload is code-complete but the backend (`server/`) still needs to be deployed and its
  Cloudflare/PayPal/PayOS accounts configured.

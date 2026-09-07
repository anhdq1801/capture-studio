# Capture Studio — Master Context (Handoff Document)

> Read this first if you are an AI/editor picking up this project. It is the single source of
> truth for architecture, conventions, what exists, and what to build next.

---

## 1. What this app is

A **cross-platform (macOS + Windows) desktop app** for:
- **Screenshots** — full display, a chosen monitor, a drag-selected region, a picked window, a
  scrolling capture, or **several regions of one display at once** (§13).
- **Text recognition (OCR)** — read text off a region or a library image. macOS Vision;
  `Windows.Media.Ocr` on Windows, with **Tesseract** for the languages it ships no model for —
  Vietnamese among them (§14).
- **Annotation / notes** — a Shottr-style image editor (arrows, shapes, pen, highlighter, text, step-numbers, blur/redact) plus a free-text note per capture.
- **Screen recording (advanced)** — full screen or region, mic/loopback audio, fps, cursor,
  start/stop, and an optional **zoom-to-cursor** pass over the finished video (§13).
- **Image size optimization** — re-encode to WebP/JPEG/PNG with quality + max-width, before/after comparison.
- **Menu-bar app** — tray icon with quick actions and **global keyboard shortcuts**, close-to-tray.
- **Upload to Cloud (opt-in, paid)** — per-item, uploads to Cloudflare R2 via a presigned URL and
  returns a public shareable link. See §11. **Built but switched off** — see below.

Capture, annotation, recording, and optimization are fully deterministic and offline — no network
calls, no telemetry. The only code that talks to the network is the explicit, per-item "Upload to
Cloud" action (§11), and shipped builds do not expose it: `COMMERCE_ENABLED` in
`src/lib/features.ts` is `false`, which hides the cloud button in `DetailModal` and
`AnnotationEditor`, the Account tab and licence-key field in `Settings`, and the licence nudge bar
in `App.tsx`. So the app as distributed makes no network calls at all. The flag exists because the
backend is undeployed and nothing is for sale; flipping it back on is a one-line change once
§11's "Not yet done" list is finished.

---

## 2. Tech stack

| Layer | Choice | Version |
|-------|--------|---------|
| Shell | **Tauri** | v2 (features: `macos-private-api`, `protocol-asset`, `tray-icon`, `image-png`) |
| Backend | **Rust** | edition 2021, toolchain stable (installed via rustup) |
| UI | **React + TypeScript + Vite** | React 19, TS 5.8, Vite 7 |
| Screenshot | `xcap` | 0.9.8 |
| Image encode | `image` 0.25, `webp` 0.3 (libwebp), `oxipng` 10 | |
| Recording | system **ffmpeg** (NOT bundled) | avfoundation (mac) / gdigrab+dshow (win) |
| Clipboard | `arboard` 3.6 | image read/write |
| Tauri plugins | `dialog`, `fs`, `shell`, `opener`, `global-shortcut`, `autostart` | v2 |
| Cloud upload (opt-in) | `reqwest` 0.12 (`json`,`stream`) + `tokio-util` (codec) in Rust; Cloudflare Workers + D1 + R2 backend in `server/` (Hono + `aws4fetch`) | see §11 |

There is **no router** and **no state library** — plain React state in `App.tsx`, view switch via a `view` string.

---

## 3. Run / build

Prerequisites: Node 18+, Rust stable (`source ~/.cargo/env`), and **ffmpeg on PATH** for recording.

```bash
npm install
npm run tauri dev      # dev (Vite + Rust, hot reload). LONG-RUNNING.
npm run tauri build    # bundle: .dmg/.app (mac), .msi/.exe (win)
npx tsc --noEmit       # typecheck frontend only
cd src-tauri && cargo check   # typecheck/compile backend only
```

`npm run tauri dev` is long-running — run it in the background. Closing the window does NOT quit
(close-to-tray); use tray → Quit or kill the process.

### Cross-platform builds & CI

Tauri **cannot cross-compile** a Windows installer from macOS (or vice versa) — it needs the
native MSVC linker + WebView2 on Windows, Xcode toolchain on macOS. The code itself is already
cross-platform (`#[cfg(target_os = "...")]` branches in `recorder.rs`/`lib.rs` for the mac/Windows
differences), but *producing* both `.dmg`/`.app` and `.msi`/`.exe` requires building on each OS.

Dev machine is a Mac, so **macOS builds/checks are done locally** — `npm run tauri build` for a
`.dmg`, `npx tsc --noEmit` / `cd src-tauri && cargo check` to verify. **CI (`.github/workflows/`,
assumes this `capture-studio/` directory is the git repo root) exists only for Windows**, the one
platform with no local machine available, and is **manual/on-demand only** (no push/PR triggers).
(Actions minutes are **free and unlimited for public repositories**, so these builds cost the
account's private repos nothing; only the 20-concurrent-job limit is shared.)
- **`ci.yml`** — run manually (Actions tab or `gh workflow run ci.yml`) to verify `cargo check` +
  `tsc --noEmit` on `windows-latest`. This is what actually proves the `#[cfg(target_os =
  "windows")]` code paths compile — a local `cargo check` on the Mac never touches them.
- **`release.yml`** — triggers on pushing a `v*` tag, or manual `workflow_dispatch`: builds the
  Windows installer via `tauri-apps/tauri-action` and attaches it to a draft GitHub Release. Build
  and attach the macOS `.dmg` to that same release locally.

To use: `git init` this directory (if not already), push to a GitHub repo, then
`git tag v0.1.0 && git push --tags` to trigger the Windows release build.

---

## 4. Repository map

```
capture-studio/
├── index.html  overlay.html  stopbar.html  editor.html  scrollbar.html
├── regionhint.html  textpanel.html      # one entry per window; all inputs in vite.config.ts
├── src/
│   ├── App.tsx                # ORCHESTRATOR: state, tray-action listener, capture flows, recording
│   ├── overlay.tsx            # region selector — single, multi-region (§13), window pick
│   ├── editor.tsx             # React root for the annotation editor's own window
│   ├── stopbar.tsx  scrollbar.tsx  regionhint.tsx  textpanel.tsx
│   ├── styles.css             # ALL styles (dark theme, tokens as CSS vars). No CSS modules.
│   ├── lib/
│   │   ├── api.ts             # typed wrapper per Rust command + types + itemSrc()
│   │   ├── actions.ts         # ACTIONS: one label/icon/shortcut-id per capture action
│   │   ├── shortcuts.ts       # mirror of settings::SHORTCUTS + a live store
│   │   ├── overlay.ts         # one overlay WebviewWindow per display, kept warm
│   │   ├── ownwindows.ts      # hide/show our own windows so they stay out of captures
│   │   ├── editorwindow.ts  stopbar.ts  scrollbar.ts  regionhint.ts  textpanel.ts
│   │   ├── platform.ts        # isMac / isWindows
│   │   ├── features.ts        # COMMERCE_ENABLED — the cloud/licence kill switch
│   │   ├── links.ts           # every outward link, incl. donate + bug report
│   │   ├── vietqr.ts  qr.ts   # EMVCo/NAPAS payload + the QR renderer for it
│   │   ├── beautify.ts  paragraphs.ts  format.ts
│   └── components/            # Sidebar, Gallery, DetailModal, AnnotationEditor, EditIcons,
│                              # Icons, OptimizeModal, Optimizer, BeautifyModal, RecordModal,
│                              # Settings, ShortcutRecorder, AccountModal, LicenseBar, QrCode,
│                              # Modal, Toasts
├── src-tauri/
│   ├── tauri.conf.json        # window, macOSPrivateApi, assetProtocol scope
│   ├── capabilities/default.json  # permissions; `windows` must list every label
│   ├── icons/menu/            # tray glyphs, drawn by make_icons.py (light + dark sets)
│   └── src/
│       ├── lib.rs             # run(): plugins, state, tray menu, shortcuts, invoke_handler
│       ├── models.rs          # serde structs (camelCase to JS), incl. AppSettings
│       ├── settings.rs        # settings.json + the SHORTCUTS table
│       ├── library.rs         # library.json index + MediaItem CRUD on disk
│       ├── capture.rs         # screenshots, region, multi-region (§13), windows, clipboard
│       ├── scroll.rs          # scrolling capture session + stitching
│       ├── optimize.rs        # single + batch re-encode
│       ├── recorder.rs        # ffmpeg control, codecs, thumbnails, zoom-to-cursor (§13)
│       ├── ocr.rs             # Vision / Windows.Media.Ocr / Tesseract (§14)
│       ├── permissions.rs     # macOS Screen Recording: check, request, open Settings, restart
│       ├── license.rs         # offline Ed25519 licence keys + the weekly reminder
│       └── cloud.rs           # HTTP client for server/ (§11) — the only networked module
└── server/                    # Cloudflare Worker backend for cloud upload — see its README
```

---

## 5. Backend (Rust) reference

### State (Tauri managed)
- `LibraryState = Mutex<Library>` — the on-disk index, see `library.rs`.
- `RecorderState = Mutex<Option<RecordingSession>>` — current ffmpeg child, see `recorder.rs`.
- `CloudState = Mutex<Option<cloud::Session>>` — the logged-in session (JWT + email), if any; see §11.

### Data model (`models.rs`, all `#[serde(rename_all = "camelCase")]`)
- `MediaItem { id, kind: "screenshot"|"recording", fileName, createdAt, note, width, height, sizeBytes, durationMs?, cloudUrl?, uploadedAt? }`
  — `cloudUrl`/`uploadedAt` are `#[serde(default, skip_serializing_if = "Option::is_none")]` so old
  `library.json` entries from before this feature still deserialize.
- `MonitorInfo`, `DeviceEntry`, `CaptureDevices { screens, audio, ffmpegAvailable }`, `OptimizeResult`, `RecordOptions`.
- `AccountStatus { email, subscriptionActive, planInterval, currentPeriodEnd, provider, storageUsedBytes, storageQuotaBytes }` — mirrors the backend's `GET /account/status` response.

### Storage
- Library dir: `dirs::picture_dir()/CaptureStudio` (fallback `$HOME/CaptureStudio`).
- Index file: `<dir>/library.json` (array of MediaItem). Loaded at startup; entries whose file is
  missing on disk are pruned. Files: `shot-<stamp>.png`, `rec-<stamp>.mp4`, `*-opt-*.ext`.

### Commands (all registered in `lib.rs` `invoke_handler`)
| Command | File | Purpose |
|---------|------|---------|
| `get_library` / `get_library_dir` / `item_path` | lib.rs | list items (newest first), dir, absolute path of an item |
| `update_note` / `delete_item` / `reveal_item` | lib.rs | edit note, delete (removes file), reveal in Finder/Explorer |
| `get_autostart` / `set_autostart` | lib.rs | autostart via `tauri-plugin-autostart` |
| `list_monitors` | capture.rs | enumerate displays |
| `capture_monitor(monitorId?)` | capture.rs | full-monitor screenshot → MediaItem |
| `capture_region(monitorId?, x,y,w,h)` | capture.rs | crop a monitor capture (physical px) |
| `capture_regions(monitorId?, rects, combine)` | capture.rs | **one** grab, N crops → N items, or one stitched sheet (§13) |
| `capture_all_monitors()` | capture.rs | every display in one image, at their real desktop positions |
| `copy_item(id)` | capture.rs | a library item onto the clipboard, read from disk rather than shipped as base64 |
| `trim_video(id, startMs, endMs, replace)` | recorder.rs | frame-accurate cut; re-encodes on purpose (§13) |
| `capture_window(windowId)` / `list_windows` | capture.rs | per-window grab, follows the window's real shape |
| `keep_item(id)` | capture.rs | commit a draft without re-encoding it through the canvas |
| `scroll_start` / `scroll_step` / `scroll_finish` / `scroll_cancel` | scroll.rs | scrolling-capture session |
| `scan_images` / `optimize_files` | optimize.rs | batch optimiser over a folder |
| `screen_permission_granted` / `request_screen_permission` / `open_screen_permission_settings` / `restart_app` | permissions.rs | the macOS Screen Recording gate |
| `list_video_codecs` | recorder.rs | which encoders this ffmpeg build actually has |
| `tesseract_available()` | ocr.rs | Tesseract presence + its languages, re-checked every call (§14) |
| `get_app_settings` / `set_app_settings` | settings.rs | `settings.json`; shortcuts have their own path |
| `grab_screen(monitorId?)` | capture.rs | full monitor as base64 PNG (NOT saved) — for the overlay |
| `import_png(pngBase64)` | capture.rs | save a PNG data-URL as a new item |
| `import_file(path)` | capture.rs | import an existing image file |
| `import_from_clipboard()` | capture.rs | read clipboard image (arboard) → item |
| `set_clipboard_png(pngBase64)` | capture.rs | write an image to the clipboard (arboard) |
| `set_clipboard_text(text)` | capture.rs | write plain text to the clipboard (arboard) |
| `save_annotated(id, pngBase64)` | capture.rs | overwrite an item's file with edited PNG |
| `optimize_image(id, format, quality, maxWidth?, replace)` | optimize.rs | re-encode; `replace` overwrites vs new copy |
| `check_ffmpeg` / `list_capture_devices` | recorder.rs | ffmpeg presence + screen/audio device lists |
| `start_recording(opts)` / `stop_recording()` / `is_recording()` | recorder.rs | ffmpeg session |
| `ensure_thumbnail(id)` | recorder.rs | poster frame for a recording, generated on demand |
| `ocr_available()` / `list_ocr_languages()` | ocr.rs | whether the OS has a recogniser, and its languages |
| `ocr_region(monitorId?, x,y,w,h)` | ocr.rs | read text off the screen — nothing is saved |
| `ocr_item(id)` | ocr.rs | read text out of an image already in the library |
| `get_license_status()` | license.rs | licence + days-used + whether a reminder is due |
| `activate_license(key)` / `remove_license()` | license.rs | verify-then-store; never stores an invalid key |
| `snooze_license_nudge()` | license.rs | records that the reminder was shown |
| `cloud_signup` / `cloud_login` / `cloud_logout` / `get_account_status` | cloud.rs | auth + session, see §11 |
| `create_paypal_subscription` / `create_payos_payment` / `create_paypal_topup` / `create_payos_topup` | cloud.rs | returns a checkout URL to open in the system browser |
| `upload_item(id)` | cloud.rs | presign → stream PUT to R2 → confirm → sets `MediaItem.cloudUrl` |

### Recording internals (`recorder.rs`)
- Spawns `ffmpeg` via `std::process::Command` with **stdin piped**; the child + metadata live in
  `RecorderState`. **Stop = write `q\n` to stdin** then `wait()`. stderr → `<dir>/last-record.log`.
- macOS: `-f avfoundation -capture_cursor {0|1} -framerate N -i "SCREEN:AUDIO|none"` + optional
  `-vf crop=w:h:x:y`. Screen device index comes from `list_capture_devices` (avfoundation list parse).
- Windows: `-f gdigrab -framerate N [-offset_x -offset_y -video_size WxH] -i desktop` + optional
  `-f dshow -i audio="NAME"`.
- Encode: `libx264 -preset veryfast -pix_fmt yuv420p` (+ `aac 128k` when audio).

---

## 6. Frontend (React) reference

### Data flow
`App.tsx` owns `items`, `monitors`, `view`, modal targets, `toasts`. It calls `reload()` after any
mutation. Child components receive callbacks + a `toast()` fn. Images are shown by resolving
`itemSrc(item)` → `convertFileSrc(path)?v=size` (Tauri **asset protocol**, cache-busted by byte size).

### Cross-window / tray events (Tauri event bus)
- Rust emits **`"tray-action"`** with a string payload on tray click / global shortcut. `App.tsx`
  listens and dispatches: `capture-full`, `capture-region`, `capture-delayed`, `record`,
  `record-toggle`, `open-file`, `clipboard`, `settings`. Both `record` and `record-toggle` now go
  through `App.tsx`'s `toggleRecording()`: opens the setup modal if idle, stops the active
  recording if not.
- The **region overlay** (`overlay.tsx`) emits `"captured"` with the new `MediaItem` as payload
  (shot done → App reloads and opens the annotation toolbar for it, see below),
  `"capture-error"`, or `"region-selected" {rect,monitorId}` (record mode → `RecordModal` listens).
- The **stop-bar** (`stopbar.tsx`) emits `"stop-recording-request"` when its Stop button is
  clicked; `App.tsx` is the only listener and owns the actual `stopRecording()` call, so there is a
  single code path for ending a recording regardless of trigger (stop-bar click or ⇧⌘5).

### Recording lifecycle (state lives in `App.tsx`)
- `recording: boolean` in `App.tsx` is the single source of truth (no more local timer state in
  `RecordModal`).
- Start: `RecordModal` calls `startRecording()` then its `onStarted` prop →
  `App.handleRecordStarted()` hides the main window (`getCurrentWindow().hide()`) and opens the
  stop-bar (`openStopBar(Date.now())`, label `"stopbar"`, small/transparent/always-on-top/
  undecorated/draggable, timestamp passed via `?since=` query param so the bar computes its own
  elapsed time — no polling needed).
- Stop: `App.stopActiveRecording()` (triggered by stop-bar's `stop-recording-request` event or by
  ⇧⌘5 while recording) calls `stopRecording()`, closes the stop-bar, re-shows + focuses the main
  window, and reloads the library.
- This fixes "main window appears in recordings" and makes ⇧⌘5 a true start/stop toggle
  (previously known limitations #1 and #2).

### The region overlay — important (no longer freeze-frame)
`openRegionOverlay(mode, monitors, pick)` shows **one overlay window per display**, labelled
`overlay-<monitorId>`, created at startup by `prewarmRegionOverlays` and thereafter **hidden and
reused** rather than recreated. Monitor id, scale factor and physical origin are baked into each
window's URL and never change; only `{mode, pick}` varies, broadcast as `overlay-init`.

The window is **transparent** — there is no frozen backdrop and no dim veil, so the crosshair is
usable on the first frame with nothing to wait for. A 1%-opaque fill is all that makes it
hit-test pointer events. `grab_screen` still exists but the overlay no longer uses it.

Things in this file that look removable and are not:
- **`acceptFirstMouse: true`** — a capture started from the tray runs while another app is
  frontmost, and macOS otherwise swallows the activating click. Without it every tray and
  hotkey capture loses the press that starts the drag and reports `no-gesture`.
- **`setPointerCapture` in a `try`** — the windows are reused, so a gesture interrupted by the
  window hiding can leave stale capture for a dead pointer; the throw would abort the handler
  and silently break dragging for the rest of the session.
- **`up` measures from the event, never from `sel`** — `sel` is written by pointermove, whose
  re-render React may defer, so a fast drag read `{w:0,h:0}` and cancelled itself.
- **`visibleOnAllWorkspaces` and not `fullscreen`** — native fullscreen gives the window its own
  Space and animates a desktop switch to it.

Per mode, on pointerup: **shot** → `capture_region`/`capture_window`, emits `captured`;
**multishot** → collects (§13); **record** → `region-selected`; **text** → `text-region-selected`;
**scroll** → `scroll-region-selected`. `overlay-dismiss` hides every overlay;
`overlay-cancelled` additionally means the main window should come back.

### Annotation editor (`AnnotationEditor.tsx`) — opens automatically right after every capture
- **Shottr-style: the toolbar opens immediately after any screenshot** (full monitor, delayed, or
  drag-region), not just via a manual "Annotate" click. `App.tsx`'s `openEditorForCapture(item)` is
  the single entry point: it force-shows + focuses the main window (even if it was hidden in the
  tray when the capture was triggered) and sets `annotateTarget`. `captureFull` calls it directly
  with the `MediaItem` `capture_monitor` returns; the region overlay calls it indirectly by
  emitting the item on `"captured"` (see above). Recording, file-import, and clipboard-import do
  **not** auto-open the editor — only fresh screenshots do.
- Loads the image via `fs.readFile` → `Blob` → **`createImageBitmap`** (NOT the asset URL) so the
  canvas stays **untainted** and `toDataURL()` works for save/copy. `createImageBitmap` rather than
  `new Image()` on purpose: it rejects on failure (an `img.onload` with no `onerror` left a blank
  canvas and said nothing), and its `close()` releases the decoded pixels when the editor closes.
- **Redraws on `visibilitychange`/`focus`/`pageshow` and on the frame after load.** Every capture
  hides and re-shows the main window; a first paint landing while the webview is still off-screen
  is discarded by the compositor, leaving a correctly sized but empty canvas. Do not "simplify"
  this back to a single paint.
- Canvas is at natural pixel size; pointer coords mapped via `getBoundingClientRect` ratio (so zoom
  is automatically correct). Shapes stored in a `Shape[]` union; `drawShape()` re-renders all each frame.
- Toolbar also has a **Cloud upload button** (`upload()`): saves the current annotated canvas first
  (so the cloud copy matches what's on screen), then `uploadItem()`. If not subscribed, routes to
  `onNeedSubscription` (same Settings/AccountModal flow as `DetailModal`'s upload button) instead
  of attempting the upload.
- Tools: select, arrow, line, rect, ellipse, pen, highlight, text, **counter** (auto-incrementing
  numbered circles), **blur** (pixelate a region by down/up-scaling the base image).
- Toolbar readout: hex of active color, image size, live zoom %. Actions: undo, clear, copy
  (`set_clipboard_png`), save (`save_annotated`), close.

---

## 7. Permissions / capabilities

- `src-tauri/capabilities/default.json` applies to windows
  `["main","overlay-*","stopbar","scrollbar","editor","regionhint","textpanel"]`. **A new window
  label that is not in this list gets no permissions and fails silently at runtime** — that is
  the first thing to check when a new window does nothing. Includes core
  window ops (create/close/hide/show/is-visible/unminimize/set-always-on-top/start-dragging),
  `opener`, `dialog`, `shell:allow-open`, `fs` read/write + **fs:scope** for
  `$PICTURE/CaptureStudio/**` and `$HOME/CaptureStudio/**`.
- `tauri.conf.json` → `app.security.assetProtocol.scope.allow` mirrors those two globs (needed for
  `<img>`/`<video>` to load library files) and `app.macOSPrivateApi: true` (transparent overlay).
- Global-shortcut & autostart plugins are used from Rust, so no extra JS capability entries are needed.

---

## 8. Platform notes

- **macOS Screen Recording permission** is required for screenshots AND recording. First capture
  triggers the OS prompt; user must enable it in *System Settings → Privacy & Security → Screen
  Recording*, then relaunch. Until granted, captures may be black or fail.
- **System (loopback) audio** is not captured by default. Needs a virtual device: BlackHole (mac) or
  Stereo Mix / virtual-audio-capturer (win). Microphones work directly.
- **ffmpeg is not bundled** — must be on PATH. `check_ffmpeg` gates the record UI.
- Global shortcut accelerators are written as `Shift+Cmd+1` etc.; on Windows Tauri maps `Cmd`→`Ctrl`.

---

## 9. Status

### Implemented ✅
- Screenshots (full / monitor / region freeze-frame), notes, delete, reveal, gallery.
- Annotation editor with all tools above + copy-to-clipboard + save-in-place + cloud upload.
  **Opens automatically right after every screenshot** (Shottr-style), not just on manual click.
- Image optimization (WebP/JPEG/PNG, quality, max-width, replace/copy, before-after).
- ffmpeg recording (full/region, mic, fps, cursor) with live timer.
- Menu-bar tray menu, global shortcuts (⇧⌘1/2/5/V), autostart toggle, close-to-tray.
- Import from file / clipboard, delayed (3s) capture.
- Floating stop-bar during recording — main window hides on record start, a small always-on-top
  timer + stop button window takes over; ⇧⌘5 is now a true start/stop toggle (recording state
  lives in `App.tsx`, see §6).
- **Cloud upload (opt-in, paid)** — login/signup, PayPal + PayOS monthly/annual subscriptions with
  storage top-ups, presigned R2 upload with a copy-link UX. See §11. Code-complete but **switched
  off in shipped builds** (`COMMERCE_ENABLED = false`, `src/lib/features.ts`): the Worker backend
  is not deployed and there is no paid plan (see server/README.md and the "Not yet done" list in
  §11).

- **Crop** in the annotation editor, and a **post-capture action** setting (§13).
- **Video trimming** — frame-accurate, in place or as a copy (§13).
- **All displays** — every monitor in one image, laid out as the desktop arranges them (§13).
- **Multi-region capture** (⌃⇧7) — N regions of one display from a single grab, saved as
  separate files or one stitched sheet (§13).
- **Zoom to cursor** on recordings — optional post-pass that eases in on wherever the cursor
  settled (§13).
- **Text recognition** — Vision on macOS; `Windows.Media.Ocr` plus optional Tesseract on Windows,
  which is what makes Vietnamese work there (§14).
- **Scrolling capture**, **window picker**, **batch image optimiser**, **video codec picker**,
  **rebindable global shortcuts**, **PNG/JPEG capture format**.
- **Donate card** in Settings — PayPal plus a **VietQR** code generated in-app (`lib/vietqr.ts`,
  EMVCo/NAPAS, CRC-16/CCITT-FALSE), chosen by system language.
- **Report a bug** — Settings' right-hand column and a link in its footer, both opening a GitHub
  issue or an email with the version and OS already filled in (`lib/links.ts`).

### Known limitations ⚠️ (good next tasks)
0. **`xcap` 0.9.8 grabs the screen with `CGWindowListCreateImage`**, which Apple deprecated in
   macOS 14. It still works, but it is the single largest piece of borrowed time in this app: the
   modern replacement is **ScreenCaptureKit**, whose API is async and whose adoption means
   replacing the capture backend rather than patching it. Windows has the same story with
   Windows Graphics Capture. Nothing is broken today; this is the thing to plan for.
1. **Annotation shapes can't be selected/moved/deleted individually** — only global Undo/Clear. Add
   hit-testing + a selection/move tool (the `select` tool is currently a no-op).
2. ~~No video trimming~~ — done (§13). Still missing: **splitting** a recording into several
   clips, and joining. Both are the same ffmpeg shape as `trim_video`, wanting only UI.
3. **ffmpeg not bundled** — consider shipping a sidecar binary via Tauri's externalBin.
4. ~~Region overlay assumes the primary monitor~~ — done: one overlay per display, each carrying
   its own id, scale and origin (§6).
   **Still open:** a Windows *region* recording passes the rectangle straight to gdigrab's
   `-offset_x/-offset_y`, which are **virtual-desktop** coordinates, while the overlay sends
   **monitor-relative** ones. They coincide on a single-monitor setup and diverge on any other,
   so region recording on a secondary Windows display records the wrong rectangle. Untested — no
   Windows machine here.
5. ~~No scrolling capture / window-picker capture~~ — both implemented (`scroll.rs`,
   `list_windows` + the overlay's window pick).
6. Optional: hide the Dock icon (macOS `ActivationPolicy::Accessory`) to be a pure menu-bar app.
7. **`base64` crate is 0.23** — API used is `STANDARD.decode/encode`. Keep that if upgrading.
8. **Stop-bar is fixed top-center** (`center: true`) — could instead remember/restore its last
   dragged position, or default to bottom-center to stay clear of menu bars/notches.
9. **Cloud upload backend is not deployed** — `API_BASE` in `src-tauri/src/cloud.rs` is a
   placeholder (`capture-studio-api.YOUR_SUBDOMAIN.workers.dev`) until `server/` is deployed and
   its Cloudflare/PayPal/PayOS accounts are set up (see server/README.md §"One-time setup").
   Because of that the whole surface is gated behind `COMMERCE_ENABLED` in `src/lib/features.ts`,
   along with `BUY_URL` (still `example.com`) and the undeployed `web/` site the password-reset
   link points at. Turning it on means: deploy `server/`, set `API_BASE`, deploy `web/` with a
   filled `site.config.json`, set `BUY_URL`, then flip the flag.
11. **Deleting is permanent** — `Library::remove` unlinks the file immediately, with no trash and
    no undo. A `.trash/` folder inside the library dir plus a Trash filter would be the fix; the
    cloud-copy reaping in `delete_item` would have to be deferred until the trash is emptied.
12. **No click indicators during recording** — the cursor is sampled at 20 Hz for zoom-to-cursor
    (§13) but its *buttons* are not. `NSEvent.pressedMouseButtons` on macOS and
    `GetAsyncKeyState` on Windows both read button state without any permission prompt, so the
    sampler could carry it; drawing the ripples is then another ffmpeg overlay pass. Untested on
    Windows, which is the reason it was not attempted.
10. **Capture Area can't include Capture Studio's own window** — every mode except the window
    picker hides the app first (`openOverlay` in `App.tsx`), because a WKWebView cropped out of a
    whole-monitor grab comes back as a black rectangle. Capturing the app itself works today only
    via the window picker, which uses xcap's per-window grab. Fixing it properly means
    compositing: take the monitor grab, take a separate per-window grab of our own window, paint
    the second over the first at its screen position, then crop. Deferred deliberately.

---

## 10. Conventions

- Rust command results are `Result<T, String>` (error = human message shown via toast).
- All serde structs are camelCase for the JS boundary; TS types mirror them in `lib/api.ts`.
- Add a new capability/command in THREE places: the Rust `#[tauri::command]`, the `invoke_handler!`
  list in `lib.rs`, and a wrapper in `src/lib/api.ts`. Add any new permission to `capabilities/default.json`.
- Styling is one global `styles.css` using CSS variables (`--bg`, `--accent`, …). Match the dark theme.
- Keep capture/annotate/record/optimize deterministic/offline. Network calls are confined to the
  opt-in cloud-upload path (`cloud.rs` on the Rust side, `server/` on the backend) — don't add
  network calls anywhere else without a similarly explicit, user-initiated trigger.

---

## 11. Cloud upload (opt-in, paid)

### What it does
Any captured item (screenshot or recording) can be uploaded to Cloudflare R2 from its
`DetailModal`, producing a public shareable link. Requires logging in and an active paid plan
(monthly or annual; PayPal for card/international, PayOS for Vietnamese domestic payment — PayOS
has no native recurring billing, so its "subscription" is a payment link the user re-clicks each
period). Each plan includes 3GB of storage; storage top-up packs (+5GB, +20GB) can be bought
one-time and stack permanently onto the account's quota. All pricing lives in one place:
`server/src/pricing.ts`.

### Cost model — why a custom domain is mandatory
A public link embedded in a post is fetched by every reader's browser, so N views = N reads of
the object. On R2 that is a Class B operation ($0.36/million), which is the cost that decides
whether $3/month is profitable. A Cloudflare CDN cache in front of the bucket turns all but the
first read into a free cache hit — but **caching is unavailable on `*.r2.dev`**, which
Cloudflare documents as rate-limited and development-only. `PUBLIC_R2_URL` must therefore point
at a **custom domain attached to the bucket**, with a Cache Everything rule and a long TTL,
before going live. This is a launch prerequisite, not a scaling nicety.

Deliberately **not** built: per-view overage billing. Once the CDN is doing its job neither R2
nor the Worker ever sees a cached view, so there is no per-user counter to bill from; and
neither payment provider can collect a variable amount anyway (PayOS has no recurring billing
at all, PayPal subscriptions are a fixed amount). Abuse is handled by fair-use limits, not by
invoicing.

### Storage reclamation (`server/src/cleanup.ts`, nightly cron)
- **Orphan sweep** — deletes bucket objects with no `uploads` row older than 6h. `/upload/confirm`
  is what charges bytes to a quota, and a client can just never call it.
- **Lapsed-account sweep** — 30 days (`LAPSE_GRACE_DAYS`) after `current_period_end`, a
  non-active account's objects and rows are deleted. The value is returned by `/account/status`
  and rendered in Settings so the stated promise and the enforced number cannot drift.

### Trust boundary on uploads
The client is never believed about sizes. `presign` signs `content-length` into the URL
(`allHeaders: true`, since aws4fetch treats it as unsignable by default) so R2 rejects a PUT of
any other size, and `confirm` reads the real size back with `BUCKET.head()` rather than taking
it from the request body. `uploads` has a unique index on `(user_id, item_id)` so a repeated
confirm cannot inflate usage.

### Backend
`server/` is a separate Cloudflare Worker (Hono router) + D1 (SQLite) + R2 project — see
`server/README.md` for the full endpoint list, data model, and one-time Cloudflare/PayPal/PayOS
setup steps. It is **not part of the Tauri app's build** and deploys independently
(`cd server && npm run deploy`).

### Desktop side (`src-tauri/src/cloud.rs`)
- The only module in this app that makes network calls, and only in response to an explicit user
  action (login, upload, subscribe).
- Session (`{token, email}`) persists at `<library_dir>/.session.json` — reuses the fs
  capability/scope already granted for the library folder, so **no new Tauri capability entries
  were needed** for this feature.
- `upload_item` streams the file straight into the PUT request body (`tokio_util::codec::FramedRead`
  + `reqwest::Body::wrap_stream`) so large recordings are never fully buffered in memory.
- `API_BASE` is a placeholder constant at the top of `cloud.rs` — update it once `server/` is
  deployed (§"Not yet done" below).

### Frontend
- `AccountModal.tsx` — login/signup.
- `Settings.tsx` "Account & Cloud Upload" section — subscribe (monthly/annual, PayPal/PayOS),
  storage usage bar, top-up buttons, logout. After opening a checkout URL in the system browser it
  short-polls `getAccountStatus()` for ~2 minutes and always shows a manual "I've paid — refresh
  status" button as a fallback (Tauri desktop apps can't easily receive a browser redirect
  callback without OS-level URL-scheme registration — deliberately not built for this MVP).
- `DetailModal.tsx` — "Upload to Cloud" button (routes to Settings if not subscribed instead of
  attempting an upload that would 402), "Copy link" once uploaded, a `Cloud` row in the meta list.

### Not yet done (documented follow-ups, not gaps to "fix" — deliberate MVP cuts)
- Deploying `server/` and wiring real Cloudflare/PayPal/PayOS credentials (§9 point 9).
- Deep-link payment return (`tauri-plugin-deep-link`) instead of poll + manual refresh.
- Email receipts / renewal reminders — PayOS especially has no auto-renew; the in-app "expires in
  N days" state is the only reminder today.
- OS keychain for the session token (plaintext `.session.json`, matching this app's existing
  local-trust model for `library.json`).
- Self-service cancel/refund UI (PayPal subscriptions are cancelled from the user's own PayPal
  account; PayOS has nothing recurring to cancel).


## 13. Multi-region capture and zoom-to-cursor

Two features that share nothing technically but were built together, and both have a shape that
is easy to get wrong on a second reading.

### Capture Multiple Areas

**Its own tray item, action and shortcut (⌃⇧7) — deliberately not a modifier on Capture Area.**
That path is the most-used thing in the app; making its overlay decide mid-gesture whether a drag
is one region or the first of several would put a state machine in the busiest code here. A
separate entry point leaves the common path untouched, and it also removes the need for any
`if (n === 1)` special-casing downstream.

- `overlay.tsx` mode `"multishot"` **collects** on pointerup instead of finishing: the overlay
  stays up, each committed rectangle is drawn with its index, Backspace drops the last one and
  Escape throws the set away. A too-small drag is dropped in silence here — in this mode it is
  nearly always a stray click between two real selections, not a failed capture.
- **Enter broadcasts `multishot-confirm`** rather than acting where the key was pressed.
  Keyboard focus sits on one overlay but the regions may have been drawn on another display's;
  every overlay hears the event and only the one holding regions responds.
- The save-as dialog is rendered **inside** the overlay. A separate window would have to be
  created, placed on the right display and focused while a borderless always-on-top surface
  already covers the screen — and would land behind it as often as not.
- `AppSettings.multiRegionSave` (`""` | `"separate"` | `"combined"`) skips the dialog once the
  user ticks "always do this". It ships empty because the right answer depends on the task, not
  on taste: regions bound for an AI prompt want separate files, regions bound for a document want
  one sheet, and that is the same person on two different days.
- `capture_regions` grabs the monitor **once** and crops N times. A loop over `capture_region`
  would re-grab per rectangle — the slow part — and the crops would be milliseconds apart, so a
  moving cursor or a mid-animation frame could land in some and not others.
- Items are saved **non-draft**. Drafts exist so the editor can open a capture before it is
  committed and are swept at startup if nothing commits them; nothing opens the editor here, so
  a draft would simply vanish.
- The result is emitted as **`captured-many`**, never `captured`. `App.tsx`'s `captured` listener
  opens the annotation editor for its payload, and a set of five would open five editor windows.
- Stitching (`stitch_sheet`) is vertical, left-aligned, 16px gaps, on the editor's own backdrop
  colour, **in the order the regions were drawn**. Crops are arbitrary sizes, so a row leaves
  short ones floating in a band of background and a grid means guessing a column count that is
  wrong for most selections. The draw order is the only thing the user actually chose; sorting by
  position would discard it. Covered by unit tests in `capture.rs`.

### Trimming a recording

`trim_video` **re-encodes rather than stream-copying**. `-c copy` can only cut on keyframes, and
at the ~2-second GOP these recordings carry that puts the cut up to two seconds from where the
handles were — invisible until playback. Audio is re-encoded for the same reason: a stream copy
starting mid-packet leaves the sound a fraction ahead of the picture for the whole clip.

The output is written to a `.tmp.` name beside the original and only renamed once ffmpeg has
returned successfully with a non-empty file. Encoding straight over the source would destroy the
original whether or not the trim worked. `replace` mirrors `optimize_image`'s flag and defaults
to false in the UI, because a trim throws away footage nothing can recover.

`TrimModal` scrubs the real `<video>` element rather than building a filmstrip: every thumbnail
in a strip is another ffmpeg run before anything appears, and what is being chosen here is a
moment, which scrubbing already shows at full resolution and immediately. Its `stamp()` is local
and not `formatDuration` — that one rounds to whole seconds, coarser than what is being picked,
and returns `""` for zero, so an In point at the start would render blank. Drag listeners are
bound to `window`, not to the track, so a drag that runs off the end keeps tracking.

### All displays

`capture_all_monitors` places each display at its real desktop coordinates rather than laying
them out in a strip, so a monitor mounted above another comes out above it. Gaps left by an
uneven arrangement are filled with the sheet backdrop, not left transparent — the saved format
may be JPEG. Displays are grabbed one after another; there is no API that grabs several
atomically, and this does not pretend otherwise.

Offered **only in the sidebar's "Choose display…" menu**, which already appears only when there
is more than one display. It is not a tray item or a shortcut: the tray menu is long enough, and
the option is meaningless on a single screen.

### Crop, in the annotation editor

Crop is **not** a shape. It changes the picture rather than sitting on top of it, and it cannot
be taken back by removing an entry from `shapes` — so it waits for an explicit Apply instead of
committing on pointerup, and `drawShape` returns early for it (falling through would stroke the
crop box as an ordinary rectangle in the current colour).

Two things it must do that are easy to miss:
- **The editor keeps its own `size` state.** `item` is a prop describing the file on disk, and a
  crop only reaches disk on save; sizing the canvas from the prop snaps it back to the original
  dimensions on the next render, leaving the cropped bitmap drawn into a frame the wrong shape.
- **Every existing annotation is translated by the crop offset.** Shapes are stored in canvas
  pixels, so leaving them put slides each arrow and label away from what it pointed at.

The old `ImageBitmap` is `close()`d after `createImageBitmap(im, x, y, w, h)` — nothing else
frees it. `save_annotated` already writes the new width/height back from the PNG it receives, so
the Rust side needed no change at all.

### What happens after a screenshot

`AppSettings.afterCapture` — `"editor"` (default), `"copy"`, `"save"`. The editor opening every
time is right for annotating and wrong for capturing to paste, where it is a window to dismiss on
every capture.

**The non-editor paths must call `keep_item`.** A fresh capture is a draft: hidden from the
library and swept at startup unless something commits it, and the editor is normally what does.
Without that call, "just save it" saves nothing that survives a restart.

### Zoom to cursor (recording)

Optional, off by default (`AppSettings.followCursor`), because it **re-encodes the finished video**
— time, plus one generation of quality.

- While recording, a thread polls `AppHandle::cursor_position()` at 20 Hz. Polling rather than a
  global mouse hook: a hook needs Accessibility permission on macOS, which is a second scary
  system prompt for a cosmetic feature, and 20 Hz is far more than a zoom that moves every few
  seconds can use. Sampling stops **before** ffmpeg is waited on, so readings from the flush are
  not counted.
- **It does not follow the cursor continuously.** That is the obvious reading and it is
  unwatchable — every stray hand movement swings the frame. `zoom_segments` finds the places the
  cursor *settled* and eases in on those, the way a human editor cuts in, sits still and pulls
  back out.
- The detector classifies each sample as moving or still **by local speed** before grouping
  anything. Two earlier attempts grouped first and judged the group afterwards, and both failed
  the same way: a run grown until its bounding box bursts always ends somewhere in the middle of
  the movement that burst it, so the run is part dwell and part transit and no test applied to it
  as a whole can separate them. Speed is a property of one sample's neighbourhood, so it puts the
  boundary in the right place. **Do not "simplify" this back to grouping-then-judging** — the
  regression tests in `recorder.rs` exist because of it.
- `zoom_filter` emits a `zoompan` expression whose segments are **summed, not nested**: they never
  overlap, so each term is zero outside its window, and a sum avoids an `if()` nested once per
  segment. Easing is smoothstep over a trapezoid; a linear ramp starts and stops visibly. `x`/`y`
  are the viewport's top-left, derived from the centre and the `zoom` zoompan has already computed
  for that frame, and clamped so the viewport never leaves the frame.
- `RecordOptions.origin` — the desktop coordinate that lands on video pixel (0,0) — is computed in
  `RecordModal` because that is where the monitor list lives and because the answer is
  platform-specific: avfoundation hands over one display and crops the region inside it, so the
  origin is that display's corner plus the rectangle; gdigrab's `-i desktop` hands over the whole
  virtual desktop and takes its offset in desktop coordinates, so the rectangle already is the
  origin.
- **Wrong origin degrades to no zoom, never to a wrong zoom**: if under `MIN_INSIDE` of the
  samples land inside the frame, `zoom_segments` returns nothing. `render_zoom` is likewise
  best-effort — every failure path leaves the original recording exactly as it was.

---

## 14. Text recognition (OCR)

`ocr.rs` is four modules chosen by `cfg`: a macOS `backend` (Vision via `objc2-vision`), a
Windows `winocr` (`Windows.Media.Ocr`), a `tesseract` shell-out for everything non-macOS, and a
dispatcher `backend` that prefers Tesseract whenever it has a model for a language that was asked
for.

**The thing that cost the most time, written down so nobody repeats it:** Windows keeps two lists
that look nearly identical in Settings — the system's *preferred display languages*, and the
languages `Windows.Media.Ocr` actually ships a **recognition model** for. Adding Vietnamese to the
first does not create the second, and there is no Vietnamese model at all. Nothing errors: OCR
runs and returns text, just with the diacritics wrong, which looks like a weak model rather than a
missing one. Only `AvailableRecognizerLanguages` tells the truth. Vietnamese on Windows therefore
goes through Tesseract.

- WinRT calls run inside `on_mta`, a scoped thread that does `RoInitialize(RO_INIT_MULTITHREADED)`
  and uninitialises only if it was the one that initialised. `IAsyncOperation` is awaited with
  **`.join()`** (not `.get()` — renamed in windows-future 0.3.2).
- `engine_for` matches the whole BCP-47 tag first, then the primary subtag, because macOS Vision
  says `vi-VT` and Windows says `vi` for the same language.
- **`tesseract::path()` and `tesseract::languages()` are deliberately uncached.** They had
  `OnceLock`s and it was a bug: Tesseract gets installed *while the app is running*, and the cache
  meant "Check again" in Settings re-read a stale answer forever. Do not put the caches back.
- Tesseract is fed a temp PNG rather than stdin, and read back as TSV. `parse_tsv` uses `f[0]`
  (level, must be `5`), `f[2..5]` (block/par/line), `f[7]` (**top**, not `f[6]` which is left),
  `f[9]`, `f[10]`, `f[11]`.
- `winget install UB-Mannheim.TesseractOCR` installs **English only** — winget runs the installer
  silently so its language-picker page never appears. `vie.traineddata` has to be downloaded into
  `tessdata` by hand; **Settings → Text** walks through both steps.

---

## 12. Licensing (local app)

The local app is free and fully featured, forever. A licence sells two things — the right to
use Capture Studio **commercially**, and quiet. It gates **no features**: gating would make the
free app worse, which is not the deal being offered.

**Offline by construction.** `license.rs` verifies an Ed25519 signature against a `PUBLIC_KEY`
compiled into the binary. There is no licence server and no activation request, because the
local app makes no network calls at all and that has to remain true. The trade-off is that a
key cannot be revoked once issued; at this price point revocation would cost more than the
fraud it prevents.

**Key format** — `base64url(payload || signature)`, signature 64 bytes over:
`[version u8][kind u8: 1 personal, 2 commercial][issued u32 LE, days since epoch][name UTF-8]`.
The name runs to the end of the payload, which runs to 64 bytes before the end of the blob.

**Issuing keys** — `src-tauri/examples/license_tool.rs`, an *example* so it never builds into
the app:
```
cargo run --example license_tool -- keygen                     # once; paste PUBLIC_KEY into license.rs
CS_PRIVATE_KEY=<hex> cargo run --example license_tool -- issue commercial "Jane Doe"
```
`PUBLIC_KEY` ships as all zeroes, which makes every key fail with an explicit "not configured"
message rather than a confusing signature error. **The private key must never be committed.**

**State** — `<library_dir>/license.json` (`key`, `firstRun`, `lastNudge`). The stored key is
re-verified on every status read rather than trusting a cached "was valid once" flag, so a
hand-edited file degrades to unlicensed instead of granting a licence.

**The reminder** (`LicenseBar.tsx`) appears after 30 days of real use, at most weekly, as a
dismissible strip in the main window. Never a modal, never a countdown, and never during a
capture — the overlay is a separate window and the annotation editor replaces the main tree,
so neither can show it. `BUY_URL` in `App.tsx` is a placeholder until a storefront exists.

**Not the same product as cloud upload.** The licence covers the local app; §11's subscription
covers cloud storage and shareable links. They are sold and billed separately.

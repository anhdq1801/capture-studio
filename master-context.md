# Capture Studio — Master Context (Handoff Document)

> Read this first if you are an AI/editor picking up this project. It is the single source of
> truth for architecture, conventions, what exists, and what to build next.
> Location on disk: `/Volumes/DATA/OneShot/capture-studio`

---

## 1. What this app is

A **cross-platform (macOS + Windows) desktop app** for:
- **Screenshots** — full display, a chosen monitor, or a drag-selected region.
- **Annotation / notes** — a Shottr-style image editor (arrows, shapes, pen, highlighter, text, step-numbers, blur/redact) plus a free-text note per capture.
- **Screen recording (advanced)** — full screen or region, mic/loopback audio, fps, cursor, start/stop.
- **Image size optimization** — re-encode to WebP/JPEG/PNG with quality + max-width, before/after comparison.
- **Menu-bar app** — tray icon with quick actions and **global keyboard shortcuts**, close-to-tray.
- **Upload to Cloud (opt-in, paid)** — per-item, uploads to Cloudflare R2 via a presigned URL and
  returns a public shareable link. See §11.

Capture, annotation, recording, and optimization are fully deterministic and offline by default —
no network calls, no telemetry. The one exception is the explicit, per-item "Upload to Cloud"
action (§11), which requires an account and an active paid plan and is the only thing in this app
that talks to the network.

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
platform with no local machine available, and is **manual/on-demand only** (no push/PR triggers) —
that Actions-minute quota is shared across every repo on the account (including AltaVn):
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
├── index.html                 # main window entry (loads src/main.tsx)
├── overlay.html               # region-selector window entry (loads src/overlay.tsx)
├── stopbar.html                # floating recording-control window entry (loads src/stopbar.tsx)
├── vite.config.ts             # multi-page: inputs { main, overlay, stopbar }
├── src/
│   ├── main.tsx               # React root for main window
│   ├── App.tsx                # ORCHESTRATOR: state, tray-action listener, capture flows, recording lifecycle
│   ├── overlay.tsx            # region selector UI (freeze-frame + drag), its own React root
│   ├── stopbar.tsx            # small always-on-top timer + stop button, its own React root
│   ├── styles.css             # ALL styles (dark theme, tokens as CSS vars). No CSS modules.
│   ├── lib/
│   │   ├── api.ts             # typed wrappers around every Rust command + types + itemSrc()
│   │   ├── overlay.ts         # openRegionOverlay(mode, monitorId) → creates WebviewWindow
│   │   ├── stopbar.ts         # openStopBar(since) / closeStopBar() → creates/closes the "stopbar" WebviewWindow
│   │   └── format.ts          # formatBytes / formatDuration / percentSaved
│   └── components/
│       ├── Sidebar.tsx        # left nav + capture/import buttons
│       ├── Gallery.tsx        # grid of MediaItem cards (async thumbnail via itemSrc)
│       ├── DetailModal.tsx    # per-item preview, note editor, actions
│       ├── AnnotationEditor.tsx  # Shottr-style canvas editor (big file)
│       ├── EditIcons.tsx      # inline SVG icon set for the editor toolbar
│       ├── OptimizeModal.tsx  # image optimization UI + before/after
│       ├── RecordModal.tsx    # device pick, region, fps, start/stop timer
│       ├── Settings.tsx       # library dir, ffmpeg status, autostart, shortcuts, displays, Account & Cloud Upload
│       ├── AccountModal.tsx   # login/signup form
│       └── Toasts.tsx         # transient notifications
├── src-tauri/
│   ├── tauri.conf.json        # window, macOSPrivateApi, assetProtocol scope
│   ├── capabilities/default.json  # permissions (windows: main + overlay + stopbar)
│   └── src/
│       ├── lib.rs             # run(): plugins, state, tray menu, global shortcuts, commands
│       ├── main.rs            # calls capture_studio_lib::run()
│       ├── models.rs          # serde structs (camelCase to JS)
│       ├── library.rs         # Library index (library.json) + MediaItem CRUD on disk
│       ├── capture.rs         # screenshots, region, grab_screen, import_*, clipboard, annotated
│       ├── optimize.rs        # optimize_image
│       ├── recorder.rs        # ffmpeg control: devices, start/stop, session state, video posters
│       ├── ocr.rs             # text recognition on the OS engine (macOS Vision) — offline
│       ├── license.rs         # offline Ed25519 licence keys + the once-a-week reminder
│       └── cloud.rs           # HTTP client for server/: auth, billing, presigned upload (§11)
└── server/                    # Cloudflare Worker backend for cloud upload — see server/README.md
    ├── wrangler.toml
    ├── migrations/0001_init.sql
    └── src/                   # index.ts, auth.ts, account.ts, upload.ts, paypal.ts, payos.ts, pricing.ts, db.ts
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

### The region overlay (freeze-frame pattern) — important
`openRegionOverlay(mode, monitorId)` creates a transparent, fullscreen, always-on-top
`WebviewWindow` labeled `"overlay"` loading `overlay.html?mode=shot|record&monitor=<id>`.
It calls `grab_screen` to get a frozen PNG of the display, dims it, lets the user drag a rect, then:
- **shot**: crops client-side from the frozen image, `import_png`, emits `captured`, closes.
- **record**: converts the rect to physical px and emits `region-selected`, closes.

Why freeze-frame: capturing live would also capture the overlay veil. CSS→physical conversion uses
`grab.width / window.innerWidth` (≈ monitor scale factor).

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

- `src-tauri/capabilities/default.json` applies to windows `["main","overlay"]`. Includes core
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
  storage top-ups, presigned R2 upload with a copy-link UX. See §11. Code-complete; **the Worker
  backend still needs to be deployed and its accounts configured** before this works end-to-end
  (see server/README.md and the "Not yet done" list in §11).

### Known limitations ⚠️ (good next tasks)
1. **Annotation shapes can't be selected/moved/deleted individually** — only global Undo/Clear. Add
   hit-testing + a selection/move tool (the `select` tool is currently a no-op).
2. **No video trimming** after recording. Add an ffmpeg-based trim command.
3. **ffmpeg not bundled** — consider shipping a sidecar binary via Tauri's externalBin.
4. **Region overlay assumes the primary monitor** — multi-monitor region needs the overlay to open on
   the monitor under the cursor and pass that monitor's id/scale.
5. ~~No scrolling capture / window-picker capture~~ — both implemented (`scroll.rs`,
   `list_windows` + the overlay's window pick).
6. Optional: hide the Dock icon (macOS `ActivationPolicy::Accessory`) to be a pure menu-bar app.
7. **`base64` crate is 0.23** — API used is `STANDARD.decode/encode`. Keep that if upgrading.
8. **Stop-bar is fixed top-center** (`center: true`) — could instead remember/restore its last
   dragged position, or default to bottom-center to stay clear of menu bars/notches.
9. **Cloud upload backend is not deployed** — `API_BASE` in `src-tauri/src/cloud.rs` is a
   placeholder (`capture-studio-api.YOUR_SUBDOMAIN.workers.dev`) until `server/` is deployed and
   its Cloudflare/PayPal/PayOS accounts are set up (see server/README.md §"One-time setup").
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

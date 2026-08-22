import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import {
  AccountStatus,
  MediaItem,
  MonitorInfo,
  getLibrary,
  listMonitors,
  captureMonitor,
  importFile,
  importFromClipboard,
  stopRecording,
  getAccountStatus,
  checkFfmpeg,
  screenPermissionGranted,
  requestScreenPermission,
  openScreenPermissionSettings,
  restartApp,
  deleteItems,
  scrollStart,
  scrollFinish,
  scrollCancel,
  ocrRegion,
  setClipboardText,
  LicenseStatus,
  getLicenseStatus,
  snoozeLicenseNudge,
} from "./lib/api";
import { OverlayMode, openRegionOverlay, prewarmRegionOverlays } from "./lib/overlay";
import { loadShortcuts } from "./lib/shortcuts";
import { openEditorWindow } from "./lib/editorwindow";
import { openStopBar, closeStopBar } from "./lib/stopbar";
import { openScrollBar, closeScrollBar } from "./lib/scrollbar";
import { hideRegionHint } from "./lib/regionhint";
import { Sidebar } from "./components/Sidebar";
import { Gallery } from "./components/Gallery";
import { DetailModal } from "./components/DetailModal";
import { OptimizeModal } from "./components/OptimizeModal";
import { BeautifyModal } from "./components/BeautifyModal";
import { RecordModal } from "./components/RecordModal";
import { Optimizer } from "./components/Optimizer";
import { Settings, Tab as SettingsTab } from "./components/Settings";
import { LicenseBar } from "./components/LicenseBar";
import { open as openUrl } from "@tauri-apps/plugin-shell";

/** Where "Get a licence" goes. Replace once the storefront exists. */
const BUY_URL = "https://example.com/capture-studio/license";
import { AccountModal } from "./components/AccountModal";
import { Toasts, ToastMsg } from "./components/Toasts";

export type Filter = "all" | "screenshot" | "recording";
export type View = "library" | "optimize" | "settings";

export default function App() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [view, setView] = useState<View>("library");
  const [filter, setFilter] = useState<Filter>("all");
  const [detail, setDetail] = useState<MediaItem | null>(null);
  const [optimizeTarget, setOptimizeTarget] = useState<MediaItem | null>(null);
  const [beautifyTarget, setBeautifyTarget] = useState<MediaItem | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [ffmpegReady, setFfmpegReady] = useState<boolean | null>(null);
  const [screenReady, setScreenReady] = useState<boolean | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const toastId = useRef(0);
  // A ref, not the `busy` state: two clicks inside one render pass would both read the
  // stale state and fire two captures.
  const busyRef = useRef(false);

  const dismissToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback(
    (text: string, kind: ToastMsg["kind"] = "ok") => {
      const id = ++toastId.current;
      setToasts((t) => [...t, { id, text, kind }]);
      // Errors persist until dismissed: they are usually a raw backend message, often the
      // only explanation the user will get, and 3.4s is not long enough to read one.
      if (kind !== "err") {
        setTimeout(() => dismissToast(id), 3400);
      }
    },
    [dismissToast]
  );

  const reload = useCallback(async () => {
    try {
      setItems(await getLibrary());
    } catch (e) {
      toast(String(e), "err");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    reload();
    listMonitors().then(setMonitors).catch(() => {});
    // The sidebar labels its buttons with these, so they are read once here rather than by
    // each surface that prints one. Falls back to the shipped defaults on failure.
    loadShortcuts().catch(() => {});
    getAccountStatus().then(setAccount).catch(() => {});
    // Checked once here so the sidebar can disable recording up front, instead of the user
    // discovering it two clicks deep inside the record dialog.
    checkFfmpeg().then(setFfmpegReady).catch(() => setFfmpegReady(false));
    // Same reasoning, but this one is worse when missed: a capture without permission looks
    // like a successful capture of the wallpaper. Failing open on error, so a broken check
    // can never be the reason someone cannot take a screenshot.
    screenPermissionGranted().then(setScreenReady).catch(() => setScreenReady(true));
  }, [reload]);

  // The grant happens in System Settings, in another app — coming back to our window is the
  // one reliable signal that it may have changed.
  useEffect(() => {
    const recheck = () => {
      screenPermissionGranted().then(setScreenReady).catch(() => {});
    };
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, []);

  // Stable identity: Settings runs its jump-to-tab effect on this, and a fresh closure each
  // render would re-run it.
  const clearSettingsTab = useCallback(() => setSettingsTab(null), []);

  /**
   * Where "Upload to Cloud (Subscribe)" leads. This is the whole paid funnel, so it has to
   * land on the thing being sold rather than on Settings in general — and it has to say why
   * it moved, because a modal that closes and a view that swaps, with no words, reads as a
   * misclick rather than as a price.
   */
  const needSubscription = useCallback(() => {
    setDetail(null);
    setView("settings");
    setSettingsTab("account");
    if (!account) {
      setAccountModalOpen(true);
      toast("Cloud links need an account — sign in or create one to continue", "info");
    } else {
      toast("Cloud upload is part of the paid plan — $3/month including 3GB", "info");
    }
  }, [account, toast]);

  // Bring the main window to front and open the Shottr-style annotation toolbar
  // right after a capture, so the user always sees it immediately.
  /**
   * Set while the main window is hidden so it stays out of a capture, cleared by whoever
   * brings it back. Only ever true if the window was actually visible to begin with — a
   * capture started from the tray or a shortcut must not conjure the window into view.
   */
  const hidForCapture = useRef(false);

  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const refreshLicense = useCallback(() => {
    getLicenseStatus().then(setLicense).catch(() => {});
  }, []);
  useEffect(refreshLicense, [refreshLicense]);

  const dismissNudge = useCallback(async () => {
    // Recorded before the bar disappears, so closing it really does buy a week's quiet even
    // if the app is killed straight afterwards.
    await snoozeLicenseNudge().catch(() => {});
    setLicense((l) => (l ? { ...l, shouldNudge: false } : l));
  }, []);

  const restoreAfterCapture = useCallback(async (focus: boolean) => {
    if (!hidForCapture.current) return;
    hidForCapture.current = false;
    const win = getCurrentWindow();
    await win.show();
    if (focus) await win.setFocus();
  }, []);

  /**
   * Hand a fresh capture to the editor window.
   *
   * This used to drag the main window on screen first, which meant a screenshot taken from the
   * menu bar ended with the whole application in front of you — sidebar, library, whichever
   * screen you were last on — behind one image. The editor is its own window now, and the app
   * only comes back if it was already open when the capture started.
   */
  const openEditorForCapture = useCallback(
    async (item: MediaItem) => {
      await restoreAfterCapture(false);
      try {
        await openEditorWindow(item);
      } catch (e) {
        toast(String(e), "err");
      }
    },
    [restoreAfterCapture, toast]
  );

  // The region overlay notifies us when a screenshot was captured.
  useEffect(() => {
    const un = listen<MediaItem>("captured", (e) => {
      reload();
      openEditorForCapture(e.payload);
    });
    const unErr = listen<string>("capture-error", (e) => {
      toast(e.payload, "err");
      restoreAfterCapture(true);
    });
    return () => {
      un.then((f) => f());
      unErr.then((f) => f());
    };
  }, [reload, toast, openEditorForCapture, restoreAfterCapture]);

  const primaryMonitorId =
    monitors.find((m) => m.isPrimary)?.id ?? monitors[0]?.id ?? null;

  // Build the region-select overlays as soon as the monitor list is known, so the first
  // "Capture Area" shows its crosshair instantly instead of paying webview startup cost.
  useEffect(() => {
    if (monitors.length) prewarmRegionOverlays(monitors).catch(() => {});
  }, [monitors]);

  /**
   * Gate in front of every capture entry point.
   *
   * macOS reports a missing Screen Recording permission as an ordinary, successful
   * screenshot — of the desktop, with all window content stripped out. Checking afterwards
   * is therefore impossible: nothing distinguishes that from a real capture of an empty
   * desktop. Asking first is the only point at which the difference can be explained.
   *
   * The system dialog appears at most once per binary; every later request returns the
   * stored answer with no UI at all. That is why a second refusal routes to System Settings
   * rather than asking again.
   */
  const screenStage = useRef<"unasked" | "prompted" | "sent" | "resigned">("unasked");
  const ensureScreenAccess = useCallback(async () => {
    if (screenReady) return true;
    // Re-read rather than trusting state: it may have been granted since the last check.
    const ok = await screenPermissionGranted().catch(() => true);
    setScreenReady(ok);
    if (ok) return true;

    switch (screenStage.current) {
      case "unasked":
        screenStage.current = "prompted";
        // Shows the system dialog, but only if this binary has never asked before.
        await requestScreenPermission().catch(() => false);
        toast(
          "Capture Studio needs Screen Recording permission — allow it, then restart the app",
          "err"
        );
        return false;

      case "prompted": {
        screenStage.current = "sent";
        // The restart is the step people skip, and nothing works until they take it, so it
        // is offered as the primary action rather than buried in a sentence.
        const now = await confirmDialog(
          "macOS applies Screen Recording permission only to a fresh launch, so granting it does not affect the running app. Restart Capture Studio to finish, or open System Settings if it is not switched on yet.",
          {
            title: "Restart to finish",
            kind: "warning",
            okLabel: "Restart now",
            cancelLabel: "Open System Settings",
          }
        ).catch(() => false);
        if (now) await restartApp().catch(() => {});
        else await openScreenPermissionSettings().catch(() => {});
        return false;
      }

      default:
        // Stop blocking after the user has been told twice.
        //
        // This check cannot be trusted enough to keep refusing on: the permission API caches
        // its answer for the life of the process, and on an ad-hoc signed build it can report
        // "denied" for a permission that is actually granted. Standing in front of a working
        // capture on a false negative would be a worse bug than the wallpaper screenshot this
        // gate exists to prevent — and the sidebar warning stays up regardless, so nobody is
        // left guessing about a blank-looking result.
        if (screenStage.current !== "resigned") {
          screenStage.current = "resigned";
          toast("Capturing anyway — if you only get the wallpaper, restart the app", "info");
        }
        return true;
    }
  }, [screenReady, toast]);

  /** The sidebar's "Fix this". Always ends somewhere, unlike a bare re-check. */
  const fixScreenPermission = useCallback(async () => {
    if (await screenPermissionGranted().catch(() => false)) {
      setScreenReady(true);
      toast("Screen Recording permission is on");
      return;
    }
    const now = await confirmDialog(
      "Turn Capture Studio on under Privacy & Security → Screen & System Audio Recording. macOS only applies the change to a fresh launch, so the app has to restart afterwards.",
      {
        title: "Screen Recording permission",
        kind: "warning",
        okLabel: "Restart now",
        cancelLabel: "Open System Settings",
      }
    ).catch(() => false);
    if (now) await restartApp().catch(() => {});
    else await openScreenPermissionSettings().catch(() => {});
  }, [toast]);

  const captureFull = useCallback(
    async (monitorId: number | null) => {
      const win = getCurrentWindow();
      if (busyRef.current) return;
      if (!(await ensureScreenAccess())) return;
      busyRef.current = true;
      setBusy("capture");
      try {
        await win.hide();
        await new Promise((r) => setTimeout(r, 320));
        const item = await captureMonitor(monitorId ?? undefined);
        await reload();
        await openEditorForCapture(item);
      } catch (e) {
        toast(String(e), "err");
        await win.show();
        await win.setFocus();
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [reload, toast, openEditorForCapture, ensureScreenAccess]
  );

  // Opening the overlay can take a moment on first use; without a busy state these three
  // buttons looked completely inert while it came up.
  const openOverlay = useCallback(
    async (mode: OverlayMode, pick: "area" | "window" | "both") => {
      // Checked before the overlay rather than after the drag: sending someone through a
      // crosshair selection only to hand them a slice of wallpaper is the exact failure this
      // gate exists to prevent.
      if (!(await ensureScreenAccess())) return;
      setBusy("capture");
      try {
        const win = getCurrentWindow();
        // Get the app's own window out of the shot. `captureFull` has always done this; every
        // overlay-driven mode skipped it, so a region drawn anywhere near the window captured
        // it — and a WKWebView pulled out of a whole-monitor grab comes out as a black
        // rectangle rather than what is on screen, so the result looked broken as well as
        // wrong.
        //
        // Window-picking is the one mode where our own window has to stay on screen, because
        // it is the only path that captures Capture Studio correctly: xcap's per-window grab
        // renders it properly. Every other mode crops from a monitor grab, so the app has to
        // get out of the way.
        //
        // Awaited before the overlay opens rather than raced against it. `openRegionOverlay`
        // ends by focusing an overlay, and a hide landing *after* that focus call hands
        // activation back to whatever was behind — leaving a crosshair that cannot receive the
        // Escape key. Two IPC round trips is a few milliseconds; the slow part this flow was
        // once criticised for was grabbing the screen, not hiding a window.
        const wasVisible = pick !== "window" && (await win.isVisible());
        if (wasVisible) await win.hide();
        hidForCapture.current = wasVisible;
        await openRegionOverlay(mode, monitors, pick);
      } catch (e) {
        toast(String(e), "err");
        await restoreAfterCapture(true);
      } finally {
        setBusy(null);
      }
    },
    [monitors, toast, restoreAfterCapture, ensureScreenAccess]
  );

  // Nothing was captured, so nothing else is going to bring the window back.
  useEffect(() => {
    const un = listen<{ reason?: string } | null>("overlay-cancelled", (e) => {
      restoreAfterCapture(true);
      // Escape is the user saying no, and needs no commentary. The rest are cases where
      // someone tried to capture and got nothing, which was previously indistinguishable
      // from the app being broken.
      const reason = e.payload?.reason;
      if (reason === "too-small") {
        toast("That selection was too small — drag a larger area", "info");
      } else if (reason === "no-window") {
        toast("No window under the cursor there", "info");
      } else if (reason === "no-gesture") {
        // The overlay was on screen but never saw a press. If this ever shows up, the problem
        // is the overlay not receiving input, not the selection geometry.
        toast("The selection didn't register — please try again", "info");
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [restoreAfterCapture]);

  const captureRegion = useCallback(() => openOverlay("shot", "area"), [openOverlay]);
  const captureWindowPick = useCallback(() => openOverlay("shot", "window"), [openOverlay]);
  const captureScroll = useCallback(() => openOverlay("scroll", "both"), [openOverlay]);
  const captureText = useCallback(() => openOverlay("text", "area"), [openOverlay]);

  const captureDelayed = useCallback(async () => {
    // Asked before the countdown starts, so the permission dialog cannot land in the middle
    // of it — or, worse, three seconds after the user looked away.
    if (!(await ensureScreenAccess())) return;
    // Counts down in the sidebar rather than firing a toast that expires around the same
    // moment the shot is taken.
    setBusy("capture");
    let left = 3;
    toast(`Capturing in ${left}…`, "info");
    const tick = window.setInterval(() => {
      left -= 1;
      if (left > 0) {
        toast(`Capturing in ${left}…`, "info");
        return;
      }
      window.clearInterval(tick);
      setBusy(null);
      captureFull(primaryMonitorId);
    }, 1000);
  }, [captureFull, primaryMonitorId, toast, ensureScreenAccess]);

  const openFile = useCallback(async () => {
    try {
      const path = await openDialog({
        multiple: false,
        filters: [
          { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] },
        ],
      });
      if (typeof path === "string") {
        await importFile(path);
        await reload();
        toast("Image imported");
      }
    } catch (e) {
      toast(String(e), "err");
    }
  }, [reload, toast]);

  const loadClipboard = useCallback(async () => {
    try {
      await importFromClipboard();
      await reload();
      toast("Loaded from clipboard");
    } catch (e) {
      toast(String(e), "err");
    }
  }, [reload, toast]);

  // Recording started from the modal: hide the main window (so it isn't captured) and
  // replace it with the small always-on-top stop-bar.
  const handleRecordStarted = useCallback(async () => {
    setRecordOpen(false);
    setRecording(true);
    try {
      await getCurrentWindow().hide();
      await openStopBar(Date.now());
    } catch (e) {
      toast(String(e), "err");
    }
  }, [toast]);

  // Single source of truth for ending a recording, whichever UI triggered it
  // (stop-bar button or the ⌃⇧5 shortcut while already recording).
  const stopActiveRecording = useCallback(async () => {
    try {
      await stopRecording();
      toast("Recording saved");
    } catch (e) {
      toast(String(e), "err");
    } finally {
      setRecording(false);
      await closeStopBar();
      // The area outline belongs to the recording that just ended.
      await hideRegionHint().catch(() => {});
      const win = getCurrentWindow();
      await win.show();
      await win.setFocus();
      await reload();
    }
  }, [reload, toast]);

  const openRecordSetup = useCallback(async () => {
    const win = getCurrentWindow();
    await win.show();
    await win.setFocus();
    setRecordOpen(true);
  }, []);

  const toggleRecording = useCallback(() => {
    if (recording) {
      stopActiveRecording();
    } else {
      openRecordSetup();
    }
  }, [recording, stopActiveRecording, openRecordSetup]);

  // The stop-bar window has no direct handle to app state, so it asks over the event bus.
  useEffect(() => {
    const un = listen("stop-recording-request", () => {
      stopActiveRecording();
    });
    return () => {
      un.then((f) => f());
    };
  }, [stopActiveRecording]);

  // ---- Scrolling capture ----
  // The overlay picks the region, the floating bar drives the per-frame polling, and this
  // window owns the session's start/finish/cancel so the result lands in the library and
  // opens in the editor like any other capture.
  useEffect(() => {
    const unPicked = listen<{
      rect: [number, number, number, number];
      monitorId: number | null;
    }>("scroll-region-selected", async (e) => {
      const { rect, monitorId } = e.payload;
      const monitor = monitors.find((m) => m.id === monitorId) ?? null;
      try {
        await getCurrentWindow().hide();
        await scrollStart(monitorId, rect[0], rect[1], rect[2], rect[3]);
        await openScrollBar(monitor, rect);
        toast("Scroll the content — press Done when finished", "info");
      } catch (err) {
        await closeScrollBar();
        toast(String(err), "err");
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
      }
    });

    const unFinish = listen("scroll-finish-request", async () => {
      await closeScrollBar();
      try {
        const item = await scrollFinish();
        await reload();
        await openEditorForCapture(item);
      } catch (err) {
        toast(String(err), "err");
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
      }
    });

    const unCancel = listen("scroll-cancel-request", async () => {
      await closeScrollBar();
      await scrollCancel().catch(() => {});
      const win = getCurrentWindow();
      await win.show();
      await win.setFocus();
    });

    return () => {
      unPicked.then((f) => f());
      unFinish.then((f) => f());
      unCancel.then((f) => f());
    };
  }, [monitors, reload, toast, openEditorForCapture]);

  // ---- Capture Text ----
  // The overlay picks the area; the text goes on the clipboard and nothing reaches the
  // library, because the point of this flow is the words rather than a picture of them.
  useEffect(() => {
    const un = listen<{
      rect: [number, number, number, number];
      monitorId: number | null;
    }>("text-region-selected", async (e) => {
      const { rect, monitorId } = e.payload;
      try {
        // Let the overlay actually leave the screen first — its own selection rectangle sits
        // on top of the region and would otherwise be recognised along with the content.
        await new Promise((r) => setTimeout(r, 90));
        const res = await ocrRegion(monitorId, rect[0], rect[1], rect[2], rect[3]);
        if (!res.text.trim()) {
          toast("No text found in that area", "info");
          return;
        }
        await setClipboardText(res.text);
        const n = res.lines.length;
        toast(
          res.lowConfidence > 0
            ? `Copied ${n} line${n === 1 ? "" : "s"} — ${res.lowConfidence} may be misread`
            : `Copied ${n} line${n === 1 ? "" : "s"} to the clipboard`,
          res.lowConfidence > 0 ? "info" : "ok"
        );
      } catch (err) {
        toast(String(err), "err");
      } finally {
        // No editor opens for this mode, so nothing else would bring the window back. Shown
        // without focus deliberately: the text just went on the clipboard and the next thing
        // the user does is paste it into whatever they were reading.
        await restoreAfterCapture(false);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [toast, restoreAfterCapture]);

  // The editor runs in its own window, so anything it does that the app is showing has to come
  // back over an event — there is no shared React tree left to update.
  useEffect(() => {
    const unSaved = listen("library-changed", () => {
      reload();
      getAccountStatus().then(setAccount).catch(() => {});
    });
    const unPaywall = listen("editor-need-subscription", async () => {
      // The editor has already stepped aside; bring the app forward to take over.
      const win = getCurrentWindow();
      await win.show();
      await win.setFocus();
      needSubscription();
    });
    return () => {
      unSaved.then((f) => f());
      unPaywall.then((f) => f());
    };
  }, [reload, needSubscription]);

  // React to tray-menu clicks and global keyboard shortcuts (Rust emits "tray-action").
  useEffect(() => {
    const un = listen<string>("tray-action", (e) => {
      switch (e.payload) {
        case "capture-full":
          captureFull(primaryMonitorId);
          break;
        case "capture-region":
          captureRegion();
          break;
        case "capture-window":
          captureWindowPick();
          break;
        case "capture-scroll":
          captureScroll();
          break;
        case "capture-text":
          captureText();
          break;
        case "capture-delayed":
          captureDelayed();
          break;
        case "record":
        case "record-toggle":
          toggleRecording();
          break;
        case "open-file":
          openFile();
          break;
        case "clipboard":
          loadClipboard();
          break;
        case "settings":
          setView("settings");
          break;
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [
    captureFull,
    captureRegion,
    captureWindowPick,
    captureScroll,
    captureDelayed,
    openFile,
    loadClipboard,
    toggleRecording,
    primaryMonitorId,
  ]);

  const filtered = items.filter((i) => filter === "all" || i.kind === filter);

  // ---- Library multi-select ----
  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exitSelecting = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  // "Select all" applies to what's currently on screen, not the whole library, so it
  // matches what the user can actually see under the active filter.
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((i) => selected.has(i.id));
  const toggleSelectAll = useCallback(() => {
    setSelected(allVisibleSelected ? new Set() : new Set(filtered.map((i) => i.id)));
  }, [allVisibleSelected, filtered]);

  const deleteSelected = useCallback(async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const ok = await confirmDialog(
      `Delete ${ids.length} item${ids.length > 1 ? "s" : ""}? This cannot be undone.`,
      { title: "Delete items", kind: "warning" }
    );
    if (!ok) return;
    try {
      const n = await deleteItems(ids);
      exitSelecting();
      await reload();
      toast(`Deleted ${n} item${n > 1 ? "s" : ""}`);
    } catch (e) {
      toast(String(e), "err");
    }
  }, [selected, exitSelecting, reload, toast]);

  return (
    <div className="app">
      <Sidebar
        view={view}
        onView={setView}
        monitors={monitors}
        busy={busy}
        onCaptureFull={captureFull}
        ffmpegReady={ffmpegReady}
        screenReady={screenReady}
        onFixScreenPermission={fixScreenPermission}
        onCaptureRegion={captureRegion}
        onCaptureWindow={captureWindowPick}
        onCaptureScroll={captureScroll}
        onCaptureText={captureText}
        onCaptureDelayed={captureDelayed}
        recording={recording}
        onRecord={toggleRecording}
        onOpenFile={openFile}
        onClipboard={loadClipboard}
      />

      <div className="main">
        {/* Above the view, below the title bar. Never rendered over a capture: the overlay is
            a separate window and the annotation editor replaces this tree entirely. */}
        {license?.shouldNudge && (
          <LicenseBar
            status={license}
            onBuy={() => {
              openUrl(BUY_URL).catch((e) => toast(String(e), "err"));
              dismissNudge();
            }}
            onEnterKey={() => {
              setView("settings");
              dismissNudge();
            }}
            onDismiss={dismissNudge}
          />
        )}
        {view === "library" ? (
          <>
            <div className="topbar">
              <h2>Library</h2>
              <span className="count">
                {selecting
                  ? `${selected.size} selected`
                  : filter === "all"
                    ? `${items.length} items`
                    : `${filtered.length} of ${items.length}`}
              </span>
              <div className="spacer" />
              {selecting ? (
                <div className="seg-actions">
                  <button className="btn ghost" onClick={toggleSelectAll}>
                    {allVisibleSelected ? "Clear all" : "Select all"}
                  </button>
                  <button
                    className="btn danger"
                    onClick={deleteSelected}
                    disabled={selected.size === 0}
                  >
                    Delete{selected.size ? ` (${selected.size})` : ""}
                  </button>
                  <button className="btn ghost" onClick={exitSelecting}>
                    Done
                  </button>
                </div>
              ) : (
                <>
                  <button
                    className="btn ghost"
                    onClick={() => setSelecting(true)}
                    disabled={items.length === 0}
                  >
                    Select
                  </button>
                  <div className="seg">
                    {(["all", "screenshot", "recording"] as Filter[]).map((f) => (
                      <button
                        key={f}
                        className={filter === f ? "active" : ""}
                        onClick={() => setFilter(f)}
                      >
                        {f === "all" ? "All" : f === "screenshot" ? "Images" : "Videos"}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="content">
              <Gallery
                items={filtered}
                loading={loading}
                filter={filter}
                onClearFilter={() => setFilter("all")}
                selecting={selecting}
                selected={selected}
                onOpen={setDetail}
                onToggle={toggleSelected}
              />
            </div>
          </>
        ) : view === "optimize" ? (
          <Optimizer toast={toast} />
        ) : (
          <Settings
            monitors={monitors}
            account={account}
            onOpenLogin={() => setAccountModalOpen(true)}
            onAccountChange={setAccount}
            focusTab={settingsTab}
            onFocusHandled={clearSettingsTab}
            toast={toast}
          />
        )}
      </div>

      {detail && (
        <DetailModal
          item={detail}
          subscriptionActive={!!account?.subscriptionActive}
          onClose={() => setDetail(null)}
          onChanged={async () => {
            await reload();
            getAccountStatus().then(setAccount).catch(() => {});
          }}
          onAnnotate={(it) => {
            setDetail(null);
            openEditorWindow(it).catch((e) => toast(String(e), "err"));
          }}
          onOptimize={(it) => {
            setDetail(null);
            setOptimizeTarget(it);
          }}
          onBeautify={(it) => {
            setDetail(null);
            setBeautifyTarget(it);
          }}
          onNeedSubscription={needSubscription}
          toast={toast}
        />
      )}

      {accountModalOpen && (
        <AccountModal
          onClose={() => setAccountModalOpen(false)}
          onLoggedIn={setAccount}
          toast={toast}
        />
      )}

      {beautifyTarget && (
        <BeautifyModal
          item={beautifyTarget}
          onClose={() => setBeautifyTarget(null)}
          onSaved={reload}
          toast={toast}
        />
      )}

      {optimizeTarget && (
        <OptimizeModal
          item={optimizeTarget}
          onClose={() => setOptimizeTarget(null)}
          onDone={reload}
          toast={toast}
        />
      )}

      {recordOpen && (
        <RecordModal
          monitors={monitors}
          onClose={() => setRecordOpen(false)}
          onStarted={handleRecordStarted}
          toast={toast}
        />
      )}

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

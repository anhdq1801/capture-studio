import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AnnotationEditor } from "./components/AnnotationEditor";
import { Toasts, ToastMsg } from "./components/Toasts";
import { MediaItem, getAccountStatus } from "./lib/api";
import "./styles.css";

/**
 * The editor, on its own.
 *
 * This window is created once and reused, so everything here has to survive being handed a new
 * capture. It is created hidden and shows itself once it has one, because a window that appears
 * before its contents is just a black rectangle for however long the webview takes to boot.
 */
function EditorWindow() {
  const [item, setItem] = useState<MediaItem | null>(null);
  const [subscriptionActive, setSubscriptionActive] = useState(false);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const toastId = useRef(0);
  // Read by the close handler, which is registered once and would otherwise capture the item
  // from the render it was created in.
  const itemRef = useRef<MediaItem | null>(null);
  itemRef.current = item;

  const dismissToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback(
    (text: string, kind: ToastMsg["kind"] = "ok") => {
      const id = ++toastId.current;
      setToasts((t) => [...t, { id, text, kind }]);
      // Errors persist until dismissed, as in the main window: they are usually a raw backend
      // message and 3.4s is not long enough to read one.
      if (kind !== "err") setTimeout(() => dismissToast(id), 3400);
    },
    [dismissToast]
  );

  const dismiss = useCallback(async () => {
    // Dropped before hiding, so a reopen cannot show the previous capture for a frame, and so
    // the canvas and its ImageBitmap are released rather than held for the whole session.
    setItem(null);
    await getCurrentWindow().hide();
  }, []);

  // Every open, including the first: the opener waits for `editor-ready` before sending one.
  useEffect(() => {
    const un = listen<MediaItem>("editor-open", async (e) => {
      setToasts([]);
      setItem(e.payload);
      // Whether upload is allowed is the one thing the editor cannot work out for itself.
      // Re-read on every open, so subscribing in the main window takes effect here without a
      // restart.
      getAccountStatus()
        .then((a) => setSubscriptionActive(!!a?.subscriptionActive))
        .catch(() => setSubscriptionActive(false));
      const win = getCurrentWindow();
      await win.show();
      await win.setFocus();
    });
    // Announced after the listener is attached, so the reply cannot arrive before we are
    // listening for it.
    un.then(() => emit("editor-ready"));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // The close button in the window's own title bar has to behave like the editor's Close, or a
  // draft would be left behind with nothing to delete it.
  useEffect(() => {
    const win = getCurrentWindow();
    const un = win.onCloseRequested((e) => {
      e.preventDefault();
      // With an editor mounted, it owns the "discard the draft" decision. With nothing mounted
      // there is nobody to route to, and forwarding regardless is what made this window
      // impossible to close.
      if (itemRef.current) emit("editor-close-request");
      else dismiss();
    });
    return () => {
      un.then((f) => f());
    };
  }, [dismiss]);

  if (!item) {
    // Reached while waiting for the first capture, and after one is dismissed — both moments
    // when the window is hidden. If it is ever visible in this state something went wrong, so
    // it says so and offers the way out rather than being a blank rectangle.
    return (
      <div className="editor-empty">
        <p>No capture is open.</p>
        <button className="btn" onClick={dismiss}>
          Close
        </button>
        <Toasts toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  return (
    <>
      <AnnotationEditor
        // Remount for each capture: the editor holds a canvas, a shape list and a tool
        // selection, none of which should carry over from the last screenshot.
        key={item.id}
        item={item}
        subscriptionActive={subscriptionActive}
        onClose={dismiss}
        onSaved={() => {
          // The library lives in the main window; it has no other way to know.
          emit("library-changed");
        }}
        onNeedSubscription={() => {
          // The paywall and the account screen are the main window's, so hand this over and
          // get out of the way.
          emit("editor-need-subscription");
          dismiss();
        }}
        toast={toast}
      />
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("editor-root") as HTMLElement).render(
  <React.StrictMode>
    <EditorWindow />
  </React.StrictMode>
);

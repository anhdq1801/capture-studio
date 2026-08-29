import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setClipboardText } from "./lib/api";
import { Paragraph } from "./lib/paragraphs";

/**
 * What the recogniser read, shown rather than only copied.
 *
 * Capture Text used to put its result straight on the clipboard and say "copied 3 lines". The
 * app already knew some of those lines were doubtful — it counts them — but the only way to
 * find out which was to paste the text somewhere and read it. This is the missing step: the
 * text, the doubtful paragraphs marked, and the chance to fix them before they go anywhere.
 *
 * The clipboard is still written the moment recognition finishes, so the old one-gesture path
 * is not a keystroke slower. This window appears on top of that, and can be ignored.
 *
 * Styles live in this file rather than the app stylesheet, the way stopbar does it: these are
 * separate webviews, and pulling the whole app's CSS into a 420px panel costs a parse of
 * several hundred rules it will never use.
 */

const params = new URLSearchParams(window.location.search);
const paragraphs: Paragraph[] = JSON.parse(
  decodeURIComponent(params.get("paragraphs") ?? "[]")
);

const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

function TextPanel() {
  const [pinned, setPinned] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const uncertain = paragraphs.filter((p) => p.uncertain).length;

  // Rendered once, then left to the DOM. React re-rendering a contentEditable on every
  // keystroke fights the caret, and there is nothing here that needs to re-render.
  const initialHtml = useMemo(
    () =>
      paragraphs
        .map(
          (p) =>
            `<p class="${p.uncertain ? "para doubt" : "para"}">${escapeHtml(p.text)}</p>`
        )
        .join("") || '<p class="para"></p>',
    []
  );

  const currentText = () =>
    Array.from(bodyRef.current?.querySelectorAll("p") ?? [])
      .map((p) => p.textContent?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n");

  const close = () => getCurrentWindow().close();

  const copy = async () => {
    try {
      await setClipboardText(currentText());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // The clipboard already holds the text from the moment recognition finished, so a failure
      // here leaves the user no worse off than before this window existed.
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void copy();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const togglePin = async () => {
    const next = !pinned;
    setPinned(next);
    await getCurrentWindow().setAlwaysOnTop(next);
  };

  return (
    <div className="tp">
      <div className="tp-bar" data-tauri-drag-region>
        <button className="tp-close" onClick={close} title="Close (Esc)" aria-label="Close" />
        <span className="tp-title" data-tauri-drag-region>
          Extracted text
        </span>
        <span className="tp-spacer" data-tauri-drag-region />
        {uncertain > 0 && <span className="tp-warn">{uncertain} to check</span>}
        <button
          className={`tp-icon${pinned ? " on" : ""}`}
          onClick={togglePin}
          title={pinned ? "Stop keeping on top" : "Keep on top"}
          aria-pressed={pinned}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M9.5 1.5 14.5 6.5M11 5 5.5 7 3 9.5l3.5 3.5L9 10.5 11 5ZM5.5 10.5 2 14"
              stroke="currentColor"
              strokeWidth="1.4"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div
        ref={bodyRef}
        className="tp-body"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        dangerouslySetInnerHTML={{ __html: initialHtml }}
      />

      <div className="tp-foot">
        <span className="tp-hint">
          {uncertain > 0
            ? `${uncertain} marked paragraph${uncertain === 1 ? "" : "s"} may be misread — fix them here.`
            : "Already on the clipboard. Edit here to change what you copy."}
        </span>
        <button className="tp-copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <style>{`
        :root { color-scheme: dark; }
        * { box-sizing: border-box; }
        .tp {
          height: 100%;
          display: flex;
          flex-direction: column;
          background: #16181f;
          border: 1px solid #2b3040;
          border-radius: 12px;
          overflow: hidden;
          font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          color: #e7e9ee;
        }
        .tp-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 9px 10px;
          border-bottom: 1px solid #242938;
          background: #1b1e27;
          flex: 0 0 auto;
          user-select: none;
        }
        .tp-close {
          width: 12px; height: 12px; padding: 0;
          border: none; border-radius: 50%;
          background: #ff5f57; cursor: pointer;
        }
        .tp-close:hover { filter: brightness(1.15); }
        .tp-title { font-weight: 600; font-size: 12.5px; }
        .tp-spacer { flex: 1; }
        .tp-warn {
          font-size: 11px; color: #ffcf70;
          background: rgba(255, 207, 112, 0.12);
          border: 1px solid rgba(255, 207, 112, 0.25);
          border-radius: 999px; padding: 2px 8px;
        }
        .tp-icon {
          display: grid; place-items: center;
          width: 24px; height: 24px; padding: 0;
          border: none; border-radius: 6px;
          background: transparent; color: #9aa0ad; cursor: pointer;
        }
        .tp-icon:hover { background: #232838; color: #e7e9ee; }
        .tp-icon.on { background: rgba(109, 94, 252, 0.18); color: #8b7dff; }

        .tp-body {
          flex: 1; min-height: 0;
          overflow-y: auto;
          padding: 12px 14px;
          outline: none;
          user-select: text;
          -webkit-user-select: text;
        }
        .tp-body .para { margin: 0 0 11px; white-space: pre-wrap; }
        .tp-body .para:last-child { margin-bottom: 0; }
        /* Marked rather than recoloured: the text still has to be readable to be corrected. */
        .tp-body .doubt {
          border-left: 2px solid #ffcf70;
          margin-left: -8px;
          padding-left: 6px;
          background: rgba(255, 207, 112, 0.06);
        }

        .tp-foot {
          display: flex; align-items: center; gap: 10px;
          padding: 8px 10px 9px;
          border-top: 1px solid #242938;
          background: #1b1e27;
          flex: 0 0 auto;
        }
        .tp-hint { flex: 1; font-size: 11.5px; color: #9aa0ad; }
        .tp-copy {
          border: 1px solid #343b4f; border-radius: 7px;
          background: #232838; color: #e7e9ee;
          font-size: 12px; padding: 5px 12px; cursor: pointer;
        }
        .tp-copy:hover { background: #2b3143; }
      `}</style>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("textpanel-root")!).render(
  <React.StrictMode>
    <TextPanel />
  </React.StrictMode>
);

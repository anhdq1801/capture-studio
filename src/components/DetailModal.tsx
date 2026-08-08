import { useEffect, useState } from "react";
import {
  MediaItem,
  itemSrc,
  updateNote,
  deleteItem,
  revealItem,
  uploadItem,
  ocrItem,
  ocrAvailable,
  setClipboardText,
} from "../lib/api";
import { formatBytes, formatDuration } from "../lib/format";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { useEscapeKey } from "./Modal";

interface Props {
  item: MediaItem;
  subscriptionActive: boolean;
  onClose: () => void;
  onChanged: () => void;
  onAnnotate: (i: MediaItem) => void;
  onOptimize: (i: MediaItem) => void;
  onBeautify: (i: MediaItem) => void;
  onNeedSubscription: () => void;
  toast: (t: string, k?: "ok" | "err" | "info") => void;
}

export function DetailModal({
  item,
  subscriptionActive,
  onClose,
  onChanged,
  onAnnotate,
  onOptimize,
  onBeautify,
  onNeedSubscription,
  toast,
}: Props) {
  const [src, setSrc] = useState("");
  const [note, setNote] = useState(item.note);
  const [saving, setSaving] = useState(false);
  useEscapeKey(onClose);
  const [uploading, setUploading] = useState(false);
  const [reading, setReading] = useState(false);
  // Hidden rather than shown-and-failing on a platform without a system recogniser.
  const [canOcr, setCanOcr] = useState(false);
  const isImage = item.kind === "screenshot";

  useEffect(() => {
    ocrAvailable().then(setCanOcr).catch(() => setCanOcr(false));
  }, []);

  const copyText = async () => {
    if (reading) return;
    setReading(true);
    try {
      const res = await ocrItem(item.id);
      if (!res.text.trim()) {
        toast("No text found in this image", "info");
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
    } catch (e) {
      toast(String(e), "err");
    } finally {
      setReading(false);
    }
  };

  useEffect(() => {
    itemSrc(item).then(setSrc);
  }, [item.id, item.sizeBytes]);

  const saveNote = async () => {
    if (note === item.note) return;
    setSaving(true);
    try {
      await updateNote(item.id, note);
      await onChanged();
      toast("Note saved");
    } catch (e) {
      toast(String(e), "err");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    // The multi-select and editor delete paths both confirm; this one silently destroyed a
    // capture on a single misclick, with no undo.
    if (
      !(await confirmDialog("Delete this item? This cannot be undone.", {
        title: "Delete",
        kind: "warning",
      }))
    ) {
      return;
    }
    try {
      await deleteItem(item.id);
      await onChanged();
      toast("Deleted");
      onClose();
    } catch (e) {
      toast(String(e), "err");
    }
  };

  const upload = async () => {
    if (!subscriptionActive) {
      onNeedSubscription();
      return;
    }
    setUploading(true);
    try {
      await uploadItem(item.id);
      await onChanged();
      toast("Uploaded to cloud");
    } catch (e) {
      const msg = String(e);
      if (msg.includes("quota")) {
        toast("Storage quota exceeded — buy more storage in Settings", "err");
      } else if (msg.includes("subscription")) {
        onNeedSubscription();
      } else {
        toast(msg, "err");
      }
    } finally {
      setUploading(false);
    }
  };

  const copyLink = async () => {
    if (!item.cloudUrl) return;
    await navigator.clipboard.writeText(item.cloudUrl);
    toast("Link copied");
  };

  return (
    <div className="overlay-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{isImage ? "Screenshot" : "Recording"}</h3>
          <button className="x" onClick={onClose} aria-label="Close" title="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="detail-grid">
            <div>
              <div className="detail-preview">
                {isImage ? (
                  src && <img src={src} alt={item.note} />
                ) : (
                  src && <video src={src} controls />
                )}
              </div>
            </div>
            <div className="detail-side">
              <div className="field">
                <label>Note</label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onBlur={saveNote}
                  placeholder="Add a note describing this capture…"
                />
              </div>
              <div className="detail-actions">
                {isImage && (
                  <button className="btn" onClick={() => onAnnotate(item)}>
                    Annotate
                  </button>
                )}
                {isImage && (
                  <button className="btn" onClick={() => onBeautify(item)}>
                    Beautify
                  </button>
                )}
                {isImage && (
                  <button className="btn" onClick={() => onOptimize(item)}>
                    Optimize size
                  </button>
                )}
                {isImage && canOcr && (
                  <button className="btn" onClick={copyText} disabled={reading}>
                    {reading ? <i className="spin" /> : "Copy text"}
                  </button>
                )}
                <button className="btn" onClick={() => revealItem(item.id)}>
                  Reveal in {navigatorLabel()}
                </button>
                {item.cloudUrl ? (
                  <button className="btn" onClick={copyLink}>
                    Copy link
                  </button>
                ) : (
                  <button className="btn" onClick={upload} disabled={uploading}>
                    {uploading ? (
                      <i className="spin" />
                    ) : subscriptionActive ? (
                      "☁️ Upload to Cloud"
                    ) : (
                      "☁️ Upload to Cloud (Subscribe)"
                    )}
                  </button>
                )}
                <button className="btn danger" onClick={remove}>
                  🗑 Delete
                </button>
              </div>
              <div className="meta-list">
                <div>
                  <b>Created</b> · {item.createdAt}
                </div>
                <div>
                  <b>Size</b> · {formatBytes(item.sizeBytes)}
                </div>
                {item.width ? (
                  <div>
                    <b>Dimensions</b> · {item.width}×{item.height}
                  </div>
                ) : null}
                {item.durationMs ? (
                  <div>
                    <b>Duration</b> · {formatDuration(item.durationMs)}
                  </div>
                ) : null}
                <div>
                  <b>File</b> · {item.fileName}
                </div>
                {item.cloudUrl ? (
                  <div>
                    <b>Cloud</b> · uploaded {item.uploadedAt}
                  </div>
                ) : null}
              </div>
              {saving && <div className="hint">Saving…</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function navigatorLabel(): string {
  const p = navigator.platform.toLowerCase();
  if (p.includes("mac")) return "Finder";
  if (p.includes("win")) return "Explorer";
  return "folder";
}

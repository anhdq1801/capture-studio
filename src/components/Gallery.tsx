import { useEffect, useState } from "react";
import { MediaItem, previewSrc } from "../lib/api";
import { formatBytes, formatDuration } from "../lib/format";
import { Filter } from "../App";
import { UiIcon } from "./Icons";

export function Gallery({
  items,
  loading,
  filter,
  onClearFilter,
  selecting,
  selected,
  onOpen,
  onToggle,
}: {
  items: MediaItem[];
  loading: boolean;
  filter: Filter;
  onClearFilter: () => void;
  /** In selection mode a click picks items instead of opening them. */
  selecting: boolean;
  selected: Set<string>;
  onOpen: (i: MediaItem) => void;
  onToggle: (id: string) => void;
}) {
  // The library loads asynchronously, so without this the "no captures yet" illustration
  // flashed on every launch before the real contents arrived.
  if (loading) {
    return (
      <div className="grid">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="card skeleton" aria-hidden="true">
            <div className="thumb" />
            <div className="card-body">
              <div className="sk-line" />
              <div className="sk-line short" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    // An empty *filter* is a different situation from an empty library, and telling someone
    // with 12 screenshots that they have no captures is simply wrong.
    if (filter !== "all") {
      const what = filter === "recording" ? "recordings" : "screenshots";
      return (
        <div className="empty-state">
          <div className="big">🔍</div>
          <p>No {what} yet.</p>
          <button className="btn ghost" onClick={onClearFilter}>
            Show all items
          </button>
        </div>
      );
    }
    return (
      <div className="empty-state">
        <div className="big">🗂</div>
        <p>No captures yet. Take a screenshot or start a recording to begin.</p>
      </div>
    );
  }
  return (
    <div className="grid">
      {items.map((it) => (
        <Card
          key={it.id}
          item={it}
          selecting={selecting}
          selected={selected.has(it.id)}
          onOpen={onOpen}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

function Card({
  item,
  selecting,
  selected,
  onOpen,
  onToggle,
}: {
  item: MediaItem;
  selecting: boolean;
  selected: boolean;
  onOpen: (i: MediaItem) => void;
  onToggle: (id: string) => void;
}) {
  const [src, setSrc] = useState<string>("");
  useEffect(() => {
    let live = true;
    previewSrc(item)
      .then((s) => live && setSrc(s))
      // A poster that cannot be generated (ffmpeg gone, file damaged) leaves the striped
      // placeholder rather than breaking the card.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [item.id, item.sizeBytes]);

  return (
    // A real button so the library is reachable by keyboard, not just by mouse.
    <button
      type="button"
      className={`card ${selecting ? "selectable" : ""} ${selected ? "selected" : ""}`}
      onClick={() => (selecting ? onToggle(item.id) : onOpen(item))}
      aria-pressed={selecting ? selected : undefined}
      aria-label={
        selecting
          ? `${selected ? "Deselect" : "Select"} ${item.note || item.fileName}`
          : `Open ${item.note || item.fileName}`
      }
    >
      <div className="thumb">
        {selecting && (
          <span
            className={`pick ${selected ? "on" : ""}`}
            // The whole card already toggles; this is only the visual affordance.
            aria-hidden="true"
          >
            {selected ? "✓" : ""}
          </span>
        )}
        <span className="badge">
          <UiIcon name={item.kind === "recording" ? "record" : "screen"} size={12} />
          {item.kind === "recording" ? "Video" : "Image"}
        </span>
        {src && (
          <img
            src={src}
            alt={item.note || (item.kind === "recording" ? "recording" : "screenshot")}
            loading="lazy"
          />
        )}
        {/* A poster frame is a still picture, so without this a recording card reads as a
            screenshot at a glance — the badge alone is too quiet to carry the distinction. */}
        {item.kind === "recording" && (
          <span className="play" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
            </svg>
          </span>
        )}
        {item.kind === "recording" && item.durationMs ? (
          <span className="dur">{formatDuration(item.durationMs)}</span>
        ) : null}
      </div>
      <div className="card-body">
        <p className={`note ${item.note ? "" : "empty"}`}>
          {item.note || "No note"}
        </p>
        <div className="card-meta">
          <span>{item.createdAt.split(" ")[0]}</span>
          <span className="sep">·</span>
          <span>{formatBytes(item.sizeBytes)}</span>
          {item.width ? (
            <>
              <span className="sep">·</span>
              <span>
                {item.width}×{item.height}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </button>
  );
}

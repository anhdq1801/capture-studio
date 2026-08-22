import { useCallback, useEffect, useState } from "react";
import { pauseShortcuts } from "../lib/api";
import {
  SHORTCUT_DEFAULTS,
  ShortcutId,
  acceleratorFromEvent,
  comboFor,
  formatAccelerator,
  saveShortcuts,
  useShortcuts,
} from "../lib/shortcuts";

/**
 * The editable list of global shortcuts.
 *
 * These used to be a printed list of fixed combinations, which is fine right up until another
 * app already owns one — and on a Mac loaded with other tools that is most of the keyboard —
 * and then the only thing the user could do about it was nothing.
 */
export function ShortcutRecorder({
  rows,
  toast,
}: {
  rows: { id: ShortcutId; label: string }[];
  toast: (t: string, k?: "ok" | "err" | "info") => void;
}) {
  const shortcuts = useShortcuts();
  /** The row currently listening for a keypress, if any. */
  const [arming, setArming] = useState<ShortcutId | null>(null);
  /** Ids the system would not register, so the rows can say so instead of looking saved. */
  const [refused, setRefused] = useState<string[]>([]);

  const commit = useCallback(
    async (id: ShortcutId, combo: string) => {
      // Caught here as well as in Rust so the complaint can name the other action and spell the
      // combination in glyphs, rather than quoting the accelerator the parser speaks.
      const clash = rows.find((r) => r.id !== id && combo && comboFor(shortcuts, r.id) === combo);
      if (clash) {
        toast(`${formatAccelerator(combo)} is already used by "${clash.label}"`, "err");
        return;
      }
      const next = { ...shortcuts, [id]: combo };
      try {
        const failed = await saveShortcuts(next);
        setRefused(failed);
        if (failed.includes(id)) {
          toast("Another app is already using that combination", "err");
        }
      } catch (e) {
        // The Rust side refuses a duplicate rather than letting one action shadow another.
        toast(String(e).replace(/^Error:\s*/, ""), "err");
      }
    },
    [rows, shortcuts, toast]
  );

  // While a row is armed the global shortcuts are released, because a registered hot key never
  // reaches the focused window — so without this the combinations that most need rebinding,
  // the ones already taken, are exactly the ones that could not be typed here.
  useEffect(() => {
    if (!arming) return;
    pauseShortcuts(true).catch(() => {});

    const onKey = (e: KeyboardEvent) => {
      // Nothing here should also reach the app's own keyboard handling: ⌘W while arming a
      // shortcut must not close the window.
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setArming(null);
        return;
      }
      // A bare Backspace means "no shortcut at all" — the way macOS itself clears one.
      if ((e.code === "Backspace" || e.code === "Delete") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setArming(null);
        commit(arming, "");
        return;
      }
      const combo = acceleratorFromEvent(e);
      // Still a modifier being held, or a key the accelerator parser cannot express. Keep
      // listening rather than storing something that would never fire.
      if (!combo) return;
      setArming(null);
      commit(arming, combo);
    };

    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      pauseShortcuts(false).catch(() => {});
    };
  }, [arming, commit]);

  // Arming and then clicking away would otherwise leave the shortcuts released for good.
  useEffect(() => {
    if (!arming) return;
    const cancel = () => setArming(null);
    window.addEventListener("blur", cancel);
    return () => window.removeEventListener("blur", cancel);
  }, [arming]);

  const restoreDefaults = async () => {
    try {
      setRefused(await saveShortcuts({ ...SHORTCUT_DEFAULTS }));
      toast("Shortcuts restored to their defaults");
    } catch (e) {
      toast(String(e).replace(/^Error:\s*/, ""), "err");
    }
  };

  const changed = rows.some((r) => comboFor(shortcuts, r.id) !== SHORTCUT_DEFAULTS[r.id]);

  return (
    <>
      <div className="sc-list">
        {rows.map(({ id, label }) => {
          const combo = comboFor(shortcuts, id);
          const armed = arming === id;
          return (
            <div className="sc-row" key={id}>
              <span className="sc-name">{label}</span>
              {refused.includes(id) && !armed && (
                <span className="sc-warn" title="Another app got there first">
                  in use elsewhere
                </span>
              )}
              <button
                className={`sc-key ${armed ? "armed" : ""} ${combo ? "" : "empty"}`}
                onClick={() => setArming(armed ? null : id)}
                // A screen reader otherwise announces nothing but the glyphs.
                aria-label={`Change the shortcut for ${label}`}
              >
                {armed ? "Press keys…" : combo ? formatAccelerator(combo) : "Not set"}
              </button>
            </div>
          );
        })}
      </div>
      <div className="hint">
        {arming
          ? "Hold the modifiers and press a key. Backspace removes the shortcut, Esc cancels."
          : "Click a shortcut to change it. They work anywhere, even when the window is hidden in the menu bar."}
      </div>
      {/* Registration only fails when the other app claimed the key the same way we do; macOS
          hands the rest over quietly, so a shortcut can be dead without anything saying so. */}
      <div className="hint">
        If one does nothing, another app has it — pick a different combination.
      </div>
      {changed && (
        <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={restoreDefaults}>
          Restore defaults
        </button>
      )}
    </>
  );
}

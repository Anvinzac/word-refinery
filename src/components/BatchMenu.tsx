/**
 * Batch menu — a small sheet that rises from the Words tab in the bottom bar.
 *
 * The word list shows one batch at a time, so switching batches is frequent
 * but brief: a popup anchored to the tab that owns the list keeps it one tap
 * away without spending a row of the screen on it. Each batch shows how far
 * its review has got, so the menu doubles as a to-do list.
 *
 * Exports: BatchMenu
 * Depends on: ../lib/library.ts
 */
import { useEffect, useRef } from "react";
import { describeBatch, type BatchSummary } from "../lib/library";

export function BatchMenu({
  batches,
  current,
  onPick,
  onClose,
}: {
  batches: readonly BatchSummary[];
  current: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);

  // Escape or a tap anywhere else folds it away. The tab that opened it is
  // excluded so its own click can toggle the sheet rather than reopen it.
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element;
      if (sheet.current?.contains(target) || target.closest("[data-batch-trigger]")) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="batch-menu" ref={sheet} role="dialog" aria-label="Batches">
      <div className="batch-menu-head">
        Batches <span className="note">{batches.length}</span>
      </div>
      {batches.length === 0 ? (
        <p className="batch-menu-empty">No batches yet — Generate makes the first one.</p>
      ) : (
        <ul className="batch-menu-list">
          {batches.map((batch) => {
            const reviewed = batch.done + batch.rejected;
            return (
              <li key={batch.id}>
                <button
                  type="button"
                  className="batch-row"
                  data-active={batch.id === current}
                  aria-current={batch.id === current}
                  onClick={() => onPick(batch.id)}
                >
                  <span className="batch-row-label">{describeBatch(batch.id)}</span>
                  <span className="batch-row-meta">
                    {batch.count} words · {reviewed === batch.count ? "reviewed" : `${reviewed} reviewed`}
                  </span>
                  <span className="batch-row-bar" aria-hidden>
                    <span style={{ width: `${(batch.done / batch.count) * 100}%` }} />
                    <span
                      className="rejected"
                      style={{ width: `${(batch.rejected / batch.count) * 100}%` }}
                    />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

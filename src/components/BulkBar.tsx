/**
 * Bulk actions for the rows a reviewer has selected.
 *
 * Tagging is the reason this exists. Exams arrived as an axis after the deck
 * already had words in it, so every existing word has an empty `exams` list and
 * no amount of filtering will fill it — the only practical way to tag hundreds
 * of words is to select them and say it once.
 *
 * Status changes are here too, because approving a filtered set ("every B1 word
 * with no issues") is the same gesture.
 *
 * Exports: BulkBar
 * Depends on: ../lib/contract.ts, ../lib/types.ts
 */
import { useState } from "react";
import { EXAMS, MAX_EXAMS, MAX_TOPICS, TOPICS } from "../lib/contract";
import type { ReviewStatus } from "../lib/types";

/** What a tag button does to the selection. */
export type TagAction = { axis: "topics" | "exams"; value: string; add: boolean };

export function BulkBar({
  selectedCount,
  onStatus,
  onTag,
  onSelectAll,
  onClear,
  visibleCount,
}: {
  selectedCount: number;
  visibleCount: number;
  onStatus: (status: ReviewStatus) => void;
  onTag: (action: TagAction) => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const [axis, setAxis] = useState<"topics" | "exams">("exams");
  const [value, setValue] = useState<string>(EXAMS[0]);

  const options = axis === "exams" ? EXAMS : TOPICS;
  const cap = axis === "exams" ? MAX_EXAMS : MAX_TOPICS;

  if (selectedCount === 0) {
    return (
      <div className="bulk-bar" data-idle="true">
        <span className="bulk-hint">
          Tick rows to approve, reject or tag them together.
        </span>
        <div className="spacer" />
        <button type="button" className="btn sm" onClick={onSelectAll} disabled={visibleCount === 0}>
          Select all {visibleCount} shown
        </button>
      </div>
    );
  }

  return (
    <div className="bulk-bar">
      <strong>{selectedCount} selected</strong>
      <button type="button" className="btn sm" onClick={onSelectAll}>
        Select all {visibleCount} shown
      </button>
      <button type="button" className="btn sm" onClick={onClear}>
        Clear
      </button>

      <div className="bulk-sep" aria-hidden="true" />

      <button type="button" className="btn sm" onClick={() => onStatus("approved")}>
        Approve
      </button>
      <button type="button" className="btn sm" onClick={() => onStatus("pending")}>
        Reset to pending
      </button>
      <button type="button" className="btn sm danger" onClick={() => onStatus("rejected")}>
        Reject
      </button>

      <div className="bulk-sep" aria-hidden="true" />

      <select
        aria-label="Which axis to tag"
        value={axis}
        onChange={(event) => {
          const next = event.target.value as "topics" | "exams";
          setAxis(next);
          setValue(next === "exams" ? EXAMS[0] : TOPICS[0]);
        }}
      >
        <option value="exams">Exam</option>
        <option value="topics">Topic</option>
      </select>
      <select
        aria-label="Which tag to apply"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <button type="button" className="btn sm" onClick={() => onTag({ axis, value, add: true })}>
        Add
      </button>
      <button type="button" className="btn sm" onClick={() => onTag({ axis, value, add: false })}>
        Remove
      </button>
      <span className="bulk-hint">max {cap}</span>
    </div>
  );
}

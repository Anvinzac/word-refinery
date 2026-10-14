/**
 * Hand editor for one Vietnamese field, shown inside the refine brief.
 *
 * The sentence is laid out as chips: tap a word to toggle its highlight,
 * double-tap it to delete it, drag a `|` chip to move the phrase break, and
 * turn on the ✎ button to make every gap between words live: tapping the space
 * adds a `|` there, tapping its `+` opens a box to type a word into.
 * Gaps inside a `_`-joined word are never offered — a break there would split
 * one word in two.
 * Every change is handed back as deck text at once; the brief decides when to
 * save it.
 *
 * Exports: SentenceEditor
 * Depends on: ../lib/sentence-edit.ts, ../lib/joiner.ts
 */
import { Fragment, useRef, useState } from "react";
import { findStrayMarks, PHRASE_BREAK } from "../lib/joiner";
import {
  insertAtGap,
  moveBreak,
  parseSentence,
  removeToken,
  serializeSentence,
  toggleHighlight,
  type SentenceToken,
} from "../lib/sentence-edit";

/** Two taps on the same chip within this many milliseconds count as a double tap. */
const DOUBLE_TAP_MS = 320;
/** Pointer travel, in pixels, before a press on a break becomes a drag. */
const DRAG_THRESHOLD = 5;

interface Drag {
  from: number;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  gap: number | null;
  indicator: { left: number; top: number; height: number } | null;
}

export function SentenceEditor({
  value,
  highlightable,
  disabled,
  onChange,
}: {
  value: string;
  highlightable: boolean;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const tokens = parseSentence(value);
  const boxRef = useRef<HTMLDivElement>(null);
  const lastTap = useRef<{ key: string; at: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [inserting, setInserting] = useState(false);
  const [slot, setSlot] = useState<number | null>(null);
  const [typed, setTyped] = useState("");

  const commit = (next: SentenceToken[]) => onChange(serializeSentence(next));

  /** True on the second tap of a double tap on the same chip. */
  const isDoubleTap = (key: string) => {
    const now = Date.now();
    const previous = lastTap.current;
    if (previous !== null && previous.key === key && now - previous.at < DOUBLE_TAP_MS) {
      lastTap.current = null;
      return true;
    }
    lastTap.current = { key, at: now };
    return false;
  };

  const tapWord = (index: number) => {
    if (disabled) return;
    if (isDoubleTap(`w${index}`)) {
      commit(removeToken(tokens, index));
      return;
    }
    if (highlightable) commit(toggleHighlight(tokens, index));
  };

  /** The word gap nearest a point, plus where to draw the drop line for it. */
  const gapAt = (x: number, y: number): Pick<Drag, "gap" | "indicator"> => {
    const box = boxRef.current;
    if (box === null) return { gap: null, indicator: null };
    const chips = [...box.querySelectorAll<HTMLElement>("[data-word]")];
    if (chips.length === 0) return { gap: null, indicator: null };
    let best = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    chips.forEach((chip, index) => {
      const rect = chip.getBoundingClientRect();
      const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      const dx = Math.abs(x - (rect.left + rect.width / 2));
      const score = dy * 1000 + dx;
      if (score < bestScore) {
        bestScore = score;
        best = index;
      }
    });
    const rect = chips[best].getBoundingClientRect();
    const before = x < rect.left + rect.width / 2;
    const gap = Math.min(Math.max(before ? best : best + 1, 1), chips.length - 1);
    const anchor = chips[gap].getBoundingClientRect();
    const origin = box.getBoundingClientRect();
    return {
      gap,
      indicator: { left: anchor.left - origin.left - 3, top: anchor.top - origin.top, height: anchor.height },
    };
  };

  // Pointer events can arrive faster than React re-renders, so the live drag is
  // read from a ref and mirrored into state only to draw it.
  const dragRef = useRef<Drag | null>(null);
  const updateDrag = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const onBreakDown = (index: number) => (event: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is already gone cannot be captured; the drag still works without it.
    }
    updateDrag({
      from: index,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      gap: null,
      indicator: null,
    });
  };

  const onBreakMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (current === null || event.pointerId !== current.pointerId) return;
    const travelled = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
    if (!current.moved && travelled < DRAG_THRESHOLD) return;
    updateDrag({ ...current, moved: true, ...gapAt(event.clientX, event.clientY) });
  };

  const onBreakUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (current === null || event.pointerId !== current.pointerId) return;
    updateDrag(null);
    if (current.moved) {
      lastTap.current = null;
      const { gap } = gapAt(event.clientX, event.clientY);
      if (gap !== null) commit(moveBreak(tokens, current.from, gap));
      return;
    }
    if (isDoubleTap(`b${current.from}`)) commit(removeToken(tokens, current.from));
  };

  const onChipKey = (index: number) => (event: React.KeyboardEvent) => {
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    commit(removeToken(tokens, index));
  };

  const closeSlot = () => {
    setSlot(null);
    setTyped("");
  };

  const insertTyped = () => {
    if (slot !== null && typed.trim().length > 0) commit(insertAtGap(tokens, slot, typed.trim()));
    closeSlot();
  };

  /** A gap may take a new `|` when it sits inside the sentence and holds none yet. */
  const renderSlot = (gap: number, breakable: boolean) => {
    if (!inserting) return null;
    if (slot === gap) {
      return (
        <input
          key={`slot${gap}`}
          className="sentence-slot-input"
          autoFocus
          value={typed}
          placeholder="word, | or a=b"
          size={Math.max(typed.length, 8)}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={insertTyped}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              insertTyped();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeSlot();
            }
          }}
        />
      );
    }
    const plus = (
      <button
        type="button"
        className="sentence-slot"
        aria-label="Type a word here"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          setSlot(gap);
          setTyped("");
        }}
      >
        +
      </button>
    );
    if (!breakable) {
      return (
        <span key={`slot${gap}`} className="sentence-gap">
          {plus}
        </span>
      );
    }
    return (
      <span
        key={`slot${gap}`}
        className="sentence-gap"
        data-breakable
        title="Tap the space to add a phrase break"
        onClick={() => {
          if (!disabled) commit(insertAtGap(tokens, gap, PHRASE_BREAK));
        }}
      >
        {plus}
      </span>
    );
  };

  const problems = findStrayMarks(value);
  let wordIndex = 0;

  return (
    <div className="sentence-editor">
      <div className="sentence-tools">
        <span className="sentence-hint">
          {inserting ? (
            <>
              Tap a space to add <b>|</b> · tap <b>+</b> to type a word
            </>
          ) : (
            <>
              {highlightable ? "Tap a word to highlight · " : ""}double-tap to delete · drag <b>|</b> to move it
            </>
          )}
        </span>
        <button
          type="button"
          className="btn sm sentence-edit-toggle"
          data-active={inserting}
          aria-pressed={inserting}
          title="Type a word in between"
          disabled={disabled}
          onClick={() => {
            setInserting(!inserting);
            closeSlot();
          }}
        >
          ✎
        </button>
      </div>

      <div className="sentence-chips" lang="vi" ref={boxRef} data-dragging={drag?.moved || undefined}>
        {tokens.map((token, index) => {
          if (token.kind === "break") {
            return (
              <button
                key={index}
                type="button"
                className="sentence-break"
                data-lifted={(drag?.moved && drag.from === index) || undefined}
                aria-label="Phrase break — drag to move, double-tap to remove"
                disabled={disabled}
                onPointerDown={onBreakDown(index)}
                onPointerMove={onBreakMove}
                onPointerUp={onBreakUp}
                onPointerCancel={() => updateDrag(null)}
                onKeyDown={onChipKey(index)}
              >
                |
              </button>
            );
          }
          const gap = wordIndex;
          wordIndex += 1;
          return (
            <Fragment key={index}>
              {renderSlot(gap, gap > 0 && tokens[index - 1]?.kind !== "break")}
              <span className="sentence-word-wrap">
                {token.lead}
                <button
                  type="button"
                  className="sentence-word"
                  data-word
                  data-active={token.marked}
                  aria-pressed={highlightable ? token.marked : undefined}
                  disabled={disabled}
                  onClick={() => tapWord(index)}
                  onKeyDown={onChipKey(index)}
                >
                  {token.core.replace(/_/gu, "\u00a0")}
                </button>
                {token.trail}
                {token.bind && <span className="sentence-bind">=</span>}
              </span>
            </Fragment>
          );
        })}
        {renderSlot(wordIndex, false)}
        {drag?.indicator && (
          <span
            className="sentence-drop"
            style={{ left: drag.indicator.left, top: drag.indicator.top, height: drag.indicator.height }}
          />
        )}
      </div>

      {problems.length > 0 && (
        <ul className="sentence-problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

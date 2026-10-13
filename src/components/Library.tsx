/**
 * Library — the deck as something you search rather than scroll.
 *
 * At a few dozen words a flat table was the whole interface. At a thousand it
 * stops being one: the question changes from "what is in here" to "where is the
 * word I mean", and from "approve these" to "which corner of the deck is thin".
 * So the table is now a slice of a filtered set, with the rail answering the
 * first question and the coverage matrix the second.
 *
 * Only a window of rows is rendered. Every row was previously in the DOM at
 * once — 16k nodes at a thousand words, with every click paying to re-render
 * all of them. A cap plus "show more" keeps that bounded without the fragility
 * of windowing variable-height rows, and filters mean a reviewer rarely wants
 * more than a screenful anyway.
 *
 * Exports: Library
 * Depends on: ./FilterRail.tsx, ./BulkBar.tsx, ./ReviewTable.tsx, ../lib/library.ts
 */
import { useMemo, useState } from "react";
import { BulkBar, type TagAction } from "./BulkBar";
import { FilterRail } from "./FilterRail";
import { ReviewTable } from "./ReviewTable";
import { MAX_EXAMS, MAX_TOPICS } from "../lib/contract";
import { validateDeck } from "../lib/deck";
import { EMPTY_FILTER, applyFilter, buildFacets, type LibraryFilter } from "../lib/library";
import type { Settings } from "../lib/settings";
import type { DeckWord, ReviewEntry, ReviewStatus } from "../lib/types";

/** Rows rendered before "show more" is needed. */
const PAGE = 60;

export function Library({
  entries,
  settings,
  filter,
  onFilter,
  onChange,
}: {
  entries: readonly ReviewEntry[];
  settings: Settings;
  filter: LibraryFilter;
  onFilter: (next: LibraryFilter) => void;
  onChange: (next: ReviewEntry[]) => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState(PAGE);

  /** Word ids the validator has something to say about. */
  const flagged = useMemo(() => {
    const issues = validateDeck({
      meta: { wordCount: entries.length } as never,
      words: entries.map((entry) => entry.deckWord),
    });
    return new Set(issues.map((issue) => issue.wordId));
  }, [entries]);

  const hasIssue = useMemo(() => (id: string) => flagged.has(id), [flagged]);

  const matching = useMemo(
    () => applyFilter(entries, filter, hasIssue),
    [entries, filter, hasIssue],
  );
  const facets = useMemo(() => buildFacets(entries, filter, hasIssue), [entries, filter, hasIssue]);

  const rows = useMemo(() => matching.slice(0, shown), [matching, shown]);

  const changeFilter = (next: LibraryFilter) => {
    onFilter(next);
    // A new filter means a new set of rows; carrying the old page depth over
    // would silently hide most of a narrower result.
    setShown(PAGE);
  };

  const toggleSelect = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Apply a change to every selected row, leaving the rest untouched. */
  const patchSelected = (patch: (entry: ReviewEntry) => ReviewEntry) => {
    onChange(entries.map((entry) => (selected.has(entry.id) ? patch(entry) : entry)));
  };

  const bulkStatus = (status: ReviewStatus) => {
    patchSelected((entry) => ({ ...entry, status }));
  };

  const bulkTag = ({ axis, value, add }: TagAction) => {
    const cap = axis === "exams" ? MAX_EXAMS : MAX_TOPICS;
    patchSelected((entry) => {
      const current = entry.deckWord[axis];
      let next = add
        ? current.includes(value)
          ? current
          : [...current, value].slice(0, cap)
        : current.filter((item) => item !== value);
      // A word must always keep at least one topic, and `topic` restates the
      // first one — removing the last would make the deck fail validation.
      if (axis === "topics" && next.length === 0) next = ["general"];
      if (next === current) return entry;
      const deckWord: DeckWord =
        axis === "topics"
          ? { ...entry.deckWord, topics: next, topic: next[0]! }
          : { ...entry.deckWord, exams: next };
      return { ...entry, deckWord, status: "edited" as const };
    });
  };

  return (
    <section className="panel library">
      <div className="library-head">
        <h2>Library</h2>
        <p className="hint">
          Narrow with the rail, then refine in place. Only approved and edited words are exported.
        </p>
      </div>

      <div className="library-body">
        <FilterRail filter={filter} facets={facets} onChange={changeFilter} />

        <div className="library-main">
          <BulkBar
            selectedCount={selected.size}
            visibleCount={matching.length}
            onStatus={bulkStatus}
            onTag={bulkTag}
            onSelectAll={() => setSelected(new Set(matching.map((entry) => entry.id)))}
            onClear={() => setSelected(new Set())}
          />

          <ReviewTable
            entries={entries}
            rows={rows}
            settings={settings}
            selected={selected}
            onToggleSelect={toggleSelect}
            onChange={onChange}
          />

          {matching.length > rows.length && (
            <div className="library-more">
              <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, matching.length - rows.length)} more
              </button>
              <span className="note">
                {rows.length} of {matching.length} shown
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** The filter a fresh session starts from. */
export const INITIAL_FILTER = EMPTY_FILTER;

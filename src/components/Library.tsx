/**
 * Library — the deck as something you search rather than scroll.
 *
 * At a few dozen words a flat table was the whole interface. At a thousand it
 * stops being one: the question changes from "what is in here" to "where is the
 * word I mean", and from "approve these" to "which corner of the deck is thin".
 * So the table is now a slice of a filtered set, with the rail answering the
 * first question and the coverage matrix the second.
 *
 * The library shows one batch at a time — a generation run or an import, picked
 * from the batch menu in the bottom bar — never the whole deck. Within it, the filtered
 * set is cut into pages of at most twenty words, laid side by side
 * in a horizontal scroller that snaps page by page, so a swipe turns the page.
 * Only the current page and its neighbours render their rows: every row in the
 * DOM at once was 16k nodes at a thousand words, with every click paying to
 * re-render all of them.
 *
 * Exports: Library
 * Depends on: ./FilterRail.tsx, ./BulkBar.tsx, ./ReviewTable.tsx, ../lib/library.ts
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { BulkBar, type TagAction } from "./BulkBar";
import { FilterRail } from "./FilterRail";
import { ReviewTable } from "./ReviewTable";
import { MAX_EXAMS, MAX_TOPICS } from "../lib/contract";
import { markupWord, describeLlmError } from "../lib/llm";
import { hasAnyMark } from "../lib/joiner";
import { validateDeck } from "../lib/deck";
import {
  EMPTY_FILTER,
  applyFilter,
  buildFacets,
  describeBatch,
  type LibraryFilter,
} from "../lib/library";
import type { Settings } from "../lib/settings";
import type { DeckWord, ReviewEntry, ReviewStatus } from "../lib/types";

/** Most words one page holds. */
const PAGE_SIZE = 20;

/** Pages either side of the current one that keep their rows rendered. */
const RENDER_RADIUS = 1;

/** Past this many pages a row of dots stops being readable. */
const MAX_DOTS = 15;

export function Library({
  entries,
  batch,
  settings,
  filter,
  onFilter,
  onChange,
}: {
  entries: readonly ReviewEntry[];
  /** The one batch on show, chosen from the batch menu in the bottom bar. */
  batch: string | null;
  settings: Settings;
  filter: LibraryFilter;
  onFilter: (next: LibraryFilter) => void;
  onChange: (next: ReviewEntry[]) => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [page, setPage] = useState(0);
  const pager = useRef<HTMLDivElement>(null);
  /** Progress of the markup backfill, or null when none is running. */
  const [markup, setMarkup] = useState<{ done: number; total: number; issues: string[] } | null>(
    null,
  );

  /** Word ids the validator has something to say about. */
  const flagged = useMemo(() => {
    const issues = validateDeck({
      meta: { wordCount: entries.length } as never,
      words: entries.map((entry) => entry.deckWord),
    });
    return new Set(issues.map((issue) => issue.wordId));
  }, [entries]);

  const hasIssue = useMemo(() => (id: string) => flagged.has(id), [flagged]);

  const batchEntries = useMemo(
    () => entries.filter((entry) => entry.deckWord.batchId === batch),
    [entries, batch],
  );

  const matching = useMemo(
    () => applyFilter(batchEntries, filter, hasIssue),
    [batchEntries, filter, hasIssue],
  );
  const facets = useMemo(
    () => buildFacets(batchEntries, filter, hasIssue),
    [batchEntries, filter, hasIssue],
  );

  const pages = useMemo(() => {
    const chunks: ReviewEntry[][] = [];
    for (let start = 0; start < matching.length; start += PAGE_SIZE) {
      chunks.push(matching.slice(start, start + PAGE_SIZE));
    }
    return chunks;
  }, [matching]);

  const lastPage = Math.max(0, pages.length - 1);
  const current = Math.min(page, lastPage);

  /** Scroll the pager so `index` fills it; the scroll handler then records it. */
  const goTo = (index: number) => {
    const scroller = pager.current;
    if (scroller === null) return;
    const target = Math.max(0, Math.min(index, lastPage));
    scroller.scrollTo({ left: target * scroller.clientWidth, behavior: "smooth" });
    // A page turned from the bottom of a long page should start at its top.
    const top = scroller.getBoundingClientRect().top;
    if (top < 0) window.scrollBy({ top: top - 80, behavior: "smooth" });
  };

  const onPagerScroll = () => {
    const scroller = pager.current;
    if (scroller === null || scroller.clientWidth === 0) return;
    setPage(Math.round(scroller.scrollLeft / scroller.clientWidth));
  };

  /** Back to the first page: a new set of rows makes the old page meaningless. */
  const resetPage = () => {
    setPage(0);
    pager.current?.scrollTo({ left: 0 });
  };

  const changeFilter = (next: LibraryFilter) => {
    onFilter(next);
    resetPage();
  };

  // Another batch is another set of rows: ticks and page depth do not carry over.
  useEffect(() => {
    setSelected(new Set());
    resetPage();
  }, [batch]);

  // A narrower set can leave the scroller past its last page.
  useEffect(() => {
    if (page > lastPage) pager.current?.scrollTo({ left: lastPage * (pager.current?.clientWidth ?? 0) });
  }, [page, lastPage]);

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

  /**
   * Add breaking marks to the selected cards, one request each.
   *
   * Sequential on purpose: this rewrites reviewed text, so a failure part-way
   * should leave a short, legible trail rather than a dozen half-applied cards.
   */
  const runMarkup = async () => {
    const targets = entries.filter((entry) => selected.has(entry.id));
    if (targets.length === 0) return;
    setMarkup({ done: 0, total: targets.length, issues: [] });

    const patches = new Map<string, Partial<Record<string, string>>>();
    const issues: string[] = [];
    for (const [index, entry] of targets.entries()) {
      try {
        const result = await markupWord(settings.llm, entry.deckWord);
        if (Object.keys(result.patch).length > 0) patches.set(entry.id, result.patch);
        issues.push(...result.issues);
      } catch (thrown) {
        issues.push(`${entry.deckWord.word}: ${describeLlmError(thrown)}`);
      }
      setMarkup({ done: index + 1, total: targets.length, issues: [...issues] });
    }

    if (patches.size > 0) {
      onChange(
        entries.map((entry) => {
          const patch = patches.get(entry.id);
          if (patch === undefined) return entry;
          const deckWord = { ...entry.deckWord };
          if (patch.defVi !== undefined) deckWord.defVi = patch.defVi;
          if (patch.leadVi !== undefined) deckWord.leadVi = patch.leadVi;
          if (patch.anticipateVi !== undefined) deckWord.anticipateVi = patch.anticipateVi;
          if (patch.usageVi !== undefined && deckWord.usage[0] !== undefined) {
            deckWord.usage = deckWord.usage.map((item, index) =>
              index === 0 ? { ...item, vi: patch.usageVi! } : item,
            );
          }
          return { ...entry, deckWord, status: "edited" as const };
        }),
      );
    }
  };

  /** How much of the deck still predates the breaking marks. */
  const unmarked = useMemo(
    () => entries.filter((entry) => !hasAnyMark(entry.deckWord.defVi)).length,
    [entries],
  );

  return (
    <section className="panel library">
      <div className="library-head">
        <h2>Library</h2>
        <p className="hint">
          {batch !== null && <strong className="library-batch">{describeBatch(batch)}</strong>}
          {batch !== null && " · "}
          Switch batches from Words in the bar below. Swipe through pages of twenty and refine in
          place; only approved and edited words are exported.
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
            onMarkup={() => void runMarkup()}
            markupBusy={markup !== null && markup.done < markup.total}
          />

          {unmarked > 0 && markup === null && (
            <div className="banner warn" style={{ marginBottom: 10 }}>
              {unmarked} word(s) were written before the breaking marks existed. Select them and
              choose “Add breaking marks” — the words are not rewritten, only marked, and any card
              that comes back edited is discarded.
            </div>
          )}

          {markup !== null && (
            <div className="banner" style={{ marginBottom: 10 }}>
              Marking up {markup.done} of {markup.total}…
              {markup.issues.length > 0 && (
                <ul className="refine-issues" style={{ marginTop: 8 }}>
                  {markup.issues.slice(0, 8).map((issue, index) => (
                    <li key={index}>{issue}</li>
                  ))}
                </ul>
              )}
              {markup.done === markup.total && (
                <div style={{ marginTop: 8 }}>
                  <button type="button" className="btn sm" onClick={() => setMarkup(null)}>
                    Done
                  </button>
                </div>
              )}
            </div>
          )}

          {pages.length > 1 && (
            <div className="pager-bar">
              <button
                type="button"
                className="btn sm"
                aria-label="Previous page"
                disabled={current === 0}
                onClick={() => goTo(current - 1)}
              >
                ‹
              </button>
              <span className="pager-label">
                Page <b>{current + 1}</b> of {pages.length}
                <span className="note">
                  {" "}
                  · words {current * PAGE_SIZE + 1}–{current * PAGE_SIZE + pages[current]!.length} of{" "}
                  {matching.length}
                </span>
              </span>
              <button
                type="button"
                className="btn sm"
                aria-label="Next page"
                disabled={current === lastPage}
                onClick={() => goTo(current + 1)}
              >
                ›
              </button>
              {pages.length <= MAX_DOTS && (
              <div className="pager-dots" role="tablist" aria-label="Pages">
                {pages.map((_, index) => (
                  <button
                    key={index}
                    type="button"
                    role="tab"
                    className="pager-dot"
                    aria-label={`Page ${index + 1}`}
                    aria-selected={index === current}
                    data-active={index === current}
                    onClick={() => goTo(index)}
                  />
                ))}
              </div>
              )}
            </div>
          )}

          {pages.length === 0 ? (
            <ReviewTable
              entries={entries}
              rows={[]}
              settings={settings}
              selected={selected}
              onToggleSelect={toggleSelect}
              onChange={onChange}
            />
          ) : (
            <div className="pager" ref={pager} onScroll={onPagerScroll}>
              {pages.map((rows, index) => (
                <div
                  key={index}
                  className="pager-page"
                  aria-label={`Page ${index + 1} of ${pages.length}`}
                  aria-hidden={index !== current}
                >
                  {Math.abs(index - current) <= RENDER_RADIUS && (
                    <ReviewTable
                      entries={entries}
                      rows={rows}
                      settings={settings}
                      selected={selected}
                      onToggleSelect={toggleSelect}
                      onChange={onChange}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** The filter a fresh session starts from. */
export const INITIAL_FILTER = EMPTY_FILTER;

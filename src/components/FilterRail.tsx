/**
 * Filter rail — the axes a deck of thousands is narrowed by.
 *
 * Every value carries its own count, computed with its axis excluded, so the
 * number answers "how many would I get if I picked this too?". A value that
 * would yield nothing is still shown when selected (so it can be unpicked) and
 * hidden otherwise, which keeps the topic list from growing into eighteen rows
 * of zeroes.
 *
 * The rail is a single bar above the table: search inline, every axis folded
 * into a drop-down, so the word list keeps the full width.
 *
 * Exports: FilterRail
 * Depends on: ../lib/library.ts, ../lib/contract.ts, ../lib/types.ts
 */
import { useEffect, useRef } from "react";
import { EXAMS, TOPICS } from "../lib/contract";
import { describeBatch, isFilterActive, type LibraryFacets, type LibraryFilter } from "../lib/library";
import { CEFR_LEVELS, type CefrLevel, type ReviewStatus } from "../lib/types";

/** Statuses in the order a word travels through them. */
const STATUSES: readonly ReviewStatus[] = ["pending", "edited", "approved", "rejected"];

/** One toggleable value with its count. */
function FacetValue({
  label,
  count,
  active,
  onToggle,
}: {
  label: string;
  count: number;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="facet"
      data-active={active}
      aria-pressed={active}
      onClick={onToggle}
    >
      <span className="facet-label">{label}</span>
      <span className="facet-count">{count}</span>
    </button>
  );
}

/**
 * One titled group of values, folded into a drop-down so the bar stays one
 * line. The summary names what is picked, so a closed group still says how
 * the list is narrowed. Groups share a `name`, so opening one closes the rest.
 */
function FacetGroup({
  title,
  picked,
  children,
}: {
  title: string;
  picked: readonly string[];
  children: React.ReactNode;
}) {
  return (
    <details className="facet-group" name="facet-group" data-active={picked.length > 0}>
      <summary className="facet-title">
        {title}
        {picked.length > 0 && (
          <span className="facet-picked">
            {picked.length <= 2 ? picked.join(", ") : `${picked.length} picked`}
          </span>
        )}
      </summary>
      <div className="facet-values">{children}</div>
    </details>
  );
}

export function FilterRail({
  filter,
  facets,
  onChange,
}: {
  filter: LibraryFilter;
  facets: LibraryFacets;
  onChange: (next: LibraryFilter) => void;
}) {
  /** Toggle one value of a multi-select axis. */
  const toggle = <K extends "statuses" | "levels" | "topics" | "exams" | "batches">(
    axis: K,
    value: LibraryFilter[K][number],
  ) => {
    const current = filter[axis] as string[];
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    onChange({ ...filter, [axis]: next });
  };

  /** Values worth offering: anything with a count, plus anything already picked. */
  const offered = (all: readonly string[], counts: Map<string, number>, picked: readonly string[]) =>
    all.filter((value) => (counts.get(value) ?? 0) > 0 || picked.includes(value));

  const batchIds = [...facets.batches.keys()].sort().reverse();

  // A drop-down left open would cover the table; any click outside folds it.
  const railRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const rail = railRef.current;
      if (rail === null || rail.contains(event.target as Node)) return;
      for (const open of rail.querySelectorAll("details[open]")) open.removeAttribute("open");
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, []);

  return (
    <aside className="rail" aria-label="Filters" ref={railRef}>
      <div className="rail-head">
        <strong>{facets.total}</strong> word{facets.total === 1 ? "" : "s"}
        {isFilterActive(filter) && (
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              onChange({
                search: "",
                statuses: [],
                levels: [],
                topics: [],
                exams: [],
                batches: [],
                onlyIssues: false,
              })
            }
          >
            Clear
          </button>
        )}
      </div>

      <input
        type="search"
        className="rail-search"
        placeholder="Search word or Vietnamese — accents optional"
        aria-label="Search the deck"
        title="Accents optional — “tin cay” finds “tin cậy”."
        value={filter.search}
        onChange={(event) => onChange({ ...filter, search: event.target.value })}
      />

      {(facets.issues > 0 || filter.onlyIssues) && (
        <FacetValue
          label="Has issues"
          count={facets.issues}
          active={filter.onlyIssues}
          onToggle={() => onChange({ ...filter, onlyIssues: !filter.onlyIssues })}
        />
      )}

      <FacetGroup title="Status" picked={filter.statuses}>
        {STATUSES.map((status) => (
          <FacetValue
            key={status}
            label={status}
            count={facets.statuses.get(status) ?? 0}
            active={filter.statuses.includes(status)}
            onToggle={() => toggle("statuses", status)}
          />
        ))}
      </FacetGroup>

      <FacetGroup title="Level" picked={filter.levels}>
        {CEFR_LEVELS.map((level) => (
          <FacetValue
            key={level}
            label={level}
            count={facets.levels.get(level) ?? 0}
            active={filter.levels.includes(level as CefrLevel)}
            onToggle={() => toggle("levels", level)}
          />
        ))}
      </FacetGroup>

      <FacetGroup title="Topic" picked={filter.topics}>
        {offered(TOPICS, facets.topics, filter.topics).map((topic) => (
          <FacetValue
            key={topic}
            label={topic}
            count={facets.topics.get(topic) ?? 0}
            active={filter.topics.includes(topic)}
            onToggle={() => toggle("topics", topic)}
          />
        ))}
      </FacetGroup>

      <FacetGroup title="Exam" picked={filter.exams.map((exam) => exam.toUpperCase())}>
        {offered(EXAMS, facets.exams, filter.exams).length === 0 ? (
          <p className="rail-note">
            No word carries an exam tag yet. Select rows in the table to assign one.
          </p>
        ) : (
          offered(EXAMS, facets.exams, filter.exams).map((exam) => (
            <FacetValue
              key={exam}
              label={exam.toUpperCase()}
              count={facets.exams.get(exam) ?? 0}
              active={filter.exams.includes(exam)}
              onToggle={() => toggle("exams", exam)}
            />
          ))
        )}
      </FacetGroup>

      {batchIds.length > 1 && (
        <FacetGroup title="Added in" picked={filter.batches.map(describeBatch)}>
          {batchIds.slice(0, 12).map((batchId) => (
            <FacetValue
              key={batchId}
              label={describeBatch(batchId)}
              count={facets.batches.get(batchId) ?? 0}
              active={filter.batches.includes(batchId)}
              onToggle={() => toggle("batches", batchId)}
            />
          ))}
        </FacetGroup>
      )}
    </aside>
  );
}

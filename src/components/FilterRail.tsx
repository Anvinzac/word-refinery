/**
 * Filter rail — the axes a deck of thousands is narrowed by.
 *
 * Every value carries its own count, computed with its axis excluded, so the
 * number answers "how many would I get if I picked this too?". A value that
 * would yield nothing is still shown when selected (so it can be unpicked) and
 * hidden otherwise, which keeps the topic list from growing into eighteen rows
 * of zeroes.
 *
 * Exports: FilterRail
 * Depends on: ../lib/library.ts, ../lib/contract.ts, ../lib/types.ts
 */
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

/** One titled group of values. */
function FacetGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="facet-group">
      <div className="facet-title">{title}</div>
      <div className="facet-values">{children}</div>
    </div>
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

  return (
    <aside className="rail" aria-label="Filters">
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
        placeholder="Search word or Vietnamese…"
        aria-label="Search the deck"
        value={filter.search}
        onChange={(event) => onChange({ ...filter, search: event.target.value })}
      />
      <p className="rail-note">Accents optional — “tin cay” finds “tin cậy”.</p>

      <FacetGroup title="Needs attention">
        <FacetValue
          label="Has validation issues"
          count={facets.issues}
          active={filter.onlyIssues}
          onToggle={() => onChange({ ...filter, onlyIssues: !filter.onlyIssues })}
        />
      </FacetGroup>

      <FacetGroup title="Status">
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

      <FacetGroup title="Level">
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

      <FacetGroup title="Topic">
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

      <FacetGroup title="Exam">
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
        <FacetGroup title="Added in">
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

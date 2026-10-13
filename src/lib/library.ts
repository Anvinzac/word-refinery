/**
 * Library filtering — how a reviewer finds one word among thousands.
 *
 * Everything here is pure, so the behaviour that decides what a reviewer can
 * see is testable without a browser. Three ideas carry most of the value:
 *
 *  - Search folds diacritics on both sides, so "tin cay" finds "tin cậy". A
 *    reviewer typing quickly should not have to produce Vietnamese tone marks
 *    to locate a word they can already see in their head.
 *  - Facet counts are computed with their OWN axis excluded, which is what lets
 *    a count answer "how many would I get if I also picked this?" rather than
 *    "how many did I already pick". A facet counted under its own selection
 *    would read 0 for every value the reviewer has not chosen.
 *  - Every axis is AND-ed with the others; values WITHIN an axis are OR-ed.
 *    Picking B1 and B2 widens, picking B1 and the topic `work` narrows.
 *
 * Exports: LibraryFilter, LibraryFacets, EMPTY_FILTER, foldText, matchesSearch,
 *          applyFilter, buildFacets, isFilterActive, describeBatch
 * Depends on: ./types.ts
 */
import type { CefrLevel, ReviewEntry, ReviewStatus } from "./types.ts";

/** The whole filter state, one field per axis. An empty array means "any". */
export interface LibraryFilter {
  /** Free text, matched against the headword and every Vietnamese field. */
  search: string;
  statuses: ReviewStatus[];
  levels: CefrLevel[];
  topics: string[];
  exams: string[];
  /** Generation runs and imports, by `batchId`. */
  batches: string[];
  /** Restrict to words the validator has something to say about. */
  onlyIssues: boolean;
}

/** Nothing selected: every word matches. */
export const EMPTY_FILTER: LibraryFilter = {
  search: "",
  statuses: [],
  levels: [],
  topics: [],
  exams: [],
  batches: [],
  onlyIssues: false,
};

/** How many words sit behind each value of each axis. */
export interface LibraryFacets {
  statuses: Map<string, number>;
  levels: Map<string, number>;
  topics: Map<string, number>;
  exams: Map<string, number>;
  batches: Map<string, number>;
  /** Words with at least one validation issue, under the other axes. */
  issues: number;
  /** Words matching the whole filter. */
  total: number;
}

/**
 * Lowercase and strip Vietnamese diacritics, so typed ASCII matches toned text.
 *
 * @param value - any text
 * @returns the folded form used on both sides of a search
 */
export function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // đ/Đ carries no combining mark, so NFD leaves it untouched.
    .replace(/[đĐ]/g, "d")
    .toLowerCase();
}

/** Every searchable string of one entry, folded once per call. */
function searchableText(entry: ReviewEntry): string {
  const word = entry.deckWord;
  const usage = word.usage.map((item) => `${item.en} ${item.vi}`).join(" ");
  return foldText(
    `${word.word} ${word.defVi} ${word.leadVi} ${word.anticipateVi} ${usage} ${word.topics.join(" ")}`,
  );
}

/**
 * Whether one entry matches a search string.
 *
 * Every whitespace-separated term must appear, so adding a word narrows rather
 * than widens — the behaviour a reviewer expects from a search box.
 *
 * @param entry - the row being tested
 * @param search - raw search text, possibly empty
 */
export function matchesSearch(entry: ReviewEntry, search: string): boolean {
  const terms = foldText(search).split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return true;
  const haystack = searchableText(entry);
  return terms.every((term) => haystack.includes(term));
}

/** Whether a value passes one axis. An empty selection accepts everything. */
function passes(selected: readonly string[], values: readonly string[]): boolean {
  if (selected.length === 0) return true;
  return values.some((value) => selected.includes(value));
}

/**
 * Apply the whole filter.
 *
 * @param entries - every row in the deck
 * @param filter - the current selection
 * @param hasIssue - whether a word id has validation issues
 * @returns the matching rows, in their original order
 */
export function applyFilter(
  entries: readonly ReviewEntry[],
  filter: LibraryFilter,
  hasIssue: (id: string) => boolean,
): ReviewEntry[] {
  return entries.filter((entry) => {
    if (!passes(filter.statuses, [entry.status])) return false;
    if (!passes(filter.levels, [entry.deckWord.level])) return false;
    if (!passes(filter.topics, entry.deckWord.topics)) return false;
    if (!passes(filter.exams, entry.deckWord.exams)) return false;
    if (!passes(filter.batches, [entry.deckWord.batchId])) return false;
    if (filter.onlyIssues && !hasIssue(entry.id)) return false;
    return matchesSearch(entry, filter.search);
  });
}

/** Count one value into a map. */
function tally(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Count every facet value.
 *
 * Each axis is counted against the filter with that axis removed, so a count
 * says what selecting the value would yield rather than what is already
 * selected. `total` is counted against the filter in full.
 *
 * @param entries - every row in the deck
 * @param filter - the current selection
 * @param hasIssue - whether a word id has validation issues
 */
export function buildFacets(
  entries: readonly ReviewEntry[],
  filter: LibraryFilter,
  hasIssue: (id: string) => boolean,
): LibraryFacets {
  const without = (axis: keyof LibraryFilter): ReviewEntry[] =>
    applyFilter(entries, { ...filter, [axis]: axis === "onlyIssues" ? false : [] }, hasIssue);

  const statuses = new Map<string, number>();
  for (const entry of without("statuses")) tally(statuses, entry.status);

  const levels = new Map<string, number>();
  for (const entry of without("levels")) tally(levels, entry.deckWord.level);

  const topics = new Map<string, number>();
  for (const entry of without("topics")) {
    for (const topic of entry.deckWord.topics) tally(topics, topic);
  }

  const exams = new Map<string, number>();
  for (const entry of without("exams")) {
    for (const exam of entry.deckWord.exams) tally(exams, exam);
  }

  const batches = new Map<string, number>();
  for (const entry of without("batches")) tally(batches, entry.deckWord.batchId);

  const issues = without("onlyIssues").filter((entry) => hasIssue(entry.id)).length;

  return {
    statuses,
    levels,
    topics,
    exams,
    batches,
    issues,
    total: applyFilter(entries, filter, hasIssue).length,
  };
}

/** Whether anything is selected at all, so the UI can offer to clear it. */
export function isFilterActive(filter: LibraryFilter): boolean {
  return (
    filter.search.trim().length > 0 ||
    filter.statuses.length > 0 ||
    filter.levels.length > 0 ||
    filter.topics.length > 0 ||
    filter.exams.length > 0 ||
    filter.batches.length > 0 ||
    filter.onlyIssues
  );
}

/**
 * Turn a batch id into something a human can read.
 *
 * Ids are minted as `run-20261013T120800Z` / `import-…`, which is precise and
 * unreadable; the date is what a reviewer actually thinks in.
 *
 * @param batchId - the stored id
 * @returns a short label, falling back to the raw id when it is not a stamp
 */
export function describeBatch(batchId: string): string {
  const match = /^(run|import)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(batchId);
  if (match === null) return batchId;
  const [, kind, year, month, day, hour, minute] = match;
  return `${kind === "run" ? "Generated" : "Imported"} ${year}-${month}-${day} ${hour}:${minute}`;
}

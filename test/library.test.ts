/**
 * Tests for library filtering — finding one word among thousands.
 *
 * The behaviours that matter: diacritic-insensitive search (a reviewer types
 * ASCII), every term narrowing rather than widening, axes AND-ing while values
 * within an axis OR, and facet counts computed with their own axis excluded so
 * a count predicts what selecting it would give. Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/library.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_FILTER,
  applyFilter,
  buildFacets,
  describeBatch,
  foldText,
  isFilterActive,
  listBatches,
  matchesSearch,
} from "../src/lib/library.ts";
import type { CefrLevel, ReviewEntry, ReviewStatus } from "../src/lib/types.ts";

/** One row, with just enough shape for the filters to bite. */
function entry(
  id: string,
  options: {
    status?: ReviewStatus;
    level?: CefrLevel;
    topics?: string[];
    exams?: string[];
    batchId?: string;
    defVi?: string;
    word?: string;
  } = {},
): ReviewEntry {
  return {
    id,
    status: options.status ?? "pending",
    warnings: [],
    deckWord: {
      id,
      word: options.word ?? id,
      pos: "noun",
      ipa: "",
      defVi: options.defVi ?? "Một thứ quen thuộc trong đời sống hằng ngày.",
      leadVi: "",
      anticipateVi: "",
      topic: (options.topics ?? ["general"])[0]!,
      topics: options.topics ?? ["general"],
      exams: options.exams ?? [],
      level: options.level ?? "B1",
      chars: id.length,
      initial: id.charAt(0).toUpperCase(),
      usage: [{ en: "A sentence with _____ here.", vi: "Một câu ví dụ." }],
      addedAt: "2026-01-01T00:00:00.000Z",
      batchId: options.batchId ?? "run-1",
    },
  };
}

/** A small deck covering every axis. */
const DECK: ReviewEntry[] = [
  entry("harvest", { level: "B1", topics: ["nature"], status: "approved", batchId: "run-a" }),
  entry("invoice", { level: "B2", topics: ["work", "money"], exams: ["toeic"], batchId: "run-a" }),
  entry("nuance", {
    level: "C1",
    topics: ["thinking"],
    exams: ["ielts", "gre"],
    status: "rejected",
    batchId: "run-b",
    defVi: "Sự khác biệt rất nhỏ về nghĩa hoặc sắc thái.",
  }),
  entry("ladder", { level: "A2", topics: ["daily"], status: "approved", batchId: "run-b" }),
];

const noIssues = () => false;
const allIssues = () => true;

// ── search ─────────────────────────────────────────────────────────────────

test("foldText strips Vietnamese diacritics, đ included", () => {
  assert.equal(foldText("tin cậy"), "tin cay");
  assert.equal(foldText("Đoán xem"), "doan xem");
  assert.equal(foldText("sắc thái"), "sac thai");
});

test("search matches toned text from an ASCII query", () => {
  const nuance = DECK[2];
  assert.ok(matchesSearch(nuance, "sac thai"), "ASCII finds the toned phrase");
  assert.ok(matchesSearch(nuance, "sắc thái"), "the toned query still works");
});

test("every search term must match, so adding one narrows", () => {
  const nuance = DECK[2];
  assert.ok(matchesSearch(nuance, "khac biet"));
  assert.ok(!matchesSearch(nuance, "khac biet nonsense"));
});

test("search covers the headword, the Vietnamese fields, usage and topics", () => {
  assert.ok(matchesSearch(DECK[0], "harvest"), "headword");
  assert.ok(matchesSearch(DECK[0], "quen thuoc"), "defVi");
  assert.ok(matchesSearch(DECK[0], "mot cau vi du"), "usage vi");
  assert.ok(matchesSearch(DECK[0], "nature"), "topic slug");
});

test("an empty search matches everything", () => {
  assert.ok(matchesSearch(DECK[0], ""));
  assert.ok(matchesSearch(DECK[0], "   "));
});

// ── axes ───────────────────────────────────────────────────────────────────

test("values within one axis are OR-ed", () => {
  const got = applyFilter(DECK, { ...EMPTY_FILTER, levels: ["B1", "C1"] }, noIssues);
  assert.deepEqual(got.map((e) => e.id), ["harvest", "nuance"]);
});

test("different axes are AND-ed", () => {
  const got = applyFilter(
    DECK,
    { ...EMPTY_FILTER, levels: ["B1", "B2", "C1"], statuses: ["approved"] },
    noIssues,
  );
  assert.deepEqual(got.map((e) => e.id), ["harvest"]);
});

test("a word matches a topic axis on any of its topics", () => {
  assert.deepEqual(
    applyFilter(DECK, { ...EMPTY_FILTER, topics: ["money"] }, noIssues).map((e) => e.id),
    ["invoice"],
  );
});

test("exams and batches filter the same way", () => {
  assert.deepEqual(
    applyFilter(DECK, { ...EMPTY_FILTER, exams: ["gre"] }, noIssues).map((e) => e.id),
    ["nuance"],
  );
  assert.deepEqual(
    applyFilter(DECK, { ...EMPTY_FILTER, batches: ["run-b"] }, noIssues).map((e) => e.id),
    ["nuance", "ladder"],
  );
});

test("the issues toggle narrows to flagged words only", () => {
  assert.equal(applyFilter(DECK, { ...EMPTY_FILTER, onlyIssues: true }, noIssues).length, 0);
  assert.equal(applyFilter(DECK, { ...EMPTY_FILTER, onlyIssues: true }, allIssues).length, 4);
});

test("an empty filter returns the deck in its original order", () => {
  assert.deepEqual(
    applyFilter(DECK, EMPTY_FILTER, noIssues).map((e) => e.id),
    ["harvest", "invoice", "nuance", "ladder"],
  );
});

// ── facets ─────────────────────────────────────────────────────────────────

test("a facet is counted with its own axis excluded", () => {
  // With B1 selected, the level facet must still be able to say how many words
  // the other levels hold — otherwise every unselected level would read 0 and
  // the reviewer could never widen.
  const facets = buildFacets(DECK, { ...EMPTY_FILTER, levels: ["B1"] }, noIssues);
  assert.equal(facets.levels.get("B1"), 1);
  assert.equal(facets.levels.get("C1"), 1, "an unselected level still reports its count");
  assert.equal(facets.total, 1, "but the total honours the whole filter");
});

test("other axes still constrain a facet's counts", () => {
  // Status is approved, so the level facet counts only approved words.
  const facets = buildFacets(DECK, { ...EMPTY_FILTER, statuses: ["approved"] }, noIssues);
  assert.equal(facets.levels.get("B1"), 1);
  assert.equal(facets.levels.get("A2"), 1);
  assert.equal(facets.levels.get("C1"), undefined, "the rejected C1 word is excluded");
});

test("topic and exam facets count a word once per tag it carries", () => {
  const facets = buildFacets(DECK, EMPTY_FILTER, noIssues);
  assert.equal(facets.topics.get("work"), 1);
  assert.equal(facets.topics.get("money"), 1);
  assert.equal(facets.exams.get("ielts"), 1);
  assert.equal(facets.exams.get("gre"), 1);
  assert.equal(facets.batches.get("run-a"), 2);
});

test("the issues facet predicts the toggle, not the current state", () => {
  const facets = buildFacets(DECK, { ...EMPTY_FILTER, onlyIssues: true }, allIssues);
  assert.equal(facets.issues, 4);
  const none = buildFacets(DECK, { ...EMPTY_FILTER, onlyIssues: false }, noIssues);
  assert.equal(none.issues, 0);
});

test("search constrains the facets too", () => {
  const facets = buildFacets(DECK, { ...EMPTY_FILTER, search: "invoice" }, noIssues);
  assert.equal(facets.total, 1);
  assert.equal(facets.levels.get("B2"), 1);
  assert.equal(facets.levels.get("B1"), undefined);
});

// ── odds and ends ──────────────────────────────────────────────────────────

test("isFilterActive notices every axis", () => {
  assert.equal(isFilterActive(EMPTY_FILTER), false);
  assert.ok(isFilterActive({ ...EMPTY_FILTER, search: "x" }));
  assert.ok(isFilterActive({ ...EMPTY_FILTER, topics: ["work"] }));
  assert.ok(isFilterActive({ ...EMPTY_FILTER, onlyIssues: true }));
  assert.equal(isFilterActive({ ...EMPTY_FILTER, search: "   " }), false, "blank text is not a filter");
});

test("describeBatch turns a stamped id into a date a human reads", () => {
  assert.equal(describeBatch("run-20261013T120800Z"), "Generated 2026-10-13 12:08");
  assert.equal(describeBatch("import-20260202T090000Z"), "Imported 2026-02-02 09:00");
  assert.equal(describeBatch("legacy"), "legacy", "an unstamped id is shown as it is");
});

test("listBatches orders by stamp, not id, and tallies review progress", () => {
  const stamped = (id: string, batchId: string, addedAt: string, status: ReviewStatus = "pending") => {
    const row = entry(id, { batchId, status });
    return { ...row, deckWord: { ...row.deckWord, addedAt } };
  };
  const batches = listBatches([
    stamped("a", "run-20261012T0900Z", "2026-10-12T09:00:00.000Z", "approved"),
    stamped("b", "run-20261012T0900Z", "2026-10-12T09:00:00.000Z", "rejected"),
    stamped("c", "import-20261014T0700Z", "2026-10-14T07:00:00.000Z", "edited"),
    stamped("d", "import-20261014T0700Z", "2026-10-14T07:00:00.000Z"),
  ]);
  assert.deepEqual(
    batches.map((batch) => [batch.id, batch.count, batch.done, batch.rejected]),
    [
      ["import-20261014T0700Z", 2, 1, 0],
      ["run-20261012T0900Z", 2, 1, 1],
    ],
  );
});

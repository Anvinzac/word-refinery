/**
 * Tests for the two curated axes a word is organised by — usage domains and
 * exam targets — and for the bookkeeping that makes a weekly batch findable.
 *
 * The axes are closed lists shared with KineMedia, so the behaviour that
 * matters is what happens to a tag that is NOT on them: it must be dropped and
 * reported, never invented into the deck where no filter would show it again.
 * Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/contract.ts, ../src/lib/deck.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  EXAMS,
  MAX_EXAMS,
  MAX_TOPICS,
  TOPICS,
  keepCurated,
  parseAnnotation,
} from "../src/lib/contract.ts";
import { coerceDeckWord, migrateDeckWord, validateDeck } from "../src/lib/deck.ts";
import type { Deck, DeckWord } from "../src/lib/types.ts";

/** A model reply for one word, overridable per test. */
function reply(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    word: "reliable",
    pos: "adj",
    ipa: "/rɪˈlaɪəbl/",
    defVi: "Dễ tin cậy và luôn giữ đúng lời hứa của mình.",
    leadVi: "Người mà ai cũng có thể dựa vào khi cần.",
    anticipateVi: "Ai đáng để giao việc?",
    usageEn: "She is a very _____ colleague.",
    usageVi: "Cô ấy là một đồng nghiệp rất đáng tin.",
    topics: ["character", "work"],
    exams: ["ielts"],
    emphasisVi: ["tin cậy", "dựa vào"],
    ...extra,
  };
}

/** A deck wrapping one word, for the validator. */
function deckOf(word: DeckWord): Deck {
  return { meta: {} as Deck["meta"], words: [word] };
}

// ── the curated lists ──────────────────────────────────────────────────────

test("the topic list matches the taxonomy KineMedia imports against", () => {
  // Drift here is silent: a tag this side has and that side lacks is dropped on
  // import, and the word loses its filter.
  assert.equal(TOPICS.length, 18);
  for (const required of ["perception", "food", "daily", "general"]) {
    assert.ok((TOPICS as readonly string[]).includes(required), `missing ${required}`);
  }
  assert.equal(new Set(TOPICS).size, TOPICS.length, "no repeated topic");
});

test("the exam list is the seven targets, with no duplicates", () => {
  assert.deepEqual([...EXAMS], ["toeic", "ielts", "toefl", "vstep", "cambridge", "sat", "gre"]);
});

test("keepCurated drops unknowns, lowercases, de-duplicates and caps", () => {
  assert.deepEqual(keepCurated(["Work", "work", "wizardry", "study"], TOPICS, MAX_TOPICS), [
    "work",
    "study",
  ]);
  assert.deepEqual(keepCurated(["a", "b"], TOPICS, MAX_TOPICS), []);
  assert.equal(keepCurated(TOPICS, TOPICS, 3).length, 3, "the cap is honoured");
  assert.deepEqual(keepCurated([null, 7, "work"], TOPICS, MAX_TOPICS), ["work"]);
});

// ── what the model is allowed to produce ───────────────────────────────────

test("an annotation keeps its curated topics in the order given", () => {
  const { annotation, issues } = parseAnnotation(reply(), "reliable");
  assert.ok(annotation !== null, issues.join("; "));
  assert.deepEqual(annotation.topics, ["character", "work"]);
  assert.deepEqual(annotation.exams, ["ielts"]);
});

test("an invented topic is dropped and reported rather than stored", () => {
  const { annotation, issues } = parseAnnotation(
    reply({ topics: ["character", "vibes"] }),
    "reliable",
  );
  assert.ok(annotation !== null);
  assert.deepEqual(annotation.topics, ["character"]);
  assert.ok(issues.some((issue) => issue.includes("vibes")), issues.join("; "));
});

test("an annotation with no usable topic falls back to general, and says so", () => {
  const { annotation, issues } = parseAnnotation(reply({ topics: ["nonsense"] }), "reliable");
  assert.deepEqual(annotation?.topics, ["general"]);
  assert.ok(issues.some((issue) => issue.includes("defaulted to general")));
});

test("a legacy single `topic` is folded into topics without being called an extra field", () => {
  const legacy = reply();
  delete legacy.topics;
  legacy.topic = "character";
  const { annotation, issues } = parseAnnotation(legacy, "reliable");
  assert.deepEqual(annotation?.topics, ["character"]);
  assert.ok(!issues.some((issue) => issue.includes("extra field")), issues.join("; "));
});

test("an invented exam is dropped and reported", () => {
  const { annotation, issues } = parseAnnotation(
    reply({ exams: ["ielts", "hsk"] }),
    "reliable",
  );
  assert.deepEqual(annotation?.exams, ["ielts"]);
  assert.ok(issues.some((issue) => issue.includes("hsk")));
});

test("no exams is an ordinary answer, not a defect", () => {
  const { annotation, issues } = parseAnnotation(reply({ exams: [] }), "reliable");
  assert.deepEqual(annotation?.exams, []);
  assert.ok(!issues.some((issue) => issue.includes("exams")), issues.join("; "));
});

// ── import and migration ───────────────────────────────────────────────────

test("a word from before the axes existed is migrated, not rejected", () => {
  const old = {
    id: "reliable",
    word: "reliable",
    pos: "adj",
    ipa: "/x/",
    defVi: "Dễ tin cậy và luôn giữ đúng lời hứa của mình.",
    leadVi: "",
    anticipateVi: "",
    topic: "character",
    level: "B1",
    chars: 8,
    initial: "R",
    usage: [],
  } as unknown as DeckWord;
  const migrated = migrateDeckWord(old);
  assert.deepEqual(migrated.topics, ["character"]);
  assert.deepEqual(migrated.exams, []);
  assert.equal(migrated.topic, "character");
  assert.equal(migrated.batchId, "legacy", "an unknown origin is named, not faked");
});

test("migrating a current word changes nothing", () => {
  const current = migrateDeckWord({
    id: "x",
    word: "x",
    pos: "",
    ipa: "",
    defVi: "",
    leadVi: "",
    anticipateVi: "",
    topic: "work",
    topics: ["work"],
    exams: ["toeic"],
    level: "B1",
    chars: 1,
    initial: "X",
    usage: [],
    addedAt: "2026-01-01T00:00:00.000Z",
    batchId: "run-1",
  });
  assert.equal(current.batchId, "run-1");
  assert.deepEqual(current.exams, ["toeic"]);
});

test("an imported word inherits the batch that carried it in", () => {
  const word = coerceDeckWord(
    { word: "harvest", topics: ["nature", "nonsense"], exams: ["ielts", "nope"] },
    new Set(),
    { batchId: "import-X", addedAt: "2026-02-02T00:00:00.000Z" },
  );
  assert.ok(word !== null);
  assert.deepEqual(word.topics, ["nature"]);
  assert.deepEqual(word.exams, ["ielts"]);
  assert.equal(word.batchId, "import-X");
  assert.equal(word.addedAt, "2026-02-02T00:00:00.000Z");
});

test("a word that already names its batch keeps it through a re-import", () => {
  const word = coerceDeckWord(
    { word: "harvest", topic: "nature", batchId: "run-original", addedAt: "2025-05-05T00:00:00.000Z" },
    new Set(),
    { batchId: "import-X", addedAt: "2026-02-02T00:00:00.000Z" },
  );
  assert.equal(word?.batchId, "run-original");
  assert.equal(word?.addedAt, "2025-05-05T00:00:00.000Z");
});

test("C2 survives an import now that the band exists", () => {
  assert.equal(coerceDeckWord({ word: "nuance", level: "C2" }, new Set())?.level, "C2");
  // Anything that is not a band still falls back rather than throwing.
  assert.equal(coerceDeckWord({ word: "nuance", level: "Z9" }, new Set())?.level, "B1");
});

// ── validation ─────────────────────────────────────────────────────────────

/** A valid deck word, overridable per test. */
function validWord(extra: Partial<DeckWord> = {}): DeckWord {
  return {
    id: "reliable",
    word: "reliable",
    pos: "adj",
    ipa: "/x/",
    defVi: "Dễ tin cậy và luôn giữ đúng lời hứa mình nói.",
    leadVi: "",
    anticipateVi: "",
    topic: "character",
    topics: ["character"],
    exams: [],
    level: "B1",
    chars: 8,
    initial: "R",
    usage: [],
    addedAt: "2026-01-01T00:00:00.000Z",
    batchId: "run-1",
    ...extra,
  };
}

test("the validator rejects an uncurated topic or exam", () => {
  const topicIssues = validateDeck(deckOf(validWord({ topic: "vibes", topics: ["vibes"] })));
  assert.ok(topicIssues.some((issue) => issue.field === "topics"), "uncurated topic flagged");

  const examIssues = validateDeck(deckOf(validWord({ exams: ["hsk"] })));
  assert.ok(examIssues.some((issue) => issue.field === "exams"), "uncurated exam flagged");
});

test("the validator insists `topic` restates topics[0]", () => {
  const issues = validateDeck(deckOf(validWord({ topic: "work", topics: ["character"] })));
  assert.ok(
    issues.some((issue) => issue.field === "topic" && issue.message.includes("topics[0]")),
    JSON.stringify(issues),
  );
});

test("the validator flags an empty topic list and repeated tags", () => {
  assert.ok(
    validateDeck(deckOf(validWord({ topics: [] }))).some((issue) => issue.field === "topics"),
  );
  assert.ok(
    validateDeck(deckOf(validWord({ topics: ["work", "work"], topic: "work" }))).some((issue) =>
      issue.message.includes("repeated"),
    ),
  );
});

test("the validator accepts a word carrying both axes fully populated", () => {
  const issues = validateDeck(
    deckOf(
      validWord({
        topic: "work",
        topics: ["work", "study", "communication"],
        exams: ["ielts", "toeic"],
      }),
    ),
  );
  assert.deepEqual(
    issues.filter((issue) => issue.field === "topics" || issue.field === "exams"),
    [],
  );
});

test("the caps are the ones KineMedia's importer enforces", () => {
  assert.equal(MAX_TOPICS, 6);
  assert.equal(MAX_EXAMS, 8);
});

/**
 * Tests for the style set as a committable file.
 *
 * The point of the file is that hours of editorial judgement stop living in one
 * browser's IndexedDB. So what matters is that a round trip loses nothing, that
 * a card which cannot be matched is reported rather than dropped, and that a
 * marked-but-unrewritten card never becomes a row that teaches nothing.
 * Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/style-file.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  STYLE_FILE_NAME,
  applyStyleFile,
  buildStyleFile,
  parseStyleFile,
} from "../src/lib/style-file.ts";
import { stylePairs } from "../src/lib/style.ts";
import type { DeckWord, ReviewEntry } from "../src/lib/types.ts";

/** One card, optionally with a pre-edit snapshot. */
function entry(
  word: string,
  options: { after?: Partial<DeckWord>; before?: Partial<DeckWord>; sample?: boolean } = {},
): ReviewEntry {
  const base: DeckWord = {
    id: word,
    word,
    pos: "noun",
    ipa: "",
    meaningVi: "",
    defVi: `Định nghĩa của ${word}.`,
    leadVi: `Gợi ý cho ${word}.`,
    anticipateVi: `Đoán ${word}?`,
    topic: "general",
    topics: ["general"],
    exams: [],
    level: "B1",
    chars: word.length,
    initial: word.charAt(0).toUpperCase(),
    usage: [{ en: "A _____ here.", vi: `Ví dụ ${word}.` }],
    addedAt: "2026-01-01T00:00:00.000Z",
    batchId: "deck-v3-A1",
  };
  const deckWord = { ...base, ...options.after };
  return {
    id: word,
    deckWord,
    // A card with no pre-edit snapshot has not been rewritten, so it is pending.
    status: options.before === undefined ? "pending" : "edited",
    warnings: [],
    styleSample: options.sample ?? true,
    original: options.before === undefined ? undefined : { ...base, ...options.before },
  };
}

const EDITED = entry("tidy", {
  before: { defVi: "Máy móc viết.", leadVi: "Gợi ý máy." },
  after: { defVi: "Mọi thứ xếp đúng chỗ.", leadVi: "Bàn học không một tờ giấy lệch." },
});

// ── what gets written ──────────────────────────────────────────────────────

test("every marked card becomes a row; only rewritten ones carry a pair", () => {
  const file = buildStyleFile(
    [EDITED, entry("untouched", { before: undefined }), entry("unmarked", { sample: false })],
    "",
  );
  assert.deepEqual(file.samples.map((row) => row.word).sort(), ["tidy", "untouched"]);
  const chosen = file.samples.find((row) => row.word === "untouched")!;
  // Neither side, rather than two empty ones: there is no pair to fake.
  assert.equal(chosen.before, undefined);
  assert.equal(chosen.after, undefined);
  assert.ok(file.samples.find((row) => row.word === "tidy")!.before !== undefined);
});

test("a selection-only row seeds an empty workspace and nothing else", () => {
  const file = buildStyleFile([entry("chosen", { before: undefined })], "");
  const fresh = [entry("chosen", { before: undefined, sample: false })];
  const seeded = applyStyleFile(fresh, file).entries[0];
  assert.equal(seeded.styleSample, true, "the card is chosen");
  assert.equal(seeded.original, undefined, "but no pair is invented");
  assert.equal(seeded.status, "pending", "and it is not pretended to be edited");
});

test("a selection-only row never overrides a reviewer's own set", () => {
  // The committed thirty are a starting point, not an instruction.
  const file = buildStyleFile([entry("theirs", { before: undefined })], "");
  const mine = [
    entry("mine", { before: undefined }),
    entry("theirs", { before: undefined, sample: false }),
  ];
  const applied = applyStyleFile(mine, file).entries;
  assert.equal(applied.find((e) => e.id === "theirs")?.styleSample, false);
  assert.equal(applied.find((e) => e.id === "mine")?.styleSample, true);
});

test("a committed PAIR applies even when the reviewer has their own set", () => {
  // Real editorial work is not a suggestion.
  const file = buildStyleFile([EDITED], "");
  const mine = [entry("mine", { before: undefined }), entry("tidy", { before: undefined, sample: false })];
  const applied = applyStyleFile(mine, file).entries;
  assert.equal(applied.find((e) => e.id === "tidy")?.deckWord.defVi, "Mọi thứ xếp đúng chỗ.");
});

test("a row carries both sides, and the identity to find its card again", () => {
  const sample = buildStyleFile([EDITED], "").samples[0];
  assert.ok(sample.before !== undefined && sample.after !== undefined, "a rewritten card has both sides");
  assert.equal(sample.before.defVi, "Máy móc viết.");
  assert.equal(sample.after.defVi, "Mọi thứ xếp đúng chỗ.");
  assert.equal(sample.batchId, "deck-v3-A1");
  assert.equal(sample.level, "B1");
});

test("the guide travels with the pairs", () => {
  // A guide without its evidence cannot be checked; pairs without the guide
  // have to be re-distilled before they are useful.
  const file = buildStyleFile([EDITED], "## Voice\nPrefer concrete images.");
  assert.match(file.guide, /Prefer concrete images\./);
  assert.equal(file.version, 1);
  assert.ok(file.exportedAt.length > 0);
});

test("an empty field is left out rather than written as a blank", () => {
  const sample = buildStyleFile([entry("x", { before: {}, after: { leadVi: "" } })], "").samples[0];
  assert.ok(sample.after !== undefined);
  assert.equal(sample.after.leadVi, undefined);
  assert.ok(sample.after.defVi !== undefined);
});

// ── reading it back ────────────────────────────────────────────────────────

test("a round trip restores the text, the pair and the mark", () => {
  const file = buildStyleFile([EDITED], "g");
  const reparsed = parseStyleFile(JSON.stringify(file));
  assert.ok(reparsed !== null);

  // A fresh deck, as a new browser would load it: generated text, no pairs.
  const fresh = [entry("tidy", { before: undefined, sample: false })];
  const { entries, unmatched } = applyStyleFile(fresh, reparsed);
  assert.deepEqual(unmatched, []);
  assert.equal(entries[0].deckWord.defVi, "Mọi thứ xếp đúng chỗ.", "the rewrite is the deck's text");
  assert.equal(entries[0].original?.defVi, "Máy móc viết.", "and the before survives");
  assert.equal(entries[0].styleSample, true);
  assert.equal(stylePairs(entries).length, 2, "the pairs are usable again");
});

test("a card is found by word when its id has shifted under a re-bundle", () => {
  const file = buildStyleFile([EDITED], "");
  file.samples[0].id = "tidy-2";
  const { entries, unmatched } = applyStyleFile([entry("tidy", { before: undefined })], file);
  assert.deepEqual(unmatched, []);
  assert.equal(entries[0].deckWord.defVi, "Mọi thứ xếp đúng chỗ.");
});

test("a sample with no home is reported, not silently dropped", () => {
  const file = buildStyleFile([EDITED], "");
  const { entries, unmatched } = applyStyleFile([entry("other", { before: undefined })], file);
  assert.deepEqual(unmatched, ["tidy"]);
  assert.equal(entries[0].deckWord.defVi, "Định nghĩa của other.", "the other card is untouched");
});

test("cards outside the file are left exactly as they were", () => {
  const file = buildStyleFile([EDITED], "");
  const deck = [entry("tidy", { before: undefined }), entry("keep", { before: undefined, sample: false })];
  const { entries } = applyStyleFile(deck, file);
  assert.equal(entries[1].styleSample, false);
  assert.equal(entries[1].original, undefined);
});

// ── bad input ──────────────────────────────────────────────────────────────

test("junk is refused rather than half-read", () => {
  assert.equal(parseStyleFile("not json"), null);
  assert.equal(parseStyleFile("[]"), null, "an array is not a style file");
  assert.equal(parseStyleFile('{"samples":"nope"}'), null);
});

test("a malformed row is skipped and the rest of the file still loads", () => {
  const text = JSON.stringify({
    version: 1,
    samples: [
      { word: "", before: {}, after: {} },
      null,
      { word: "good", before: { defVi: "a" }, after: { defVi: "b" } },
    ],
  });
  const file = parseStyleFile(text);
  assert.equal(file?.samples.length, 1);
  assert.equal(file?.samples[0].word, "good");
  assert.equal(file?.guide, "", "a file with no guide reads as no guide, not undefined");
});

test("the file name is the one the loader looks for", () => {
  assert.equal(STYLE_FILE_NAME, "style-samples.json");
});

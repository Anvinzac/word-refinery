/**
 * Logic tests for the emphasis marker pipeline and deck validation.
 *
 * These cover the rules that decide whether a generated word is safe to ship:
 * diacritic-preserving phrase matching, the two-syllable emphasis cap, marker
 * injection that can never attach a highlight to text that lacks it, and the
 * whole-deck validator. Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/emphasis.ts, ../src/lib/deck.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  countSyllables,
  injectEmphasisMarkers,
  isVietnameseStopWord,
  stripEmphasisMarkers,
  validateEmphasis,
} from "../src/lib/emphasis.ts";
import { buildDeckWord, slugifyWord, validateDeck } from "../src/lib/deck.ts";
import type { CrawlerAnnotation } from "../src/lib/contract.ts";
import type { Deck, DeckWord } from "../src/lib/types.ts";

// ---------------------------------------------------------------------------
// Emphasis validation
// ---------------------------------------------------------------------------

test("keeps two-syllable phrases that occur verbatim", () => {
  const result = validateEmphasis({
    defVi: "Dễ tin cậy và luôn giữ lời hứa.",
    leadVi: "Người mà ai cũng có thể dựa vào…",
    emphasisVi: ["tin cậy", "dựa vào"],
  });
  assert.deepEqual(result.emphasis, ["tin cậy", "dựa vào"]);
  assert.deepEqual(result.warnings, []);
});

test("drops a phrase that is absent from both fields", () => {
  const result = validateEmphasis({
    defVi: "Dễ tin cậy và luôn giữ lời hứa.",
    emphasisVi: ["không có thật"],
  });
  assert.deepEqual(result.emphasis, []);
  assert.equal(result.warnings.length, 1);
});

test("drops a three-syllable clause", () => {
  const result = validateEmphasis({
    defVi: "Khả năng bật dậy nhanh sau nghịch cảnh.",
    emphasisVi: ["bật dậy nhanh"],
  });
  assert.deepEqual(result.emphasis, []);
});

test("drops a phrase made only of function words", () => {
  const result = validateEmphasis({ defVi: "Cảm giác và của thì là.", emphasisVi: ["và của"] });
  assert.deepEqual(result.emphasis, []);
});

test("drops a single syllable that is half of a compound", () => {
  const result = validateEmphasis({
    defVi: "Học sinh đang đọc sách trong lớp.",
    emphasisVi: ["sinh"],
  });
  assert.deepEqual(result.emphasis, []);
  assert.match(result.warnings[0] ?? "", /half of "Học sinh"/);
});

test("diacritics are preserved so homographs never collide", () => {
  // "nền" and "nên" are different words; an accent-stripped key would merge them.
  const result = validateEmphasis({ defVi: "Nói rằng nên làm như vậy.", emphasisVi: ["nền tảng"] });
  assert.deepEqual(result.emphasis, []);
  assert.equal(isVietnameseStopWord("nên"), true);
  assert.equal(isVietnameseStopWord("nền"), false);
});

test("re-cases a phrase to how the source text wrote it", () => {
  const result = validateEmphasis({ defVi: "Chất lỏng trong suốt mỗi ngày.", emphasisVi: ["chất lỏng"] });
  assert.deepEqual(result.emphasis, ["Chất lỏng"]);
});

test("syllable counting ignores punctuation", () => {
  assert.equal(countSyllables("tin cậy"), 2);
  assert.equal(countSyllables("bật dậy nhanh"), 3);
  assert.equal(countSyllables("học, sinh!"), 2);
});

// ---------------------------------------------------------------------------
// Marker injection
// ---------------------------------------------------------------------------

test("marks each field with the phrase that lives in it", () => {
  const result = injectEmphasisMarkers(
    "Dễ tin cậy và luôn giữ lời hứa.",
    "Người mà ai cũng có thể dựa vào…",
    ["tin cậy", "dựa vào"],
  );
  assert.equal(result.defVi, "Dễ /tin cậy/ và luôn giữ lời hứa.");
  assert.equal(result.leadVi, "Người mà ai cũng có thể /dựa vào/…");
  assert.deepEqual(result.warnings, []);
});

test("stripping markers restores the original text", () => {
  const { defVi } = injectEmphasisMarkers("Dễ tin cậy và luôn giữ lời hứa.", "", ["tin cậy"]);
  assert.equal(stripEmphasisMarkers(defVi), "Dễ tin cậy và luôn giữ lời hứa.");
});

test("never nests a marker into an already-marked field, and keeps source casing", () => {
  const result = injectEmphasisMarkers("Đã /có sẵn/ marker.", "Chưa có gì.", ["có sẵn", "chưa có"]);
  assert.equal(result.defVi, "Đã /có sẵn/ marker.");
  assert.equal(result.leadVi, "/Chưa có/ gì.");
});

test("places nothing and warns when no phrase occurs in either field", () => {
  const result = injectEmphasisMarkers("Không khớp gì cả.", "Cũng vậy thôi.", ["tin cậy"]);
  assert.equal(result.defVi, "Không khớp gì cả.");
  assert.equal(result.leadVi, "Cũng vậy thôi.");
  assert.equal(result.warnings.length, 1);
});

// ---------------------------------------------------------------------------
// Deck word assembly
// ---------------------------------------------------------------------------

const RELIABLE: CrawlerAnnotation = {
  word: "reliable",
  pos: "adj",
  ipa: "/rɪˈlaɪəbl/",
  defVi: "Dễ tin cậy và luôn giữ lời hứa.",
  leadVi: "Người mà ai cũng có thể dựa vào…",
  anticipateVi: "Ai đáng để bạn giao việc?",
  usageEn: "She is a very _____ colleague.",
  usageVi: "Cô ấy là một đồng nghiệp rất đáng tin.",
  topic: "character",
  emphasisVi: ["tin cậy", "dựa vào"],
};

function buildReliable(): DeckWord {
  const built = buildDeckWord({
    corpusWord: { word: "reliable", pos: "adj", level: "B1", band: 3, source: "ngsl" },
    annotation: RELIABLE,
    usedIds: new Set(),
  });
  if (built.deckWord === null) {
    assert.fail(`build failed: ${built.errors.join("; ")}`);
  }
  return built.deckWord;
}

function deckOf(words: DeckWord[]): Deck {
  return {
    meta: {
      name: "test",
      version: "1",
      locale: "en_vi",
      generatedAt: "",
      generator: "test",
      model: "test",
      corpus: "test",
      corpusLicense: "CC BY-SA 4.0",
      wordCount: words.length,
      notes: "",
    },
    words,
  };
}

test("level, chars and initial are computed locally, never taken from the model", () => {
  const word = buildReliable();
  assert.equal(word.level, "B1");
  assert.equal(word.chars, 8);
  assert.equal(word.initial, "R");
  assert.equal(word.defVi.includes("/tin cậy/"), true);
});

test("a word that echoes a level back is still corpus-assigned", () => {
  const built = buildDeckWord({
    corpusWord: { word: "reliable", pos: "adj", level: "B1", band: 3, source: "ngsl" },
    annotation: { ...RELIABLE, word: "reliable" },
    usedIds: new Set(),
  });
  if (built.deckWord === null) assert.fail(built.errors.join("; "));
  assert.equal(built.deckWord.level, "B1");
});

test("slugify produces importer-safe ids and de-duplicates collisions", () => {
  assert.equal(slugifyWord("self-esteem"), "self-esteem");
  assert.equal(slugifyWord("It's"), "its");
  const used = new Set<string>(["reliable"]);
  const built = buildDeckWord({
    corpusWord: { word: "reliable", pos: "adj", level: "B1", band: 3, source: "ngsl" },
    annotation: RELIABLE,
    usedIds: used,
  });
  if (built.deckWord === null) assert.fail(built.errors.join("; "));
  assert.equal(built.deckWord.id, "reliable-2");
});

// ---------------------------------------------------------------------------
// Deck validation
// ---------------------------------------------------------------------------

test("a clean word raises no issues", () => {
  assert.deepEqual(validateDeck(deckOf([buildReliable()])), []);
});

test("flags a defVi outside the 8-11 word band", () => {
  const issues = validateDeck(deckOf([{ ...buildReliable(), defVi: "Ngắn." }]));
  assert.ok(issues.some((issue) => issue.field === "defVi" && /expected 8-11/.test(issue.message)));
});

test("flags an English leak in a Vietnamese field", () => {
  const issues = validateDeck(
    deckOf([
      {
        ...buildReliable(),
        leadVi: "Một người rất reliable trong công việc hằng ngày.",
      },
    ]),
  );
  assert.ok(issues.some((issue) => issue.field === "leadVi" && /leaks the English answer/.test(issue.message)));
});

test("flags an unpaired marker", () => {
  const issues = validateDeck(deckOf([{ ...buildReliable(), defVi: "Chỉ /một marker lẻ ở đây thôi." }]));
  assert.ok(issues.some((issue) => /unpaired/.test(issue.message)));
});

test("flags a marker wrapping the wrong syllable count", () => {
  const issues = validateDeck(
    deckOf([{ ...buildReliable(), defVi: "Có /bật dậy nhanh/ ở trong câu này rồi." }]),
  );
  assert.ok(issues.some((issue) => /syllables; expected 2/.test(issue.message)));
});

test("flags more than one marker in a field", () => {
  const issues = validateDeck(
    deckOf([{ ...buildReliable(), defVi: "Có /tin cậy/ và /giữ lời/ trong câu." }]),
  );
  assert.ok(issues.some((issue) => /one word per page/.test(issue.message)));
});

test("flags duplicate ids and duplicate headwords", () => {
  const word = buildReliable();
  const issues = validateDeck(deckOf([word, { ...word }]));
  assert.equal(issues.filter((issue) => /duplicate/.test(issue.message)).length, 2);
});

test("flags a reused anticipateVi placeholder across words", () => {
  const first = buildReliable();
  const second: DeckWord = { ...first, id: "other", word: "other", anticipateVi: first.anticipateVi };
  const issues = validateDeck(deckOf([first, second]));
  assert.ok(issues.some((issue) => /reused verbatim/.test(issue.message)));
});

test("flags an example sentence missing its blank", () => {
  const word = buildReliable();
  const issues = validateDeck(
    deckOf([{ ...word, usage: [{ en: "She is a colleague.", vi: "Cô ấy là đồng nghiệp." }] }]),
  );
  assert.ok(issues.some((issue) => /missing the _____ blank/.test(issue.message)));
});

/**
 * Logic tests for the emphasis marker pipeline and deck validation.
 *
 * These cover the rules that decide whether a generated word is safe to ship:
 * diacritic-preserving phrase matching, the two-syllable emphasis cap, marker
 * injection that can never attach a highlight to text that lacks it, and the
 * whole-deck validator. They also cover the refine brief: the complaint chips a
 * reviewer taps, their free-text note and the validator's own findings must all
 * reach the regeneration prompt as one instruction. Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/emphasis.ts, ../src/lib/deck.ts,
 * ../src/lib/prompt.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ANNOTATION_SYSTEM_PROMPT,
  COMPLAINT_CHIPS,
  FIELD_RULES,
  REWRITE_SYSTEM_PROMPT,
  buildRegeneratePrompt,
  chipsForField,
} from "../src/lib/prompt.ts";
import {
  countSyllables,
  injectEmphasisMarkers,
  isVietnameseStopWord,
  joinMarkedSyllables,
  splitMarkedSyllables,
  stripEmphasisMarkers,
  validateEmphasis,
} from "../src/lib/emphasis.ts";
import {
  buildDeckWord,
  coerceDeckWord,
  entriesForNewBatches,
  slugifyWord,
  validateDeck,
} from "../src/lib/deck.ts";
import { addLockedKey, openSecret, sealSecret } from "../src/lib/vault.ts";
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

test("syllable split reads markers and a re-join round-trips the field", () => {
  const text = "Người /đáng tin/, luôn giữ lời hứa.";
  const syllables = splitMarkedSyllables(text);
  assert.deepEqual(
    syllables.map((syllable) => [syllable.core, syllable.marked]),
    [["Người", false], ["đáng", true], ["tin", true], ["luôn", false], ["giữ", false], ["lời", false], ["hứa", false]],
  );
  assert.equal(syllables[2].trail, ",");
  assert.equal(joinMarkedSyllables(syllables), text);
});

test("toggling syllables wraps each run once and keeps punctuation outside", () => {
  const syllables = splitMarkedSyllables("Người đáng tin, luôn giữ lời hứa.");
  const toggled = syllables.map((syllable, index) => ({
    ...syllable,
    marked: index === 2 || index === 3 || index === 6,
  }));
  assert.equal(joinMarkedSyllables(toggled), "Người đáng /tin/, /luôn/ giữ lời /hứa/.");
});

test("un-toggling every syllable leaves the plain text", () => {
  const syllables = splitMarkedSyllables("Một /xe đạp/ — cũ.").map((syllable) => ({
    ...syllable,
    marked: false,
  }));
  assert.equal(joinMarkedSyllables(syllables), "Một xe đạp — cũ.");
});

// ---------------------------------------------------------------------------
// Deck word assembly
// ---------------------------------------------------------------------------

const RELIABLE: CrawlerAnnotation = {
  word: "reliable",
  pos: "adj",
  ipa: "/rɪˈlaɪəbl/",
  meaningVi: "đáng_tin",
  defVi: "Dễ tin cậy và luôn giữ lời hứa.",
  leadVi: "Người mà ai cũng có thể dựa vào…",
  anticipateVi: "Ai đáng để bạn giao việc?",
  usageEn: "She is a very _____ colleague.",
  usageVi: "Cô ấy là một đồng nghiệp rất đáng tin.",
  topics: ["character", "work"],
  exams: [],
  emphasisVi: ["tin cậy", "dựa vào"],
};

function buildReliable(): DeckWord {
  const built = buildDeckWord({
    corpusWord: { word: "reliable", pos: "adj", level: "B1", band: 3, source: "ngsl" },
    annotation: RELIABLE,
    usedIds: new Set(),
    batchId: "test-batch",
    addedAt: "2026-01-01T00:00:00.000Z",
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
    batchId: "test-batch",
    addedAt: "2026-01-01T00:00:00.000Z",
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
    batchId: "test-batch",
    addedAt: "2026-01-01T00:00:00.000Z",
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

test("a marker may be one to four syllables, and no more", () => {
  // Card-prompt v3.7: "either one syllable or one joined word of up to 4".
  const tooLong = validateDeck(
    deckOf([{ ...buildReliable(), defVi: "Có /bật dậy nhanh hơn thế/ trong câu này." }]),
  );
  assert.ok(tooLong.some((issue) => /syllables; expected 1-4/.test(issue.message)));

  // One syllable is explicitly allowed, and used by the v4 starter pack.
  const single = validateDeck(
    deckOf([{ ...buildReliable(), defVi: "Có /đế/ ở trong câu này rồi đấy nhé." }]),
  );
  assert.deepEqual(single.filter((issue) => /syllables/.test(issue.message)), []);
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

// ---------------------------------------------------------------------------
// WordCrawler batch import normalisation
// ---------------------------------------------------------------------------

test("coerces a batch entry: topics array, no chars / initial", () => {
  const word = coerceDeckWord(
    {
      id: "jealous",
      word: "jealous",
      defVi: "Khó chịu, /ghen tị/ khi người khác có thứ mình muốn.",
      leadVi: "Bạn thân khoe điện thoại mới, lòng bỗng thấy hơi chua.",
      anticipateVi: "Có ai đang nóng mắt không?",
      pos: "adj",
      ipa: "/ˈdʒel.əs/",
      topics: ["emotion"],
      level: "B1",
      usage: [{ en: "She felt _____ of her sister's success.", vi: "Cô ấy ghen tị với chị gái." }],
    },
    new Set(),
  );
  assert.ok(word !== null);
  assert.equal(word.topic, "emotion");
  assert.equal(word.level, "B1");
  assert.equal(word.chars, "jealous".length);
  assert.equal(word.initial, "J");
  assert.equal(word.usage.length, 1);
});

test("coerce keeps a valid deck word untouched and dedupes ids", () => {
  const used = new Set(["reliable"]);
  const word = coerceDeckWord({ id: "reliable", word: "reliable", topic: "character", level: "A2" }, used);
  assert.ok(word !== null);
  assert.equal(word.id, "reliable-2");
  assert.equal(word.topic, "character");
  assert.equal(word.level, "A2");
});

test("coerce falls back on a sloppy level and a bad topic", () => {
  const word = coerceDeckWord({ word: "habit", level: "weird", topics: ["Not A Slug"] }, new Set());
  assert.ok(word !== null);
  assert.equal(word.level, "B1");
  assert.equal(word.topic, "general");
});

test("coerce returns null when there is no headword", () => {
  assert.equal(coerceDeckWord({ defVi: "không có từ" }, new Set()), null);
});

test("coerce reads raw model output: flat usage fields and emphasisVi phrases", () => {
  const word = coerceDeckWord(
    {
      word: "achieve",
      defVi: "Đạt_được điều mong_muốn sau nhiều cố_gắng bền_bỉ.",
      leadVi: "Leo tới đỉnh núi sau bao năm luyện_tập.",
      usageEn: "She worked hard to _____ her dream.",
      usageVi: "Cô ấy làm_việc chăm_chỉ để đạt_được ước_mơ.",
      emphasisVi: ["Đạt được", "đỉnh núi"],
    },
    new Set(),
  );
  assert.ok(word !== null);
  assert.deepEqual(word.usage, [
    { en: "She worked hard to _____ her dream.", vi: "Cô ấy làm_việc chăm_chỉ để đạt_được ước_mơ." },
  ]);
  assert.equal(word.defVi, "/Đạt_được/ điều mong_muốn sau nhiều cố_gắng bền_bỉ.");
  assert.equal(word.leadVi, "Leo tới /đỉnh núi/ sau bao năm luyện_tập.");
});

test("entriesForNewBatches adds only whole batches the workspace lacks, with fresh ids", () => {
  const usedIds = new Set<string>();
  const kept = coerceDeckWord({ word: "apple", batchId: "vocab_a1_100" }, usedIds, { batchId: "x", addedAt: "" });
  assert.ok(kept !== null);
  const existing = [{ id: kept.id, deckWord: kept, status: "approved" as const, warnings: [] }];

  const added = entriesForNewBatches(existing, [
    { word: "apple", batchId: "vocab_a1_100", level: "A1" },
    { word: "apple", batchId: "deck-v3-A1", level: "A1" },
    { word: "imagine", batchId: "deck-v3-A1", level: "A1" },
    { word: "orphan" },
  ]);
  assert.deepEqual(added.map((entry) => entry.deckWord.word), ["apple", "imagine"]);
  // The repeat of a word already present gets an id of its own, not a clash.
  assert.equal(added[0]?.id, "apple-2");
  assert.ok(added.every((entry) => entry.status === "pending" && entry.deckWord.batchId === "deck-v3-A1"));
  assert.equal(added[1]?.deckWord.level, "A1");

  assert.deepEqual(entriesForNewBatches([...existing, ...added], [{ word: "imagine", batchId: "deck-v3-A1" }]), []);
});

// ── Refine brief: chips + note + validator findings reach one prompt ────────

/** A deck word with enough fields for the regenerate prompt to render. */
const refineWord = {
  word: "harvest",
  defVi: "Việc thu gom cây trái sau một mùa trồng trọt dài.",
  leadVi: "Nông dân chờ cả năm mới tới lúc này.",
  anticipateVi: "Mùa gì vui nhất nhỉ?",
  usage: [{ en: "The _____ was poor this year.", vi: "Vụ mùa năm nay kém." }],
};

test("buildRegeneratePrompt expands chip ids into full instructions", () => {
  const prompt = buildRegeneratePrompt(refineWord, {
    field: "defVi",
    chips: ["too-long", "leaks-answer"],
    note: "",
    issues: [],
  });
  const tooLong = COMPLAINT_CHIPS.find((chip) => chip.id === "too-long");
  const leaks = COMPLAINT_CHIPS.find((chip) => chip.id === "leaks-answer");
  assert.ok(tooLong !== undefined && leaks !== undefined);
  assert.match(prompt, new RegExp(escapeRegExp(tooLong.instruction)));
  assert.match(prompt, new RegExp(escapeRegExp(leaks.instruction)));
  // The raw id is an internal key and must never be shipped to the model.
  assert.ok(!prompt.includes("too-long"));
});

test("buildRegeneratePrompt combines chips, the note and validator findings", () => {
  const prompt = buildRegeneratePrompt(refineWord, {
    field: "leadVi",
    chips: ["weak-hint"],
    note: "compare it to something a child would recognise",
    issues: ["leadVi 13 words; expected 8-11"],
  });
  assert.match(prompt, /Sharpen the hint/);
  assert.match(prompt, /compare it to something a child would recognise/);
  assert.match(prompt, /13 words; expected 8-11/);
  // All three land under the single brief, not as competing instructions.
  const brief = prompt.slice(prompt.indexOf("What to fix"));
  assert.equal(brief.split("\n").filter((line) => line.startsWith("- ")).length, 3);
});

test("buildRegeneratePrompt names the field's own constraints and scope", () => {
  const prompt = buildRegeneratePrompt(refineWord, {
    field: "anticipateVi",
    chips: [],
    note: "",
    issues: [],
  });
  assert.match(prompt, /Rewrite ONLY the "anticipateVi" field/);
  assert.match(prompt, /3-8 words/);
  assert.match(prompt, /Leave every other field alone/);
  // An empty brief still has to ask for something.
  assert.match(prompt, /fresher, more vivid alternative/);
});

test("buildRegeneratePrompt names the word and field ID and quotes the batch rule verbatim", () => {
  for (const field of ["defVi", "leadVi", "anticipateVi", "usageVi"] as const) {
    const prompt = buildRegeneratePrompt(refineWord, { field, chips: [], note: "", issues: [] });
    assert.match(prompt, /English word: harvest/);
    assert.ok(prompt.includes(`Field ID: ${field}`));
    assert.ok(prompt.includes(`- "${field}": ${FIELD_RULES[field]}`), `${field} rule is quoted`);
    // The batch prompt carries the very same line, so the two cannot drift.
    assert.ok(ANNOTATION_SYSTEM_PROMPT.includes(`- "${field}": ${FIELD_RULES[field]}`));
  }
});

test("buildRegeneratePrompt asks for a highlight only where one is rendered", () => {
  const marked = { ...refineWord, leadVi: "Nông_dân chờ cả năm mới tới /lúc này/." };
  const def = buildRegeneratePrompt(marked, { field: "defVi", chips: [], note: "", issues: [] });
  assert.match(def, /also return "emphasis"/);
  assert.match(def, /CHOOSE BY MEANING FIRST/);
  assert.match(def, /from the defVi you just wrote/);
  assert.match(def, /different from "lúc này", which leadVi already highlights/);
  // The card is shown without markers, so the model never copies a slash.
  assert.ok(def.includes("- leadVi: Nông_dân chờ cả năm mới tới lúc này."));

  const usage = buildRegeneratePrompt(refineWord, { field: "usageVi", chips: [], note: "", issues: [] });
  assert.ok(!usage.includes("emphasis"));
});

test("buildRegeneratePrompt passes the deck's taken teasers only to an anticipateVi rewrite", () => {
  const avoid = "Already used verbatim:\n- Mùa gì vui nhất nhỉ?";
  const teaser = buildRegeneratePrompt(refineWord, { field: "anticipateVi", chips: [], note: "", issues: [] }, avoid);
  assert.ok(teaser.includes(avoid));
  const def = buildRegeneratePrompt(refineWord, { field: "defVi", chips: [], note: "", issues: [] }, avoid);
  assert.ok(!def.includes("Already used verbatim"));
});

test("the rewrite system prompt never asks for the eleven-field batch array", () => {
  assert.ok(!REWRITE_SYSTEM_PROMPT.includes("JSON array"));
  assert.match(REWRITE_SYSTEM_PROMPT, /\{"value": /);
  assert.match(REWRITE_SYSTEM_PROMPT, /Never define a word with the word itself/);
});

test("buildRegeneratePrompt ignores unknown chip ids rather than leaking them", () => {
  const prompt = buildRegeneratePrompt(refineWord, {
    field: "defVi",
    chips: ["not-a-real-chip"],
    note: "",
    issues: [],
  });
  assert.ok(!prompt.includes("not-a-real-chip"));
  assert.match(prompt, /fresher, more vivid alternative/);
});

test("chipsForField offers shared chips everywhere and specific ones only in place", () => {
  const lead = chipsForField("leadVi").map((chip) => chip.id);
  const usage = chipsForField("usageVi").map((chip) => chip.id);
  assert.ok(lead.includes("awkward") && usage.includes("awkward"));
  assert.ok(lead.includes("weak-hint"));
  assert.ok(!usage.includes("weak-hint"));
  assert.ok(usage.includes("example-mismatch"));
  assert.ok(!lead.includes("example-mismatch"));
});

test("every chip id is unique, so a tapped chip maps to one instruction", () => {
  const ids = COMPLAINT_CHIPS.map((chip) => chip.id);
  assert.equal(new Set(ids).size, ids.length);
});

/** Quote a literal for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("buildRegeneratePrompt keeps its section breaks and drops only absent lines", () => {
  const withExample = buildRegeneratePrompt(refineWord, {
    field: "defVi",
    chips: [],
    note: "",
    issues: [],
  });
  // Blank lines separate the sections; only a missing example may vanish.
  assert.ok(withExample.includes("\n\nThe card as it stands:"));
  assert.ok(withExample.includes("\n\nWhat to fix, all of it in one rewrite:"));
  assert.match(withExample, /- usageEn: /);

  const noExample = buildRegeneratePrompt({ ...refineWord, usage: [] }, {
    field: "defVi",
    chips: [],
    note: "",
    issues: [],
  });
  assert.ok(!noExample.includes("usageEn"));
  assert.ok(noExample.includes("\n\nWhat to fix, all of it in one rewrite:"));
});

// ---------------------------------------------------------------------------
// PIN-locked keys
// ---------------------------------------------------------------------------

test("a sealed key opens with the right PIN and not with a wrong one", async () => {
  const sealed = await sealSecret("sk-or-v1-secret", "4821", 1_000);
  assert.ok(!JSON.stringify(sealed).includes("secret"));
  assert.equal(await openSecret(sealed, "4821"), "sk-or-v1-secret");
  assert.equal(await openSecret(sealed, "4822"), null);
});

test("sealing twice never repeats the ciphertext", async () => {
  const first = await sealSecret("same key", "0000", 1_000);
  const second = await sealSecret("same key", "0000", 1_000);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("adding a locked key replaces only that provider", async () => {
  const one = await sealSecret("a", "1111", 1_000);
  const two = await sealSecret("b", "2222", 1_000);
  const file = addLockedKey(addLockedKey(null, "openrouter", one), "alibaba", two);
  assert.deepEqual(Object.keys(file.keys).sort(), ["alibaba", "openrouter"]);
  assert.equal(await openSecret(file.keys.alibaba!, "2222"), "b");
});

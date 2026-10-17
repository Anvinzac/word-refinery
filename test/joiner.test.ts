/**
 * Tests for the word joiner — "these syllables are ONE word".
 *
 * The contract has two halves that must not drift from KineMedia's
 * `word-joiner.ts`: what counts as a join (one underscore between two letters,
 * never a run), and what a "word" is for a length rule (syllables, joins
 * removed). The second is the subtle one: if joining made a field count fewer
 * words, a generator could slip an over-long sentence past the validator by
 * joining it. Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/joiner.ts, ../src/lib/deck.ts, ../src/lib/emphasis.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  countUnits,
  findStrayMarks,
  hasAnyMark,
  hasWordJoin,
  splitPhrases,
  stripMarks,
  stripWordJoins,
} from "../src/lib/joiner.ts";
import { injectEmphasisMarkers, validateEmphasis } from "../src/lib/emphasis.ts";
import { validateDeck } from "../src/lib/deck.ts";
import type { Deck, DeckWord } from "../src/lib/types.ts";

/** A deck word that passes validation, overridable per test. */
function word(extra: Partial<DeckWord> = {}): DeckWord {
  return {
    id: "water",
    word: "water",
    pos: "noun",
    ipa: "/x/",
    defVi: "Chất lỏng trong suốt mà ta uống mỗi ngày.",
    leadVi: "",
    anticipateVi: "",
    topic: "nature",
    topics: ["nature"],
    exams: [],
    level: "A1",
    chars: 5,
    initial: "W",
    usage: [{ en: "A glass of _____ please.", vi: "Một cốc nước nhé." }],
    addedAt: "2026-01-01T00:00:00.000Z",
    batchId: "run-1",
    ...extra,
  };
}

const deckOf = (entry: DeckWord): Deck => ({ meta: {} as Deck["meta"], words: [entry] });

// ── what counts as a join ──────────────────────────────────────────────────

test("a join is one underscore between two letters", () => {
  assert.ok(hasWordJoin("ba_lô"));
  assert.ok(hasWordJoin("Điều quan_trọng nhất"));
  assert.equal(hasWordJoin("khong co gi"), false);
});

test("the answer blank is never a join", () => {
  assert.equal(hasWordJoin("A glass of _____ please."), false);
  assert.equal(stripWordJoins("A glass of _____ please."), "A glass of _____ please.");
  assert.deepEqual(findStrayMarks("A glass of _____ please."), []);
});

test("stripWordJoins turns joins into plain spaces and leaves the rest alone", () => {
  assert.equal(stripWordJoins("đeo ba_lô ra cửa"), "đeo ba lô ra cửa");
  assert.equal(stripWordJoins("sức_khỏe và học_sinh"), "sức khỏe và học sinh");
  assert.equal(stripWordJoins("no joins here"), "no joins here");
});

test("joins work on a diacritic-bearing syllable", () => {
  // The character before the underscore may carry a combining mark.
  assert.equal(stripWordJoins("thình_thịch"), "thình thịch");
  assert.ok(hasWordJoin("thình_thịch"));
});

// ── the unit a length rule counts ──────────────────────────────────────────

test("a join does not shrink a word count", () => {
  assert.equal(countUnits("Chất lỏng trong suốt mà ta uống mỗi ngày."), 9);
  assert.equal(
    countUnits("Chất_lỏng trong suốt mà ta uống mỗi ngày."),
    9,
    "joining two syllables must not make the sentence look shorter",
  );
  assert.equal(countUnits("quan_trọng"), 2);
});

test("the validator counts joined text the same as unjoined", () => {
  const plain = validateDeck(deckOf(word()));
  const joined = validateDeck(
    deckOf(word({ defVi: "Chất_lỏng trong suốt mà ta uống mỗi ngày." })),
  );
  assert.deepEqual(
    joined.filter((issue) => issue.field === "defVi"),
    plain.filter((issue) => issue.field === "defVi"),
  );
});

test("joining cannot smuggle an over-long sentence past the length rule", () => {
  // Fifteen syllables, joined into eight tokens: still too long.
  const long = "Chất_lỏng trong_suốt mà ta uống_được mỗi ngày trong đời_sống hằng_ngày này";
  const issues = validateDeck(deckOf(word({ defVi: long })));
  assert.ok(
    issues.some((issue) => issue.field === "defVi" && /expected 8-11/.test(issue.message)),
    JSON.stringify(issues),
  );
});

// ── stray underscores ──────────────────────────────────────────────────────

test("an underscore that is not a join is reported", () => {
  assert.equal(findStrayMarks("snake_case is fine").length, 0, "letters both sides is a join");
  assert.equal(findStrayMarks("trailing_ space").length, 1);
  assert.equal(findStrayMarks("leading _underscore").length, 1);
  assert.equal(findStrayMarks("alone _ here").length, 1);
});

test("the validator flags a stray underscore in a Vietnamese field", () => {
  const issues = validateDeck(
    deckOf(word({ anticipateVi: "Đoán xem _ nào?" })),
  );
  assert.ok(
    issues.some((issue) => issue.field === "anticipateVi" && /stray "_"/.test(issue.message)),
    JSON.stringify(issues),
  );
});

test("a clean joined word raises no stray-underscore issue", () => {
  const issues = validateDeck(
    deckOf(word({ defVi: "Chất_lỏng trong suốt mà ta uống mỗi ngày." })),
  );
  assert.deepEqual(issues.filter((issue) => /stray/.test(issue.message)), []);
});

// ── emphasis across a join ─────────────────────────────────────────────────

test("a plain emphasis phrase still matches text whose syllables are joined", () => {
  const result = validateEmphasis({
    defVi: "Chất_lỏng trong suốt mà ta uống mỗi ngày.",
    leadVi: "",
    emphasisVi: ["Chất lỏng"],
  });
  assert.deepEqual(result.emphasis, ["Chất lỏng"], result.warnings.join("; "));
});

test("the marker is injected around the joined form, not a re-spaced one", () => {
  const marked = injectEmphasisMarkers(
    "Chất_lỏng trong suốt mà ta uống mỗi ngày.",
    "",
    ["Chất lỏng"],
  );
  assert.match(marked.defVi, /\/Chất_lỏng\//, marked.warnings.join("; "));
  // The rest of the sentence is untouched.
  assert.ok(marked.defVi.includes("trong suốt mà ta uống mỗi ngày."));
});

test("a single syllable next to a join is dropped as half of a compound", () => {
  // The join states outright that the two syllables are one word, so
  // highlighting only half of it must not survive.
  const result = validateEmphasis({
    defVi: "Điều quan_trọng nhất là sức khỏe.",
    leadVi: "",
    emphasisVi: ["trọng"],
  });
  assert.deepEqual(result.emphasis, []);
  assert.ok(result.warnings.some((warning) => /half of/.test(warning)), result.warnings.join("; "));
});

// ── the prompt's side of the contract ──────────────────────────────────────

test("the system prompt states all three marks and what each one permits", async () => {
  const { ANNOTATION_SYSTEM_PROMPT } = await import("../src/lib/prompt.ts");
  const prompt = ANNOTATION_SYSTEM_PROMPT;
  assert.match(prompt, /Breaking marks/);
  assert.match(prompt, /ba_lô/, "the worked example is shown");
  assert.match(prompt, /changes a word count/, "marking up must not look like shortening");
  // The three categories take "=" rather than "_", each shown with an example.
  for (const category of [/function words/, /classifier and its noun/, /free verb-object pair/]) {
    assert.match(prompt, category, `the rule names ${category}`);
  }
  for (const example of ["của=tôi", "con=mèo", "ăn=cơm"]) {
    assert.ok(prompt.includes(example), `${example} is shown bound with "="`);
    assert.ok(
      !prompt.includes(example.replace("=", "_")),
      `${example} must never appear word-joined in the prompt`,
    );
  }
  // Why there are two bonds rather than one, and the floor on a phrase.
  assert.match(prompt, /may NEVER cover a "="/, "the highlight rule separates the bonds");
  assert.match(prompt, /at least TWO syllables/, "a phrase too short to break beside is refused");
  assert.match(prompt, /ăn_mừng/, "a lexicalised verb-object pair shows the exception");
  assert.match(prompt, /NEVER put an underscore in "usageEn"/, "the blank's field is protected");
  assert.match(prompt, /emphasisVi" entries are written PLAIN/, "emphasis stays unjoined");
});

test("a single-field rewrite is told the rule too", async () => {
  const { REWRITE_SYSTEM_PROMPT } = await import("../src/lib/prompt.ts");
  const prompt = REWRITE_SYSTEM_PROMPT;
  // Both paths share one marks block rather than two wordings that can drift.
  assert.match(prompt, /Breaking marks/);
  assert.match(prompt, /quan_trọng/);
  assert.match(prompt, /function words/, "a rewrite gets the exclusions too");
  assert.match(prompt, /free verb-object pair/);
  assert.match(prompt, /may NEVER cover a "="/);
  assert.match(prompt, /changes a word count/);
});

test("the worked example in the prompt obeys its own word count", async () => {
  const { ANNOTATION_SYSTEM_PROMPT } = await import("../src/lib/prompt.ts");
  const match = /"defVi":"([^"]+)"/.exec(ANNOTATION_SYSTEM_PROMPT);
  assert.ok(match !== null, "the example carries a defVi");
  const units = countUnits(match[1]);
  assert.ok(units >= 8 && units <= 11, `example defVi counts ${units} units, outside 8-11`);
  assert.ok(match[1].includes("_"), "and it demonstrates a join");
});

// ── clitic bind and phrase break ───────────────────────────────────────────

test("a clitic bind is transparent to a word count, like a word join", () => {
  // Con · mèo · nằm · trên · cái · bàn · gỗ — seven either way.
  assert.equal(countUnits("Con=mèo nằm trên cái=bàn gỗ."), 7);
  assert.equal(countUnits("Con mèo nằm trên cái bàn gỗ."), 7);
});

test("a phrase break is transparent to a word count too", () => {
  assert.equal(countUnits("Chất_lỏng trong suốt | mà ta uống=mỗi ngày."), 9);
  assert.equal(countUnits("Chất lỏng trong suốt mà ta uống mỗi ngày."), 9);
});

test("stripMarks removes all three, leaving ordinary Vietnamese", () => {
  assert.equal(
    stripMarks("Chất_lỏng trong suốt | mà ta uống=mỗi ngày."),
    "Chất lỏng trong suốt mà ta uống mỗi ngày.",
  );
  // A phrase break written without spaces collapses the same way.
  assert.equal(stripMarks("cây trái|sau một mùa"), "cây trái sau một mùa");
});

test("splitPhrases returns each phrase as plain syllables", () => {
  assert.deepEqual(splitPhrases("Chất_lỏng trong suốt | mà ta uống=mỗi ngày."), [
    "Chất lỏng trong suốt",
    "mà ta uống mỗi ngày.",
  ]);
  assert.deepEqual(splitPhrases("không có dấu nào"), ["không có dấu nào"]);
});

test("a stray clitic bind is reported like a stray word join", () => {
  assert.equal(findStrayMarks("con=mèo ngủ").length, 0);
  assert.equal(findStrayMarks("trailing= space").length, 1);
  assert.equal(findStrayMarks("alone = here").length, 1);
});

test("a one-syllable phrase is refused, because nothing can break beside it", () => {
  // The whole point of "|" is that a break can land on a phrase edge instead of
  // stranding a lone syllable. A phrase of one syllable cannot offer that.
  const problems = findStrayMarks("Mèo | nằm trên bàn gỗ.");
  assert.ok(
    problems.some((problem) => /1 syllable/.test(problem) && /at least 2/.test(problem)),
    problems.join("; "),
  );
});

test("a two-syllable phrase is the shortest one accepted", () => {
  assert.deepEqual(findStrayMarks("Mèo ngủ | trên cái=bàn gỗ."), []);
});

test("a lone phrase break with nothing on one side is refused", () => {
  assert.ok(findStrayMarks("chỉ một cụm |").length > 0);
});

test("the validator reports a one-syllable phrase on the word it belongs to", () => {
  const issues = validateDeck(
    deckOf(word({ defVi: "Nước | là chất lỏng trong suốt mà ta uống." })),
  );
  assert.ok(
    issues.some((issue) => issue.field === "defVi" && /syllable/.test(issue.message)),
    JSON.stringify(issues),
  );
});

// ── what a highlight may and may not cover ─────────────────────────────────

test("a highlight may cover a word join", () => {
  const result = validateEmphasis({
    defVi: "Điều quan_trọng nhất là sức khỏe của bạn.",
    leadVi: "",
    emphasisVi: ["quan trọng"],
  });
  assert.deepEqual(result.emphasis, ["quan trọng"], result.warnings.join("; "));
});

test("a highlight may NEVER cover a clitic bind", () => {
  // "con mèo" is a classifier plus a noun: bound for layout, but two words, so
  // glowing them as one unit would be wrong.
  const result = validateEmphasis({
    defVi: "Con=mèo nằm ngủ trên chiếc ghế gỗ.",
    leadVi: "",
    emphasisVi: ["Con mèo"],
  });
  assert.deepEqual(result.emphasis, []);
  assert.ok(
    result.warnings.some((warning) => /spans a "="/.test(warning)),
    result.warnings.join("; "),
  );
});

test("a highlight may never straddle a phrase boundary", () => {
  const result = validateEmphasis({
    defVi: "Chất lỏng trong suốt | mà ta uống mỗi ngày.",
    leadVi: "",
    emphasisVi: ["suốt mà"],
  });
  assert.deepEqual(result.emphasis, []);
  assert.ok(
    result.warnings.some((warning) => /phrase boundary/.test(warning)),
    result.warnings.join("; "),
  );
});

test("the marker still wraps the text's own form when marks are present", () => {
  const marked = injectEmphasisMarkers(
    "Chất_lỏng trong suốt | mà ta uống=mỗi ngày.",
    "",
    ["Chất lỏng"],
  );
  assert.match(marked.defVi, /\/Chất_lỏng\//, marked.warnings.join("; "));
  assert.ok(marked.defVi.includes("|"), "the phrase break survives marking");
});

// ── the markup pass ────────────────────────────────────────────────────────

test("the markup prompt forbids editing and says how it will be checked", async () => {
  const { MARKUP_SYSTEM_PROMPT } = await import("../src/lib/prompt.ts");
  assert.match(MARKUP_SYSTEM_PROMPT, /SAME WORDS in the SAME ORDER/);
  assert.match(MARKUP_SYSTEM_PROMPT, /typesetter, not an editor/);
  assert.match(MARKUP_SYSTEM_PROMPT, /every mark stripped out must equal the input/);
  assert.match(MARKUP_SYSTEM_PROMPT, /Breaking marks/, "it carries the shared marks block");
  assert.match(MARKUP_SYSTEM_PROMPT, /at least TWO syllables/);
});

test("the markup request lists only the fields that have text", async () => {
  const { buildMarkupPrompt } = await import("../src/lib/prompt.ts");
  const prompt = buildMarkupPrompt({
    word: "harvest",
    defVi: "Việc thu gom cây trái sau một mùa dài.",
    leadVi: "",
    anticipateVi: "Mùa gì vui nhất nhỉ?",
    usage: [{ en: "The _____ was poor.", vi: "Vụ mùa kém." }],
  });
  assert.match(prompt, /- defVi:/);
  assert.match(prompt, /- anticipateVi:/);
  assert.match(prompt, /- usageVi:/);
  assert.ok(!prompt.includes("- leadVi:"), "an empty field is not offered for marking");
  assert.match(prompt, /exactly these key\(s\): defVi, anticipateVi, usageVi/);
});

test("a card with nothing to mark up produces no request at all", async () => {
  const { buildMarkupPrompt } = await import("../src/lib/prompt.ts");
  assert.equal(
    buildMarkupPrompt({ word: "x", defVi: "", leadVi: "", anticipateVi: "", usage: [] }),
    "",
  );
});

test("hasAnyMark tells marked text from text that predates the marks", () => {
  assert.equal(hasAnyMark("Việc thu gom cây trái sau một mùa dài."), false);
  assert.ok(hasAnyMark("Việc thu_gom cây trái sau một mùa dài."));
  assert.ok(hasAnyMark("Việc thu gom | cây trái sau một mùa dài."));
  assert.ok(hasAnyMark("Con=mèo ngủ."));
  // The answer blank is not a mark.
  assert.equal(hasAnyMark("The _____ was poor this year."), false);
});

test("stripping the marks off a correctly marked field returns the original", () => {
  // This is the check the markup pass is validated by, so it has to hold exactly.
  const before = "Việc thu gom cây trái sau một mùa trồng trọt dài.";
  const after = "Việc thu_gom cây trái | sau một=mùa trồng_trọt dài.";
  assert.equal(stripMarks(after), before);
});

test("a markup reply that edited the text fails the identity check", () => {
  const before = "Việc thu gom cây trái sau một mùa dài.";
  // One word changed under cover of marking up — exactly what must be caught.
  const edited = "Việc thu_gom hoa trái | sau một mùa dài.";
  assert.notEqual(stripMarks(edited), before);
});

// ── typing marks by hand ───────────────────────────────────────────────────

test("a bond replaces the space it stands in for, from either side", async () => {
  const { applyMark } = await import("../src/lib/sentence-edit.ts");
  const text = "thu gom";
  // Caret on the space.
  assert.deepEqual(applyMark(text, 3, 3, "_"), { text: "thu_gom", caret: 4 });
  // Caret just after the space — the same gap, so the same result.
  assert.deepEqual(applyMark(text, 4, 4, "_"), { text: "thu_gom", caret: 4 });
  assert.deepEqual(applyMark(text, 3, 3, "="), { text: "thu=gom", caret: 4 });
});

test("a bond with no space beside it is simply inserted", async () => {
  const { applyMark } = await import("../src/lib/sentence-edit.ts");
  assert.deepEqual(applyMark("thugom", 3, 3, "_"), { text: "thu_gom", caret: 4 });
});

test("a phrase break lands as exactly one spaced token", async () => {
  const { applyMark } = await import("../src/lib/sentence-edit.ts");
  assert.deepEqual(applyMark("cây trái sau mùa", 8, 8, "|"), {
    text: "cây trái | sau mùa",
    caret: 10,
  });
  // Spaces already around the caret are absorbed, never doubled.
  assert.equal(applyMark("cây trái  sau mùa", 9, 9, "|").text, "cây trái | sau mùa");
});

test("a phrase break at the very start or end does not leave a dangling space", async () => {
  const { applyMark } = await import("../src/lib/sentence-edit.ts");
  assert.equal(applyMark("cây trái", 0, 0, "|").text, "| cây trái");
  assert.equal(applyMark("cây trái", 8, 8, "|").text, "cây trái |");
});

test("highlight markers wrap a selection and unwrap it again", async () => {
  const { toggleMarkers } = await import("../src/lib/sentence-edit.ts");
  const wrapped = toggleMarkers("Chất lỏng trong suốt", 0, 9);
  assert.equal(wrapped.text, "/Chất lỏng/ trong suốt");
  // Selecting the same words again, now inside the markers, removes them.
  assert.equal(toggleMarkers(wrapped.text, 1, 10).text, "Chất lỏng trong suốt");
  // Selecting the markers themselves also removes them.
  assert.equal(toggleMarkers(wrapped.text, 0, 11).text, "Chất lỏng trong suốt");
});

test("toggling markers with nothing selected changes nothing", async () => {
  const { toggleMarkers } = await import("../src/lib/sentence-edit.ts");
  assert.deepEqual(toggleMarkers("Chất lỏng", 4, 4), { text: "Chất lỏng", caret: 4 });
});

test("marks typed by hand round-trip through the parser", async () => {
  const { parseSentence, serializeSentence } = await import("../src/lib/sentence-edit.ts");
  // Whatever someone types in the text view must survive a trip through the
  // chip view, or switching back and forth would quietly rewrite the field.
  for (const text of [
    "Chất_lỏng trong suốt | mà ta uống=mỗi ngày.",
    "Con=mèo nằm trên cái=bàn gỗ.",
    "Việc thu_gom cây trái sau một mùa dài.",
  ]) {
    assert.equal(serializeSentence(parseSentence(text)), text, `round trip failed for ${text}`);
  }
});

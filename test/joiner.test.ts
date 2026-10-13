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

import { countUnits, findStrayJoins, hasWordJoin, stripWordJoins } from "../src/lib/joiner.ts";
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
  assert.deepEqual(findStrayJoins("A glass of _____ please."), []);
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
  assert.equal(findStrayJoins("snake_case is fine").length, 0, "letters both sides is a join");
  assert.equal(findStrayJoins("trailing_ space").length, 1);
  assert.equal(findStrayJoins("leading _underscore").length, 1);
  assert.equal(findStrayJoins("alone _ here").length, 1);
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

test("the system prompt states the joining rule and its traps", async () => {
  const { ANNOTATION_SYSTEM_PROMPT } = await import("../src/lib/prompt.ts");
  const prompt = ANNOTATION_SYSTEM_PROMPT;
  assert.match(prompt, /Word joining/);
  assert.match(prompt, /ba_lô/, "the worked example is shown");
  assert.match(prompt, /does NOT change a word count/, "joining must not look like shortening");
  assert.match(prompt, /when you are not sure.*do not join/i, "the safe default is stated");
  // The three categories that must never be joined, each with an example.
  for (const category of [/function words/, /classifier and its noun/, /free verb-object pair/]) {
    assert.match(prompt, category, `the do-not-join list names ${category}`);
  }
  for (const example of ["của tôi", "con mèo", "ăn cơm"]) {
    assert.ok(prompt.includes(example), `${example} is shown unjoined`);
    assert.ok(
      !prompt.includes(example.replace(" ", "_")),
      `${example} must never appear joined in the prompt`,
    );
  }
  assert.match(prompt, /ăn_mừng/, "a lexicalised verb-object pair shows the exception");
  assert.match(prompt, /NEVER put an underscore in "usageEn"/, "the blank's field is protected");
  assert.match(prompt, /emphasisVi" entries are written PLAIN/, "emphasis stays unjoined");
});

test("a single-field rewrite is told the rule too", async () => {
  const { buildRegeneratePrompt } = await import("../src/lib/prompt.ts");
  const prompt = buildRegeneratePrompt(
    { word: "water", defVi: "x", leadVi: "", anticipateVi: "", usage: [] },
    { field: "defVi", chips: [], note: "", issues: [] },
  );
  assert.match(prompt, /Word joining:/);
  assert.match(prompt, /quan_trọng/);
  assert.match(prompt, /Never join a function word/, "a rewrite gets the exclusions too");
  assert.match(prompt, /free verb-object pair/);
});

test("the worked example in the prompt obeys its own word count", async () => {
  const { ANNOTATION_SYSTEM_PROMPT } = await import("../src/lib/prompt.ts");
  const match = /"defVi":"([^"]+)"/.exec(ANNOTATION_SYSTEM_PROMPT);
  assert.ok(match !== null, "the example carries a defVi");
  const units = countUnits(match[1]);
  assert.ok(units >= 8 && units <= 11, `example defVi counts ${units} units, outside 8-11`);
  assert.ok(match[1].includes("_"), "and it demonstrates a join");
});

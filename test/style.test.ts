/**
 * Tests for the house-voice harness.
 *
 * The load-bearing idea is that a PAIR teaches and a final does not: the
 * difference between what the model wrote and what the reviewer changed it to
 * is voice with the content held constant. So the behaviour that matters is
 * which pairs are produced, which are refused, and that nothing is sent to a
 * model while the guide is still the shipped placeholder. Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/style.ts, ../src/lib/prompt.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_EXEMPLARS,
  renderExemplarCards,
  renderExemplars,
  renderPairs,
  styleExemplarCards,
  pickStyleSet,
  styleExemplars,
  stylePairs,
  styleSetProgress,
} from "../src/lib/style.ts";
import { buildHouseVoice } from "../src/lib/prompt.ts";
import type { CefrLevel, DeckWord, ReviewEntry } from "../src/lib/types.ts";

/** One card, with optional pre-edit original. */
function entry(
  word: string,
  options: {
    level?: CefrLevel;
    topics?: string[];
    defVi?: string;
    leadVi?: string;
    anticipateVi?: string;
    before?: Partial<DeckWord>;
    sample?: boolean;
  } = {},
): ReviewEntry {
  const deckWord: DeckWord = {
    id: word,
    word,
    pos: "noun",
    ipa: "",
    meaningVi: "",
    defVi: options.defVi ?? `Định nghĩa của ${word}.`,
    leadVi: options.leadVi ?? `Gợi ý cho ${word}.`,
    anticipateVi: options.anticipateVi ?? `Đoán ${word}?`,
    topic: (options.topics ?? ["general"])[0]!,
    topics: options.topics ?? ["general"],
    exams: [],
    level: options.level ?? "B1",
    chars: word.length,
    initial: word.charAt(0).toUpperCase(),
    usage: [{ en: "A _____ here.", vi: `Ví dụ ${word}.` }],
    addedAt: "2026-01-01T00:00:00.000Z",
    batchId: "run-1",
  };
  return {
    id: word,
    deckWord,
    status: "edited",
    warnings: [],
    styleSample: options.sample ?? true,
    original: options.before === undefined ? undefined : { ...deckWord, ...options.before },
  };
}

// ── what teaches and what does not ─────────────────────────────────────────

test("a pair is produced only where the reviewer actually changed something", () => {
  const pairs = stylePairs([
    entry("alpha", { defVi: "Bản mới.", before: { defVi: "Bản cũ." } }),
    // Edited, but this field came through untouched: it teaches nothing.
    entry("beta", { defVi: "Giữ nguyên.", before: { defVi: "Giữ nguyên." } }),
  ]);
  assert.equal(pairs.length, 1);
  assert.deepEqual(
    { word: pairs[0].word, before: pairs[0].before, after: pairs[0].after },
    { word: "alpha", before: "Bản cũ.", after: "Bản mới." },
  );
});

test("a card with no pre-edit snapshot yields nothing", () => {
  // Marked but never edited — a finished sentence without its before cannot
  // say what the reviewer would have changed.
  assert.deepEqual(stylePairs([entry("alpha", { before: undefined })]), []);
});

test("an unmarked card is ignored however much it was edited", () => {
  assert.deepEqual(
    stylePairs([entry("alpha", { sample: false, defVi: "Mới.", before: { defVi: "Cũ." } })]),
    [],
  );
});

test("pairs are drawn from each voice-bearing field separately", () => {
  const pairs = stylePairs([
    entry("alpha", {
      defVi: "Định nghĩa mới.",
      leadVi: "Gợi ý mới.",
      before: { defVi: "Định nghĩa cũ.", leadVi: "Gợi ý cũ." },
    }),
  ]);
  assert.deepEqual(pairs.map((pair) => pair.field).sort(), ["defVi", "leadVi"]);
});

// ── choosing what to show a request ────────────────────────────────────────

test("exemplars prefer a shared topic, then the nearest level", () => {
  const deck = [
    entry("far", { level: "C2", topics: ["money"] }),
    entry("near", { level: "A1", topics: ["food"] }),
    entry("same-topic", { level: "C2", topics: ["nature"] }),
  ];
  const picked = styleExemplars(deck, "defVi", { level: "A1", topics: ["nature"] });
  assert.equal(picked[0].word, "same-topic", "topic beats level distance");
  assert.equal(picked[1].word, "near", "then the closest level");
});

test("exemplars are capped and never padded", () => {
  const deck = Array.from({ length: 20 }, (_, index) => entry(`w${index}`));
  assert.equal(styleExemplars(deck, "defVi").length, MAX_EXEMPLARS);
  assert.equal(styleExemplars([], "defVi").length, 0);
  assert.equal(styleExemplars(deck, "defVi", {}, 3).length, 3);
});

test("a field with no text in it is not offered as an exemplar", () => {
  assert.deepEqual(styleExemplars([entry("alpha", { leadVi: "" })], "leadVi"), []);
});

test("card exemplars spread across levels rather than taking the first few", () => {
  const deck = [
    entry("a1-one", { level: "A1" }),
    entry("a1-two", { level: "A1" }),
    entry("a1-three", { level: "A1" }),
    entry("c1-one", { level: "C1" }),
  ];
  const picked = styleExemplarCards(deck, 2).map((card) => card.word);
  assert.deepEqual(picked, ["a1-one", "c1-one"], "one per level before a second from any");
});

// ── the block that reaches the model ───────────────────────────────────────

test("no guide means no house-voice block at all", () => {
  assert.equal(buildHouseVoice("", "- alpha (B1): x", false), "");
  assert.equal(buildHouseVoice("   ", "", false), "");
});

test("the block carries the guide, the examples and the read-back question", () => {
  const block = buildHouseVoice("Prefer concrete images.", "- alpha (B1): Mùa hái trái chín.", false);
  assert.match(block, /HOUSE VOICE/);
  assert.match(block, /Prefer concrete images\./);
  assert.match(block, /Mùa hái trái chín\./);
  assert.match(block, /never their subject matter/, "examples are a sound, not a template");
  assert.match(block, /competent generic Vietnamese/, "the anonymous-output failure is named");
});

test("the block says which kind of example it is showing", () => {
  assert.match(buildHouseVoice("g", "x", true), /Finished cards by the writer/);
  assert.match(buildHouseVoice("g", "x", false), /in the field you are writing now/);
});

test("a guide with no examples yet is still worth sending", () => {
  const block = buildHouseVoice("Prefer concrete images.", "", false);
  assert.match(block, /Prefer concrete images\./);
  assert.ok(!block.includes("never their subject matter"), "no example preamble without examples");
});

// ── rendering ──────────────────────────────────────────────────────────────

test("pairs render with the context a distillation needs", () => {
  const rendered = renderPairs(
    stylePairs([
      entry("alpha", { level: "A2", topics: ["food"], defVi: "Mới.", before: { defVi: "Cũ." } }),
    ]),
  );
  assert.match(rendered, /── alpha · defVi · A2 · food/);
  assert.match(rendered, /BEFORE: Cũ\./);
  assert.match(rendered, /AFTER:  Mới\./);
});

test("exemplars render as finals only, with no before to distract", () => {
  const rendered = renderExemplars([{ word: "alpha", level: "B1", text: "Mùa hái trái chín." }]);
  assert.equal(rendered, "- alpha (B1): Mùa hái trái chín.");
  assert.ok(!rendered.includes("BEFORE"));
});

test("card exemplars show the fields beside each other", () => {
  const rendered = renderExemplarCards(styleExemplarCards([entry("alpha")], 1));
  assert.match(rendered, /── alpha \(B1\)/);
  for (const field of ["meaningVi", "defVi", "leadVi", "anticipateVi"]) {
    assert.match(rendered, new RegExp(`${field}:`), `${field} is shown`);
  }
});

// ── choosing the set ───────────────────────────────────────────────────────

/** A deck with a deliberately lopsided level distribution, like the real one. */
function lopsidedDeck(): ReviewEntry[] {
  const deck: ReviewEntry[] = [];
  const spread: Array<[CefrLevel, number]> = [
    ["A1", 40],
    ["A2", 40],
    ["B1", 10],
    ["C2", 4],
  ];
  for (const [level, count] of spread) {
    for (let index = 0; index < count; index += 1) {
      deck.push(entry(`${level}-${index}`, { level, sample: false }));
    }
  }
  return deck;
}

/** Deterministic stand-in for Math.random. */
function sequence(): () => number {
  let seed = 1;
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

test("the draw spreads across levels instead of following the deck's shape", () => {
  const picked = new Set(pickStyleSet(lopsidedDeck(), 12, sequence()));
  const deck = lopsidedDeck();
  const levels = deck.filter((e) => picked.has(e.id)).map((e) => e.deckWord.level);
  const counts = new Map<string, number>();
  for (const level of levels) counts.set(level, (counts.get(level) ?? 0) + 1);
  // Four levels, twelve cards: every level contributes before any contributes
  // a fourth. A uniform draw would have given mostly A1/A2.
  assert.equal(picked.size, 12);
  assert.equal(counts.get("C2"), 3, "the rarest level is still represented");
  assert.equal(counts.get("A1"), 3, "and the commonest does not dominate");
});

test("a level with too few cards does not stall the draw", () => {
  // C2 runs out after 4; the rest must still fill to the requested size.
  const picked = pickStyleSet(lopsidedDeck(), 20, sequence());
  assert.equal(picked.length, 20);
  assert.equal(new Set(picked).size, 20, "no card is drawn twice");
});

test("the draw tops up rather than replacing what is already marked", () => {
  const deck = lopsidedDeck();
  deck[0] = { ...deck[0]!, styleSample: true };
  deck[1] = { ...deck[1]!, styleSample: true };
  const picked = pickStyleSet(deck, 10, sequence());
  assert.equal(picked.length, 8, "it asks for the shortfall only");
  assert.ok(!picked.includes(deck[0]!.id), "an existing sample is never re-drawn");
});

test("a full set asks for nothing", () => {
  const deck = lopsidedDeck().map((e) => ({ ...e, styleSample: true }));
  assert.deepEqual(pickStyleSet(deck, 10, sequence()), []);
});

test("a card with an empty voice field is not offered", () => {
  // Nothing to rewrite in the teaser means nothing to learn about teasers.
  const deck = [entry("hollow", { sample: false, leadVi: "" })];
  assert.deepEqual(pickStyleSet(deck, 5, sequence()), []);
});

test("progress counts rewritten cards, not marked ones", () => {
  const deck = [
    entry("touched", { defVi: "Mới.", before: { defVi: "Cũ." } }),
    entry("untouched", { before: undefined }),
  ];
  assert.deepEqual(styleSetProgress(deck), { marked: 2, edited: 1, pairs: 1 });
});

test("an empty deck reports an empty set rather than throwing", () => {
  assert.deepEqual(styleSetProgress([]), { marked: 0, edited: 0, pairs: 0 });
  assert.deepEqual(pickStyleSet([], 30, sequence()), []);
});

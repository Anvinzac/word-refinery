/**
 * Tests for the variations grid.
 *
 * The point of the feature is that four takes differ along fixed axes rather
 * than by resampling, so what matters is that the axes are distinct and the
 * prompt holds everything except the axis constant — and that a reply which
 * mangles one field still yields the other four, since a partly-usable
 * suggestion beats an error. Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/variations.ts, ../src/lib/prompt.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  VARIATION_FIELDS,
  VARIATION_SLANTS,
  emptyRow,
  slantById,
} from "../src/lib/variations.ts";
import { VARIATION_SYSTEM_PROMPT, buildVariationPrompt } from "../src/lib/prompt.ts";
import { generateVariation } from "../src/lib/llm.ts";
import type { DeckWord } from "../src/lib/types.ts";

const CARD: DeckWord = {
  id: "climb",
  word: "climb",
  pos: "verb",
  ipa: "/klaɪm/",
  meaningVi: "leo_trèo",
  defVi: "Dùng cả tay lẫn chân | để /leo lên/ | chỗ cao.",
  leadVi: "Chinh_phục Phan_Xi_Păng, | lên đỉnh | thở không ra hơi.",
  anticipateVi: "Lên cao chút nữa!",
  topic: "daily",
  topics: ["daily"],
  exams: [],
  level: "A1",
  chars: 5,
  initial: "C",
  usage: [{ en: "Let's _____ to the top of the hill.", vi: "Mình leo lên | đỉnh đồi nhé." }],
  addedAt: "2026-01-01T00:00:00.000Z",
  batchId: "deck-v3-A1",
};

const LLM = { provider: "openrouter", model: "m", apiKey: "k", batchSize: 5, maxTokens: 1024 } as const;
const realFetch = globalThis.fetch;
function stubReply(content: string): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as typeof fetch;
}
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── the axes ───────────────────────────────────────────────────────────────

test("there are four axes and they are genuinely different instructions", () => {
  assert.equal(VARIATION_SLANTS.length, 4);
  const ids = VARIATION_SLANTS.map((slant) => slant.id);
  assert.deepEqual(ids, ["plain", "warm", "vivid", "playful"]);
  assert.equal(new Set(VARIATION_SLANTS.map((s) => s.instruction)).size, 4);
  // Ordered least to most liberty, so the safe option is met first.
  assert.match(VARIATION_SLANTS[0].instruction, /Strip it to the bone/);
  assert.match(VARIATION_SLANTS[3].instruction, /wit/);
});

test("the playful axis forbids the joke the word cannot carry", () => {
  // A pun on the English spelling is invisible to a reader who sees Vietnamese
  // first, and a card that only works if you get the joke is a broken card.
  const playful = slantById("playful");
  assert.match(playful?.instruction ?? "", /never from a pun on its spelling/);
  assert.match(playful?.instruction ?? "", /must still work for someone who misses the joke/);
});

test("the grid covers every field a reviewer can choose in", () => {
  assert.deepEqual([...VARIATION_FIELDS], [
    "meaningVi",
    "defVi",
    "leadVi",
    "anticipateVi",
    "usageVi",
  ]);
});

test("an empty row is inert, not broken", () => {
  assert.deepEqual(emptyRow("plain"), { slant: "plain", fields: {}, error: null, busy: false });
});

// ── the prompt ─────────────────────────────────────────────────────────────

test("the prompt says the card is acceptable, so it is not read as a fix", () => {
  const prompt = buildVariationPrompt(CARD, "Strip it to the bone.", "Plain");
  assert.match(prompt, /acceptable as it stands/);
  assert.match(prompt, /do not repeat its phrasing/);
  assert.match(prompt, /THE AXIS: Strip it to the bone\./);
});

test("the English example is held fixed, so the two versions stay comparable", () => {
  const prompt = buildVariationPrompt(CARD, "x", "Plain");
  assert.match(prompt, /Keep usageEn exactly as it is/);
  // And its rule is not restated, which would invite a rewrite.
  const rules = VARIATION_SYSTEM_PROMPT.split("Field rules:")[1].split("Breaking marks")[0];
  assert.ok(!rules.includes('"usageEn"'), "usageEn is not listed as a field to write");
  assert.ok(rules.includes('"usageVi"'));
});

test("the system prompt keeps everything but the axis constant", () => {
  assert.match(VARIATION_SYSTEM_PROMPT, /Your job is NOT to fix it/);
  assert.match(VARIATION_SYSTEM_PROMPT, /The axis is the ONLY thing you are free about/);
  assert.match(VARIATION_SYSTEM_PROMPT, /Breaking marks/, "the marks convention still binds");
  assert.match(VARIATION_SYSTEM_PROMPT, /Write every field/, "a skipped field is a column lost");
});

test("a card with no example omits the lines rather than printing blanks", () => {
  const prompt = buildVariationPrompt({ ...CARD, usage: [] }, "x", "Plain");
  assert.ok(!prompt.includes("usageEn"));
  assert.ok(!prompt.includes("Keep usageEn"));
});

// ── reading a reply ────────────────────────────────────────────────────────

test("a full reply yields all five fields", async () => {
  stubReply(JSON.stringify({
    meaningVi: "trèo", defVi: "a", leadVi: "b", anticipateVi: "c", usageVi: "d",
  }));
  const fields = await generateVariation(LLM, CARD, "x", "Plain");
  assert.deepEqual(Object.keys(fields).sort(), [
    "anticipateVi", "defVi", "leadVi", "meaningVi", "usageVi",
  ]);
});

test("a reply missing a field still yields the rest", async () => {
  // A partly-usable suggestion beats an error: the reviewer picks per cell.
  stubReply(JSON.stringify({ defVi: "a", leadVi: "", anticipateVi: null, usageVi: "d" }));
  const fields = await generateVariation(LLM, CARD, "x", "Plain");
  assert.deepEqual(Object.keys(fields).sort(), ["defVi", "usageVi"]);
});

test("a reply with nothing usable is an error, not an empty row", async () => {
  stubReply(JSON.stringify({ meaningVi: "   ", defVi: "" }));
  await assert.rejects(() => generateVariation(LLM, CARD, "x", "Plain"), /none of the five fields/);
  stubReply("no json here");
  await assert.rejects(() => generateVariation(LLM, CARD, "x", "Plain"), /no JSON object/);
});

test("prose around the JSON is tolerated", async () => {
  stubReply('Here you go: {"defVi":"a"} hope that helps');
  assert.deepEqual(await generateVariation(LLM, CARD, "x", "Plain"), { defVi: "a" });
});

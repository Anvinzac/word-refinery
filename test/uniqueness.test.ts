/**
 * Tests for deck-wide `anticipateVi` uniqueness.
 *
 * The rule is deck-wide but generation sees one batch, so the lines in use have
 * to be carried into the prompt. What matters here: the comparison key matches
 * the validator's exactly (otherwise the prompt avoids the wrong things), the
 * budget is honoured (a thousand lines cannot go into a prompt), the risky
 * lines are the ones chosen, and a run feeds its own output forward so a
 * multi-batch run cannot collide with itself. Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/uniqueness.ts, ../src/lib/prompt.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  collectUniqueness,
  createAvoidList,
  normalizeLine,
  openingOf,
  renderAvoidSection,
} from "../src/lib/uniqueness.ts";
import { buildBatchPrompt } from "../src/lib/prompt.ts";
import type { CorpusWord } from "../src/lib/types.ts";

/** One corpus word for the batch prompt. */
const WORDS: CorpusWord[] = [
  { word: "harvest", pos: "noun", level: "B1", band: 2, source: "ngsl" },
  { word: "whisper", pos: "verb", level: "A2", band: 1, source: "ngsl" },
];

// ── the comparison key ─────────────────────────────────────────────────────

test("normalizeLine matches the validator's key: markers out, lowercased", () => {
  assert.equal(normalizeLine("Đoán /xem nào/?"), "đoán xem nào?");
  assert.equal(normalizeLine("  Mùa   gì  vui?  "), "mùa gì vui?");
  assert.equal(normalizeLine(""), "");
});

test("openingOf takes the first two words, punctuation ignored", () => {
  assert.equal(openingOf("Đoán xem nào?"), "đoán xem");
  assert.equal(openingOf("Thứ gì chảy được nhỉ?"), "thứ gì");
  assert.equal(openingOf("Một?"), "một");
  assert.equal(openingOf("   "), "");
});

// ── what gets chosen ───────────────────────────────────────────────────────

test("already-repeated lines are offered before merely short ones", () => {
  const used = [
    "Một câu rất dài và cụ thể về mùa màng nông thôn",
    "Đoán xem nào?",
    "Đoán xem nào?",
    "Ngắn thôi?",
  ];
  const { lines } = collectUniqueness(used, { lineChars: 60 });
  assert.equal(lines[0], "đoán xem nào?", "the line already used twice comes first");
});

test("shorter lines come before longer ones, as the likelier to recur", () => {
  const { lines } = collectUniqueness(
    ["Một câu rất dài và rất cụ thể không bao giờ lặp lại", "Ngắn?"],
    { lineChars: 500 },
  );
  assert.deepEqual(lines[0], "ngắn?");
});

test("the character budget is honoured", () => {
  const used = Array.from({ length: 400 }, (_, index) => `Đoán thử xem là gì số ${index}?`);
  const { lines, totalLines } = collectUniqueness(used, { lineChars: 200 });
  assert.equal(totalLines, 400);
  assert.ok(lines.length < 20, `expected a small sample, got ${lines.length}`);
  assert.ok(lines.join("").length <= 200);
});

test("openings are tallied across the deck and capped", () => {
  const used = [
    "Đoán xem nào?",
    "Đoán xem gì đây?",
    "Đoán xem thử?",
    "Thứ gì chảy được?",
    "Thứ gì bay cao?",
    "Ai là người đó?",
  ];
  const { openings } = collectUniqueness(used, { maxOpenings: 2 });
  assert.equal(openings.length, 2);
  assert.deepEqual(openings[0], { opening: "đoán xem", count: 3 });
  assert.deepEqual(openings[1], { opening: "thứ gì", count: 2 });
});

test("an opening used once is not called worn out", () => {
  const { openings } = collectUniqueness(["Ai là người đó?"]);
  assert.deepEqual(openings, []);
});

test("blank lines are ignored rather than counted as a used line", () => {
  const { totalLines, lines } = collectUniqueness(["", "   ", "Đoán xem nào?"]);
  assert.equal(totalLines, 1);
  assert.deepEqual(lines, ["đoán xem nào?"]);
});

// ── the rendered section ───────────────────────────────────────────────────

test("an empty deck produces no avoid section at all", () => {
  assert.equal(renderAvoidSection(collectUniqueness([])), "");
});

test("the section states the total, the worn openings and the exact lines", () => {
  const used = ["Đoán xem nào?", "Đoán xem gì?", "Mùa gì vui nhất?"];
  const section = renderAvoidSection(collectUniqueness(used));
  assert.match(section, /already contains 3 "anticipateVi" line/);
  assert.match(section, /worn out/);
  assert.match(section, /"đoán xem" \(2×\)/);
  assert.match(section, /- mùa gì vui nhất\?/);
});

test("the section says when it is showing only a sample", () => {
  const used = Array.from({ length: 300 }, (_, index) => `Câu hỏi số ${index} dài vừa phải?`);
  const section = renderAvoidSection(collectUniqueness(used, { lineChars: 120 }));
  assert.match(section, /of 300 shown/);
});

// ── the batch prompt ───────────────────────────────────────────────────────

test("the batch prompt carries the avoid section after the word list", () => {
  const prompt = buildBatchPrompt(WORDS, "AVOID THIS");
  assert.ok(prompt.includes("AVOID THIS"));
  assert.ok(
    prompt.indexOf("AVOID THIS") > prompt.indexOf("harvest"),
    "the constraint follows the words it applies to",
  );
  assert.ok(
    prompt.indexOf("AVOID THIS") < prompt.indexOf("Return the JSON array"),
    "and precedes the closing instruction",
  );
});

test("an empty avoid section leaves the prompt as it was", () => {
  assert.equal(buildBatchPrompt(WORDS), buildBatchPrompt(WORDS, ""));
  assert.equal(buildBatchPrompt(WORDS), buildBatchPrompt(WORDS, "   "));
});

// ── a run avoiding itself ──────────────────────────────────────────────────

test("a batch's own output is avoided by the batches after it", () => {
  const avoid = createAvoidList([]);
  assert.equal(avoid.section(), "", "nothing to avoid on an empty deck");

  avoid.add(["Đoán xem nào?", "Mùa gì vui nhất?"]);
  const second = avoid.section();
  assert.match(second, /đoán xem nào\?/);
  assert.match(second, /mùa gì vui nhất\?/);
  assert.equal(avoid.size(), 2);

  avoid.add(["Thứ gì chảy được?"]);
  assert.match(avoid.section(), /thứ gì chảy được\?/);
  assert.equal(avoid.size(), 3);
});

test("the avoid list starts from the deck and grows from there", () => {
  const avoid = createAvoidList(["Có sẵn trong bộ thẻ?"]);
  assert.match(avoid.section(), /có sẵn trong bộ thẻ\?/);
  avoid.add(["Mới sinh ra trong lượt này?"]);
  const section = avoid.section();
  assert.match(section, /có sẵn trong bộ thẻ\?/);
  assert.match(section, /mới sinh ra trong lượt này\?/);
});

test("recording nothing usable leaves the section untouched", () => {
  const avoid = createAvoidList(["Có sẵn?"]);
  const before = avoid.section();
  avoid.add(["", "   "]);
  assert.equal(avoid.section(), before);
  assert.equal(avoid.size(), 1);
});

test("duplicates inside a run are counted once", () => {
  const avoid = createAvoidList([]);
  avoid.add(["Đoán xem nào?", "Đoán xem nào?"]);
  assert.equal(avoid.size(), 1);
  assert.match(avoid.section(), /already contains 1 "anticipateVi" line/);
});

/**
 * Tests for batch intake.
 *
 * The invariant the whole pipeline exists to protect is that a CANDIDATE is not
 * a CARD. A candidate becomes a card by passing checks, never by not having
 * been checked, and a rejection keeps the reason it happened. Most of what is
 * asserted here is that distinction holding under each way it could be lost.
 * Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/intake.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_FIELD_ORDER,
  candidateId,
  checkContent,
  checkSchema,
  partitionRecords,
  summarize,
  verdictOf,
  type IntakeFinding,
  type IntakeRecord,
} from "../src/lib/intake.ts";
import { coerceDeckWord } from "../src/lib/deck.ts";

/** A candidate that passes every structural check. */
function candidate(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    word: "harvest",
    pos: "noun",
    ipa: "/ˈhɑː.vɪst/",
    meaningVi: "vụ_mùa",
    defVi: "Việc thu_gom cây trái | sau một mùa trồng_trọt dài.",
    leadVi: "Nông_dân chờ cả năm | mới tới lúc này.",
    anticipateVi: "Mùa gì vui nhất nhỉ?",
    usageEn: "The _____ was poor this year.",
    usageVi: "Vụ mùa năm nay kém.",
    topics: ["nature"],
    exams: [],
    emphasisVi: ["thu gom"],
  };
  return { ...base, ...extra };
}

const blockers = (findings: readonly IntakeFinding[]): IntakeFinding[] =>
  findings.filter((finding) => finding.severity === "blocker");

// ── stage one: structure ───────────────────────────────────────────────────

test("a well-formed candidate raises nothing that blocks it", () => {
  assert.deepEqual(blockers(checkSchema(candidate())), []);
});

test("a missing or mistyped field blocks", () => {
  const missing = candidate();
  delete missing.defVi;
  assert.ok(blockers(checkSchema(missing)).some((f) => f.field === "defVi"));
  assert.ok(blockers(checkSchema(candidate({ defVi: 42 }))).some((f) => f.field === "defVi"));
  assert.ok(blockers(checkSchema(candidate({ topics: "nature" }))).some((f) => f.field === "topics"));
});

test("a card about the wrong word is caught by target mapping", () => {
  // The commonest batch failure: the model answered a different slot.
  const found = blockers(checkSchema(candidate({ word: "whisper" }), "harvest"));
  assert.ok(found.some((f) => f.message.includes('describes "whisper"')));
  // And the same card is fine when that IS the word asked for.
  assert.deepEqual(blockers(checkSchema(candidate({ word: "whisper" }), "whisper")), []);
});

test("field order is a warning, not a blocker", () => {
  // Order means nothing to a parser, but a batch whose keys drifted usually
  // came from a different prompt than the one you think you are running.
  const reordered: Record<string, unknown> = {};
  for (const key of [...CANONICAL_FIELD_ORDER].reverse()) reordered[key] = candidate()[key];
  const findings = checkSchema(reordered);
  assert.deepEqual(blockers(findings), []);
  assert.ok(findings.some((f) => f.severity === "warn" && /out of order/.test(f.message)));
});

test("a tag outside the closed lists blocks, because it vanishes downstream", () => {
  assert.ok(blockers(checkSchema(candidate({ topics: ["vibes"] }))).some((f) => f.field === "topics"));
  assert.ok(blockers(checkSchema(candidate({ exams: ["hsk"] }))).some((f) => f.field === "exams"));
});

test("an emphasis phrase that is not in the text blocks", () => {
  const found = blockers(checkSchema(candidate({ emphasisVi: ["không có"] })));
  assert.ok(found.some((f) => f.field === "emphasisVi"));
  // No emphasis at all is only a warning: the deck can fall back to heuristics.
  const none = checkSchema(candidate({ emphasisVi: [] }));
  assert.deepEqual(blockers(none), []);
  assert.ok(none.some((f) => f.field === "emphasisVi" && f.severity === "warn"));
});

test("the blank and the answer beside it are both checked", () => {
  assert.ok(blockers(checkSchema(candidate({ usageEn: "The crop was poor." }))).some((f) => /blank/.test(f.message)));
  assert.ok(
    blockers(checkSchema(candidate({ usageEn: "The _____ harvest was poor." })))
      .some((f) => /leaks the answer/.test(f.message)),
  );
});

test("an unexpected field is tolerated with a warning", () => {
  const findings = checkSchema(candidate({ level: "B1" }));
  assert.deepEqual(blockers(findings), []);
  assert.ok(findings.some((f) => f.field === "level" && f.severity === "warn"));
});

test("something that is not an object at all fails immediately", () => {
  assert.equal(blockers(checkSchema("a string")).length, 1);
  assert.equal(blockers(checkSchema(null)).length, 1);
  assert.equal(blockers(checkSchema([candidate()])).length, 1);
});

// ── stage two: content ─────────────────────────────────────────────────────

test("content findings come from the same validator the deck is held to", () => {
  const card = coerceDeckWord(candidate({ defVi: "Ngắn." }), new Set(), { batchId: "b", addedAt: "" });
  assert.ok(card !== null);
  const findings = checkContent(card);
  assert.ok(findings.some((f) => f.field === "defVi"), "a short definition is caught");
  assert.ok(findings.every((f) => f.stage === "content"));
});

// ── the verdict ────────────────────────────────────────────────────────────

test("a card is accepted by passing, never by not having been checked", () => {
  // This is the invariant the page exists to protect.
  assert.equal(verdictOf([], []), "pending");
  assert.equal(verdictOf([], ["schema"]), "pending");
  assert.equal(verdictOf([], ["schema", "content"]), "accepted");
});

test("one blocker rejects however many stages ran", () => {
  const blocker: IntakeFinding = { stage: "safety", field: "usageEn", severity: "blocker", message: "x" };
  assert.equal(verdictOf([blocker], ["schema", "content", "safety"]), "rejected");
  assert.equal(verdictOf([blocker], []), "rejected");
});

test("warnings alone do not reject", () => {
  const warn: IntakeFinding = { stage: "schema", field: "card", severity: "warn", message: "x" };
  assert.equal(verdictOf([warn], ["schema", "content"]), "accepted");
});

// ── keeping the populations apart ──────────────────────────────────────────

/** One record, for the partition tests. */
function record(id: string, verdict: IntakeRecord["verdict"], extra: Partial<IntakeRecord> = {}): IntakeRecord {
  return { id, word: id, batchId: "b", raw: {}, card: null, findings: [], verdict, ...extra };
}

test("the two populations never merge", () => {
  const split = partitionRecords([
    record("a", "accepted"),
    record("b", "rejected"),
    record("c", "pending"),
  ]);
  assert.deepEqual(split.accepted.map((r) => r.id), ["a"]);
  assert.deepEqual(split.rejected.map((r) => r.id), ["b"]);
  assert.deepEqual(split.pending.map((r) => r.id), ["c"]);
});

test("the summary counts candidates and cards separately, and says where failures came from", () => {
  const rejected = record("b", "rejected", {
    findings: [
      { stage: "schema", field: "word", severity: "blocker", message: "x" },
      { stage: "safety", field: "usageEn", severity: "blocker", message: "y" },
      { stage: "content", field: "defVi", severity: "warn", message: "z" },
    ],
  });
  const result = summarize([record("a", "accepted"), rejected, record("c", "rejected", { repaired: true })]);
  assert.equal(result.total, 3);
  assert.equal(result.accepted, 1, "one card");
  assert.equal(result.rejected, 2);
  assert.equal(result.repaired, 1);
  assert.equal(result.byStage.schema, 1);
  assert.equal(result.byStage.safety, 1);
  assert.equal(result.byStage.content, 0, "a warning is not a failure");
});

test("a candidate id is stable and distinguishes repeats of one word", () => {
  assert.equal(candidateId("batch", "harvest", 3), "batch:3:harvest");
  assert.notEqual(candidateId("b", "x", 0), candidateId("b", "x", 1));
});

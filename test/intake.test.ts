/**
 * Tests for batch intake.
 *
 * The invariant the whole pipeline exists to protect is that a CANDIDATE is not
 * a CARD. A candidate becomes a card by passing checks, never by not having
 * been checked, and a rejection keeps the reason it happened. Most of what is
 * asserted here is that distinction holding under each way it could be lost.
 * Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/intake.ts, ../src/lib/intake-db.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import { CATALOG_SCHEMA_VERSION, catalogVersionRefusal } from "../src/lib/intake-db.ts";

import {
  CANONICAL_FIELD_ORDER,
  candidateId,
  checkBatchRules,
  checkContent,
  checkPromptRules,
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
    // v3.7: one entry per animated sentence, in order.
    emphasisVi: ["thu gom", "chờ", "nhất"],
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

test("each emphasis entry must occur in ITS OWN sentence", () => {
  // v3.7 made the triple positional. An entry that matches the wrong sentence
  // used to pass and now cannot: the app animates each sentence with its own
  // word, so a mismatch glows nothing.
  const swapped = candidate({ emphasisVi: ["chờ", "thu gom", "nhất"] });
  const found = blockers(checkSchema(swapped));
  assert.ok(found.some((f) => f.field === "emphasisVi[0]" && /does not occur in defVi/.test(f.message)));
  assert.ok(found.some((f) => f.field === "emphasisVi[1]" && /does not occur in leadVi/.test(f.message)));
});

test("the triple must have exactly three entries", () => {
  for (const emphasisVi of [["thu gom"], ["thu gom", "chờ"], ["thu gom", "chờ", "nhất", "mùa"]]) {
    const found = blockers(checkSchema(candidate({ emphasisVi })));
    assert.ok(found.some((f) => /exactly 3 entries/.test(f.message)), JSON.stringify(emphasisVi));
  }
});

test("the three entries must differ from one another", () => {
  const found = blockers(checkSchema(candidate({ emphasisVi: ["chờ", "chờ", "nhất"] })));
  assert.ok(found.some((f) => /all be different/.test(f.message)));
});

test("a highlight may cover a join but never a bind or a phrase edge", () => {
  // "thu_gom" is one word; "con=mèo" is a classifier plus a noun.
  assert.deepEqual(
    blockers(checkSchema(candidate({ emphasisVi: ["thu_gom", "chờ", "nhất"] })))
      .filter((f) => f.field.startsWith("emphasisVi")),
    [],
  );
  const bound = blockers(checkSchema(candidate({ emphasisVi: ["thu=gom", "chờ", "nhất"] })));
  assert.ok(bound.some((f) => /spans a "=" or "\|"/.test(f.message)));
});

test("a highlight is one syllable or one two-syllable \"_\" word", () => {
  const shapeBlockers = (extra: Record<string, unknown>) =>
    blockers(checkSchema(candidate(extra))).filter((f) => f.field === "emphasisVi[0]");
  assert.deepEqual(shapeBlockers({}), []);
  assert.deepEqual(shapeBlockers({ emphasisVi: ["cây", "chờ", "nhất"] }), []);
  assert.ok(
    shapeBlockers({ emphasisVi: ["cây trái", "chờ", "nhất"] }).some((f) => /does not join with "_"/.test(f.message)),
    "two syllables a space apart are two words",
  );
  assert.ok(
    shapeBlockers({ defVi: "Việc thu_gom_cây trái | sau một mùa dài.", emphasisVi: ["thu gom cây", "chờ", "nhất"] })
      .some((f) => /3 syllables/.test(f.message)),
    "three syllables never glow, joined or not",
  );
  assert.ok(
    shapeBlockers({ emphasisVi: ["gom", "chờ", "nhất"] }).some((f) => /part of a "_" word/.test(f.message)),
    "half of a joined word is not a word",
  );
});

test("a generic intensifier is never the meaning word", () => {
  const found = blockers(
    checkSchema(candidate({ defVi: "Việc rất tốt | cho một mùa trồng_trọt dài hơi.", emphasisVi: ["rất", "chờ", "nhất"] })),
  );
  assert.ok(found.some((f) => /generic intensifier/.test(f.message)));
});

test("but it may be the third slot, which reveals rather than explains", () => {
  // The third entry is not a meaning word in either language: v3.7 glows it in
  // the teaser, where tone is the point, and v3.9 glows it in the usage
  // sentence, where it IS the answer. A card for "considerably" reveals
  // 「かなり」, and refusing that asks it to reveal something other than the
  // word it teaches.
  const found = blockers(
    checkSchema(candidate({ anticipateVi: "Chờ mùa, rất lâu?", emphasisVi: ["thu gom", "chờ", "rất"] })),
  );
  assert.deepEqual(
    found.filter((f) => /generic intensifier/.test(f.message)),
    [],
  );
});

test("a soft filler may be the tone pivot but never the meaning word", () => {
  // Allowed in anticipateVi, which is where tone lives.
  const tone = candidate({ anticipateVi: "Mùa gì vui nhỉ?", emphasisVi: ["thu gom", "chờ", "nhỉ"] });
  assert.deepEqual(
    blockers(checkSchema(tone)).filter((f) => f.field === "emphasisVi[2]"),
    [],
  );
  // Forbidden in leadVi, where the meaning word has to carry it.
  const meaning = candidate({ leadVi: "Nông_dân chờ cả năm | mới tới lúc này nhỉ.", emphasisVi: ["thu gom", "nhỉ", "nhất"] });
  assert.ok(blockers(checkSchema(meaning)).some((f) => /soft filler/.test(f.message)));
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

// ── card-prompt v3.7 ───────────────────────────────────────────────────────

test("null is a permitted value, listed for review rather than type-errored", () => {
  // The prompt tells the writer to use null rather than drop a key, on the
  // promise that the validator lists every one. Treating it as a type error
  // would make the instruction a trap.
  const findings = checkSchema(candidate({ ipa: null }));
  assert.deepEqual(blockers(findings), []);
  assert.ok(findings.some((f) => f.field === "ipa" && f.severity === "warn" && /review/.test(f.message)));
});

test("a dropped key still fails, which is the point of allowing null", () => {
  const missing = candidate();
  delete missing.ipa;
  assert.ok(blockers(checkSchema(missing)).some((f) => f.field === "ipa"));
});

test("meaningVi is a gloss, not a sentence", () => {
  const long = checkPromptRules(candidate({ meaningVi: "việc thu gom cây trái sau mùa" }));
  assert.ok(long.some((f) => /1-4/.test(f.message)), "more than four words");
  const stopped = checkPromptRules(candidate({ meaningVi: "vụ_mùa." }));
  assert.ok(stopped.some((f) => /not a sentence/.test(f.message)));
  // Two genuine senses after ", " are allowed.
  assert.deepEqual(checkPromptRules(candidate({ meaningVi: "hệ_quả, hàm_ý" })), []);
});

test("usageEn is held to the word list and to British spelling", () => {
  const unlisted = checkPromptRules(candidate({ usageEn: "I bought a _____ and a snack." }));
  assert.ok(unlisted.some((f) => /"snack" is not in the Oxford list/.test(f.message)));
  const american = checkPromptRules(candidate({ usageEn: "The _____ is my favorite colour." }));
  assert.ok(american.some((f) => /write "favourite"/.test(f.message)));
});

test("the answer must not appear in any field read before guessing", () => {
  for (const field of ["meaningVi", "defVi", "leadVi", "anticipateVi"]) {
    const leaked = checkPromptRules(candidate({ [field]: "Đây là harvest nhé." }));
    assert.ok(
      leaked.some((f) => f.field === field && /contains the English answer/.test(f.message)),
      `${field} leak not caught`,
    );
  }
});

test("a join in usageEn is refused, because the blank lives there", () => {
  const found = checkPromptRules(candidate({ usageEn: "The _____ was a thu_gom day." }));
  assert.ok(found.some((f) => /no underscore but the blank/.test(f.message)));
});

// ── rules only a batch can break ───────────────────────────────────────────

/** Wrap raw candidates as records, as the panel does. */
function asRecords(raws: Array<Record<string, unknown>>): IntakeRecord[] {
  return raws.map((raw, index) => ({
    id: `b:${index}:${String(raw.word)}`,
    word: String(raw.word),
    batchId: "b",
    raw,
    card: null,
    findings: [],
    verdict: "pending" as const,
  }));
}

test("a duplicated headword means a requested target lost its slot", () => {
  // Tone words varied, so only the duplicate fires and the count is unambiguous.
  const extra = checkBatchRules(
    asRecords([
      candidate({ emphasisVi: ["thu gom", "chờ", "t1"] }),
      candidate({ emphasisVi: ["thu gom", "chờ", "t2"] }),
      candidate({ word: "whisper", emphasisVi: ["thu gom", "chờ", "t3"] }),
    ]),
  );
  const flagged = [...extra.values()].flat();
  assert.equal(flagged.length, 1, "the second occurrence is flagged, not the first");
  assert.equal(flagged[0].severity, "blocker");
  assert.ok(/may not be duplicated/.test(flagged[0].message));
});

test("a tone word repeated across the batch is a warning, not a rejection", () => {
  // Sixteen cards, cap is two, and "mà" is on four of them.
  const raws = Array.from({ length: 16 }, (_, index) =>
    candidate({
      word: `w${index}`,
      emphasisVi: ["thu gom", "chờ", index < 4 ? "mà" : `t${index}`],
    }),
  );
  const extra = checkBatchRules(asRecords(raws));
  const flagged = [...extra.values()].flat();
  assert.equal(flagged.length, 4, "every card carrying the overused word is told");
  assert.ok(flagged.every((f) => f.severity === "warn"), "a tic is not a defect");
  assert.ok(/is used on 4 of 16/.test(flagged[0].message));
});

test("a varied batch raises nothing", () => {
  const raws = Array.from({ length: 16 }, (_, index) =>
    candidate({ word: `w${index}`, emphasisVi: ["thu gom", "chờ", `t${index}`] }),
  );
  assert.equal(checkBatchRules(asRecords(raws)).size, 0);
});

/**
 * The catalogue now OUTLIVES the session, so the question "may this build write
 * to this file" has an answer that matters. A file from a later build opens
 * fine and loses columns on the first write, which is the one failure the
 * reviewer could not see happening.
 */
test("a catalogue from a newer build is refused rather than quietly downgraded", () => {
  const refusal = catalogVersionRefusal(CATALOG_SCHEMA_VERSION + 1);
  assert.ok(refusal !== null);
  assert.ok(/newer version/.test(refusal), "it says what is wrong");
  assert.ok(
    new RegExp(`schema ${CATALOG_SCHEMA_VERSION + 1}`).test(refusal),
    "and which version wrote it",
  );
});

test("a catalogue from this build, or an older one, opens", () => {
  assert.equal(catalogVersionRefusal(CATALOG_SCHEMA_VERSION), null);
  assert.equal(catalogVersionRefusal(CATALOG_SCHEMA_VERSION - 1), null);
});

test("a catalogue written before the stamp existed is version 1, not unreadable", () => {
  // The tables an unstamped file holds are the ones version 1 created, so
  // refusing it would strand every catalogue released before this change.
  assert.equal(catalogVersionRefusal(null), null);
});

/**
 * A Vietnamese sentence-final particle is a softener in that position and a
 * content word everywhere else. Judging by the word alone rejected a correct
 * card for "stop", whose defVi opens with the verb meaning to cease.
 */
test("a soft filler is judged by where it sits, not by which word it is", () => {
  const cease = checkSchema(
    candidate({
      word: "stop",
      defVi: "Thôi không=làm tiếp | hay không=đi tiếp nữa.",
      emphasisVi: ["thôi", "chờ", "nhất"],
    }),
  );
  assert.deepEqual(
    blockers(cease).filter((f) => /soft filler/.test(f.message)),
    [],
    "\"Thôi không làm tiếp\" opens with the meaning word",
  );

  const softener = checkSchema(
    candidate({ defVi: "Việc thu_gom cây trái sau mùa thôi.", emphasisVi: ["thôi", "chờ", "nhất"] }),
  );
  assert.ok(
    blockers(softener).some((f) => /soft filler/.test(f.message)),
    "at the end of the line it is still a softener",
  );
});

test("usageEn carries exactly one five-underscore blank", () => {
  const none = checkPromptRules(candidate({ usageEn: "The harvest was poor this year." }));
  assert.ok(blockers(none).some((f) => /no answer blank/.test(f.message)));
  const twice = checkPromptRules(candidate({ usageEn: "The _____ and the _____ were poor." }));
  assert.ok(blockers(twice).some((f) => /expected exactly one/.test(f.message)));
  const short = checkPromptRules(candidate({ usageEn: "The ___ was poor this year." }));
  assert.ok(blockers(short).some((f) => /expected exactly one/.test(f.message)));
  assert.deepEqual(
    blockers(checkPromptRules(candidate())).filter((f) => /blank/.test(f.message)),
    [],
  );
});

test("usageEn is held to twenty words and to IPA in slashes", () => {
  const long = checkPromptRules(
    candidate({
      usageEn:
        "The _____ of this year was very good and the weather was kind and the long days were warm and dry too.",
    }),
  );
  assert.ok(long.some((f) => /at most 20/.test(f.message)));
  assert.ok(checkPromptRules(candidate({ ipa: "ˈhɑː.vɪst" })).some((f) => /not IPA in slashes/.test(f.message)));
});

/**
 * The Oxford list is not in this package and never will be, so the ceiling can
 * only be enforced for the words v3.7 spells out itself — and only when a
 * manifest says what the card's level was meant to be.
 */
test("the example-level ceiling applies only when the level is known", () => {
  const card = candidate({ usageEn: "Can I borrow the _____ today?" });
  assert.deepEqual(
    blockers(checkPromptRules(card)).filter((f) => /ceiling/.test(f.message)),
    [],
    "without a level, the rule is skipped rather than guessed",
  );
  assert.ok(
    blockers(checkPromptRules(card, "A1")).some((f) =>
      /"borrow" is a A2 word, above this card's A1 ceiling/.test(f.message),
    ),
  );
  assert.deepEqual(
    blockers(checkPromptRules(card, "B1")).filter((f) => /ceiling/.test(f.message)),
    [],
    "the same word is fine once the ceiling is high enough",
  );
});

test("padding the prompt names by name is a warning, never a rejection", () => {
  const padded = checkPromptRules(candidate({ defVi: "Giúp_ích được | khi cần làm việc gì." }));
  const named = padded.filter((f) => /padding v3.7 names/.test(f.message));
  assert.equal(named.length, 1);
  assert.equal(named[0]!.severity, "warn", "cutting it is a rewrite only a reader can judge");
  // The wider "never stack two near-synonyms" rule is deliberately absent: over
  // the A101-A105 pack it fired on 235 of 500 cards, nearly all of them the
  // genuine choices the rule permits.
  assert.deepEqual(
    checkPromptRules(candidate({ defVi: "Nơi bán báo | và tạp_chí cho khách." })),
    [],
  );
});

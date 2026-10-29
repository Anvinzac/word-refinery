/**
 * Tests for the Japanese reader registers.
 *
 * A pack card holds four tellings of one scene and the app holds one, so
 * something chooses — and the choosing is twelve hand-matched renames. Nothing
 * here is subtle logic; what is worth pinning is that the renames stay matched.
 * A mapping that drifted would not throw, it would quietly file a Japanese
 * definition under the lead-in's name for every card in every batch.
 *
 * The last three tests are the ones that matter most: they feed flattened cards
 * from a real pack into the schema gate, which is the only proof that the shape
 * this module emits is the shape the pipeline accepts — that the gate reads the
 * third highlight from the sentence Japanese actually puts it in, and that it
 * reads a highlight across a bond the way Japanese writes one.
 * Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/registers.ts, ../src/lib/intake.ts,
 *             ../src/lib/lang.ts, ../src/lib/joiner.ts, ../src/lib/contract.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import { CRAWLER_ANNOTATION_FIELDS } from "../src/lib/contract.ts";
import { stripMarks } from "../src/lib/joiner.ts";
import {
  REGISTER_CODES,
  flattenRegisters,
  isRegisterCard,
  type RegisterCard,
} from "../src/lib/registers.ts";

// intake.ts reads the gloss profile ONCE, into a module-level constant, so the
// workspace has to be in place before that module is first evaluated - which a
// static import would do before any statement here ran. Hence the dynamic
// import below. This is the same constraint scripts/verify-batch.ts works
// around, and it is why `--gloss ja` is not simply a flag there.
const store = new Map<string, string>();
store.set(
  "word-refinery.workspaces",
  JSON.stringify({
    version: 1,
    activeId: "current",
    list: [{ id: "current", label: "English → Japanese", gloss: "ja", createdAt: "" }],
  }),
);
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
};
const { activeGlossProfile, displayText } = await import("../src/lib/lang.ts");
const { checkSchema } = await import("../src/lib/intake.ts");

/**
 * One card as `engvocab_JA_*_v3.9_flat` delivers it, with all four registers.
 *
 * The Japanese text is a real card ("following", batch A203) rather than
 * lorem ipsum, so the length and mark rules it meets on the way through the
 * gate are the ones a shipped card meets.
 */
const FOLLOWING = {
  word: "following",
  pos: "adj",
  ipa: "/ˈfɒl.əʊ.ɪŋ/",
  kanaReading: "フォロウイング",
  usageEn: "We will talk about it on the _____ day.",
  topics: ["time", "general"],
  exams: ["toeic"],
  defaultLevel: "JHIGH",
  levels: {
    JPRIM: {
      kanjiTier: 0,
      meaningJP: "つぎの",
      defJa: "ある 日や ものの | すぐ うしろに | つづく ほう。",
      leadJa: "月曜日に 雨が ふって、 | 火曜日は | 青空に なった。",
      anticipateJa: "その あとは | どうなる？",
      usageJa: "その 話は | つぎの 日に しよう。",
      emphasisJa: ["つづく", "火曜日", "つぎの"],
    },
    JSEC: {
      kanjiTier: 1,
      meaningJP: "次の、翌",
      defJa: "ある 日や ものの | すぐ 後に | 続く ほう。",
      leadJa: "月曜日に 雨が ふって、 | 火曜日は | 青空に なった。",
      anticipateJa: "その 後は | どうなる？",
      usageJa: "その 話は | 次の 日に しよう。",
      emphasisJa: ["続く", "火曜日", "次の"],
    },
    JHIGH: {
      kanjiTier: 2,
      meaningJP: "次の、翌",
      defJa: "ある 日や 物事の | すぐ 後に | 続く ほう。",
      leadJa: "月曜日に 雨が 降って、 | 火曜日は | 青空に なった。",
      anticipateJa: "その 後は | どうなる？",
      usageJa: "その 話は | 翌日に しよう。",
      emphasisJa: ["続く", "火曜日", "翌日"],
    },
    JCOLL: {
      kanjiTier: 3,
      meaningJP: "次の、翌",
      defJa: "ある 日や できごとの | 直後に | 続く ほう。",
      leadJa: "月曜日は 雨だったが、 | 火曜日は | 青空が 広がった。",
      anticipateJa: "話の 続きは | また 明日！",
      usageJa: "その 話は | 翌日に しよう。",
      emphasisJa: ["直後", "火曜日", "翌日"],
    },
  },
  // The reviewer's Vietnamese, which the app has no slot for.
  defVi: "Tiếp theo. Cái đến ngay sau một ngày hay một việc nào đó.",
  leadVi: "Thứ Hai trời mưa, sang thứ Ba thì trời xanh.",
  anticipateVi: "Rồi sau đó thì sao?",
} satisfies RegisterCard;

/** The flat card, once, for the assertions that only need to read it. */
const flat = flattenRegisters(FOLLOWING) as Record<string, unknown>;

test("a register card flattens to exactly the contract's fields, in the contract's order", () => {
  // The schema gate reports a card whose keys arrive in any other order, so a
  // flattener that emitted the right twelve in the wrong sequence would turn
  // every Japanese card into a finding.
  assert.deepEqual(Object.keys(flat), [...CRAWLER_ANNOTATION_FIELDS]);
});

test("each Japanese field lands in the slot the app reads it from", () => {
  const high = FOLLOWING.levels.JHIGH;
  // The pack spells the gloss `meaningJP` and the rest `…Ja`; the app's slots
  // are all `…Vi`, named before a second gloss language existed.
  assert.equal(flat.meaningVi, high.meaningJP);
  assert.equal(flat.defVi, high.defJa);
  assert.equal(flat.leadVi, high.leadJa);
  assert.equal(flat.anticipateVi, high.anticipateJa);
  assert.equal(flat.usageVi, high.usageJa);
  assert.deepEqual(flat.emphasisVi, high.emphasisJa);
});

test("the fields that are not per-register survive unchanged", () => {
  assert.equal(flat.word, "following");
  assert.equal(flat.pos, "adj");
  assert.equal(flat.ipa, "/ˈfɒl.əʊ.ɪŋ/");
  assert.equal(flat.usageEn, FOLLOWING.usageEn);
  assert.deepEqual(flat.topics, FOLLOWING.topics);
  assert.deepEqual(flat.exams, FOLLOWING.exams);
});

test("defaultLevel picks the register, not the hardest one", () => {
  // JCOLL is the most difficult telling and the last in the object, so it is
  // what a flattener that took "the last one" or "the richest one" would emit.
  assert.notEqual(FOLLOWING.levels.JCOLL.defJa, FOLLOWING.levels.JHIGH.defJa);
  assert.equal(flat.defVi, FOLLOWING.levels.JHIGH.defJa);

  const forPrimary = flattenRegisters({ ...FOLLOWING, defaultLevel: "JPRIM" }) as Record<
    string,
    unknown
  >;
  assert.equal(forPrimary.defVi, FOLLOWING.levels.JPRIM.defJa);
  assert.equal(forPrimary.meaningVi, FOLLOWING.levels.JPRIM.meaningJP);
});

test("the reviewer's Vietnamese gives way to the chosen register's own text", () => {
  // Those three fields exist so a Vietnamese reviewer can check Japanese they
  // do not read. The app has no slot for them, and the slots they share names
  // with belong to the deck's gloss language - so the Japanese wins.
  assert.notEqual(flat.defVi, FOLLOWING.defVi);
  assert.notEqual(flat.leadVi, FOLLOWING.leadVi);
  assert.notEqual(flat.anticipateVi, FOLLOWING.anticipateVi);
  // kanaReading, defaultLevel and levels are dropped rather than carried: the
  // app normalises a word down to the fields it knows, so they would be weight
  // that never arrives. They stay in data/batches-ja/, where re-bundling reads.
  assert.ok(!("kanaReading" in flat));
  assert.ok(!("levels" in flat));
  assert.ok(!("defaultLevel" in flat));
});

test("a card that carries no registers passes through untouched", () => {
  // A Vietnamese card, and an already-flattened one, are both left exactly as
  // they arrived: the bundler runs this over every batch of both languages.
  const vietnamese = { word: "harvest", pos: "n", defVi: "Mùa màng." };
  assert.equal(flattenRegisters(vietnamese), vietnamese);
  assert.equal(flattenRegisters(flat), flat);
  for (const value of [null, undefined, 42, "text", [1, 2]]) {
    assert.equal(flattenRegisters(value), value);
  }
});

test("a defaultLevel naming a register the card lacks is refused, naming the word", () => {
  // Guessing another register would put a different reader's text in the deck
  // under the default's name - the quietest possible way to be wrong.
  const partial = {
    ...FOLLOWING,
    defaultLevel: "JCOLL",
    levels: { JHIGH: FOLLOWING.levels.JHIGH },
  };
  assert.throws(() => flattenRegisters(partial), /following.*JCOLL/s);
});

test("isRegisterCard is not fooled by null, an array, or a card without levels", () => {
  assert.equal(isRegisterCard(FOLLOWING), true);
  assert.equal(isRegisterCard(flat), false);
  assert.equal(isRegisterCard(null), false);
  assert.equal(isRegisterCard(undefined), false);
  assert.equal(isRegisterCard([]), false);
  assert.equal(isRegisterCard("levels"), false);
  // `levels: null` is a card that tried to carry registers and failed. It is
  // not a register card, and flattening leaves it for the gate to reject.
  assert.equal(isRegisterCard({ word: "x", levels: null }), false);
});

test("every register code the rules name is one the pack can deliver", () => {
  assert.deepEqual([...REGISTER_CODES], ["JPRIM", "JSEC", "JHIGH", "JCOLL"]);
  // The pack's own four, so a fifth code appearing in a future rules version
  // is a change someone made on purpose rather than one that slipped through.
  assert.deepEqual(Object.keys(FOLLOWING.levels).sort(), [...REGISTER_CODES].sort());
});

test("this file checks cards as the Japanese workspace sees them", () => {
  // If the shim above ever stops taking effect, the gate falls back to the
  // Vietnamese profile and every assertion below quietly tests the wrong
  // language instead of failing. So the premise is asserted, not assumed.
  const profile = activeGlossProfile();
  assert.equal(profile.id, "ja");
  // The Japanese rules put the third glow in the usage sentence and give the
  // teaser none, which is the disagreement intake.ts has to follow.
  assert.deepEqual([...profile.emphasisSlots], ["def", "lead", "usageGloss"]);
});

test("a flattened pack card is what the schema gate accepts", () => {
  // The reason the flattener exists: the gates read a flat card, so a pack fed
  // to them unflattened is rejected for missing fields it does have.
  const unflattened = checkSchema(FOLLOWING).filter((f) => f.severity === "blocker");
  assert.ok(
    unflattened.some((f) => f.field === "meaningVi"),
    "expected the raw nested card to be rejected for a missing gloss",
  );

  const blockers = checkSchema(flat).filter((f) => f.severity === "blocker");
  assert.deepEqual(
    blockers.map((f) => `${f.field}: ${f.message}`),
    [],
  );
});

test("the third highlight is checked against the usage sentence, not the teaser", () => {
  // 翌日 occurs in JHIGH's usageJa and not in its anticipateJa. A gate that
  // assumed the Vietnamese layout - third glow in the teaser - rejects this
  // card, and with it every other Japanese card in the pack.
  const high = FOLLOWING.levels.JHIGH;
  assert.ok(!high.anticipateJa.includes(high.emphasisJa[2]!));
  assert.ok(high.usageJa.includes(high.emphasisJa[2]!));

  const found = checkSchema(flat).filter((f) => f.field === "emphasisVi[2]");
  assert.deepEqual(found, []);
});

/**
 * A second real card ("anyway", batch A203), kept to the register the pack
 * declares as default because the bond is what is under test and all four
 * registers carry one.
 *
 * Its definition bonds 気に to せず - two pieces written flush, one unit worth
 * glowing - and its highlight names that unit WITHOUT the bond, the way a
 * reader sees it. That gap is the whole test.
 */
const ANYWAY = {
  word: "anyway",
  pos: "adv",
  ipa: "/ˈen.i.weɪ/",
  kanaReading: "エニウェイ",
  usageEn: "It was raining, but we went out _____.",
  topics: ["communication", "general"],
  exams: [],
  defaultLevel: "JHIGH",
  levels: {
    JHIGH: {
      kanjiTier: 2,
      meaningJP: "それでも、とにかく",
      defJa: "困る ことが あっても、 | 気に_せず | 行う 様子。",
      leadJa: "雨が 降って=いたが、 | かさを さして | 公園へ 行った。",
      anticipateJa: "雨でも | 平気！",
      usageJa: "雨だったけど、 | それでも 出かけた。",
      emphasisJa: ["気にせず", "かさ", "それでも"],
    },
  },
} satisfies RegisterCard;

const anyway = flattenRegisters(ANYWAY) as Record<string, unknown>;

test("a highlight is found across a bond, because Japanese writes a bond flush", () => {
  const def = ANYWAY.levels.JHIGH.defJa;
  const glow = ANYWAY.levels.JHIGH.emphasisJa[0]!;

  // The premise, stated rather than assumed: the sentence carries the bond and
  // the highlight does not, so the two only match once the bond is removed the
  // way THIS language removes one.
  assert.ok(def.includes("気に_せず"), "expected the sentence to bond 気に to せず");
  assert.ok(!glow.includes("_"), "expected the highlight to be written as read");

  // Vietnamese reads a bond as a space, so stripping marks the Vietnamese way
  // leaves 気に せず in the sentence - which does not contain 気にせず. This is
  // the false blocker: eleven phrases across A203-A207 fail it, and a gate that
  // strips marks without asking the profile reports every one as a highlight
  // that glows nothing.
  assert.ok(!stripMarks(def).includes(stripMarks(glow)));
  // Japanese writes the pieces flush, so the bond leaves nothing behind.
  assert.ok(displayText(def, activeGlossProfile()).includes(displayText(glow, activeGlossProfile())));

  // And the gate agrees with the second reading, not the first.
  assert.deepEqual(checkSchema(anyway).filter((f) => f.field === "emphasisVi[0]"), []);
  assert.deepEqual(
    checkSchema(anyway)
      .filter((f) => f.severity === "blocker")
      .map((f) => `${f.field}: ${f.message}`),
    [],
  );
});

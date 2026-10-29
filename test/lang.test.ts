/**
 * Tests for the gloss-language profiles.
 *
 * The profile is prose that a model reads and numbers that a validator
 * enforces, and the failure mode of that pairing is silent: a prompt that asks
 * for something its own worked example breaks teaches the model the example,
 * not the rule. So the central test here feeds each profile's example back
 * through the profile's own limits.
 * Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/lang.ts, ../src/lib/joiner.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  GLOSS_LANGS,
  glossProfile,
  displayText,
  markRules,
  measureLength,
  type GlossProfile,
} from "../src/lib/lang.ts";
import { findStrayMarks, stripMarks } from "../src/lib/joiner.ts";
import {
  injectEmphasisMarkers,
  stripEmphasisMarkers,
  validateEmphasis,
} from "../src/lib/emphasis.ts";

const vi = glossProfile("vi");
const ja = glossProfile("ja");

test("a language is measured the way it is written", () => {
  // Vietnamese separates syllables with spaces, so words are countable.
  assert.equal(measureLength("Chất_lỏng trong suốt | mà ta uống=mỗi ngày.", vi), 9);
  // Japanese does not, so counting words would mean parsing it; characters are
  // what both the writer and the validator can agree on.
  assert.equal(measureLength("手足を使って | 高い所まで", ja), 11);
});

test("a join never makes a field look shorter than it reads", () => {
  assert.equal(measureLength("quan_trọng nhất", vi), 3);
  assert.equal(measureLength("quan trọng nhất", vi), 3);
});

test("a bond comes out as a space in one language and as nothing in the other", () => {
  // The same mark, read by two languages. Vietnamese writes its syllables a
  // space apart, so "_" stands where a space would be and has to leave one
  // behind. Japanese writes them flush, so "_" stands where nothing would be -
  // and a bond that left a space behind would put a gap into every phrase the
  // app quotes back at a reviewer, and into every emphasis match.
  assert.equal(displayText("ba_lô mới | của=tôi", vi), "ba lô mới của tôi");
  assert.equal(displayText("気前が_いい 人に | 会って=みる。", ja), "気前がいい人に会ってみる。");
});

test("both languages use all three marks, each for its own reason", () => {
  assert.deepEqual(findStrayMarks("ba_lô mới | của=tôi", markRules(vi)), []);
  // "_" for a Japanese idiom given whole, "=" for a 補助動詞 leaning on the
  // て-form it follows. Refusing either would reject the cards as written.
  assert.deepEqual(findStrayMarks("手を_貸して | もらって=うれしい。", markRules(ja)), []);
});

test("a chunk is sized in the language's own unit, and fails at its own end", () => {
  // Vietnamese states a FLOOR: one syllable alone is what the mark exists to
  // prevent. Japanese states a CEILING: a chunk that fills the line on its own
  // has not given the line anywhere to break either.
  assert.deepEqual(findStrayMarks("đi học | về nhà", markRules(vi)), []);
  assert.ok(findStrayMarks("đi | về nhà sau một ngày dài", markRules(vi)).some((p) => /at least 2/.test(p)));

  assert.deepEqual(findStrayMarks("まだ | 余るくらいの大きさだ", markRules(ja)), [], "2 characters is a chunk");
  const bulky = findStrayMarks("朝の 電車で 読みかけの 本を 開いた、 | 眠い。", markRules(ja));
  assert.ok(bulky.some((problem) => /at most 14/.test(problem)));
});

/** The example a profile shows the model, parsed back out of it. */
function exampleCard(profile: GlossProfile): Record<string, string | string[]> {
  const parsed = JSON.parse(profile.example) as Array<Record<string, string | string[]>>;
  assert.equal(parsed.length, 1, `${profile.id}: the example is one card`);
  return parsed[0]!;
}

for (const profile of GLOSS_LANGS) {
  test(`the ${profile.label} example obeys the ${profile.label} rules`, () => {
    const card = exampleCard(profile);
    const field = (name: string): string => {
      const value = card[name];
      assert.equal(typeof value, "string", `${name} is text`);
      return value as string;
    };

    for (const [name, rule] of [
      ["defVi", profile.limits.def],
      ["leadVi", profile.limits.lead],
      ["anticipateVi", profile.limits.anticipate],
    ] as const) {
      const size = measureLength(field(name), profile);
      assert.ok(
        size >= rule.min && size <= rule.max,
        `${name} is ${size} ${profile.unitWord}, outside the ${rule.min}-${rule.max} the prompt asks for`,
      );
    }

    const meaning = stripMarks(field("meaningVi"));
    assert.ok(
      measureLength(meaning, profile) <= profile.glossUnits,
      "the example gloss is within the gloss limit",
    );
    assert.ok(
      !profile.sentenceEnd.some((mark) => meaning.endsWith(mark)),
      "the example gloss is a word, not a sentence",
    );

    // Every mark in the example is one this language actually uses, and every
    // phrase it creates is long enough to be worth breaking at.
    for (const name of ["meaningVi", "defVi", "leadVi", "anticipateVi", "usageVi"]) {
      assert.deepEqual(
        findStrayMarks(field(name), markRules(profile)),
        [],
        `${name} carries only marks this language uses`,
      );
    }

    // The highlight entries are drawn from the sentences they glow in - and
    // WHICH sentence is the profile's own business, because the two prompts
    // disagree about the third slot.
    const emphasis = card.emphasisVi as string[];
    assert.ok(Array.isArray(emphasis) && emphasis.length >= 2);
    const slotField = { def: "defVi", lead: "leadVi", anticipate: "anticipateVi", usageGloss: "usageVi" };
    for (const [index, phrase] of emphasis.entries()) {
      const slot = profile.emphasisSlots[index];
      assert.ok(slot !== undefined, `emphasis entry ${index} has no slot to glow in`);
      const name = slotField[slot];
      assert.ok(
        displayText(field(name), profile).includes(phrase),
        `"${phrase}" does not occur in ${name}, the sentence it is meant to highlight`,
      );
      const size = measureLength(phrase, profile);
      assert.ok(
        size >= profile.emphasis.min && size <= profile.emphasis.max,
        `"${phrase}" is ${size} ${profile.emphasis.unitWord}, outside ${profile.emphasis.min}-${profile.emphasis.max}`,
      );
    }
  });

  test(`the ${profile.label} profile is complete enough to prompt with`, () => {
    for (const [name, value] of Object.entries(profile.fieldRules)) {
      assert.ok(value.trim().length > 20, `fieldRules.${name} says something`);
    }
    for (const block of [profile.audience, profile.joining, profile.rules, profile.emphasisChoice]) {
      assert.ok(block.trim().length > 40);
    }
    // A prompt that names the wrong language is the one defect no reviewer
    // would think to look for, because everything else about it reads right.
    assert.ok(profile.audience.includes(profile.label));
    assert.ok(profile.rules.includes(profile.label));
  });
}

test("every profile has its own id, so the picker cannot address two at once", () => {
  const ids = GLOSS_LANGS.map((profile) => profile.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("an unknown language falls back to the original deck rather than throwing", () => {
  assert.equal(glossProfile("xx" as never).id, "vi");
});

/* --------------------------------------------------------------------------
 * A highlight in a language with no word boundaries.
 *
 * The emphasis matcher was written for Vietnamese, where a highlight has
 * visible edges. Run against the Japanese pack, its word-boundary test alone
 * refused 876 highlights in 1000 — every one where a particle sits flush
 * against the word it marks. These hold the fix in place.
 * ------------------------------------------------------------------------ */

test("a Japanese highlight is found with a particle flush against it", () => {
  // 「知りたい」 followed directly by と. A Vietnamese matcher reads the と as a
  // letter on the right and refuses the match; Japanese has no edge there to
  // test, so the phrase is simply located.
  const result = validateEmphasis({
    defVi: "もっと 知りたいと | 心が 引かれる 様子。",
    leadVi: "弟が 魚の 図鑑を | じっと 見つめて、 | 「これ 何？」と 聞く。",
    emphasisVi: ["知りたい", "聞く"],
    profile: ja,
  });
  assert.deepEqual(result.emphasis, ["知りたい", "聞く"]);
  assert.deepEqual(result.warnings, []);
});

test("a Japanese highlight may cross a join but never a bind or a chunk edge", () => {
  // An idiom is given whole, so "_" is crossed: 気前が_いい is one entry.
  const idiom = validateEmphasis({
    defVi: "お金や 時間を | 人の=ために | 気前が_いい 性格。",
    emphasisVi: ["気前がいい"],
    profile: ja,
  });
  assert.deepEqual(idiom.emphasis, ["気前がいい"]);

  // A "=" unit is NOT one word: 忘れて=しまう gives 忘れて, never the whole run.
  const bound = validateEmphasis({
    defVi: "名前を | 忘れて=しまう | ことの 様子。",
    emphasisVi: ["忘れてしまう"],
    profile: ja,
  });
  assert.deepEqual(bound.emphasis, []);
  assert.ok(bound.warnings.some((note) => /crosses a space/.test(note)));
});

test("the marker wraps the text's own form, so stripping it gives the field back", () => {
  const marked = injectEmphasisMarkers(
    "お金や 時間を | 人の=ために | 気前が_いい 性格。",
    "初めての 給料で、 | 家族みんなに | ごちそうした。",
    ["気前がいい", "ごちそうした"],
    ja,
  );
  // The marks stay inside the marker; the field is unchanged once it comes off.
  assert.ok(marked.defVi.includes("/気前が_いい/"), marked.defVi);
  assert.equal(stripEmphasisMarkers(marked.defVi), "お金や 時間を | 人の=ために | 気前が_いい 性格。");
  assert.ok(marked.leadVi.includes("/ごちそうした/"));
});

test("a Japanese highlight that spans two 文節 is refused", () => {
  // 「人前で失敗して」 reads as one run once the marks come off, but in the text
  // a space stands between the two 文節, and a highlight stays inside one.
  const result = validateEmphasis({
    defVi: "人前で 失敗して、 | 顔が 熱くなる | 気持ち。",
    emphasisVi: ["人前で失敗して"],
    profile: ja,
  });
  assert.deepEqual(result.emphasis, []);
  assert.ok(result.warnings.some((note) => /crosses a space/.test(note)));
});

test("a Japanese highlight longer than one word is refused on its length", () => {
  const result = validateEmphasis({
    defVi: "話や ものの | こまかい部分までを | 調べる こと。",
    emphasisVi: ["こまかい部分までを"],
    profile: ja,
  });
  assert.deepEqual(result.emphasis, []);
  assert.ok(result.warnings.some((note) => /at most 8/.test(note)), result.warnings.join(" / "));
});

test("a length range a language calls an aim is reported as advice, not a defect", () => {
  // v3.7 gives Vietnamese a hard 8-11 words. v3.9 says Japanese defJa is
  // "about 12 to 36 characters" and its own validator warns, so a tight,
  // correct definition must not be reported the way a broken one is.
  assert.equal(vi.limits.def.aim, undefined);
  assert.equal(ja.limits.def.aim, true);
  // What is hard in Japanese lives elsewhere, and stays hard.
  assert.equal(ja.limits.meaning.maxChars, 14);
  assert.equal(ja.emphasis.max, 8);
  assert.equal(ja.marks.maxPhrase, 14);
});

test("a character ceiling counts what the reader sees, not the markup", () => {
  // The gloss ceiling once counted the raw string. For Vietnamese that is
  // nearly right; for Japanese the 文節 spaces and the bonds are markup, and
  // counting them rejected three correct glosses of one B2 pack for being
  // 15, 16 and 17 characters when they are 13, 14 and 14.
  const gloss = "あえて する、思い切って する";
  assert.equal([...gloss].length, 15, "the raw string, markup and all");
  assert.equal(measureLength(gloss, ja), 13, "what the reveal panel shows");
  assert.ok(measureLength(gloss, ja) <= (ja.limits.meaning.maxChars ?? ja.limits.meaning.max));
  // The same holds for a Vietnamese join: the panel shows "quả táo".
  assert.equal(displayText("quả_táo", vi), "quả táo");
});

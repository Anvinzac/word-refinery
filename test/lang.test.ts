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
  markRules,
  measureLength,
  type GlossProfile,
} from "../src/lib/lang.ts";
import { findStrayMarks, stripMarks } from "../src/lib/joiner.ts";

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

test("the marks a language does not use are refused in it", () => {
  // The same mark, read by two languages: Vietnamese needs it to say "these
  // two syllables are one word", Japanese has no space there to suppress.
  assert.deepEqual(findStrayMarks("ba_lô mới | của=tôi", markRules(vi)), []);
  const refused = findStrayMarks("手足を_使って | 高い所まで登る", markRules(ja));
  assert.equal(refused.length, 1);
  assert.ok(/does not use that mark/.test(refused[0]!));
});

test("a phrase edge is sized in the language's own unit", () => {
  // Two Japanese characters is a stranded fragment, not a phrase; two
  // Vietnamese syllables is a phrase.
  assert.deepEqual(findStrayMarks("đi học | về nhà", markRules(vi)), []);
  const thin = findStrayMarks("まだ | 余るくらいの大きさだ", markRules(ja));
  assert.ok(thin.some((problem) => /needs at least 4/.test(problem)));
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

    // The highlight entries are drawn from the sentences they glow in.
    const emphasis = card.emphasisVi as string[];
    assert.ok(Array.isArray(emphasis) && emphasis.length >= 2);
    const sources = [stripMarks(field("defVi")), stripMarks(field("leadVi"))];
    for (const [index, phrase] of emphasis.entries()) {
      assert.ok(
        sources[index]?.includes(phrase),
        `"${phrase}" does not occur in the sentence it is meant to highlight`,
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

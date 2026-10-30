/**
 * Tests for the example-level ceiling (U1).
 *
 * The rule is simple to state and easy to get wrong in both directions. A
 * ceiling that misses a hard word passes a card that will confuse a beginner;
 * one that condemns a correct word sends a reviewer to rewrite a sentence that
 * was fine. The second is worse, because the reviewer cannot tell it is the
 * checker's fault — so most of what is asserted here is the checker NOT firing:
 * on inflected forms a lemma list does not carry, on names, on contractions,
 * on the answer blank.
 *
 * The numbers in the comments come from running this over 2,900 real cards.
 * Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/cefr-words.ts, ../src/lib/intake.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateForms,
  countableTokens,
  describeWordList,
  levelOf,
  parseCefrWords,
  type CefrWordList,
} from "../src/lib/cefr-words.ts";
import { checkPromptRules } from "../src/lib/intake.ts";

/** A word list big enough to answer the questions these tests ask. */
function listOf(entries: Record<string, string>): CefrWordList {
  return {
    levels: new Map(Object.entries(entries) as Array<[string, never]>),
    name: "test list",
  };
}

const LIST = listOf({
  // Enough function words that a test sentence is about the word being tested
  // and not about the scaffolding around it.
  a: "A1", the: "A1", in: "A1", of: "A1", and: "A1", is: "A1", are: "A1",
  be: "A1", do: "A1", does: "A1", not: "A1", can: "A1", will: "A1",
  i: "A1", you: "A1", she: "A1", he: "A1", it: "A1", my: "A1",
  one: "A1", two: "A1", thing: "A1", every: "A1", here: "A1", today: "A1",
  go: "A1", like: "A1", have: "A1", know: "A1", meet: "A1", say: "A1",
  work: "A1", cat: "A1", nice: "A1", child: "A1", win: "A1", ten: "A1",
  music: "A1", good: "A1", face: "A1", run: "A1", down: "A1", hope: "A1",
  big: "A1",
  cheap: "A2", film: "A2", university: "A2", museum: "A2",
  pain: "B1", pounds: "B1",
  project: "B2",
  exterior: "C1",
});

/* --- reading a list ------------------------------------------------------ */

test("a CSV with a headword and a CEFR column is read", () => {
  const list = parseCefrWords(
    "headword,pos,CEFR,notes\na,determiner,A1,\ncheap,adjective,A2,\nexterior,noun,C1,\n",
    "cefrj.csv",
  );
  assert.notEqual(list, null);
  assert.equal(list!.levels.get("cheap"), "A2");
  assert.equal(list!.levels.get("exterior"), "C1");
  assert.equal(describeWordList(list!), "cefrj.csv — 3 words");
});

test("a row carrying slash variants becomes one entry each", () => {
  const list = parseCefrWords("headword,CEFR\na.m./A.M./am/AM,A1\n", "x.csv");
  assert.equal(list!.levels.get("a.m."), "A1");
  assert.equal(list!.levels.get("am"), "A1");
});

test("the lowest level a word is listed at is the one kept", () => {
  // A word appears once per part of speech, and the two lists that exist
  // overlap. The prompts settle it the same way: a learner who has met the word
  // at all has met it.
  const list = parseCefrWords("headword,pos,CEFR\nrun,verb,B1\nrun,noun,A1\n", "x.csv");
  assert.equal(list!.levels.get("run"), "A1");
});

test("the four JSON shapes a levelled list comes in are all read", () => {
  const flat = parseCefrWords('{"cheap":"A2","go":"A1"}', "a.json");
  const rows = parseCefrWords('[{"word":"cheap","level":"A2"}]', "b.json");
  const byLevel = parseCefrWords('{"A2":["cheap"],"A1":["go"]}', "c.json");
  const corpus = parseCefrWords('{"meta":{},"words":[{"word":"cheap","level":"A2"}]}', "d.json");
  for (const list of [flat, rows, byLevel, corpus]) {
    assert.notEqual(list, null);
    assert.equal(list!.levels.get("cheap"), "A2");
  }
});

test("a file that is not a word list is refused rather than half-read", () => {
  assert.equal(parseCefrWords('{"word":"tear","defVi":"Giọt nước."}', "card.json"), null);
  assert.equal(parseCefrWords("word,pos\ntear,noun\n", "nolevel.csv"), null);
  assert.equal(parseCefrWords("", "empty.csv"), null);
});

/* --- reaching the lemma a list actually holds ---------------------------- */

test("an inflected form reaches its lemma", () => {
  // CEFR-J 1.5 has `go` and not `went`, `child` and not `children`. Measured
  // over 500 B2 cards, suffix stripping alone left nine words unresolved and
  // eight were irregular pasts.
  assert.equal(levelOf(LIST, "went"), "A1");
  assert.equal(levelOf(LIST, "children"), "A1");
  assert.equal(levelOf(LIST, "won"), "A1");
  assert.equal(levelOf(LIST, "cheaper"), "A2");
  assert.equal(levelOf(LIST, "cheapest"), "A2");
  assert.equal(levelOf(LIST, "films"), "A2");
  assert.equal(levelOf(LIST, "hoped"), "A1", "hoped -> hope, not hop");
  assert.equal(levelOf(LIST, "running"), "A1", "running -> run");
  assert.equal(levelOf(LIST, "bigger"), "A1", "bigger -> big");
  assert.equal(levelOf(LIST, "tenth"), "A1", "an ordinal reaches its cardinal");
  assert.equal(levelOf(LIST, "better"), "A1", "better -> good");
});

test("a word no form of which is listed has no level", () => {
  assert.equal(levelOf(LIST, "aliens"), undefined);
  assert.equal(candidateForms("went").includes("go"), true);
});

/* --- which words of a sentence the ceiling counts ------------------------ */

const tokens = (sentence: string) => countableTokens(sentence).map((t) => t.token);

test("the answer blank is not counted, with or without an inflection", () => {
  assert.deepEqual(tokens("I _____ the film."), ["i", "the", "film"]);
  assert.deepEqual(tokens("She _____ed it."), ["she", "it"]);
  assert.deepEqual(tokens("Two _____s are here."), ["two", "s", "are", "here"].filter((t) => t !== "s"));
});

test("a contraction counts as its base words", () => {
  assert.deepEqual(tokens("I don't know."), ["i", "do", "not", "know"]);
  assert.deepEqual(tokens("She can't go."), ["she", "can", "not", "go"]);
  assert.deepEqual(tokens("It won't work."), ["it", "will", "not", "work"]);
  assert.deepEqual(tokens("She's here."), ["she", "here"]);
});

test("a word written solid that a lemma list holds as two is split", () => {
  // "cannot" fired seven times on the Japanese deck as "not in the list",
  // which is the checker's spelling preference, not the card's vocabulary.
  assert.deepEqual(tokens("I cannot go."), ["i", "can", "not", "go"]);
  assert.deepEqual(tokens("Everyone is here."), ["every", "one", "is", "here"]);
});

test("a name mid-sentence is dropped; one opening a sentence is flagged instead", () => {
  // U1 exempts names, and no levelled list carries them. Mid-sentence a capital
  // settles it. At the start of a sentence the capital is forced by position
  // and says nothing, so the word is kept and marked for the caller to word
  // carefully.
  assert.deepEqual(tokens("I met Tom in London."), ["i", "met", "in"]);
  const opening = countableTokens("London is big.");
  assert.equal(opening[0]!.token, "london");
  assert.equal(opening[0]!.capitalised, true);
  assert.equal(opening[0]!.opensSentence, true);
  assert.equal(opening[1]!.capitalised, false);
});

test("a digit is not a word, and a quote is not part of one", () => {
  assert.deepEqual(tokens("I have 3 cats."), ["i", "have", "cats"]);
  // A leading quote once turned «"Nice» into «'nice», which is in no list.
  assert.deepEqual(tokens('He said "nice".'), ["he", "said", "nice"]);
});

/* --- the gate --------------------------------------------------------------*/

/** A card that passes everything except whatever the test is about. */
function card(usageEn: string): Record<string, unknown> {
  return {
    word: "music", pos: "noun", ipa: "/ˈmjuː.zɪk/", meaningVi: "âm_nhạc",
    defVi: "Âm thanh có nhịp | mà người ta nghe cho vui.",
    leadVi: "Chiều nào Minh cũng mở loa | nghe suốt một giờ.",
    anticipateVi: "Nghe bằng tai, đoán ra chưa?",
    usageEn,
    usageVi: "Mình thích âm_nhạc.",
    topics: ["daily"], exams: [],
    emphasisVi: ["nhịp", "loa", "tai"],
  };
}

/** The usageEn findings a card draws, as plain messages. */
function ceiling(usageEn: string, level: "A1" | "B2", words?: CefrWordList): string[] {
  return checkPromptRules(card(usageEn), level, words)
    .filter((finding) => finding.field === "usageEn")
    .map((finding) => `${finding.severity}: ${finding.message}`);
}

test("without a list the ceiling is skipped, not guessed", () => {
  // A guessed level would reject correct sentences and pass wrong ones, and a
  // reviewer could not tell which. At B2 the hand-written fallback can decide
  // nothing at all, which is the whole reason a real list is worth having.
  assert.deepEqual(ceiling("I like _____ in the museum.", "A1"), []);
});

test("with a list, a word above the card's own level is a blocker", () => {
  const found = ceiling("I like _____ in the museum.", "A1", LIST);
  assert.equal(found.length, 1, found.join(" / "));
  assert.match(found[0]!, /^blocker: "museum" is a A2 word, above this card's A1 ceiling$/);
});

test("the same sentence passes at a level that allows the word", () => {
  assert.deepEqual(ceiling("I like _____ in the museum.", "B2", LIST), []);
});

test("an unlisted word is an error, because it has no level to be below", () => {
  const found = ceiling("Do you like _____ of aliens?", "B2", LIST);
  assert.equal(found.length, 1, found.join(" / "));
  assert.match(found[0]!, /^blocker: "aliens" is not in test list/);
});

test("an unlisted word opening the sentence with a capital is a warning, not an error", () => {
  const found = ceiling("Hanoi has good _____ today.", "B2", LIST);
  assert.equal(found.length, 1, found.join(" / "));
  assert.match(found[0]!, /^warn: "hanoi" is not in test list, but it opens the sentence/);
});

test("the ceiling reports a word once however often it appears", () => {
  const found = ceiling("The museum and the museum _____ in the museum.", "A1", LIST);
  assert.equal(found.length, 1, found.join(" / "));
});

test("a real list supersedes the words hardcoded from one prompt's examples", () => {
  // v3.7 names nine words as absent from the Oxford 3000/5000 and bans them at
  // every level. Seven are in CEFR-J 1.5 at an ordinary level, so applying both
  // at once asserts two incompatible things — and a Japanese pack, whose rule
  // 9.2 names CEFR-J and never mentions Oxford, was rejected over one of them.
  const sentence = "Our _____ fixed the heater quickly.";
  const withList = listOf({ ...Object.fromEntries(
    ["our", "fixed", "the", "heater", "quickly"].map((w) => [w, "B1"]),
  ) });
  const banned = checkPromptRules(card(sentence), "C1")
    .filter((f) => /not in the Oxford list/.test(f.message));
  assert.equal(banned.length, 1, "with no list, the prompt's own examples still hold");

  const checked = checkPromptRules(card(sentence), "C1", withList)
    .filter((f) => /not in the Oxford list/.test(f.message));
  assert.deepEqual(checked, [], "with a list, the list decides");
});

/**
 * Tests for the corpus importer — the supported route past the 381-word bundle.
 *
 * The parser has to be forgiving, because official word-list downloads change
 * layout between releases and a reviewer should not have to reshape a CSV by
 * hand. What it must NOT be forgiving about is provenance: these lists are
 * CC BY-SA, so an import without attribution is refused, and Oxford data is
 * refused outright because this project has committed in writing never to carry
 * it. Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/corpus-import.ts, ../src/lib/corpus.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  bandForRank,
  buildCorpus,
  levelForBand,
  levelForRank,
  parseImportList,
} from "../src/lib/corpus-import.ts";
import { countByLevel, isBundledCorpus, loadCorpus, setActiveCorpus } from "../src/lib/corpus.ts";
import { CEFR_LEVELS } from "../src/lib/types.ts";

/** Provenance good enough to import with, matching the NGSL preset. */
const NGSL = {
  name: "New General Service List 1.2 (imported)",
  source: "ngsl",
  license: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  attribution: "Browne, C., Culligan, B., & Phillips, J. (2013).",
  url: "https://www.newgeneralservicelist.com",
};

test.afterEach(() => {
  // The active corpus is module state; leaving one installed would leak between tests.
  setActiveCorpus(null);
});

// ── parsing ────────────────────────────────────────────────────────────────

test("a ranked CSV with a header parses into rows", () => {
  const { rows, summary } = parseImportList(
    ["Rank,Word,Frequency", "1,the,22038615", "2,be,12545825", "3,and,10741073"].join("\n"),
  );
  assert.deepEqual(rows, [
    { word: "the", rank: 1 },
    { word: "be", rank: 2 },
    { word: "and", rank: 3 },
  ]);
  assert.equal(summary.rowsSkipped, 1, "the header row is skipped, not imported");
});

test("tab-separated files are detected without being told", () => {
  const { rows } = parseImportList("rank\tword\n1\ttime\n2\tpeople");
  assert.deepEqual(rows, [
    { word: "time", rank: 1 },
    { word: "people", rank: 2 },
  ]);
});

test("a bare word list with no ranks still imports", () => {
  const { rows } = parseImportList("harvest\nwhisper\nladder");
  assert.deepEqual(rows, [
    { word: "harvest", rank: null },
    { word: "whisper", rank: null },
    { word: "ladder", rank: null },
  ]);
});

test("duplicates collapse to their best rank", () => {
  const { rows, summary } = parseImportList("5,time\n1,time\n9,people");
  assert.deepEqual(rows, [
    { word: "time", rank: 1 },
    { word: "people", rank: 9 },
  ]);
  assert.equal(summary.duplicatesDropped, 1);
});

test("comments, blank lines, single letters and junk rows are skipped", () => {
  const { rows, summary } = parseImportList(
    ["# a comment", "", "1,a", "2,of", "999,,,", "3,time"].join("\n"),
  );
  assert.deepEqual(
    rows.map((row) => row.word),
    ["of", "time"],
  );
  assert.ok(summary.rowsSkipped >= 2);
});

test("words are lowercased and surrounding quotes stripped", () => {
  const { rows } = parseImportList('1,"Time"\n2,PEOPLE');
  assert.deepEqual(
    rows.map((row) => row.word),
    ["time", "people"],
  );
});

// ── banding ────────────────────────────────────────────────────────────────

test("bandForRank keeps word-crawler's three coarse tiers", () => {
  assert.equal(bandForRank(1), 1);
  assert.equal(bandForRank(1000), 1);
  assert.equal(bandForRank(1001), 2);
  assert.equal(bandForRank(2000), 2);
  assert.equal(bandForRank(2001), 3);
  assert.equal(bandForRank(null), 3, "an unranked word lands in the last tier");
});

test("levelForRank spreads a ranked list across five bands", () => {
  assert.equal(levelForRank(1), "A1");
  assert.equal(levelForRank(500), "A1");
  assert.equal(levelForRank(501), "A2");
  assert.equal(levelForRank(1000), "A2");
  assert.equal(levelForRank(1001), "B1");
  assert.equal(levelForRank(2000), "B1");
  assert.equal(levelForRank(2001), "B2");
  assert.equal(levelForRank(2800), "B2");
  assert.equal(levelForRank(2801), "C1");
  assert.equal(levelForRank(null), levelForBand(3));
});

// ── provenance ─────────────────────────────────────────────────────────────

test("an import without attribution is refused", () => {
  assert.throws(
    () => buildCorpus("1,time", { ...NGSL, attribution: "" }),
    /attribution/i,
  );
  assert.throws(() => buildCorpus("1,time", { ...NGSL, license: "  " }), /license/i);
});

test("Oxford data is refused however it is declared", () => {
  for (const field of ["name", "attribution", "source", "url"] as const) {
    assert.throws(
      () => buildCorpus("1,time", { ...NGSL, [field]: "Oxford 5000" }),
      /Oxford/,
      `declaring Oxford in ${field} must be refused`,
    );
  }
});

test("an empty or wordless file is refused rather than installed", () => {
  assert.throws(() => buildCorpus("", NGSL), /No usable words/);
  assert.throws(() => buildCorpus("# only a comment", NGSL), /No usable words/);
});

test("the built corpus carries the license and attribution into its meta", () => {
  const { corpus } = buildCorpus("1,time\n2,people", NGSL);
  assert.equal(corpus.meta.license, "CC BY-SA 4.0");
  assert.equal(corpus.meta.derivedFrom, NGSL.attribution);
  const sources = corpus.meta.sources as Array<Record<string, unknown>>;
  assert.equal(sources[0].authors, NGSL.attribution);
  assert.equal(sources[0].license, "CC BY-SA 4.0");
  assert.equal(corpus.meta.wordCount, 2);
});

test("levels come from the rank unless the import forces one", () => {
  const ranked = buildCorpus("1,the\n1500,harvest\n2900,nuance", NGSL).corpus;
  assert.deepEqual(
    ranked.words.map((word) => word.level),
    ["A1", "B1", "C1"],
  );

  const forced = buildCorpus("1,the\n1500,harvest", { ...NGSL, level: "C1" }).corpus;
  assert.deepEqual(
    forced.words.map((word) => word.level),
    ["C1", "C1"],
    "a list of academic vocabulary can be stamped wholesale",
  );
});

test("every imported word keeps the source id, for later provenance", () => {
  const { corpus } = buildCorpus("1,time", { ...NGSL, source: "nawl" });
  assert.equal(corpus.words[0].source, "nawl");
});

// ── installing it ──────────────────────────────────────────────────────────

test("installing a corpus replaces the bundle, and reverting restores it", () => {
  const bundledSize = loadCorpus().words.length;
  assert.ok(isBundledCorpus());

  const { corpus } = buildCorpus("1,alpha\n2,beta\n3,gamma", NGSL);
  setActiveCorpus(corpus);
  assert.equal(isBundledCorpus(), false);
  assert.equal(loadCorpus().words.length, 3);

  setActiveCorpus(null);
  assert.ok(isBundledCorpus());
  assert.equal(loadCorpus().words.length, bundledSize);
});

test("an empty corpus is never installed over the bundle", () => {
  setActiveCorpus({ meta: {} as never, words: [] });
  assert.ok(isBundledCorpus(), "an empty import must not blank the word list");
});

test("countByLevel tallies every band, C2 included", () => {
  // C2 was added to CefrLevel after this tally was first written; a missing key
  // would have produced NaN rather than 0.
  const counts = countByLevel([{ word: "x", pos: "", level: "C2", band: 3, source: "s" }]);
  for (const level of CEFR_LEVELS) {
    assert.equal(typeof counts[level], "number");
    assert.ok(!Number.isNaN(counts[level]), `${level} tallied to NaN`);
  }
  assert.equal(counts.C2, 1);
  assert.equal(counts.A1, 0);
});

test("a realistic NGSL-shaped file imports at full size", () => {
  // 2809 ranked rows, the size of the real list, to prove nothing caps out.
  // The headwords must be purely alphabetic, as real ones are — a cell with a
  // digit in it is not a word, and the parser is right to skip it.
  const name = (index: number): string => {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    return (
      letters[Math.floor(index / 676) % 26] +
      letters[Math.floor(index / 26) % 26] +
      letters[index % 26]
    );
  };
  const lines = ["Rank,Word,Frequency"];
  for (let rank = 1; rank <= 2809; rank += 1) lines.push(`${rank},${name(rank)},${100000 - rank}`);
  const { corpus, summary } = buildCorpus(lines.join("\n"), NGSL);
  assert.equal(summary.wordsKept, 2809);
  const counts = countByLevel(corpus.words);
  assert.equal(counts.A1, 500);
  assert.equal(counts.A2, 500);
  assert.equal(counts.B1, 1000);
  assert.equal(counts.B2, 800);
  assert.equal(counts.C1, 9);
  // The point of the whole exercise: a thousand words is now reachable.
  assert.ok(corpus.words.length > 1000);
});

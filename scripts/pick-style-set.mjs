/**
 * Choose a style set from the bundled deck and write public/style-samples.json.
 *
 * The same draw the app's "Pick 30 for me" button makes, run here so a set can
 * be chosen once and committed: every browser that loads the site then starts
 * on the same thirty cards, instead of each reviewer drawing their own and the
 * guide being distilled from a different sample each time.
 *
 * The draw is stratified across CEFR levels. The deck is lopsided — far more
 * A2 than C2 — so a uniform thirty would come back mostly beginner nouns, and a
 * guide built from those describes a voice that only exists in the easy half.
 *
 * Seeded, so re-running gives the same set. Pass a different seed to re-roll:
 *   node scripts/pick-style-set.mjs 7
 *
 * An existing file's PAIRS are preserved — this only ever changes which cards
 * are chosen, never anybody's rewrites.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SIZE = 30;
const DECK = "public/default-deck.json";
const TARGET = "public/style-samples.json";
const seed = Number(process.argv[2] ?? 1);

/** Small deterministic PRNG, so a seed reproduces a set exactly. */
function makeRandom(from) {
  let state = from || 1;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const words = JSON.parse(readFileSync(DECK, "utf8"));
const existing = existsSync(TARGET) ? JSON.parse(readFileSync(TARGET, "utf8")) : null;
const pairs = (existing?.samples ?? []).filter((row) => row.before !== undefined);
const keep = new Set(pairs.map((row) => row.word));

// A headword that sits in two batches is skipped. The app matches a sample by
// id and then by headword, and the bundler deliberately keeps a word that
// appears twice — so a duplicate would be matched to whichever copy came first
// and could land on a different level than the one drawn. There are plenty of
// unambiguous words, and an ambiguous one is a poor sample anyway.
const seen = new Map();
for (const word of words) seen.set(word.word, (seen.get(word.word) ?? 0) + 1);

const eligible = words.filter(
  (word) =>
    !keep.has(word.word) &&
    seen.get(word.word) === 1 &&
    ["defVi", "leadVi", "anticipateVi"].every((field) => (word[field] ?? "").trim().length > 0),
);

const byLevel = new Map();
for (const word of eligible) {
  const list = byLevel.get(word.level) ?? [];
  list.push(word);
  byLevel.set(word.level, list);
}

const random = makeRandom(seed);
for (const list of byLevel.values()) {
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [list[index], list[swap]] = [list[swap], list[index]];
  }
}

const levels = [...byLevel.keys()].sort();
const picked = [];
for (let round = 0; picked.length < SIZE - pairs.length; round += 1) {
  let tookAny = false;
  for (const level of levels) {
    const list = byLevel.get(level);
    if (round >= list.length) continue;
    picked.push(list[round]);
    tookAny = true;
    if (picked.length === SIZE - pairs.length) break;
  }
  if (!tookAny) break;
}

const samples = [
  ...pairs,
  ...picked.map((word) => ({
    id: word.id ?? word.word,
    word: word.word,
    batchId: word.batchId,
    level: word.level,
  })),
].sort((left, right) => left.word.localeCompare(right.word));

writeFileSync(
  TARGET,
  `${JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), guide: existing?.guide ?? "", samples }, null, 2)}\n`,
);

const spread = {};
for (const row of samples) spread[row.level] = (spread[row.level] ?? 0) + 1;
console.log(`${samples.length} cards (${pairs.length} already rewritten) → ${TARGET}`);
console.log("by level:", spread);
console.log(samples.map((row) => `${row.word} (${row.level})`).join(", "));

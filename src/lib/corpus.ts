/**
 * Corpus loading and selection.
 *
 * The NGSL/NAWL starter subset is bundled into the app at build time, so the
 * word list works offline on GitHub Pages with no network dependency. Selection
 * is deterministic: words are frequency-ordered as shipped, then filtered by
 * CEFR level and by what the deck already contains.
 *
 * Exports: loadCorpus, filterCorpus, chunk, countByLevel
 * Depends on: ../../data/ngsl-starter-subset.json, ./types.ts
 */
import raw from "../../data/ngsl-starter-subset.json";
import type { CefrLevel, Corpus, CorpusWord } from "./types.ts";
import { CEFR_LEVELS } from "./types.ts";

/** The bundled corpus, validated once at module load. */
let cached: Corpus | null = null;

/**
 * Read the bundled corpus.
 * @throws when the bundled file does not have the expected shape
 */
export function loadCorpus(): Corpus {
  if (cached !== null) return cached;
  const document = raw as unknown as { meta?: Record<string, unknown>; words?: unknown };
  if (!Array.isArray(document.words)) {
    throw new Error("Bundled corpus has no words array");
  }
  const words = (document.words as CorpusWord[]).filter(
    (entry) => typeof entry?.word === "string" && entry.word.length > 0,
  );
  if (words.length === 0) throw new Error("Bundled corpus is empty");
  cached = {
    meta: (document.meta ?? {}) as Corpus["meta"],
    words,
  };
  return cached;
}

/** How many corpus words sit in each CEFR band. */
export function countByLevel(words: readonly CorpusWord[]): Record<CefrLevel, number> {
  const counts = { A1: 0, A2: 0, B1: 0, B2: 0, C1: 0 } as Record<CefrLevel, number>;
  for (const entry of words) {
    if (CEFR_LEVELS.includes(entry.level)) counts[entry.level] += 1;
  }
  return counts;
}

/**
 * Pick the next words to annotate.
 *
 * @param options.levels - CEFR bands to include; empty means every band
 * @param options.exclude - headwords already present in the deck (lowercased)
 * @param options.limit - how many words to return
 * @param options.shuffle - take a deterministic-but-varied slice instead of the head
 * @returns corpus words in corpus order
 */
export function filterCorpus(options: {
  levels: readonly CefrLevel[];
  exclude: ReadonlySet<string>;
  limit: number;
  shuffle?: boolean;
}): CorpusWord[] {
  const corpus = loadCorpus();
  const wanted = options.levels.length > 0 ? new Set(options.levels) : null;

  const candidates = corpus.words.filter((entry) => {
    if (wanted !== null && !wanted.has(entry.level)) return false;
    return !options.exclude.has(entry.word.toLowerCase());
  });

  const pool = options.shuffle ? shuffleDeterministic(candidates) : candidates;
  return pool.slice(0, Math.max(0, options.limit));
}

/**
 * Fisher-Yates shuffle seeded from the current minute, so repeated clicks in
 * the same run give different batches without needing a stored seed.
 */
function shuffleDeterministic<T>(input: readonly T[]): T[] {
  const array = [...input];
  let seed = Math.floor(Date.now() / 60_000) || 1;
  const random = () => {
    // xorshift32 — small, dependency-free, good enough for batch variety.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 0xffffffff;
  };
  for (let index = array.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const held = array[index];
    array[index] = array[swap];
    array[swap] = held;
  }
  return array;
}

/**
 * Split a word list into batches small enough for one LLM call.
 * @param words - words to annotate
 * @param size - maximum words per batch
 */
export function chunk<T>(words: readonly T[], size: number): T[][] {
  const batchSize = Math.max(1, Math.floor(size));
  const batches: T[][] = [];
  for (let start = 0; start < words.length; start += batchSize) {
    batches.push(words.slice(start, start + batchSize));
  }
  return batches;
}

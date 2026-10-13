/**
 * Corpus loading and selection.
 *
 * The NGSL/NAWL starter subset is bundled into the app at build time, so the
 * word list works offline on GitHub Pages with no network dependency. It is
 * only 381 words, so an operator who needs more imports an official list (see
 * ./corpus-import.ts); once installed, that corpus replaces the bundle
 * everywhere. Selection is deterministic: words are frequency-ordered as
 * shipped, then filtered by CEFR level and by what the deck already contains.
 *
 * `loadCorpus` stays synchronous because the generator, the panel and the
 * document rebuild all call it during render. The stored corpus is therefore
 * installed once at startup through `setActiveCorpus`, not awaited per call.
 *
 * Exports: loadCorpus, loadBundledCorpus, setActiveCorpus, isBundledCorpus,
 *          filterCorpus, chunk, countByLevel
 * Depends on: ../../data/ngsl-starter-subset.json, ./types.ts
 */
// The import attribute is required by Node's ESM loader (the test runner) and
// understood by the bundler, so one spelling serves both.
import raw from "../../data/ngsl-starter-subset.json" with { type: "json" };
import type { CefrLevel, Corpus, CorpusWord } from "./types.ts";
import { CEFR_LEVELS } from "./types.ts";

/** The bundled corpus, parsed once on first use. */
let bundled: Corpus | null = null;

/** An imported corpus, when one has been installed for this browser. */
let active: Corpus | null = null;

/**
 * Read the corpus shipped inside the app.
 * @throws when the bundled file does not have the expected shape
 */
export function loadBundledCorpus(): Corpus {
  if (bundled !== null) return bundled;
  const document = raw as unknown as { meta?: Record<string, unknown>; words?: unknown };
  if (!Array.isArray(document.words)) {
    throw new Error("Bundled corpus has no words array");
  }
  const words = (document.words as CorpusWord[]).filter(
    (entry) => typeof entry?.word === "string" && entry.word.length > 0,
  );
  if (words.length === 0) throw new Error("Bundled corpus is empty");
  bundled = { meta: (document.meta ?? {}) as Corpus["meta"], words };
  return bundled;
}

/**
 * Install an imported corpus, or pass null to fall back to the bundle.
 * Called once at startup from the stored copy, and again on each import.
 *
 * @param corpus - the corpus to make active, or null to revert
 */
export function setActiveCorpus(corpus: Corpus | null): void {
  active = corpus !== null && corpus.words.length > 0 ? corpus : null;
}

/** Whether the app is currently running on the bundled subset. */
export function isBundledCorpus(): boolean {
  return active === null;
}

/**
 * Read the corpus in force: the imported one when installed, else the bundle.
 */
export function loadCorpus(): Corpus {
  return active ?? loadBundledCorpus();
}

/** How many corpus words sit in each CEFR band. */
export function countByLevel(words: readonly CorpusWord[]): Record<CefrLevel, number> {
  // Built from CEFR_LEVELS rather than written out, so adding a band cannot
  // leave a hole here that tallies into `undefined + 1`.
  const counts = Object.fromEntries(CEFR_LEVELS.map((level) => [level, 0])) as Record<
    CefrLevel,
    number
  >;
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

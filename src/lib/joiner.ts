/**
 * The word joiner: how deck text says "these syllables are ONE word".
 *
 * Vietnamese is written syllable by syllable, so `ba lô` (a backpack) looks
 * exactly like two unrelated words and a card may break the line between them.
 * Deck text therefore joins the syllables of one word with an underscore —
 * `ba_lô`, `quan_trọng` — the convention Vietnamese segmenters already use.
 * KineMedia turns each join into a NO-BREAK SPACE (or a WORD JOINER between two
 * Han glyphs) when the catalog loads, so the underscore never reaches a reader.
 *
 * This module is the refinery's half of that contract, and it mirrors
 * KineMedia's `word-joiner.ts` deliberately: the same `AUTHORED_JOIN` pattern,
 * and the same definition of a "unit". That second one matters most — every
 * "N words" rule for a card field counts syllables AFTER joins are removed, so
 * joining two syllables must never make a field look shorter than it is.
 *
 * A run of underscores is the answer blank (`_____`) and is never a join: its
 * neighbours are underscores, not letters.
 *
 * Exports: WORD_JOIN, stripWordJoins, countUnits, findStrayJoins, hasWordJoin
 * Depends on: none
 */

/** What a generator or a reviewer writes between two syllables of one word. */
export const WORD_JOIN = "_";

/**
 * One underscore with a letter, digit or combining mark before it and a letter
 * or digit after. Copied from KineMedia's encoder so both sides agree exactly
 * on what counts as a join.
 */
const AUTHORED_JOIN = /([\p{L}\p{N}\p{M}])_(?=[\p{L}\p{N}])/gu;

/** True when the text carries at least one real join. */
export function hasWordJoin(text: string): boolean {
  if (!text.includes(WORD_JOIN)) return false;
  AUTHORED_JOIN.lastIndex = 0;
  return AUTHORED_JOIN.test(text);
}

/**
 * Replace every join with a plain space, leaving ordinary text.
 *
 * @param text - deck text, with or without joins
 * @returns the same text with joined syllables separated by spaces
 */
export function stripWordJoins(text: string): string {
  if (!text.includes(WORD_JOIN)) return text;
  return text.replace(AUTHORED_JOIN, "$1 ");
}

/**
 * Count the units a length rule is written in: syllables, joins removed.
 *
 * Equivalent to KineMedia's `countJoinedUnits`. `quan_trọng` is two units, not
 * one, so joining syllables can never be used to slip past a word count.
 *
 * @param text - deck text, with or without joins
 */
export function countUnits(text: string): number {
  return stripWordJoins(text).trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Underscores that are not joins and not the answer blank.
 *
 * Any single underscore between two letters is read downstream as a join, so a
 * stray one is a silent defect: it either glues two words that should wrap
 * apart, or survives to the reader as a literal underscore. Catching them here
 * is cheaper than noticing a broken card later.
 *
 * @param text - deck text to inspect
 * @returns one message per stray underscore run, empty when the text is clean
 */
export function findStrayJoins(text: string): string[] {
  if (!text.includes(WORD_JOIN)) return [];
  const problems: string[] = [];
  // Every run of underscores, with the character on each side.
  for (const match of text.matchAll(/(.?)(_+)(.?)/gsu)) {
    const [, before, run, after] = match;
    // The answer blank: a run of two or more, which is never a join.
    if (run.length > 1) continue;
    const letter = /[\p{L}\p{N}\p{M}]/u;
    if (letter.test(before) && letter.test(after)) continue; // a real join
    const context = `${before}${run}${after}`.trim();
    problems.push(
      `stray "_" in "${context}" — a join needs a letter on both sides, and nothing else may use an underscore`,
    );
  }
  return problems;
}

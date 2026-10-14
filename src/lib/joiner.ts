/**
 * The three marks deck text uses to say how a sentence may be broken.
 *
 * Vietnamese is written one syllable at a time, so nothing in the text itself
 * says where a word ends, where a phrase ends, or which syllables lean on their
 * neighbour. A line break put in the wrong place turns "ba lô" into two
 * unrelated words, or strands a classifier at the end of a line with its noun
 * on the next. The marks name the levels of the prosodic hierarchy that matter
 * at the width of a phone screen:
 *
 *   `_`  WORD JOIN     one lexical word          học_sinh, quan_trọng
 *   `=`  CLITIC BIND   leans on its neighbour    con=mèo, đã=đi, của=tôi
 *   `|`  PHRASE BREAK  edge of a phrase          cây trái | sau một mùa dài
 *
 * `_` and `=` both forbid a break; they differ in what else they permit. A `_`
 * says the two syllables ARE one word, so a highlight may cover them as a unit.
 * A `=` says only that they must stay together on the line — a classifier and
 * its noun are two words, and highlighting them as one would be wrong. The
 * symbols follow existing convention: `=` is the Leipzig glossing rules' clitic
 * boundary, `|` the usual prosodic phrase boundary.
 *
 * `|` is the one mark that is a boundary rather than a bond. It marks where a
 * break is WELCOME, and by implication where a break is bad: a line or page may
 * not take only one syllable across a phrase edge in either direction.
 *
 * None of the three reaches a reader, and none of them changes a word count:
 * every "N words" rule counts syllables as if the marks were spaces.
 *
 * Exports: WORD_JOIN, CLITIC_BIND, PHRASE_BREAK, MARKS, stripMarks,
 *          stripWordJoins, countUnits, findStrayMarks, splitPhrases,
 *          hasWordJoin, MIN_PHRASE_EDGE_UNITS
 * Depends on: none
 */

/** Between the syllables of ONE lexical word. Highlightable as a unit. */
export const WORD_JOIN = "_";
/** Between a clitic and its host. Unbreakable, but never highlighted across. */
export const CLITIC_BIND = "=";
/** Between two phrases. The preferred break point. */
export const PHRASE_BREAK = "|";

/** Every mark, for a message that needs to list them. */
export const MARKS = [WORD_JOIN, CLITIC_BIND, PHRASE_BREAK] as const;

/**
 * Fewest syllables a phrase may have on either side of a break.
 *
 * One syllable alone is the failure this exists to prevent — stranded at the
 * end of a line, or dragged up from the next phrase to fill a gap. Two is the
 * smallest number that still reads as a fragment of language.
 */
export const MIN_PHRASE_EDGE_UNITS = 2;

/** One bond with a letter, digit or combining mark before and a letter after. */
const BOND = /([\p{L}\p{N}\p{M}])[_=](?=[\p{L}\p{N}])/gu;

/** A phrase break, with whatever space the author put around it. */
const PHRASE = /\s*\|\s*/gu;

/** True when the text carries at least one word join. */
export function hasWordJoin(text: string): boolean {
  if (!text.includes(WORD_JOIN)) return false;
  return /([\p{L}\p{N}\p{M}])_(?=[\p{L}\p{N}])/u.test(text);
}

/**
 * Replace every mark with the plain text a reader would see.
 *
 * Bonds become spaces and phrase breaks disappear, so the result is ordinary
 * Vietnamese: the form a length rule counts and an emphasis phrase is stored in.
 *
 * @param text - deck text, with or without marks
 */
export function stripMarks(text: string): string {
  if (!/[_=|]/.test(text)) return text;
  return text.replace(BOND, "$1 ").replace(PHRASE, " ").replace(/\s{2,}/gu, " ").trim();
}

/**
 * Replace word joins and clitic binds with spaces, leaving phrase breaks alone.
 * Kept for callers that care about bonds only.
 */
export function stripWordJoins(text: string): string {
  if (!/[_=]/.test(text)) return text;
  return text.replace(BOND, "$1 ");
}

/**
 * Count the units a length rule is written in: syllables, every mark removed.
 *
 * Matches KineMedia's `countJoinedUnits`, so marking a sentence up can never
 * make it look shorter than it reads.
 *
 * @param text - deck text, with or without marks
 */
export function countUnits(text: string): number {
  return stripMarks(text).split(/\s+/).filter(Boolean).length;
}

/**
 * The phrases of one text, in order, each as plain syllables.
 *
 * @param text - deck text
 * @returns one entry per phrase; a text with no phrase break is one phrase
 */
export function splitPhrases(text: string): string[] {
  return text
    .split(PHRASE_BREAK)
    .map((part) => stripMarks(part))
    .filter((part) => part.length > 0);
}

/**
 * Marks that are malformed, and phrases too short to survive a break.
 *
 * Two kinds of defect. A bond needs a letter on both sides, so a stray `_` or
 * `=` either glues the wrong things or survives to the reader. And a phrase of
 * a single syllable cannot honour the rule it exists to express: there is no
 * way to break beside it without stranding that syllable alone.
 *
 * @param text - deck text to inspect
 * @returns one message per problem, empty when the text is clean
 */
export function findStrayMarks(text: string): string[] {
  const problems: string[] = [];
  if (!/[_=|]/.test(text)) return problems;

  const letter = /[\p{L}\p{N}\p{M}]/u;
  for (const match of text.matchAll(/(.?)([_=]+)(.?)/gsu)) {
    const [, before, run, after] = match;
    // A run of underscores is the answer blank, never a bond.
    if (run.length > 1 && run[0] === WORD_JOIN) continue;
    if (run.length === 1 && letter.test(before) && letter.test(after)) continue;
    problems.push(
      `stray "${run}" in "${`${before}${run}${after}`.trim()}" — a bond needs a letter on both sides`,
    );
  }

  if (text.includes(PHRASE_BREAK)) {
    const phrases = splitPhrases(text);
    for (const phrase of phrases) {
      const units = phrase.split(/\s+/).filter(Boolean).length;
      if (units < MIN_PHRASE_EDGE_UNITS) {
        problems.push(
          `phrase "${phrase}" is ${units} syllable(s); a phrase needs at least ${MIN_PHRASE_EDGE_UNITS} so a break beside it cannot strand one`,
        );
      }
    }
    if (phrases.length < 2) {
      problems.push(`"|" marks a boundary between phrases, but this text has only one phrase`);
    }
  }

  return problems;
}

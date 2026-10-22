/**
 * The house voice: learning how the reviewer writes, and showing it back.
 *
 * A general model writes competent, anonymous Vietnamese. The deck has one
 * writer, and what makes it theirs is not in any rule the prompts state — it is
 * in which word they reach for, how long they let a sentence run, and what they
 * delete. This module turns a handful of hand-edited cards into something the
 * prompts can carry.
 *
 * Two things are kept apart on purpose. A PAIR (what the model wrote, what the
 * reviewer changed it to) is the teaching signal, because the difference
 * between them is voice with the content held constant; pairs feed the
 * distillation that writes the style guide. An EXEMPLAR is just the finished
 * text, and that is what a generation request carries — at write time the
 * before-version is noise.
 *
 * Exports: StylePair, stylePairs, styleExemplars, styleExemplarCards,
 *          renderPairs, renderExemplars, renderExemplarCards, MAX_EXEMPLARS,
 *          pickStyleSet, styleSetProgress, STYLE_SET_SIZE
 * Depends on: ./prompt.ts, ./types.ts
 */
import type { RefineField } from "./prompt.ts";
import type { DeckWord, ReviewEntry } from "./types.ts";

/** How many exemplars a request carries before they start crowding the rules. */
export const MAX_EXEMPLARS = 8;

/** One before/after, for distillation. */
export interface StylePair {
  word: string;
  field: RefineField;
  level: string;
  topics: string[];
  before: string;
  after: string;
}

/** Read one field off a word, usage included. */
function textOf(word: DeckWord, field: RefineField): string {
  return field === "usageVi" ? (word.usage[0]?.vi ?? "") : (word[field] ?? "");
}

/** The entries the reviewer marked as examples of the house voice. */
function marked(entries: readonly ReviewEntry[]): ReviewEntry[] {
  return entries.filter((entry) => entry.styleSample === true);
}

/** Fields worth learning a voice from. `meaningVi` is a gloss, not a sentence. */
const VOICE_FIELDS: readonly RefineField[] = ["defVi", "leadVi", "anticipateVi"];

/**
 * Every before/after the marked cards yield.
 *
 * A field the reviewer did not touch produces no pair — it teaches nothing
 * about what they would change, and including it would dilute the evidence.
 *
 * @param entries - the whole review set
 */
export function stylePairs(entries: readonly ReviewEntry[]): StylePair[] {
  const pairs: StylePair[] = [];
  for (const entry of marked(entries)) {
    if (entry.original === undefined) continue;
    // The model wrote this card last, so its "after" is generated text. Such a
    // pair runs backwards and would teach the generator's voice as the
    // reviewer's; it comes back as soon as a human rewrites the card.
    if (entry.machineEdited === true) continue;
    for (const field of VOICE_FIELDS) {
      const before = textOf(entry.original, field).trim();
      const after = textOf(entry.deckWord, field).trim();
      if (before.length === 0 || after.length === 0 || before === after) continue;
      pairs.push({
        word: entry.deckWord.word,
        field,
        level: entry.deckWord.level,
        topics: entry.deckWord.topics,
        before,
        after,
      });
    }
  }
  return pairs;
}

/**
 * Exemplars for one field, nearest first.
 *
 * Ranked by how much they share with the word being written: same topic first,
 * then nearest level. A style example drawn from the same corner of the deck
 * carries more than a distant one, and the tail is cut rather than padded.
 *
 * @param entries - the whole review set
 * @param field - the field being written
 * @param context - the word being written, for proximity
 * @param limit - how many to return
 */
export function styleExemplars(
  entries: readonly ReviewEntry[],
  field: RefineField,
  context: { level?: string; topics?: readonly string[] } = {},
  limit = MAX_EXEMPLARS,
): Array<{ word: string; level: string; text: string }> {
  const order = ["A1", "A2", "B1", "B2", "C1", "C2"];
  const here = order.indexOf(context.level ?? "");
  const wanted = new Set(context.topics ?? []);

  return marked(entries)
    .map((entry) => ({
      word: entry.deckWord.word,
      level: entry.deckWord.level,
      text: textOf(entry.deckWord, field).trim(),
      topics: entry.deckWord.topics,
    }))
    .filter((row) => row.text.length > 0)
    .map((row) => ({
      ...row,
      // Shared topic dominates; level distance breaks the tie.
      rank:
        (row.topics.some((topic) => wanted.has(topic)) ? 0 : 10) +
        (here === -1 ? 0 : Math.abs(order.indexOf(row.level) - here)),
    }))
    .sort((left, right) => left.rank - right.rank || left.word.localeCompare(right.word))
    .slice(0, Math.max(0, limit))
    .map(({ word, level, text }) => ({ word, level, text }));
}

/**
 * Whole cards as exemplars, for a batch request.
 *
 * A batch writes every field at once, so showing complete cards says more than
 * a column of definitions: it shows how the fields sound BESIDE each other,
 * which is where the register differences live.
 *
 * @param entries - the whole review set
 * @param limit - how many cards to return
 */
export function styleExemplarCards(
  entries: readonly ReviewEntry[],
  limit = 4,
): DeckWord[] {
  // Spread across levels rather than taking the first few, so a batch is not
  // anchored on whichever corner of the deck happened to be edited first.
  const byLevel = new Map<string, DeckWord[]>();
  for (const entry of marked(entries)) {
    const list = byLevel.get(entry.deckWord.level) ?? [];
    list.push(entry.deckWord);
    byLevel.set(entry.deckWord.level, list);
  }
  const levels = [...byLevel.keys()].sort();
  const picked: DeckWord[] = [];
  for (let round = 0; picked.length < limit && round < 20; round += 1) {
    let addedThisRound = false;
    for (const level of levels) {
      const list = byLevel.get(level)!;
      if (round >= list.length) continue;
      picked.push(list[round]!);
      addedThisRound = true;
      if (picked.length === limit) break;
    }
    if (!addedThisRound) break;
  }
  return picked;
}

/** Render the pairs for the distillation prompt. */
export function renderPairs(pairs: readonly StylePair[]): string {
  return pairs
    .map(
      (pair) =>
        `── ${pair.word} · ${pair.field} · ${pair.level} · ${pair.topics.join(", ")}\n` +
        `BEFORE: ${pair.before}\n` +
        `AFTER:  ${pair.after}`,
    )
    .join("\n\n");
}

/** Render single-field exemplars for a rewrite request. */
export function renderExemplars(
  rows: ReadonlyArray<{ word: string; level: string; text: string }>,
): string {
  return rows.map((row) => `- ${row.word} (${row.level}): ${row.text}`).join("\n");
}

/** Render whole-card exemplars for a batch request. */
export function renderExemplarCards(cards: readonly DeckWord[]): string {
  return cards
    .map((card) =>
      [
        `── ${card.word} (${card.level})`,
        `   meaningVi: ${card.meaningVi}`,
        `   defVi: ${card.defVi}`,
        `   leadVi: ${card.leadVi}`,
        `   anticipateVi: ${card.anticipateVi}`,
      ].join("\n"),
    )
    .join("\n\n");
}

/** How many cards a style set holds before it teaches more than it costs. */
export const STYLE_SET_SIZE = 30;

/**
 * Choose a style set: a spread of cards for the reviewer to rewrite by hand.
 *
 * Stratified rather than uniformly random, which matters more than it sounds.
 * The deck is not evenly distributed — there are twice as many A2 cards as C2 —
 * so a uniform draw of thirty would hand back mostly beginner nouns, and a
 * style guide distilled from those would confidently describe a voice that
 * only exists in the easy half of the deck. An abstract C2 word is where a
 * writer's voice shows most and where a guide built on apples helps least, so
 * every level contributes before any level contributes twice.
 *
 * Cards already in the set are kept: the draw tops up rather than replaces, so
 * work already done is never thrown away by pressing the button again.
 *
 * @param entries - the whole review set
 * @param size - how many cards the set should end up holding
 * @param random - injectable for tests; defaults to Math.random
 * @returns ids to mark, excluding those already marked
 */
export function pickStyleSet(
  entries: readonly ReviewEntry[],
  size = STYLE_SET_SIZE,
  random: () => number = Math.random,
): string[] {
  const alreadyMarked = entries.filter((entry) => entry.styleSample === true).length;
  const wanted = size - alreadyMarked;
  if (wanted <= 0) return [];

  // Only cards with something to rewrite in every voice-bearing field: a card
  // with an empty teaser teaches nothing about how the reviewer writes teasers.
  const eligible = entries.filter(
    (entry) =>
      entry.styleSample !== true &&
      VOICE_FIELDS.every((field) => textOf(entry.deckWord, field).trim().length > 0),
  );

  const byLevel = new Map<string, ReviewEntry[]>();
  for (const entry of eligible) {
    const list = byLevel.get(entry.deckWord.level) ?? [];
    list.push(entry);
    byLevel.set(entry.deckWord.level, list);
  }
  // Shuffle within each level, so the spread is across levels and the choice
  // inside a level is free.
  for (const list of byLevel.values()) {
    for (let index = list.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [list[index], list[swap]] = [list[swap]!, list[index]!];
    }
  }

  const levels = [...byLevel.keys()].sort();
  const picked: string[] = [];
  for (let round = 0; picked.length < wanted; round += 1) {
    let tookAny = false;
    for (const level of levels) {
      const list = byLevel.get(level)!;
      if (round >= list.length) continue;
      picked.push(list[round]!.id);
      tookAny = true;
      if (picked.length === wanted) break;
    }
    if (!tookAny) break;
  }
  return picked;
}

/** How far through the set the reviewer is: a card only teaches once edited. */
export function styleSetProgress(entries: readonly ReviewEntry[]): {
  marked: number;
  edited: number;
  pairs: number;
} {
  const samples = marked(entries);
  return {
    marked: samples.length,
    edited: samples.filter((entry) => entry.original !== undefined).length,
    pairs: stylePairs(entries).length,
  };
}

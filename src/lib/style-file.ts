/**
 * The style set as a file the repository can hold.
 *
 * Everything the reviewer does lives in one browser's IndexedDB, which is fine
 * for a deck that is regenerated anyway and wrong for the style set: those
 * thirty rewrites are hours of judgement, and the pairs they produce are the
 * only record of WHY the text reads the way it does. Clearing site data would
 * take them.
 *
 * The deck's own bundle cannot carry them. `bundle-batches` writes words, and a
 * pair is not a property of a word — it is editorial provenance, a note about
 * how this sentence came to be. So it gets a file of its own, which also makes
 * it diffable: a reviewer can see in a pull request exactly which sentences the
 * voice changed and how.
 *
 * The guide travels with the pairs on purpose. A guide without the evidence it
 * was distilled from cannot be checked, and pairs without the guide have to be
 * re-distilled to be useful.
 *
 * Exports: StyleFile, StyleSample, STYLE_FILE_NAME, buildStyleFile,
 *          parseStyleFile, applyStyleFile
 * Depends on: ./prompt.ts, ./types.ts
 */
import type { MarkupField } from "./prompt.ts";
import type { DeckWord, ReviewEntry } from "./types.ts";

/** What the app downloads and the repository holds. */
export const STYLE_FILE_NAME = "style-samples.json";

/** The Vietnamese a pair records. Keyed by field so a new field cannot break an old file. */
export type StyleText = Partial<Record<MarkupField, string>>;

/** One card's before and after. */
export interface StyleSample {
  /** Deck id, matched first. */
  id: string;
  /** Headword, matched when ids have shifted under a re-bundle. */
  word: string;
  batchId: string;
  level: string;
  /**
   * The text before and after the rewrite. Both absent on a row that only
   * CHOOSES a card: a committed set names its thirty before anyone has touched
   * them, and inventing an empty "before" would fake a pair that never existed.
   */
  before?: StyleText;
  after?: StyleText;
}

/** The file itself. */
export interface StyleFile {
  version: 1;
  exportedAt: string;
  /** The distilled style guide, or "" when none has been written yet. */
  guide: string;
  samples: StyleSample[];
}

/** Fields a pair records. `usageVi` lives inside `usage`, so it is read apart. */
const FIELDS: readonly MarkupField[] = ["meaningVi", "defVi", "leadVi", "anticipateVi", "usageVi"];

/** Read one field off a word. */
function textOf(word: DeckWord, field: MarkupField): string {
  return field === "usageVi" ? (word.usage[0]?.vi ?? "") : (word[field] ?? "");
}

/** The non-empty fields of one word. */
function textsOf(word: DeckWord): StyleText {
  const texts: StyleText = {};
  for (const field of FIELDS) {
    const value = textOf(word, field);
    if (value.trim().length > 0) texts[field] = value;
  }
  return texts;
}

/**
 * Gather the marked cards into a file.
 *
 * Only cards with a pre-edit snapshot are included: a marked card nobody
 * rewrote carries no pair, and writing it out would put a row in the file that
 * teaches nothing and reads like an oversight.
 *
 * @param entries - the whole review set
 * @param guide - the distilled style guide, or "" for none
 */
export function buildStyleFile(entries: readonly ReviewEntry[], guide: string): StyleFile {
  const samples: StyleSample[] = [];
  for (const entry of entries) {
    if (entry.styleSample !== true) continue;
    // A card chosen but not yet rewritten is still worth writing down — it is
    // the set, and the next person to open the deck should get the same thirty.
    // It carries no pair, and says so by having neither side.
    samples.push(
      entry.original === undefined
        ? {
            id: entry.id,
            word: entry.deckWord.word,
            batchId: entry.deckWord.batchId,
            level: entry.deckWord.level,
          }
        : {
            id: entry.id,
            word: entry.deckWord.word,
            batchId: entry.deckWord.batchId,
            level: entry.deckWord.level,
            before: textsOf(entry.original),
            after: textsOf(entry.deckWord),
          },
    );
  }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    guide,
    samples: samples.sort((left, right) => left.word.localeCompare(right.word)),
  };
}

/**
 * Read a style file, or null when the text is not one.
 *
 * @param text - raw file contents
 */
export function parseStyleFile(text: string): StyleFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<StyleFile>;
  if (!Array.isArray(candidate.samples)) return null;

  const samples: StyleSample[] = [];
  for (const raw of candidate.samples) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Partial<StyleSample>;
    if (typeof row.word !== "string" || row.word.length === 0) continue;
    const paired = typeof row.before === "object" && row.before !== null &&
      typeof row.after === "object" && row.after !== null;
    samples.push({
      id: typeof row.id === "string" ? row.id : row.word,
      word: row.word,
      batchId: typeof row.batchId === "string" ? row.batchId : "",
      level: typeof row.level === "string" ? row.level : "",
      ...(paired ? { before: row.before as StyleText, after: row.after as StyleText } : {}),
    });
  }
  return {
    version: 1,
    exportedAt: typeof candidate.exportedAt === "string" ? candidate.exportedAt : "",
    guide: typeof candidate.guide === "string" ? candidate.guide : "",
    samples,
  };
}

/** Put one field's text back onto a word. */
function withText(word: DeckWord, texts: StyleText): DeckWord {
  const next: DeckWord = { ...word };
  for (const field of FIELDS) {
    const value = texts[field];
    if (value === undefined) continue;
    if (field === "usageVi") {
      next.usage = next.usage.map((item, index) => (index === 0 ? { ...item, vi: value } : item));
    } else {
      (next as unknown as Record<string, string>)[field] = value;
    }
  }
  return next;
}

/**
 * Restore a style set onto a deck.
 *
 * The AFTER text is written back as well as the pair, because the rewrites ARE
 * the deck's text once they have been committed — a reviewer who pulls the repo
 * should see the sentences they wrote, not the generated ones with a pair
 * hanging off them. A card that cannot be matched is skipped rather than
 * invented: ids shift when batches are re-bundled, so the word is tried next,
 * and a sample with no home is reported instead of silently dropped.
 *
 * @param entries - the deck as loaded
 * @param file - a parsed style file
 * @returns the updated entries, and the words that found no card
 */
export function applyStyleFile(
  entries: readonly ReviewEntry[],
  file: StyleFile,
): { entries: ReviewEntry[]; unmatched: string[] } {
  const byId = new Map(entries.map((entry) => [entry.id, entry.id]));
  const byWord = new Map<string, string>();
  for (const entry of entries) {
    if (!byWord.has(entry.deckWord.word)) byWord.set(entry.deckWord.word, entry.id);
  }

  const patches = new Map<string, StyleSample>();
  const unmatched: string[] = [];
  for (const sample of file.samples) {
    const target = byId.has(sample.id) ? sample.id : byWord.get(sample.word);
    if (target === undefined) {
      unmatched.push(sample.word);
      continue;
    }
    patches.set(target, sample);
  }

  // A row that only chooses a card seeds an EMPTY workspace and never fights a
  // reviewer who has their own set: the committed thirty are a starting point,
  // not an instruction. Rows carrying a pair are real editorial work and always
  // apply.
  const alreadyChosen = entries.some((entry) => entry.styleSample === true);

  return {
    entries: entries.map((entry) => {
      const sample = patches.get(entry.id);
      if (sample === undefined) return entry;
      if (sample.before === undefined || sample.after === undefined) {
        if (alreadyChosen) return entry;
        return { ...entry, styleSample: true };
      }
      return {
        ...entry,
        deckWord: withText(entry.deckWord, sample.after),
        original: withText(entry.deckWord, sample.before),
        styleSample: true,
        status: "edited" as const,
      };
    }),
    unmatched,
  };
}

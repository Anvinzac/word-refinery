/**
 * Generation pipeline — corpus selection, annotation, and deck assembly.
 *
 * One run: pick the next unannotated corpus words, send them through the LLM in
 * batches, convert each validated annotation into a deck word with inline
 * emphasis markers, and return review entries the UI can approve, edit or
 * reject. Errors on a batch degrade to issues rather than aborting the run.
 *
 * Exports: runGeneration, RunOptions, RunResult, buildReviewEntries
 * Depends on: ./corpus.ts, ./llm.ts, ./deck.ts, ./types.ts, ./settings.ts
 */
import { filterCorpus } from "./corpus.ts";
import { annotateBatch } from "./llm.ts";
import { createAvoidList } from "./uniqueness.ts";
import { buildDeck, buildDeckWord, type DeckIssue } from "./deck.ts";
import { validateDeck } from "./deck.ts";
import type { CefrLevel, CorpusWord, Deck, DeckWord, RefineryDoc, ReviewEntry } from "./types.ts";
import type { Settings } from "./settings.ts";

/** What one generation run needs. */
export interface RunOptions {
  settings: Settings;
  /** Headwords already in the deck, lowercased, so a run never duplicates. */
  existingWords: ReadonlySet<string>;
  /**
   * Every `anticipateVi` already in the deck. The uniqueness rule is deck-wide
   * but generation sees one batch, so the lines in use have to be handed over
   * explicitly or each run writes blind to everything shipped before it.
   */
  existingAnticipate?: readonly string[];
  levels: readonly CefrLevel[];
  count: number;
  shuffle: boolean;
  /** Called after each batch so the UI can render progress. */
  onProgress?: (event: { done: number; total: number; batch: number }) => void;
  signal?: AbortSignal;
}

/** What one generation run produces. */
export interface RunResult {
  /** Deck words built this run, in corpus order. */
  words: DeckWord[];
  /** Identifier stamped on every word of this run, for later "what did week N add?". */
  batchId: string;
  /** Corpus words that produced no usable annotation. */
  missed: CorpusWord[];
  /** Every warning and error, prefixed with the word it belongs to. */
  issues: string[];
}

/**
 * Run one generation pass.
 * @returns the new deck words plus everything the reviewer should see
 */
export async function runGeneration(options: RunOptions): Promise<RunResult> {
  const selected = filterCorpus({
    levels: options.levels,
    exclude: options.existingWords,
    limit: options.count,
    shuffle: options.shuffle,
  });

  // One identity for the whole run, so every word it produces is traceable to
  // it. Second-resolution is enough: two runs cannot start in the same second.
  const addedAt = new Date().toISOString();
  const batchId = `run-${addedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;

  if (selected.length === 0) {
    return {
      words: [],
      missed: [],
      batchId,
      issues: [
        "No corpus words left for this filter. Widen the CEFR levels, or the deck already covers the bundled corpus.",
      ],
    };
  }

  // Seeded with every line the deck already uses, then fed each batch's own
  // output, so the run avoids both the existing deck and itself.
  const avoid = createAvoidList(options.existingAnticipate ?? []);

  const annotated = await annotateBatch(
    options.settings.llm,
    selected,
    options.settings.llm.batchSize,
    {
      onProgress: (event) =>
        options.onProgress?.({ done: event.done, total: event.total, batch: event.batch }),
      signal: options.signal,
      avoid,
    },
  );

  const usedIds = new Set<string>();
  const words: DeckWord[] = [];
  const missed: CorpusWord[] = [];
  const issues: string[] = [...annotated.issues];

  for (const corpusWord of selected) {
    const annotation = annotated.annotations.get(corpusWord.word) ?? null;
    const built = buildDeckWord({ corpusWord, annotation, usedIds, batchId, addedAt });
    issues.push(...built.warnings, ...built.errors);
    if (built.deckWord === null) {
      missed.push(corpusWord);
      continue;
    }
    words.push(built.deckWord);
  }

  return { words, missed, issues, batchId };
}

/**
 * Wrap freshly built words into review entries. Validation issues are attached
 * to the word they belong to so each row can show its own problems.
 */
export function buildReviewEntries(words: readonly DeckWord[]): ReviewEntry[] {
  return words.map((deckWord) => ({
    id: deckWord.id,
    deckWord,
    status: "pending" as const,
    warnings: [],
  }));
}

/**
 * Merge a run into the working document, re-validating the whole deck so the
 * issue list always reflects the current state rather than the last run.
 */
export function mergeIntoDoc(
  current: RefineryDoc,
  added: readonly ReviewEntry[],
  meta: { name: string; version: string; model: string; corpusName: string; corpusLicense: string },
): { doc: RefineryDoc; issues: DeckIssue[] } {
  const byId = new Map(current.review.map((entry) => [entry.id, entry]));
  for (const entry of added) byId.set(entry.id, entry);
  const review = [...byId.values()];

  const deck: Deck = buildDeck({
    name: meta.name,
    version: meta.version,
    words: review.map((entry) => entry.deckWord),
    model: meta.model,
    corpusName: meta.corpusName,
    corpusLicense: meta.corpusLicense,
  });

  return {
    doc: { schemaVersion: 1, deck, review, savedAt: new Date().toISOString() },
    issues: validateDeck(deck),
  };
}

/** Build the plain deck JSON that KineMedia's `vocab:import` consumes. */
export function deckToImportJson(deck: Deck): string {
  return JSON.stringify(deck, null, 2);
}

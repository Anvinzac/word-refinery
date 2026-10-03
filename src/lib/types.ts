/**
 * Shared domain types for Word Refinery.
 *
 * The deck shape mirrors KineMedia's `catalog.json` AFTER the inline-marker
 * migration: highlighted Vietnamese phrases are embedded in `defVi` / `leadVi`
 * between forward slashes, and there is no separate `emphasis` array.
 *
 * Exports: CorpusWord, CefrLevel, DeckUsage, DeckWord, DeckMeta, Deck
 * Depends on: none
 */

/** CEFR bands used by the corpus and understood by the feed's level filter. */
export type CefrLevel = "A1" | "A2" | "B1" | "B2" | "C1";

/** The five CEFR bands in ascending difficulty. */
export const CEFR_LEVELS: readonly CefrLevel[] = ["A1", "A2", "B1", "B2", "C1"];

/** One entry of the bundled NGSL/NAWL starter corpus. */
export interface CorpusWord {
  word: string;
  pos: string;
  level: CefrLevel;
  band: number;
  source: string;
}

/** Provenance and licensing metadata carried by the corpus file. */
export interface CorpusMeta {
  name: string;
  version: string;
  kind: string;
  locale: string;
  license: string;
  licenseUrl: string;
  derivedFrom: string;
  disclaimer: string;
  [key: string]: unknown;
}

/** The bundled corpus document. */
export interface Corpus {
  meta: CorpusMeta;
  words: CorpusWord[];
}

/** One English/Vietnamese example pair, exactly as the app imports it. */
export interface DeckUsage {
  en: string;
  vi: string;
}

/**
 * One deck entry.
 *
 * `defVi` and `leadVi` may each contain at most one `/marked phrase/`. The
 * feed's stage builder strips the slashes and highlights only the phrase that
 * lives in the field it is rendering, which is why co-location replaces the
 * old word-level `emphasis` array.
 */
export interface DeckWord {
  id: string;
  word: string;
  pos: string;
  ipa: string;
  defVi: string;
  leadVi: string;
  anticipateVi: string;
  topic: string;
  level: CefrLevel;
  chars: number;
  initial: string;
  usage: DeckUsage[];
}

/** Deck header. `revision` is what KineMedia's importer stamps into catalog.json. */
export interface DeckMeta {
  name: string;
  version: string;
  locale: string;
  generatedAt: string;
  generator: string;
  model: string;
  corpus: string;
  corpusLicense: string;
  wordCount: number;
  notes: string;
  [key: string]: unknown;
}

/** A complete deck document — the unit of storage and of sync. */
export interface Deck {
  meta: DeckMeta;
  words: DeckWord[];
}

/** Per-word review state kept alongside the deck while refining. */
export type ReviewStatus = "pending" | "approved" | "rejected" | "edited";

/** One row of the review workspace. */
export interface ReviewEntry {
  /** Stable key: the deck word id. */
  id: string;
  deckWord: DeckWord;
  status: ReviewStatus;
  /** Warnings raised while validating this word (emphasis drops, blanking, …). */
  warnings: string[];
}

/** The document persisted to the remote store. */
export interface RefineryDoc {
  /** Schema version so a future reader can migrate older documents. */
  schemaVersion: 1;
  deck: Deck;
  review: ReviewEntry[];
  savedAt: string;
}

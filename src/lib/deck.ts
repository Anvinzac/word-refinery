/**
 * Deck builder and validator — the refinery's output contract.
 *
 * Turns validated annotations plus corpus levels into the deck shape KineMedia
 * imports (`meta` + `words`), with emphasis expressed as inline `/…/` markers
 * inside `defVi` / `leadVi` rather than a separate array. The level shown in
 * every deck word always comes from the corpus, never from the model.
 *
 * Exports: slugifyWord, buildDeckWord, buildDeck, validateDeck, deckToCatalog
 * Depends on: ./types.ts, ./contract.ts, ./emphasis.ts
 */
import type { CorpusWord, Deck, DeckMeta, DeckUsage, DeckWord, ReviewEntry } from "./types.ts";
import { containsTargetWord, type CrawlerAnnotation } from "./contract.ts";
import { countSyllables, injectEmphasisMarkers, stripEmphasisMarkers, validateEmphasis } from "./emphasis.ts";

/** Deck id pattern, identical to the app's importer rule. */
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Headword pattern, identical to the app's importer rule. */
const WORD_PATTERN = /^[a-zA-Z]+(?:['’-][a-zA-Z]+)*$/;

/** Topic pattern, identical to the app's importer rule. */
const TOPIC_PATTERN = /^[a-z0-9-]*$/;

/**
 * Build the deck id for a word.
 * @returns lowercase slug of letters, digits, dashes and underscores
 */
export function slugifyWord(word: string): string {
  const slug = word
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "word";
}

/**
 * Assemble one deck word from a corpus entry and its validated annotation.
 * Emphasis is validated, then injected as `/…/` markers into the field it
 * actually occurs in, so a highlight can never be attached to text that does
 * not contain it.
 */
export function buildDeckWord(input: {
  corpusWord: CorpusWord;
  annotation: CrawlerAnnotation | null;
  usedIds: Set<string>;
}): { deckWord: DeckWord | null; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const word = input.corpusWord.word;

  if (input.annotation === null) {
    return { deckWord: null, warnings, errors: [`${word}: no annotation to build from`] };
  }
  const annotation = input.annotation;
  if (annotation.defVi.trim().length < 2) {
    return { deckWord: null, warnings, errors: [`${word}: annotation has no usable defVi`] };
  }

  // Defense in depth: the contract parser already repairs this, but the deck
  // must never ship a Vietnamese teaser containing the English answer.
  let anticipateVi = annotation.anticipateVi;
  if (containsTargetWord(anticipateVi, word)) {
    anticipateVi = "";
    warnings.push(`${word}: anticipateVi contained the answer and was emptied`);
  }

  const emphasis = validateEmphasis({
    defVi: annotation.defVi,
    leadVi: annotation.leadVi,
    emphasisVi: annotation.emphasisVi,
  });
  for (const warning of emphasis.warnings) warnings.push(`${word}: ${warning}`);

  const marked = injectEmphasisMarkers(annotation.defVi, annotation.leadVi, emphasis.emphasis);
  for (const warning of marked.warnings) warnings.push(`${word}: ${warning}`);
  if (emphasis.emphasis.length > 0 && marked.defVi === annotation.defVi && marked.leadVi === annotation.leadVi) {
    warnings.push(`${word}: no emphasis marker could be placed; the word will fall back to heuristics`);
  }

  let id = slugifyWord(word);
  if (input.usedIds.has(id)) {
    let suffix = 2;
    while (input.usedIds.has(`${id}-${suffix}`)) suffix += 1;
    warnings.push(`${word}: id "${id}" was taken; using "${id}-${suffix}"`);
    id = `${id}-${suffix}`;
  }
  input.usedIds.add(id);

  const usage: DeckUsage[] = [];
  if (annotation.usageEn.trim().length > 0) {
    usage.push({ en: annotation.usageEn, vi: annotation.usageVi });
  } else {
    warnings.push(`${word}: no usable example sentence; usage will be empty`);
  }

  const letters = word.match(/\p{L}/gu) ?? [];
  const deckWord: DeckWord = {
    id,
    word,
    pos: annotation.pos,
    ipa: annotation.ipa,
    defVi: marked.defVi,
    leadVi: marked.leadVi,
    anticipateVi,
    topic: annotation.topic.length > 0 ? annotation.topic : "general",
    level: input.corpusWord.level,
    chars: letters.length,
    initial: word.charAt(0).toUpperCase(),
    usage,
  };
  return { deckWord, warnings, errors };
}

/**
 * Assemble a deck document from already-built words.
 * @param input.name - deck name shown by the app importer
 * @param input.words - deck words in corpus order
 * @param input.model - model id that produced the annotations
 * @param input.corpusMeta - provenance carried into the deck header
 */
export function buildDeck(input: {
  name: string;
  version: string;
  words: DeckWord[];
  model: string;
  corpusName: string;
  corpusLicense: string;
  notes?: string;
}): Deck {
  const meta: DeckMeta = {
    name: input.name,
    version: input.version,
    locale: "en_vi",
    generatedAt: new Date().toISOString(),
    generator: "word-refinery",
    model: input.model,
    corpus: input.corpusName,
    corpusLicense: input.corpusLicense,
    wordCount: input.words.length,
    notes:
      input.notes ??
      "Emphasis is encoded as inline /phrase/ markers inside defVi and leadVi. " +
      "Corpus is a CC BY-SA 4.0 derivative; see NOTICE.md.",
  };
  return { meta, words: input.words };
}

/** One validation problem found in a deck. */
export interface DeckIssue {
  wordId: string;
  field: string;
  message: string;
}

/**
 * Validate a deck against the same rules the app's importer enforces, plus the
 * refinery's own content bar. Returns every problem instead of failing fast so
 * a reviewer sees the whole picture at once.
 */
export function validateDeck(deck: Deck): DeckIssue[] {
  const issues: DeckIssue[] = [];
  const seenIds = new Set<string>();
  const seenWords = new Set<string>();
  const seenAnticipate = new Map<string, string>();

  for (const entry of deck.words) {
    const at = (field: string, message: string) => issues.push({ wordId: entry.id, field, message });

    if (!ID_PATTERN.test(entry.id)) at("id", `"${entry.id}" is not a valid deck id`);
    if (seenIds.has(entry.id)) at("id", `duplicate id "${entry.id}"`);
    seenIds.add(entry.id);

    if (!WORD_PATTERN.test(entry.word)) at("word", `"${entry.word}" is not a plain English word`);
    const lower = entry.word.toLowerCase();
    if (seenWords.has(lower)) at("word", `duplicate headword "${entry.word}"`);
    seenWords.add(lower);

    if (entry.defVi.trim().length < 2) at("defVi", "missing");
    else {
      const clean = stripEmphasisMarkers(entry.defVi);
      const words = clean.trim().split(/\s+/).filter(Boolean).length;
      if (words < 8 || words > 11) at("defVi", `${words} words; expected 8-11`);
      if (clean.length > 140) at("defVi", `${clean.length} characters; expected at most 140`);
      if (containsTargetWord(clean, entry.word)) at("defVi", "leaks the English answer");
    }

    if (entry.leadVi.trim().length > 0) {
      const clean = stripEmphasisMarkers(entry.leadVi);
      const words = clean.trim().split(/\s+/).filter(Boolean).length;
      if (words < 8 || words > 11) at("leadVi", `${words} words; expected 8-11`);
      if (clean.length > 120) at("leadVi", `${clean.length} characters; expected at most 120`);
      if (containsTargetWord(clean, entry.word)) at("leadVi", "leaks the English answer");
    }

    if (entry.anticipateVi.trim().length > 0) {
      const clean = stripEmphasisMarkers(entry.anticipateVi);
      const words = clean.trim().split(/\s+/).filter(Boolean).length;
      if (words < 3 || words > 8) at("anticipateVi", `${words} words; expected 3-8`);
      if (containsTargetWord(clean, entry.word)) at("anticipateVi", "leaks the English answer");
      const key = clean.toLowerCase();
      const previous = seenAnticipate.get(key);
      if (previous !== undefined) at("anticipateVi", `reused verbatim by "${previous}"`);
      else seenAnticipate.set(key, entry.word);
    }

    if (!TOPIC_PATTERN.test(entry.topic)) at("topic", `"${entry.topic}" is not lowercase-slug`);

    for (const [index, usage] of entry.usage.entries()) {
      if (!usage.en.includes("_____")) at(`usage[${index}].en`, "missing the _____ blank");
      if (containsTargetWord(usage.en, entry.word)) at(`usage[${index}].en`, "leaks the answer next to the blank");
      if (usage.vi.trim().length === 0) at(`usage[${index}].vi`, "missing Vietnamese gloss");
    }

    // Markers must be paired and must wrap a 2-syllable Vietnamese compound.
    for (const field of ["defVi", "leadVi"] as const) {
      const value = entry[field];
      const slashes = (value.match(/\//g) ?? []).length;
      if (slashes % 2 !== 0) at(field, `unpaired "/" marker (${slashes} slashes)`);
      for (const match of value.matchAll(/\/([^/]+)\//g)) {
        const phrase = match[1];
        const syllables = countSyllables(phrase);
        if (syllables !== 2) at(field, `marker "/${phrase}/" is ${syllables} syllables; expected 2`);
        if (!value.includes(phrase)) at(field, `marker content "${phrase}" not found unmarked`);
      }
      const markers = [...value.matchAll(/\/([^/]+)\//g)].length;
      if (markers > 1) at(field, `${markers} markers; the feed highlights one word per page`);
    }
  }

  return issues;
}

/**
 * Project the review workspace down to the deck document that gets synced.
 * Only approved and edited rows are kept; rejected and pending rows are not.
 */
export function approvedEntries(review: readonly ReviewEntry[]): ReviewEntry[] {
  return review.filter((entry) => entry.status === "approved" || entry.status === "edited");
}

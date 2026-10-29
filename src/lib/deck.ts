/**
 * Deck builder and validator — the refinery's output contract.
 *
 * Turns validated annotations plus corpus levels into the deck shape KineMedia
 * imports (`meta` + `words`), with emphasis expressed as inline `/…/` markers
 * inside `defVi` / `leadVi` rather than a separate array. The level shown in
 * every deck word always comes from the corpus, never from the model.
 *
 * Exports: slugifyWord, buildDeckWord, buildDeck, coerceDeckWord, validateDeck,
 *          migrateDeckWord, entriesForNewBatches, approvedEntries
 * Depends on: ./types.ts, ./contract.ts, ./emphasis.ts, ./lang.ts
 */
import type { CorpusWord, Deck, DeckMeta, DeckUsage, DeckWord, ReviewEntry } from "./types.ts";
import { CEFR_LEVELS, type CefrLevel } from "./types.ts";
import {
  EXAMS,
  MAX_EXAMS,
  MAX_TOPICS,
  TOPICS,
  containsTargetWord,
  keepCurated,
  type CrawlerAnnotation,
} from "./contract.ts";
import { injectEmphasisMarkers, stripEmphasisMarkers, validateEmphasis } from "./emphasis.ts";
import { findStrayMarks } from "./joiner.ts";
import { activeGlossProfile, describeLength, markRules, measureLength } from "./lang.ts";

/**
 * The language this workspace's cards are written in, and with it every length
 * the validator enforces. Read at module load; switching workspace reloads.
 */
const L = activeGlossProfile();

/** How this language's breaking marks are read. */
const MARKS = markRules(L);

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
  /** The run this word belongs to, so a weekly batch stays identifiable later. */
  batchId: string;
  /** When the run happened, ISO 8601. One stamp per run, not per word. */
  addedAt: string;
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

  // The contract parser has already dropped uncurated tags and guaranteed at
  // least one topic, so this is a straight copy with `topic` restated as the
  // primary for the importer that still reads the singular field.
  const topics = annotation.topics.length > 0 ? [...annotation.topics] : ["general"];

  const letters = word.match(/\p{L}/gu) ?? [];
  const deckWord: DeckWord = {
    id,
    word,
    pos: annotation.pos,
    ipa: annotation.ipa,
    defVi: marked.defVi,
    leadVi: marked.leadVi,
    anticipateVi,
    meaningVi: annotation.meaningVi,
    topic: topics[0]!,
    topics,
    exams: [...annotation.exams],
    level: input.corpusWord.level,
    chars: letters.length,
    initial: word.charAt(0).toUpperCase(),
    usage,
    addedAt: input.addedAt,
    batchId: input.batchId,
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
    // The headword is always English; the gloss language is what varies.
    locale: `en_${L.id}`,
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

/** Keep a level only when it is a real CEFR band; imported files can be sloppy. */
function coerceLevel(value: unknown): CefrLevel {
  return typeof value === "string" && (CEFR_LEVELS as readonly string[]).includes(value)
    ? (value as CefrLevel)
    : "B1";
}

/**
 * Coerce a loosely-shaped imported word — a deck export or a WordCrawler batch
 * entry — into a valid deck word so it can be previewed and refined here.
 *
 * Batch entries carry `topics` as an array and omit `chars` / `initial`, so
 * those are normalised: the topic collapses to its first tag (or `general`),
 * and the letter count / initial are recomputed. Anything already correct is
 * passed through untouched; unknown or malformed values fall back to safe
 * defaults rather than throwing.
 *
 * @param raw - one entry from the imported `words` array
 * @param usedIds - ids already taken, mutated to reserve the returned id
 * @param defaults - batch bookkeeping for words that carry none of their own
 * @returns the normalised deck word, or null when there is no usable headword
 */
export function coerceDeckWord(
  raw: unknown,
  usedIds: Set<string>,
  defaults: { batchId: string; addedAt: string } = { batchId: "imported", addedAt: "" },
): DeckWord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === "string" ? value : "");

  const word = text(record.word).trim();
  if (word.length === 0) return null;

  // `topics` wins; a word from before the axis existed carries only `topic`,
  // which becomes a one-entry list. Uncurated tags are dropped, never invented.
  const offeredTopics = Array.isArray(record.topics)
    ? (record.topics as unknown[])
    : [record.topic];
  const topics = keepCurated(offeredTopics, TOPICS, MAX_TOPICS);
  if (topics.length === 0) topics.push("general");
  const exams = Array.isArray(record.exams)
    ? keepCurated(record.exams as unknown[], EXAMS, MAX_EXAMS)
    : [];

  let id = ID_PATTERN.test(text(record.id)) ? record.id as string : slugifyWord(word);
  if (usedIds.has(id)) {
    let suffix = 2;
    while (usedIds.has(`${id}-${suffix}`)) suffix += 1;
    id = `${id}-${suffix}`;
  }
  usedIds.add(id);

  const usage: DeckUsage[] = Array.isArray(record.usage)
    ? (record.usage as unknown[])
        .map((item) => {
          if (typeof item !== "object" || item === null) return null;
          const pair = item as Record<string, unknown>;
          const en = text(pair.en);
          const vi = text(pair.vi);
          return en.length > 0 || vi.length > 0 ? { en, vi } : null;
        })
        .filter((item): item is DeckUsage => item !== null)
    : [];
  // Raw model output carries the example as flat usageEn / usageVi fields.
  if (usage.length === 0 && text(record.usageEn).trim().length > 0) {
    usage.push({ en: text(record.usageEn), vi: text(record.usageVi) });
  }

  // Raw model output also names its highlights in emphasisVi instead of
  // marking them; place them the way a generation run would.
  let defVi = text(record.defVi);
  let leadVi = text(record.leadVi);
  if (Array.isArray(record.emphasisVi) && !defVi.includes("/") && !leadVi.includes("/")) {
    const phrases = (record.emphasisVi as unknown[]).filter(
      (item): item is string => typeof item === "string",
    );
    const emphasis = validateEmphasis({ defVi, leadVi, emphasisVi: phrases });
    const marked = injectEmphasisMarkers(defVi, leadVi, emphasis.emphasis);
    defVi = marked.defVi;
    leadVi = marked.leadVi;
  }

  const letters = word.match(/\p{L}/gu) ?? [];
  return {
    id,
    word,
    pos: text(record.pos),
    ipa: text(record.ipa),
    defVi,
    leadVi,
    anticipateVi: text(record.anticipateVi),
    meaningVi: text(record.meaningVi),
    topic: topics[0]!,
    topics,
    exams,
    level: coerceLevel(record.level),
    chars: typeof record.chars === "number" ? record.chars : letters.length,
    initial: text(record.initial) || word.charAt(0).toUpperCase(),
    usage,
    // A word that predates this bookkeeping gets the stamp of the import that
    // carried it in, which is the truest thing still knowable about it.
    addedAt: text(record.addedAt) || defaults.addedAt,
    batchId: text(record.batchId) || defaults.batchId,
  };
}

/**
 * Bring a deck word read from storage up to the current shape.
 *
 * A document saved before the topics/exams axes existed has words with a lone
 * `topic` and no bookkeeping. Reading one must not hand the app a word whose
 * `topics` is undefined, so every read path routes through here.
 *
 * @param word - a deck word of any vintage
 * @returns the word with every current field present
 */
export function migrateDeckWord(word: DeckWord): DeckWord {
  const hasTopics = Array.isArray(word.topics) && word.topics.length > 0;
  const hasExams = Array.isArray(word.exams);
  if (
    hasTopics &&
    hasExams &&
    typeof word.meaningVi === "string" &&
    typeof word.addedAt === "string" &&
    typeof word.batchId === "string"
  ) {
    return word;
  }
  const topics = keepCurated(hasTopics ? word.topics : [word.topic], TOPICS, MAX_TOPICS);
  if (topics.length === 0) topics.push("general");
  return {
    ...word,
    meaningVi: typeof word.meaningVi === "string" ? word.meaningVi : "",
    topic: topics[0]!,
    topics,
    exams: hasExams ? keepCurated(word.exams, EXAMS, MAX_EXAMS) : [],
    addedAt: typeof word.addedAt === "string" && word.addedAt.length > 0 ? word.addedAt : "",
    batchId: typeof word.batchId === "string" && word.batchId.length > 0 ? word.batchId : "legacy",
  };
}

/** One validation problem found in a deck. */
export interface DeckIssue {
  wordId: string;
  field: string;
  message: string;
  /**
   * "error" for a rule the card breaks, "warning" for an aim it misses.
   *
   * Almost everything here is an error, because almost every rule is a limit.
   * The exception is a length range a language states as advice (see
   * `LengthRule.aim`): reporting those as errors would bury the real defects
   * under a list of definitions whose only fault is being tight.
   */
  severity: "error" | "warning";
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
    const at = (field: string, message: string, severity: DeckIssue["severity"] = "error") =>
      issues.push({ wordId: entry.id, field, message, severity });
    /** One field against one length rule, reported in the language's own unit. */
    const checkLength = (field: string, clean: string, rule: (typeof L)["limits"]["def"]) => {
      const size = measureLength(clean, L);
      if (size < rule.min || size > rule.max) {
        at(
          field,
          rule.aim === true
            ? `${describeLength(size, L)}; the aim is ${rule.min}-${rule.max}`
            : `${describeLength(size, L)}; expected ${rule.min}-${rule.max}`,
          rule.aim === true ? "warning" : "error",
        );
      }
      // A character ceiling is only a separate rule where the unit is not
      // characters; where it is, `max` has already said it.
      if (rule.maxChars !== undefined && L.measure !== "characters" && clean.length > rule.maxChars) {
        at(field, `${clean.length} characters; expected at most ${rule.maxChars}`);
      }
    };

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
      // Counted the way the language counts: words where words are separated,
      // characters where they are not. Marks are stripped first in both cases,
      // so joining two syllables never makes a field look shorter than it reads.
      checkLength("defVi", clean, L.limits.def);
      if (containsTargetWord(clean, entry.word)) at("defVi", "leaks the English answer");
    }

    if (entry.leadVi.trim().length > 0) {
      const clean = stripEmphasisMarkers(entry.leadVi);
      checkLength("leadVi", clean, L.limits.lead);
      if (containsTargetWord(clean, entry.word)) at("leadVi", "leaks the English answer");
    }

    if (entry.anticipateVi.trim().length > 0) {
      const clean = stripEmphasisMarkers(entry.anticipateVi);
      checkLength("anticipateVi", clean, L.limits.anticipate);
      if (containsTargetWord(clean, entry.word)) at("anticipateVi", "leaks the English answer");
      const key = clean.toLowerCase();
      const previous = seenAnticipate.get(key);
      if (previous !== undefined) at("anticipateVi", `reused verbatim by "${previous}"`);
      else seenAnticipate.set(key, entry.word);
    }

    // The gloss is what the reveal panel shows. It is optional on older decks,
    // but when present it must read as an equivalent rather than a definition:
    // a sentence here is the wrong register, and the app caps it at 120.
    // Read defensively: the field is optional downstream, and a validator that
    // throws on a deck written before it existed is worse than one that skips.
    if (typeof entry.meaningVi === "string" && entry.meaningVi.trim().length > 0) {
      const clean = stripEmphasisMarkers(entry.meaningVi);
      const ceiling = L.limits.meaning.maxChars;
      if (ceiling !== undefined && clean.length > ceiling) {
        at("meaningVi", `${clean.length} characters; expected at most ${ceiling}`);
      }
      // A gloss may offer two equivalents separated by a comma ("then_chốt,
      // cực_kỳ quan_trọng"), so each alternative is measured on its own. The
      // defect this catches is one long run of words, which is a definition.
      const longest = clean
        .split(/[,;、]/)
        .map((alternative) => measureLength(alternative, L))
        .reduce((most, units) => Math.max(most, units), 0);
      if (longest > L.limits.meaning.max) {
        at(
          "meaningVi",
          `${describeLength(longest, L)} in one alternative; a gloss is an equivalent, not a definition`,
        );
      }
      if (containsTargetWord(clean, entry.word)) at("meaningVi", "leaks the English answer");
      for (const problem of findStrayMarks(entry.meaningVi, MARKS)) at("meaningVi", problem);
    }

    if (!TOPIC_PATTERN.test(entry.topic)) at("topic", `"${entry.topic}" is not lowercase-slug`);

    // The two curated axes. Both are closed lists shared with KineMedia, so an
    // uncurated slug here is a tag that silently disappears downstream.
    if (!Array.isArray(entry.topics) || entry.topics.length === 0) {
      at("topics", "no usage domain assigned");
    } else {
      if (entry.topics.length > MAX_TOPICS) {
        at("topics", `${entry.topics.length} topics; at most ${MAX_TOPICS} are kept`);
      }
      if (new Set(entry.topics).size !== entry.topics.length) at("topics", "repeated topic");
      for (const topic of entry.topics) {
        if (!(TOPICS as readonly string[]).includes(topic)) {
          at("topics", `"${topic}" is not one of the curated usage domains`);
        }
      }
      if (entry.topic !== entry.topics[0]) {
        at("topic", `"${entry.topic}" does not match topics[0] "${entry.topics[0]}"`);
      }
    }

    if (Array.isArray(entry.exams)) {
      if (entry.exams.length > MAX_EXAMS) {
        at("exams", `${entry.exams.length} exams; at most ${MAX_EXAMS} are kept`);
      }
      if (new Set(entry.exams).size !== entry.exams.length) at("exams", "repeated exam target");
      for (const exam of entry.exams) {
        if (!(EXAMS as readonly string[]).includes(exam)) {
          at("exams", `"${exam}" is not one of the curated exam targets`);
        }
      }
    }

    for (const [index, usage] of entry.usage.entries()) {
      if (!usage.en.includes("_____")) at(`usage[${index}].en`, "missing the _____ blank");
      if (containsTargetWord(usage.en, entry.word)) at(`usage[${index}].en`, "leaks the answer next to the blank");
      if (usage.vi.trim().length === 0) at(`usage[${index}].vi`, "missing Vietnamese gloss");
    }

    // A bond between two letters is read downstream as a word join or a clitic
    // bind, so a mark that is not one is a silent defect rather than a typo —
    // and a one-syllable phrase cannot honour the rule its mark expresses.
    for (const field of ["defVi", "leadVi", "anticipateVi"] as const) {
      for (const problem of findStrayMarks(entry[field], MARKS)) at(field, problem);
    }
    for (const [index, usage] of entry.usage.entries()) {
      for (const problem of findStrayMarks(usage.vi, MARKS)) at(`usage[${index}].vi`, problem);
    }

    // Markers must be paired and must wrap one word of the gloss language.
    for (const field of ["defVi", "leadVi"] as const) {
      const value = entry[field];
      const slashes = (value.match(/\//g) ?? []).length;
      if (slashes % 2 !== 0) at(field, `unpaired "/" marker (${slashes} slashes)`);
      for (const match of value.matchAll(/\/([^/]+)\//g)) {
        const phrase = match[1];
        // Card-prompt v3.7: "either one syllable or one joined word of up to 4
        // syllables". The old rule demanded exactly two and rejected four
        // otherwise-sound cards in the v4 starter pack for highlighting a
        // one-syllable meaning word, which that prompt explicitly allows.
        const size = measureLength(phrase, L);
        if (size < L.emphasis.min || size > L.emphasis.max) {
          at(
            field,
            `marker "/${phrase}/" is ${size} ${L.emphasis.unitWord}; expected ${L.emphasis.min}-${L.emphasis.max}`,
          );
        }
        if (!value.includes(phrase)) at(field, `marker content "${phrase}" not found unmarked`);
      }
      const markers = [...value.matchAll(/\/([^/]+)\//g)].length;
      if (markers > 1) at(field, `${markers} markers; the feed highlights one word per page`);
    }
  }

  return issues;
}

/**
 * Pending review rows for the bundled words whose batch this workspace lacks.
 *
 * A browser that already holds a workspace never reloads the bundled dataset,
 * so batches shipped after its first visit would never reach it. Matching by
 * batch rather than by word keeps every batch already present untouched,
 * reviewed or not, and adds a new one whole.
 *
 * @param existing - the workspace's current rows
 * @param bundled - raw words from the bundled dataset, each carrying a batchId
 * @returns rows to append; empty when every bundled batch is already present
 */
export function entriesForNewBatches(
  existing: readonly ReviewEntry[],
  bundled: readonly unknown[],
): ReviewEntry[] {
  const known = new Set(existing.map((entry) => entry.deckWord.batchId));
  const usedIds = new Set(existing.map((entry) => entry.id));
  const added: ReviewEntry[] = [];
  for (const raw of bundled) {
    const batchId = (raw as { batchId?: unknown } | null)?.batchId;
    if (typeof batchId !== "string" || batchId.length === 0 || known.has(batchId)) continue;
    const deckWord = coerceDeckWord(raw, usedIds, { batchId, addedAt: "" });
    if (deckWord !== null) added.push({ id: deckWord.id, deckWord, status: "pending", warnings: [] });
  }
  return added;
}

/**
 * Project the review workspace down to the deck document that gets synced.
 * Only approved and edited rows are kept; rejected and pending rows are not.
 */
export function approvedEntries(review: readonly ReviewEntry[]): ReviewEntry[] {
  return review.filter((entry) => entry.status === "approved" || entry.status === "edited");
}

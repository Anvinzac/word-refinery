/**
 * Batch intake: the gate a generated card has to pass before it is vocabulary.
 *
 * The distinction this module exists to keep is between a CANDIDATE and an
 * ACCEPTED card. A model returns candidates; what makes one a card is surviving
 * the checks, and a pipeline that loses that distinction quietly reports its
 * own output as finished work. So nothing here mutates a deck — it produces
 * findings and a verdict, and the two populations stay separate with the reason
 * each rejection happened attached to it.
 *
 * Four stages, in the order a cheap check should precede an expensive one:
 *
 *   schema   structure, types, field order, target mapping   free, local
 *   content  counts, limits, tags, emphasis, marks           free, local
 *   safety   implication, framing, sense                     one model call
 *   repair   fix the failures and recheck the WHOLE card     one call each
 *
 * A repaired card is rechecked from the top rather than only on the field that
 * failed: fixing a definition can break its emphasis phrase, and a pipeline
 * that only re-reads the trigger field ships that.
 *
 * Exports: IntakeStage, Severity, IntakeFinding, IntakeRecord, IntakeVerdict,
 *          CANONICAL_FIELD_ORDER, checkSchema, checkContent, verdictOf,
 *          partitionRecords, summarize, candidateId
 * Depends on: ./contract.ts, ./deck.ts, ./lang.ts, ./types.ts
 */
import {
  CRAWLER_ANNOTATION_FIELDS,
  EXAMS,
  TOPICS,
  annotationWordPattern,
  containsTargetWord,
} from "./contract.ts";
import { validateDeck } from "./deck.ts";
import { stripEmphasisMarkers } from "./emphasis.ts";
import { stripMarks } from "./joiner.ts";
import { activeGlossProfile, describeLength, measureLength } from "./lang.ts";
import type { Deck, DeckWord } from "./types.ts";

/** Which gate produced a finding. */
export type IntakeStage = "schema" | "content" | "safety" | "repair";

/** How much a finding matters. A blocker keeps the card out; a warning does not. */
export type Severity = "blocker" | "warn";

/** One thing wrong with one candidate. */
export interface IntakeFinding {
  stage: IntakeStage;
  field: string;
  severity: Severity;
  message: string;
}

/** Where a candidate ended up. */
export type IntakeVerdict = "accepted" | "rejected" | "pending";

/** One candidate and everything known about it. */
export interface IntakeRecord {
  /** Stable within a run, so findings can be attached across stages. */
  id: string;
  word: string;
  batchId: string;
  /** The candidate exactly as it arrived, kept so a rejection can be inspected. */
  raw: unknown;
  /** The coerced card, or null when the candidate was too broken to coerce. */
  card: DeckWord | null;
  findings: IntakeFinding[];
  verdict: IntakeVerdict;
  /** Set when a repair pass rewrote this candidate. */
  repaired?: boolean;
}

/**
 * The field order a candidate is expected to arrive in.
 *
 * Order carries no meaning to a parser, so this is a warning rather than a
 * blocker — but a batch whose keys drift out of order is usually a batch from a
 * different prompt than the one you think you are running, and that is worth
 * knowing before the content checks start agreeing with it.
 */
export const CANONICAL_FIELD_ORDER: readonly string[] = CRAWLER_ANNOTATION_FIELDS;

/** Build a stable id for a candidate within one run. */
export function candidateId(batchId: string, word: string, index: number): string {
  return `${batchId}:${index}:${word || "?"}`;
}

/** Add a finding. */
function at(
  findings: IntakeFinding[],
  stage: IntakeStage,
  field: string,
  severity: Severity,
  message: string,
): void {
  findings.push({ stage, field, severity, message });
}

/**
 * Stage one: is this the right shape?
 *
 * Structural only — types, presence, order, and whether the card describes the
 * word that was asked for. Nothing here reads Vietnamese; that is stage two.
 *
 * @param raw - one candidate as received
 * @param expectedWord - the headword this slot was requested for, when known
 */
export function checkSchema(raw: unknown, expectedWord?: string): IntakeFinding[] {
  const findings: IntakeFinding[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    at(findings, "schema", "card", "blocker", "not a JSON object");
    return findings;
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);

  for (const field of CRAWLER_ANNOTATION_FIELDS) {
    if (!(field in record)) at(findings, "schema", field, "blocker", "missing");
  }
  for (const key of keys) {
    if (!(CRAWLER_ANNOTATION_FIELDS as readonly string[]).includes(key)) {
      at(findings, "schema", key, "warn", "unexpected field, ignored on import");
    }
  }

  // Types, for the fields that are present. `null` is a permitted value — the
  // prompt tells the writer to use it rather than drop a key, on the promise
  // that the validator lists every one for review. So it is reported, loudly,
  // but as something to look at rather than a type error.
  for (const field of CRAWLER_ANNOTATION_FIELDS) {
    if (!(field in record)) continue;
    if (record[field] === null) {
      at(findings, "schema", field, "warn", "null — the writer could not produce a value; review it");
    }
  }
  for (const field of ["word", "pos", "ipa", "meaningVi", "defVi", "leadVi", "anticipateVi", "usageEn", "usageVi"]) {
    const value = record[field];
    if (field in record && value !== null && typeof value !== "string") {
      at(findings, "schema", field, "blocker", `expected a string, got ${typeof value}`);
    }
  }
  for (const field of ["topics", "exams", "emphasisVi"]) {
    const value = record[field];
    if (field in record && value !== null && !Array.isArray(value)) {
      at(findings, "schema", field, "blocker", `expected an array, got ${typeof value}`);
    }
  }

  // Field order, as a warning: it means the batch came from a different prompt.
  const present = keys.filter((key) => (CANONICAL_FIELD_ORDER as readonly string[]).includes(key));
  const expected = CANONICAL_FIELD_ORDER.filter((field) => present.includes(field));
  if (present.join(",") !== expected.join(",")) {
    at(findings, "schema", "card", "warn", `fields are out of order (${present.join(", ")})`);
  }

  // Target mapping: the card must be about the word that was asked for.
  const word = typeof record.word === "string" ? record.word.trim().toLowerCase() : "";
  if (word.length === 0) {
    at(findings, "schema", "word", "blocker", "no headword");
  } else if (!annotationWordPattern.test(word)) {
    at(findings, "schema", "word", "blocker", `"${word}" is not a plain English word`);
  } else if (expectedWord !== undefined && word !== expectedWord.trim().toLowerCase()) {
    at(findings, "schema", "word", "blocker", `describes "${word}" but "${expectedWord}" was requested`);
  }

  // Tags must come from the closed lists, or they vanish downstream.
  for (const [field, allowed] of [["topics", TOPICS], ["exams", EXAMS]] as const) {
    const value = record[field];
    if (!Array.isArray(value)) continue;
    for (const tag of value) {
      if (typeof tag !== "string" || !(allowed as readonly string[]).includes(tag.toLowerCase())) {
        at(findings, "schema", field, "blocker", `"${String(tag)}" is not an allowed tag`);
      }
    }
  }

  findings.push(...checkEmphasisTriple(record));

  // The blank, and the answer beside it.
  const usageEn = typeof record.usageEn === "string" ? record.usageEn : "";
  if (usageEn.length > 0) {
    if (!usageEn.includes("_____")) {
      at(findings, "schema", "usageEn", "blocker", "missing the _____ blank");
    }
    if (word.length > 0 && containsTargetWord(usageEn, word)) {
      at(findings, "schema", "usageEn", "blocker", "leaks the answer beside the blank");
    }
  }

  return findings;
}

/**
 * Stage two: does the Vietnamese obey the deck's rules?
 *
 * Runs the same validator the deck itself is held to, so a card that passes
 * here cannot fail once imported.
 *
 * @param card - a coerced candidate
 */
export function checkContent(card: DeckWord): IntakeFinding[] {
  const deck: Deck = { meta: {} as Deck["meta"], words: [card] };
  return validateDeck(deck).map((issue) => ({
    stage: "content" as const,
    field: issue.field,
    // Everything the deck validator reports would also be reported after
    // import, so none of it is cosmetic.
    severity: "blocker" as const,
    message: issue.message,
  }));
}

/**
 * The verdict a set of findings implies.
 *
 * Pending rather than accepted while a stage has not run: a card is accepted by
 * passing checks, never by not having been checked.
 *
 * @param findings - everything found so far
 * @param stagesRun - which gates have actually been applied
 */
export function verdictOf(
  findings: readonly IntakeFinding[],
  stagesRun: readonly IntakeStage[],
): IntakeVerdict {
  if (findings.some((finding) => finding.severity === "blocker")) return "rejected";
  if (!stagesRun.includes("schema") || !stagesRun.includes("content")) return "pending";
  return "accepted";
}

/** Split a run into the two populations, keeping them apart. */
export function partitionRecords(records: readonly IntakeRecord[]): {
  accepted: IntakeRecord[];
  rejected: IntakeRecord[];
  pending: IntakeRecord[];
} {
  return {
    accepted: records.filter((record) => record.verdict === "accepted"),
    rejected: records.filter((record) => record.verdict === "rejected"),
    pending: records.filter((record) => record.verdict === "pending"),
  };
}

/** Counts for the run, including why rejections happened. */
export function summarize(records: readonly IntakeRecord[]): {
  total: number;
  accepted: number;
  rejected: number;
  pending: number;
  repaired: number;
  byStage: Record<IntakeStage, number>;
} {
  const byStage: Record<IntakeStage, number> = { schema: 0, content: 0, safety: 0, repair: 0 };
  for (const record of records) {
    for (const finding of record.findings) {
      if (finding.severity === "blocker") byStage[finding.stage] += 1;
    }
  }
  const split = partitionRecords(records);
  return {
    total: records.length,
    accepted: split.accepted.length,
    rejected: split.rejected.length,
    pending: split.pending.length,
    repaired: records.filter((record) => record.repaired === true).length,
    byStage,
  };
}

// ── Card-prompt v3.7 ────────────────────────────────────────────────────────

/** The language the cards under intake are written in. */
const L = activeGlossProfile();

/**
 * Soft fillers the prompt allows in a sentence but forbids as the glow.
 * They warm the tone; the meaning word still has to carry the highlight.
 */
const SOFT_FILLERS = new Set(L.fillers);

/** Intensifiers the prompt names as padding, never a highlight. */
const GENERIC_INTENSIFIERS = new Set(L.intensifiers);

/**
 * Words the prompt lists as absent from the Oxford 3000/5000, and therefore
 * banned in usageEn at every level however ordinary they feel.
 *
 * Only this list is checked, not the level ceiling itself: the ceiling needs
 * the card's CEFR level, which v3.7 passes as INPUT and forbids in the output,
 * so a card alone cannot be judged against it. A batch that carries its
 * manifest could be, and that is the obvious extension.
 */
const UNLISTED_IN_OXFORD = new Set([
  "charger", "snack", "swimsuit", "tasty", "motorbike", "heater", "hike", "lantern", "breathless",
]);

/** American spellings the prompt asks to be written the British way. */
const US_SPELLINGS: Record<string, string> = {
  color: "colour", center: "centre", favorite: "favourite", neighbor: "neighbour",
  theater: "theatre", traveling: "travelling", organize: "organise", realize: "realise",
  meter: "metre", liter: "litre", gray: "grey", defense: "defence",
};

/** The three animated sentences, in the order emphasisVi must match. */
const EMPHASIS_SOURCES = ["defVi", "leadVi", "anticipateVi"] as const;

/** Compare a highlight against its sentence the way the app will: marks removed. */
function plain(text: string): string {
  return stripMarks(stripEmphasisMarkers(text)).toLowerCase();
}

/**
 * EMPHASIS VALIDATION (E6): three entries, each belonging to its own sentence.
 *
 * v3.7 made emphasisVi positional — [defVi, leadVi, anticipateVi] — which is a
 * stronger claim than the old "occurs somewhere in the clues". An entry that
 * matches the wrong sentence used to pass and now cannot, because the app
 * animates each sentence with its own word and a mismatch glows nothing.
 */
function checkEmphasisTriple(record: Record<string, unknown>): IntakeFinding[] {
  const findings: IntakeFinding[] = [];
  const emphasis = record.emphasisVi;
  if (!Array.isArray(emphasis)) return findings;

  if (emphasis.length !== 3) {
    at(findings, "schema", "emphasisVi", "blocker",
      `expected exactly 3 entries, one per animated sentence, got ${emphasis.length}`);
  }

  EMPHASIS_SOURCES.forEach((source, index) => {
    const entry = emphasis[index];
    if (typeof entry !== "string" || entry.trim().length === 0) {
      if (index < emphasis.length) {
        at(findings, "schema", `emphasisVi[${index}]`, "blocker", `missing the ${source} highlight`);
      }
      return;
    }
    const needle = plain(entry);
    const haystack = plain(String(record[source] ?? ""));
    if (!haystack.includes(needle)) {
      at(findings, "schema", `emphasisVi[${index}]`, "blocker",
        `"${entry}" does not occur in ${source}`);
    }
    // A highlight may cover a join but never a bind or a phrase edge: those
    // mark two words leaning together, not one unit worth glowing.
    if (/[=|]/.test(entry)) {
      at(findings, "schema", `emphasisVi[${index}]`, "blocker",
        `"${entry}" spans a "=" or "|", which is never one lexical unit`);
    }
    if (GENERIC_INTENSIFIERS.has(needle)) {
      at(findings, "schema", `emphasisVi[${index}]`, "blocker",
        `"${entry}" is a generic intensifier, which the prompt forbids as a highlight`);
    }
    // Fillers are forbidden as the glow in the two meaning sentences, but may
    // legitimately BE the tone pivot in anticipateVi.
    if (source !== "anticipateVi" && SOFT_FILLERS.has(needle)) {
      at(findings, "schema", `emphasisVi[${index}]`, "blocker",
        `"${entry}" is a soft filler; the ${source} highlight must be the meaning word`);
    }
  });

  const written = emphasis.filter((entry): entry is string => typeof entry === "string");
  if (new Set(written.map(plain)).size !== written.length) {
    at(findings, "schema", "emphasisVi", "blocker", "the three entries must all be different words");
  }
  return findings;
}

/**
 * The rules v3.7 states that are checkable without reading Vietnamese.
 *
 * Deliberately excludes the tone rule (T1) and the compactness rule, which are
 * judgements about register rather than facts about text — a regex that tried
 * to score "would a second-year student feel spoken to as an equal" would fire
 * on good cards and miss bad ones. Those belong to the safety and verification
 * passes.
 *
 * @param raw - one candidate
 */
export function checkPromptRules(raw: unknown): IntakeFinding[] {
  const findings: IntakeFinding[] = [];
  if (typeof raw !== "object" || raw === null) return findings;
  const record = raw as Record<string, unknown>;

  // meaningVi is a dictionary gloss, not a sentence: 1-4 words, 40 characters,
  // no full stop. A second gloss is allowed only after ", ".
  const meaning = typeof record.meaningVi === "string" ? record.meaningVi.trim() : "";
  if (meaning.length > 0) {
    const clean = stripMarks(meaning);
    const ending = L.sentenceEnd.find((mark) => clean.endsWith(mark));
    if (ending !== undefined) {
      at(findings, "content", "meaningVi", "blocker", `ends with "${ending}"; a gloss is not a sentence`);
    }
    const ceiling = L.limits.meaning.maxChars ?? L.limits.meaning.max;
    if (clean.length > ceiling) {
      at(findings, "content", "meaningVi", "blocker", `${clean.length} characters; at most ${ceiling}`);
    }
    // Both alternatives together, as v3.7 states the rule. The separator is not
    // content, so it is spent before counting rather than counted as a word.
    const size = measureLength(clean.replace(/[,;、]/g, " "), L);
    if (size > L.glossUnits) {
      at(
        findings,
        "content",
        "meaningVi",
        "blocker",
        `${describeLength(size, L)}; a gloss is 1-${L.glossUnits}`,
      );
    }
  }

  const usageEn = typeof record.usageEn === "string" ? record.usageEn : "";
  if (usageEn.length > 0) {
    for (const token of usageEn.toLowerCase().match(/[a-z']+/g) ?? []) {
      if (UNLISTED_IN_OXFORD.has(token)) {
        at(findings, "content", "usageEn", "blocker",
          `"${token}" is not in the Oxford list, so it is banned at every level`);
      }
      const british = US_SPELLINGS[token];
      if (british !== undefined) {
        at(findings, "content", "usageEn", "blocker", `"${token}" is US spelling; write "${british}"`);
      }
    }
    // A join beside the answer blank would be read as part of it.
    if (/[A-Za-z]_[A-Za-z]/.test(usageEn)) {
      at(findings, "content", "usageEn", "blocker", "contains a join; usageEn must carry no underscore but the blank");
    }
  }

  // The answer must not appear in any field the learner reads before guessing.
  const word = typeof record.word === "string" ? record.word.trim() : "";
  if (word.length > 0) {
    for (const field of ["meaningVi", "defVi", "leadVi", "anticipateVi"] as const) {
      const value = record[field];
      if (typeof value !== "string") continue;
      if (containsTargetWord(stripMarks(stripEmphasisMarkers(value)), word)) {
        at(findings, "content", field, "blocker", "contains the English answer");
      }
    }
  }

  return findings;
}

/**
 * The rules that only a whole batch can break.
 *
 * A card is judged alone everywhere else, but v3.7 has two rules about the
 * SHAPE of a batch — one target per headword, and tone words that do not
 * repeat — and neither is visible from inside a single card.
 *
 * @param records - every candidate in the run
 * @returns findings keyed by candidate id
 */
export function checkBatchRules(records: readonly IntakeRecord[]): Map<string, IntakeFinding[]> {
  const extra = new Map<string, IntakeFinding[]>();
  const add = (id: string, finding: IntakeFinding): void => {
    extra.set(id, [...(extra.get(id) ?? []), finding]);
  };

  // B1: never duplicate, omit or reorder a target. A repeated headword means
  // one of the requested words lost its slot.
  const seen = new Map<string, string>();
  for (const record of records) {
    const key = record.word.trim().toLowerCase();
    if (key.length === 0) continue;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, record.id);
    else add(record.id, { stage: "schema", field: "word", severity: "blocker",
      message: `"${record.word}" already appears in this batch; a target may not be duplicated` });
  }

  // E5/F: vary the anticipateVi tone word — none on more than about one card
  // in eight, or the deck develops a tic the reader starts to hear.
  const cap = Math.max(1, Math.round(records.length / 8));
  const tally = new Map<string, string[]>();
  for (const record of records) {
    const raw = record.raw as Record<string, unknown> | null;
    const emphasis = raw?.emphasisVi;
    if (!Array.isArray(emphasis) || typeof emphasis[2] !== "string") continue;
    const tone = plain(emphasis[2]);
    if (tone.length === 0) continue;
    tally.set(tone, [...(tally.get(tone) ?? []), record.id]);
  }
  for (const [tone, ids] of tally) {
    if (ids.length <= cap) continue;
    for (const id of ids) {
      add(id, { stage: "content", field: "emphasisVi[2]", severity: "warn",
        message: `tone word "${tone}" is used on ${ids.length} of ${records.length} cards; about ${cap} is the cap` });
    }
  }

  return extra;
}

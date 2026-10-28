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
 * Depends on: ./contract.ts, ./deck.ts, ./types.ts
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

  // Types, for the fields that are present.
  for (const field of ["word", "pos", "ipa", "meaningVi", "defVi", "leadVi", "anticipateVi", "usageEn", "usageVi"]) {
    if (field in record && typeof record[field] !== "string") {
      at(findings, "schema", field, "blocker", `expected a string, got ${typeof record[field]}`);
    }
  }
  for (const field of ["topics", "exams", "emphasisVi"]) {
    if (field in record && !Array.isArray(record[field])) {
      at(findings, "schema", field, "blocker", `expected an array, got ${typeof record[field]}`);
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

  // Emphasis must be present and must actually occur in the text it marks.
  const emphasis = record.emphasisVi;
  if (Array.isArray(emphasis)) {
    if (emphasis.length === 0) {
      at(findings, "schema", "emphasisVi", "warn", "no emphasis phrase offered");
    }
    // Compared with the marks removed from both sides: an emphasis phrase is
    // stored PLAIN while the text it quotes carries joins, so "thu gom" against
    // "thu_gom" is a match and a raw comparison would reject every correctly
    // marked card.
    const sources = stripMarks(
      `${stripEmphasisMarkers(String(record.defVi ?? ""))} ${stripEmphasisMarkers(String(record.leadVi ?? ""))}`,
    );
    for (const phrase of emphasis) {
      if (typeof phrase !== "string") continue;
      if (!sources.includes(stripMarks(phrase.trim()))) {
        at(findings, "schema", "emphasisVi", "blocker", `"${phrase}" does not occur in defVi or leadVi`);
      }
    }
  }

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

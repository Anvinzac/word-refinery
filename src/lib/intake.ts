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
 * Exports: IntakeStage, Severity, IntakeFinding, ManifestRow, asManifest, checkManifest, IntakeRecord, IntakeVerdict,
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
import {
  countableTokens,
  levelOf,
  type CefrWordList,
} from "./cefr-words.ts";
import { stripEmphasisMarkers } from "./emphasis.ts";
import { activeGlossProfile, describeLength, displayText, measureLength } from "./lang.ts";
import { CEFR_LEVELS, type CefrLevel, type Deck, type DeckWord } from "./types.ts";

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
    // Anything the deck validator calls an error would be reported again after
    // import, so it blocks. What it calls a warning is an aim the language
    // states as advice, and blocking a batch over advice would be refusing
    // cards the rules themselves pass.
    severity: issue.severity === "warning" ? ("warn" as const) : ("blocker" as const),
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

/**
 * Words v3.7 names as sitting ABOVE a level, with the level they sit at.
 *
 * The Oxford 3000/5000 list itself is not here and must never be: its licence
 * does not permit redistribution, which is why the level ceiling could not be
 * enforced at all. What CAN be enforced is the handful of words the prompt
 * spells out by name, as its own worked examples of words that feel easier than
 * they are listed. Everything else still needs a reader with the list.
 */
const ABOVE_LEVEL: Readonly<Record<string, CefrLevel>> = {
  kid: "A2", yet: "A2", already: "A2", abroad: "A2", top: "A2", hill: "A2",
  bit: "A2", borrow: "A2", joke: "A2",
  staff: "B1", rent: "B1", nail: "B1", roll: "B1", bite: "B1", childhood: "B1",
  nearby: "B2", contest: "B2",
};

/**
 * Padding the prompt names verbatim and asks to be cut.
 *
 * Only the phrases it actually lists. The wider compactness rule - "never stack
 * two near-synonyms joined by hay, hoặc, và" - is NOT here: tried over this
 * pack it fired on 235 of 500 cards, almost all of them real disjunctions the
 * rule explicitly permits ("hai hay nhiều", "tin và nhạc"). Telling a near
 * synonym from a genuine choice is the judgement the rule is asking for, and a
 * regex that cannot make it is worse than no check.
 */
const NAMED_PADDING = [
  "một cách", "nhất định", "mang tính", "gì đó", "nào đó",
  "thực hiện việc", "tiến hành", "đưa ra quyết định", "có sự thay đổi", "làm việc gì",
];

/** Voice markers T1 rules out, limited to the ones that cannot mean anything else. */
const NURSERY_MARKERS = ["em bé", "cô giáo mầm non", "mầm non", "mẫu giáo", "ru ngủ"];

/** Fillers T1 names as dropping the age of a line. */
const BABY_FILLERS = ["ui", "ơi", "nè", "dễ thương ghê"];

/** Slang T1 forbids outright. */
const HARSH_SLANG = ["xỉu", "đúng bài", "flex", "spoil"];

/** American spellings the prompt asks to be written the British way. */
const US_SPELLINGS: Record<string, string> = {
  color: "colour", center: "centre", favorite: "favourite", neighbor: "neighbour",
  theater: "theatre", traveling: "travelling", organize: "organise", realize: "realise",
  meter: "metre", liter: "litre", gray: "grey", defense: "defence",
};

/**
 * Whether a word only ever appears where a softener appears.
 *
 * Vietnamese sentence-final particles are fillers in that position and content
 * words elsewhere: "đi thôi" is a nudge, "thôi học" is to quit. The test is
 * therefore positional, not lexical - the word is treated as a filler only when
 * EVERY occurrence of it closes a clause, which is where a softener can sit.
 *
 * @param sentence - the field, marks already stripped
 * @param word - the candidate, lowercased and plain
 */
function endsEveryClause(sentence: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const occurrences = [...sentence.matchAll(new RegExp(escaped, "gu"))];
  if (occurrences.length === 0) return false;
  return occurrences.every((match) => {
    const after = sentence.slice(match.index + word.length);
    // Nothing but a clause boundary may follow: end of field, or punctuation.
    return /^\s*([,;.!?…]|$)/u.test(after);
  });
}

/** Whether a word occurs as a whole word, not inside a longer one. */
function hasWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}])${escaped}([^\\p{L}]|$)`, "u").test(text);
}

/** The card field each emphasis slot glows in. */
const SLOT_FIELDS = {
  def: "defVi",
  lead: "leadVi",
  anticipate: "anticipateVi",
  usageGloss: "usageVi",
} as const;

/**
 * The three animated sentences, in the order emphasisVi must match them.
 *
 * Read from the profile rather than written out, because the two gloss
 * languages disagree about the third and lang.ts says so at `emphasisSlots`:
 * card-prompt v3.7 puts it in anticipateVi, the Japanese rules put it in the
 * usage sentence and give the teaser no glow at all. Hardcoding either one
 * reports every card of the OTHER language as glowing a word its own sentence
 * does not contain — and for Japanese that is every card, since the third
 * highlight is the answer reveal and lives in usageJa.
 *
 * The slot travels with the field name because one rule below is about the
 * SLOT (a filler may legitimately be the tone pivot of a teaser) while the
 * rest are about the field the reviewer has to open.
 */
const EMPHASIS_SOURCES = L.emphasisSlots.map((slot) => ({ slot, field: SLOT_FIELDS[slot] }));

/**
 * Compare a highlight against its sentence the way the app will: as displayed.
 *
 * `displayText` rather than a bare `stripMarks`, because the two languages
 * disagree about what a bond leaves behind and the profile is what knows.
 * Vietnamese writes every syllable a space apart, so a bond becomes a space and
 * `thu_gom` reads as `thu gom`. Japanese writes the pieces a bond joins FLUSH,
 * so a bond becomes nothing and `頭を_抱える` reads as `頭を抱える` — strip the
 * marks the Vietnamese way and every Japanese highlight that spans a bond
 * looks absent from its own sentence. For Vietnamese the two are the same
 * function, so this changes nothing there.
 */
function plain(text: string): string {
  return displayText(stripEmphasisMarkers(text), L).toLowerCase();
}

/**
 * Whether a slot holds a MEANING WORD, rather than a reveal or a tone pivot.
 *
 * The first two entries are the same thing in both languages: the content word
 * nearest in meaning to the target, glowing in the definition and again in the
 * scene. The THIRD is not that in either language — v3.7 puts it in the teaser,
 * where a tone word is the whole point, and v3.9 puts it in the usage sentence,
 * where it IS the answer being revealed.
 *
 * So the two bans that exist to keep the glow on something meaningful apply to
 * the first two slots and never the third. `considerably` reveals 「かなり」,
 * and かなり is a banned degree adverb — as a MEANING word. As the answer it is
 * simply the answer, and rejecting it asks the card to reveal something other
 * than the word it teaches. v3.9's own validator draws the line in the same
 * place, applying those bans to [0] and [1] only.
 */
function isMeaningSlot(slot: (typeof EMPHASIS_SOURCES)[number]["slot"]): boolean {
  return slot === "def" || slot === "lead";
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

  EMPHASIS_SOURCES.forEach(({ slot, field: source }, index) => {
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
    if (isMeaningSlot(slot) && GENERIC_INTENSIFIERS.has(needle)) {
      at(findings, "schema", `emphasisVi[${index}]`, "blocker",
        `"${entry}" is a generic intensifier; the ${source} highlight must be the meaning word`);
    }
    // Fillers are forbidden as the glow in the two meaning sentences, but may
    // legitimately BE the tone pivot in anticipateVi - and several of them are
    // only fillers in one POSITION. "thôi" at the end of a line is a softener;
    // "Thôi không=làm tiếp" opens with the verb meaning to cease, which is
    // exactly the meaning word a card for "stop" should glow. Flagging by the
    // word alone rejected that card.
    //
    // Guarded by the SLOT rather than by the name "anticipate": Japanese has no
    // anticipate slot - its third is the usage sentence - so naming that one
    // language's third slot let this ban through onto the other's answer reveal.
    if (isMeaningSlot(slot) && SOFT_FILLERS.has(needle) && endsEveryClause(haystack, needle)) {
      at(findings, "schema", `emphasisVi[${index}]`, "blocker",
        `"${entry}" is a soft filler here; the ${source} highlight must be the meaning word`);
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
 * @param level - the level the card was ASKED for, from the batch manifest.
 *   v3.7 passes it in and forbids it in the output, so a card alone cannot be
 *   held to its own ceiling; without it the level-scoped rules are skipped
 *   rather than guessed.
 * @param words - a CEFR word list, when the reviewer supplied one. With it, U1
 *   is enforced on EVERY word of the example. Without it, only on the handful
 *   v3.7 names by hand, which at B2 is nothing at all: the list cannot be
 *   carried in this package, so it is an input rather than an asset. See
 *   ./cefr-words.ts.
 */
export function checkPromptRules(
  raw: unknown,
  level?: CefrLevel,
  words?: CefrWordList,
): IntakeFinding[] {
  const findings: IntakeFinding[] = [];
  if (typeof raw !== "object" || raw === null) return findings;
  const record = raw as Record<string, unknown>;

  // meaningVi is a dictionary gloss, not a sentence: 1-4 words, 40 characters,
  // no full stop. A second gloss is allowed only after ", ".
  const meaning = typeof record.meaningVi === "string" ? record.meaningVi.trim() : "";
  if (meaning.length > 0) {
    const clean = displayText(meaning, L);
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

  // "IPA in slashes" - cheap to state, and a card without them renders the
  // pronunciation line as bare text.
  const ipa = typeof record.ipa === "string" ? record.ipa.trim() : "";
  if (ipa.length > 0 && !/^\/.+\/$/u.test(ipa)) {
    at(findings, "content", "ipa", "blocker", `"${ipa}" is not IPA in slashes`);
  }

  const usageEn = typeof record.usageEn === "string" ? record.usageEn : "";
  if (usageEn.length > 0) {
    const tokens = usageEn.toLowerCase().match(/[a-z']+/g) ?? [];
    for (const token of tokens) {
      if (UNLISTED_IN_OXFORD.has(token)) {
        at(findings, "content", "usageEn", "blocker",
          `"${token}" is not in the Oxford list, so it is banned at every level`);
      }
      // The hand-written ceiling, for the words v3.7 names. Superseded by a
      // real list where one was supplied, and left in place where none was:
      // the prompt names these because they are the ones it kept seeing.
      const sits = level === undefined || words !== undefined ? undefined : ABOVE_LEVEL[token];
      if (sits !== undefined && CEFR_LEVELS.indexOf(sits) > CEFR_LEVELS.indexOf(level!)) {
        at(findings, "content", "usageEn", "blocker",
          `"${token}" is a ${sits} word, above this card's ${level} ceiling`);
      }
      const british = US_SPELLINGS[token];
      if (british !== undefined) {
        at(findings, "content", "usageEn", "blocker", `"${token}" is US spelling; write "${british}"`);
      }
    }

    // U1 proper: every word of the example at or below the card's own level.
    // Both halves of the rule are errors, and the second is the one a writer
    // forgets — a word the list does not have is as much a violation as a word
    // above the ceiling, because an unlisted word has no level to be below.
    if (words !== undefined && level !== undefined) {
      const ceiling = CEFR_LEVELS.indexOf(level);
      const already = new Set<string>();
      for (const counted of countableTokens(usageEn)) {
        const { token } = counted;
        if (already.has(token)) continue;
        already.add(token);
        const sits = levelOf(words, token);
        if (sits === undefined) {
          // A name is exempt from U1 and no levelled list carries names, so an
          // unlisted word that opened the sentence with a capital may be
          // either. Said as a warning rather than guessed either way: calling
          // "London" a vocabulary error is the one outcome a reviewer cannot
          // act on.
          const mayBeName = counted.capitalised && counted.opensSentence;
          at(findings, "content", "usageEn", mayBeName ? "warn" : "blocker",
            mayBeName
              ? `"${token}" is not in ${words.name}, but it opens the sentence with a capital — a name, which U1 exempts, or a word to replace`
              : `"${token}" is not in ${words.name}, so it has no level to be below — use a listed word`);
        } else if (CEFR_LEVELS.indexOf(sits) > ceiling) {
          at(findings, "content", "usageEn", "blocker",
            `"${token}" is a ${sits} word, above this card's ${level} ceiling`);
        }
      }
    }
    if (tokens.length > 20) {
      at(findings, "content", "usageEn", "blocker", `${tokens.length} words; at most 20`);
    }
    // Exactly one blank, exactly five underscores: the app splits on it.
    const blanks = usageEn.match(/_{2,}/g) ?? [];
    if (blanks.length !== 1 || blanks[0] !== "_____") {
      at(findings, "content", "usageEn", "blocker",
        blanks.length === 0
          ? 'no answer blank; the target word is replaced by exactly five underscores'
          : `the blank is ${blanks.map((b) => `"${b}"`).join(", ")}; expected exactly one "_____"`);
    }
    // A join beside the answer blank would be read as part of it.
    if (/[A-Za-z]_[A-Za-z]/.test(usageEn)) {
      at(findings, "content", "usageEn", "blocker", "contains a join; usageEn must carry no underscore but the blank");
    }
  }

  // Wording the prompt names outright. Warnings, not defects: each one is a
  // phrase v3.7 asks to be cut, but cutting it is a rewrite that only a reader
  // can judge - "giờ nhất_định" is the padding the rule names and also the only
  // way to say "a fixed time".
  for (const field of ["meaningVi", "defVi", "leadVi", "anticipateVi", "usageVi"] as const) {
    const value = typeof record[field] === "string" ? displayText(record[field] as string, L) : "";
    if (value.length === 0) continue;
    const lower = value.toLowerCase();
    for (const phrase of NAMED_PADDING) {
      if (lower.includes(phrase)) {
        at(findings, "content", field, "warn", `"${phrase}" is padding v3.7 names; spend the slot on a concrete detail`);
      }
    }
    if (field === "meaningVi" || field === "usageVi") continue;
    for (const marker of NURSERY_MARKERS) {
      if (lower.includes(marker)) {
        at(findings, "content", field, "warn", `"${marker}" is a nursery scene; T1 writes to 15-22 year olds`);
      }
    }
    for (const filler of BABY_FILLERS) {
      if (hasWord(lower, filler)) {
        at(findings, "content", field, "warn", `"${filler}" is a baby-cute filler; T1 rules it out`);
      }
    }
    for (const slang of HARSH_SLANG) {
      if (hasWord(lower, slang)) {
        at(findings, "content", field, "warn", `"${slang}" is slang T1 forbids`);
      }
    }
    const stacked = [...SOFT_FILLERS].filter((filler) => hasWord(lower, filler));
    if (stacked.length > 1) {
      at(findings, "content", field, "warn",
        `stacks soft fillers (${stacked.join(", ")}); T1 allows at most one per sentence`);
    }
  }

  // The answer must not appear in any field the learner reads before guessing.
  const word = typeof record.word === "string" ? record.word.trim() : "";
  if (word.length > 0) {
    for (const field of ["meaningVi", "defVi", "leadVi", "anticipateVi"] as const) {
      const value = record[field];
      if (typeof value !== "string") continue;
      if (containsTargetWord(displayText(stripEmphasisMarkers(value), L), word)) {
        at(findings, "content", field, "blocker", "contains the English answer");
      }
    }
  }

  return findings;
}

/** One row of a batch manifest: what was ASKED for, before any card existed. */
export interface ManifestRow {
  id: string;
  word: string;
  level?: CefrLevel;
  /** The part of speech requested, as the input list wrote it. */
  input_pos?: string;
  /** The part of speech the card was written for, where they differ. */
  card_pos?: string;
  /** "accepted", or an exclusion. */
  status?: string;
  note?: string;
}

/** Read a parsed file as a manifest, or null when it is not one. */
export function asManifest(parsed: unknown): ManifestRow[] | null {
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const rows = parsed as Array<Record<string, unknown>>;
  // A manifest row names a target; a card describes one. The discriminator is
  // the Vietnamese: a row has none.
  const looksLikeManifest = rows.every(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      typeof row.id === "string" &&
      typeof row.word === "string" &&
      row.defVi === undefined,
  );
  return looksLikeManifest ? (rows as unknown as ManifestRow[]) : null;
}

/**
 * BATCH INTEGRITY (B1): the output against the manifest it was asked for.
 *
 * This is the rule no card can be checked against on its own, and until the
 * manifest travelled with the batch it could not be checked at all. What it
 * catches is the failure a reviewer reading cards one at a time never sees: a
 * target silently dropped, a headword swapped for a synonym, a card written
 * for a different part of speech, or an exclusion disguised as a card.
 *
 * Position is the mapping. v3.7 asks for one card per target IN ORDER, so a
 * manifest that no longer lines up is itself the finding — reordering it to
 * make the words match would hide exactly what B1 exists to surface.
 *
 * @param records - every candidate in the run, in file order
 * @param manifest - the batch's manifest, in its own order
 * @returns findings keyed by candidate id, plus any that belong to no card
 */
export function checkManifest(
  records: readonly IntakeRecord[],
  manifest: readonly ManifestRow[],
): { byRecord: Map<string, IntakeFinding[]>; batch: IntakeFinding[] } {
  const byRecord = new Map<string, IntakeFinding[]>();
  const batch: IntakeFinding[] = [];
  const add = (id: string, finding: IntakeFinding) => {
    const held = byRecord.get(id) ?? [];
    held.push(finding);
    byRecord.set(id, held);
  };

  const expected = manifest.filter((row) => (row.status ?? "accepted") === "accepted");
  if (records.length !== expected.length) {
    batch.push({
      stage: "schema",
      field: "batch",
      severity: "blocker",
      message:
        `${records.length} card(s) for ${expected.length} eligible target(s) — ` +
        "B1 asks for exactly one each, with exclusions kept in their own record",
    });
  }

  const seen = new Set<string>();
  for (const row of manifest) {
    if (seen.has(row.id)) {
      batch.push({
        stage: "schema",
        field: "batch",
        severity: "blocker",
        message: `the manifest uses id "${row.id}" twice`,
      });
    }
    seen.add(row.id);
  }

  records.forEach((record, index) => {
    const row = manifest[index];
    if (row === undefined) {
      add(record.id, {
        stage: "schema",
        field: "word",
        severity: "blocker",
        message: "no manifest row at this position; the batch is longer than what was asked for",
      });
      return;
    }
    if (row.word.toLowerCase() !== record.word.toLowerCase()) {
      add(record.id, {
        stage: "schema",
        field: "word",
        severity: "blocker",
        message: `position ${index + 1} was asked for "${row.word}" but carries "${record.word}" — B1 forbids substituting a target`,
      });
    }
    if ((row.status ?? "accepted") !== "accepted") {
      add(record.id, {
        stage: "schema",
        field: "word",
        severity: "blocker",
        message: `the manifest excludes "${row.word}" (${row.status}), so this card disguises an exclusion`,
      });
    }
    const pos = typeof record.raw === "object" && record.raw !== null
      ? (record.raw as { pos?: unknown }).pos
      : undefined;
    if (row.card_pos !== undefined && typeof pos === "string" && pos !== row.card_pos) {
      add(record.id, {
        stage: "schema",
        field: "pos",
        severity: "blocker",
        message: `written as "${pos}" but asked for as "${row.card_pos}" — B1 forbids changing the part of speech`,
      });
    }
  });

  return { byRecord, batch };
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

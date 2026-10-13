/**
 * Prompt builder — the instructions sent to whichever LLM provider is active.
 *
 * Encodes the quality bar proven on the KineMedia deck: 8–11 word Vietnamese
 * definitions and teasers, short unique invite-to-guess lines, blanked example
 * sentences, and TWO-syllable emphasis phrases copied verbatim from the text.
 * Emphasis is requested as a plain list; `lib/emphasis.ts` validates it and
 * injects the `/…/` markers, so the model never has to learn the delimiter.
 *
 * Exports: ANNOTATION_SYSTEM_PROMPT, buildBatchPrompt, buildRegeneratePrompt,
 * COMPLAINT_CHIPS, chipsForField, ComplaintChip, RefineField, RefineRequest
 * Depends on: ./types.ts, ./contract.ts
 */
import type { CorpusWord } from "./types.ts";
import { CRAWLER_ANNOTATION_FIELDS, EXAMS, TOPICS } from "./contract.ts";

/** Fields the model is allowed to return, rendered into the prompt. */
const FIELD_LIST = CRAWLER_ANNOTATION_FIELDS.join(", ");

/** Topic list rendered into the prompt so the model cannot invent tags. */
const TOPIC_LIST = TOPICS.join(", ");

/** Exam list, rendered the same way and for the same reason. */
const EXAM_LIST = EXAMS.join(", ");

/**
 * System prompt. One constant so the contract, the parser and the UI all point
 * at the same source of truth.
 */
export const ANNOTATION_SYSTEM_PROMPT = `You write Vietnamese vocabulary cards for a mobile "learn one English word at a time" app.
The reader is a Vietnamese learner who sees Vietnamese first and only later the English word.

For every requested word, return exactly one JSON object with these ${CRAWLER_ANNOTATION_FIELDS.length} fields and no others: ${FIELD_LIST}.

Field rules:
- "word": the English headword, copied exactly as given, lowercase.
- "pos": one of noun, verb, adj, adv, prep, conj, phrase.
- "ipa": IPA in slashes, e.g. "/ˈwɔː.tər/".
- "defVi": ONE Vietnamese sentence defining the word, exactly 8-11 words, at most 140 characters, no English words, full diacritics.
- "leadVi": a Vietnamese teaser hinting at the meaning without naming it, exactly 8-11 words, at most 120 characters, no English words.
- "anticipateVi": a short playful Vietnamese invitation to guess, 3-8 words, at most 60 characters. It must be DIFFERENT for every word IN THE WHOLE DECK, not merely within this batch - the user message lists lines and openings already taken, and reusing one is a defect. Vary the opening as well as the wording; never fall back on a placeholder like "Đoán xem nào…".
- "usageEn": ONE natural English example sentence of at most 20 words where the target word is replaced by exactly five underscores: _____
- "usageVi": the Vietnamese meaning of that example sentence.
- "topics": one to three lowercase tags from this closed list, most relevant FIRST: ${TOPIC_LIST}. Never invent a tag outside it — an unknown tag is discarded.
- "exams": the exams whose vocabulary lists this word genuinely belongs to, from: ${EXAM_LIST}. Use an empty array [] for ordinary everyday words — most words have none, and a wrong tag is worse than none.
- "emphasisVi": 2 Vietnamese phrases that will glow on screen. Each phrase MUST:
  * be copied EXACTLY, diacritics included, from the defVi or leadVi you just wrote,
  * be exactly TWO syllables taken from one neighbouring pair of words (never one syllable, never three or more),
  * be a meaningful unit - a noun phrase, verb phrase, or adjective + noun,
  * never be a function word such as và, là, của, có, được, trong, cho, với, một, rất, cũng, đã, đang, sẽ, không, những, các, thì, mà,
  * be at most 30 characters and unique inside the list,
  * appear MID-SENTENCE in lowercase where possible, so the highlight matcher finds it exactly.

Word joining (applies to the Vietnamese fields: defVi, leadVi, anticipateVi, usageVi):
Vietnamese is written one syllable at a time, so "ba lô" (a backpack) looks exactly like two unrelated words and a card may break the line between them. Join the syllables of ONE word with a single underscore, and leave an ordinary space between different words.
  Sáng nào cũng đeo ba_lô ra cửa.
  Điều /quan_trọng/ nhất là sức_khỏe.
- A join is ONE underscore with a letter or digit directly on both sides: no space before it, no space after it.
- JOIN compound words (học_sinh, điện_thoại, thư_viện, sức_khỏe) and reduplicated words (thình_thịch, lấp_lánh, nhẹ_nhàng).
- DO NOT join these three, ever:
  * function words — "của tôi", "rất đẹp", "đã đi", "sẽ về", "không biết"
  * a classifier and its noun — "con mèo", "cái bàn", "chiếc xe", "quyển sách"
  * a free verb-object pair — "ăn cơm", "đọc sách", "uống nước", "rửa tay"
  A verb-object pair is free when it still means the sum of its parts. Join it only when the pair has a meaning the parts do not give on their own, which makes it one lexical word: "ăn_mừng" (to celebrate), "ăn_năn" (to repent).
- DO NOT join anything else either. Only compounds and reduplicated words take a join.
- When you are not sure two syllables are one word, DO NOT join them. A missing join only allows a line break; a wrong join glues two words into a block that cannot wrap and shrinks the whole page.
- A join does NOT change a word count. "quan_trọng" is TWO of the 8-11 words, not one. Count syllables exactly as if the underscores were spaces.
- Never use an underscore for anything else: no snake_case, no emphasis, no decoration. Any single underscore between two letters will be read as a join. The five-underscore blank "_____" in usageEn is not a join and is unaffected.
- "emphasisVi" entries are written PLAIN, with a space where the text has a join: for /quan_trọng/ in defVi, the emphasis entry is "quan trọng".
- NEVER put an underscore in "usageEn". That field carries the five-underscore answer blank, and a join beside it would be read as part of the blank. English words wrap safely on their own.
- The reader never sees the underscore; the app replaces it when the deck loads.

Hard rules:
- Write correct Vietnamese with full diacritics in every Vietnamese field.
- Never include the English target word, or any English word, in defVi, leadVi or anticipateVi.
- Never define a word with the word itself or an obvious cognate.
- Never add a "level" field or any field outside the ${CRAWLER_ANNOTATION_FIELDS.length} listed - difficulty is handled outside this request.
- Return ONLY a JSON array with one object per requested word, in the requested order. No markdown fences, no headings, no commentary.

Minimal example of the expected format (one word, shortened):
[{"word":"water","pos":"noun","ipa":"/ˈwɔː.tər/","defVi":"Chất_lỏng trong suốt mà ta uống mỗi ngày.","leadVi":"Có thứ này thì cây_cối mới sống được.","anticipateVi":"Thứ gì chảy được nhỉ?","usageEn":"Please bring me a glass of _____.","usageVi":"Làm ơn mang cho tôi một cốc nước.","topics":["nature","daily"],"exams":[],"emphasisVi":["Chất lỏng","cây cối"]}]
(Note the example: "Chất_lỏng" is one word written as two syllables, so defVi still counts 9 words; the emphasisVi entry for it is written plain as "Chất lỏng".)`;

/**
 * Render one batch of corpus words as the user message.
 * @param words - corpus words for this batch (already frequency-sorted)
 */
export function buildBatchPrompt(words: readonly CorpusWord[], avoid = ""): string {
  const lines = words.map((entry, index) => {
    const hint = entry.pos.length > 0 ? `, ${entry.pos}` : "";
    return `${index + 1}. ${entry.word} (${entry.level}${hint})`;
  });
  // The avoid list sits AFTER the words and before the final instruction: the
  // constraint it expresses is about what to write, so it belongs next to the
  // request rather than buried above the list it applies to.
  const parts = [
    `Annotate these ${words.length} English words.`,
    "The CEFR level in brackets only tells you how simple the Vietnamese must be - do not echo it.",
    "",
    lines.join("\n"),
  ];
  if (avoid.trim().length > 0) parts.push("", avoid);
  parts.push("", `Return the JSON array with exactly ${words.length} objects, in this order.`);
  return parts.join("\n");
}

/** Vietnamese fields a reviewer can hand back for a rewrite. */
export type RefineField = "defVi" | "leadVi" | "anticipateVi" | "usageVi";

/**
 * One tappable complaint. The label is what the reviewer sees in the Review
 * table; the instruction is the sentence the model is given, so a two-word chip
 * still arrives as a clear order. Keeping both here is what stops the UI's
 * wording and the prompt's wording from drifting apart.
 */
export interface ComplaintChip {
  id: string;
  label: string;
  instruction: string;
  /** Fields the chip is offered for. Omitted means every field. */
  fields?: readonly RefineField[];
}

/** The complaint vocabulary, shared by the Review table and the prompt builder. */
export const COMPLAINT_CHIPS: readonly ComplaintChip[] = [
  {
    id: "too-long",
    label: "Too long",
    instruction: "It runs past the allowed length. Cut it down to the required word count.",
  },
  {
    id: "too-short",
    label: "Too short",
    instruction: "It is shorter than the required word count. Expand it without padding.",
  },
  {
    id: "wrong-meaning",
    label: "Wrong meaning",
    instruction: "It does not match what the English headword actually means. Fix the semantics.",
  },
  {
    id: "leaks-answer",
    label: "Gives it away",
    instruction:
      "It reveals the English headword, a cognate, or a transliteration. Remove the giveaway so the word stays guessable.",
  },
  {
    id: "awkward",
    label: "Awkward",
    instruction: "The phrasing is clumsy. Rewrite it so it reads like fluent written Vietnamese.",
  },
  {
    id: "unnatural",
    label: "Unnatural",
    instruction:
      "No Vietnamese speaker would phrase it this way. Use an idiomatic turn of phrase instead.",
  },
  {
    id: "too-hard",
    label: "Too hard",
    instruction:
      "The vocabulary is too advanced for a beginner. Use plain everyday Vietnamese words.",
  },
  {
    id: "too-formal",
    label: "Too stiff",
    instruction: "The register is too formal. Make it warmer and more conversational.",
  },
  {
    id: "generic",
    label: "Too generic",
    instruction:
      "It is vague boilerplate that would fit dozens of other words. Make it specific to this one.",
    fields: ["defVi", "leadVi", "anticipateVi"],
  },
  {
    id: "diacritics",
    label: "Bad diacritics",
    instruction: "Some syllables are missing or carry the wrong diacritics. Write correct Vietnamese orthography.",
  },
  {
    id: "weak-hint",
    label: "Hint too weak",
    instruction:
      "The teaser does not point at the meaning clearly enough to be guessable. Sharpen the hint while still not naming the word.",
    fields: ["leadVi"],
  },
  {
    id: "not-playful",
    label: "Not playful",
    instruction: "It reads flat. Make the invitation to guess livelier and more inviting.",
    fields: ["anticipateVi"],
  },
  {
    id: "example-mismatch",
    label: "Doesn't match example",
    instruction:
      "It is not a faithful translation of the English example sentence. Translate that sentence accurately.",
    fields: ["usageVi"],
  },
];

/** The chips offered for one field, in declaration order. */
export function chipsForField(field: RefineField): readonly ComplaintChip[] {
  return COMPLAINT_CHIPS.filter((chip) => chip.fields === undefined || chip.fields.includes(field));
}

/** Constraint reminder per field, so a one-field rewrite still knows its own limits. */
const FIELD_RULES: Record<RefineField, string> = {
  defVi:
    "ONE Vietnamese sentence defining the word: exactly 8-11 words, at most 140 characters, no English, full diacritics, and it must never contain the headword or a cognate.",
  leadVi:
    "A Vietnamese teaser hinting at the meaning without naming it: exactly 8-11 words, at most 120 characters, no English, full diacritics.",
  anticipateVi:
    "A short playful Vietnamese invitation to guess: 3-8 words, at most 60 characters, and unlike any stock placeholder.",
  usageVi:
    "The Vietnamese meaning of the English example sentence: natural spoken register, full diacritics, faithful to the English.",
};

/**
 * The joining convention, restated for a single-field rewrite.
 *
 * A rewrite is one field in isolation, so it cannot infer the convention from
 * the surrounding text — and a field that comes back unjoined would quietly
 * undo the joins the rest of the deck has.
 */
const JOIN_RULE =
  'Join the syllables of ONE Vietnamese word with a single underscore and leave ordinary spaces between words: "ba_lô", "quan_trọng", "sức_khỏe". Join only compounds and reduplicated words. Never join a function word ("của tôi"), a classifier and its noun ("con mèo"), or a free verb-object pair ("ăn cơm"); when unsure, do not join. A join does NOT change the word count — "quan_trọng" counts as two words. Use the underscore for nothing else.';

/**
 * Everything the reviewer said about one field, assembled by the Review table.
 * The three sources stack rather than compete: tapped chips name the defect,
 * the note adds whatever no chip covers, and the validator's own findings ride
 * along so one rewrite can settle all of them.
 */
export interface RefineRequest {
  field: RefineField;
  /** Ids of the chips tapped for this field. */
  chips: readonly string[];
  /** The reviewer's free-text request, passed through verbatim. */
  note: string;
  /** Validator messages already raised against this field. */
  issues: readonly string[];
}

/**
 * Prompt used when a reviewer sends one field back for a rewrite.
 *
 * Keeps the whole word in view so the rewrite cannot drift from the other
 * fields, then states the complaint as an explicit, numbered brief built from
 * the chips, the note and the validator.
 *
 * @param word - the deck word being refined
 * @param request - the field plus the reviewer's combined feedback
 */
export function buildRegeneratePrompt(
  word: {
    word: string;
    defVi: string;
    leadVi: string;
    anticipateVi: string;
    usage: Array<{ en: string; vi: string }>;
  },
  request: RefineRequest,
): string {
  const { field, chips, note, issues } = request;
  const example = word.usage[0];

  const chipInstructions = chips
    .map((id) => COMPLAINT_CHIPS.find((chip) => chip.id === id))
    .filter((chip): chip is ComplaintChip => chip !== undefined)
    .map((chip) => `- ${chip.instruction}`);

  const brief: string[] = [...chipInstructions];
  if (issues.length > 0) {
    brief.push(
      ...issues.map((issue) => `- An automatic check already failed on this field: ${issue}.`),
    );
  }
  const trimmedNote = note.trim();
  if (trimmedNote.length > 0) {
    brief.push(`- Additional request from the reviewer, follow it exactly: ${trimmedNote}`);
  }
  if (brief.length === 0) {
    brief.push("- Nothing specific is wrong; produce a fresher, more vivid alternative.");
  }

  // `null` is the only thing dropped here: a word without an example omits two
  // lines, while the empty strings are deliberate blank lines between sections.
  const lines: Array<string | null> = [
    `Rewrite ONLY the "${field}" field for the English word "${word.word}".`,
    "",
    "The word as it stands:",
    `- defVi: ${word.defVi}`,
    `- leadVi: ${word.leadVi}`,
    `- anticipateVi: ${word.anticipateVi}`,
    example ? `- usageEn: ${example.en}` : null,
    example ? `- usageVi: ${example.vi}` : null,
    "",
    "What to fix, all of it in one rewrite:",
    brief.join("\n"),
    "",
    `Constraints for "${field}": ${FIELD_RULES[field]}`,
    `Word joining: ${JOIN_RULE}`,
    "Leave every other field alone.",
    'Return ONLY a JSON object of the form {"value": "<the rewritten field>"} with no commentary.',
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

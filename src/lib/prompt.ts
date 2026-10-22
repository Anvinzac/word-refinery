/**
 * Prompt builder — the instructions sent to whichever LLM provider is active.
 *
 * Encodes the quality bar proven on the KineMedia deck: 8–11 word Vietnamese
 * definitions and teasers, short unique invite-to-guess lines, blanked example
 * sentences, and TWO-syllable emphasis phrases copied verbatim from the text.
 * Emphasis is requested as a plain list; `lib/emphasis.ts` validates it and
 * injects the `/…/` markers, so the model never has to learn the delimiter.
 *
 * Exports: ANNOTATION_SYSTEM_PROMPT, FIELD_RULES, buildBatchPrompt,
 * REWRITE_SYSTEM_PROMPT, buildRegeneratePrompt,
 * COMPLAINT_CHIPS, chipsForField, ComplaintChip, RefineField, RefineRequest,
 * VERIFY_SYSTEM_PROMPT, buildVerifyPrompt, VerifyFinding, VerifyReport,
 * MARKUP_SYSTEM_PROMPT, buildMarkupPrompt, MARKUP_FIELDS, MarkupField,
 * STYLE_SYSTEM_PROMPT, DISTIL_SYSTEM_PROMPT, buildDistilPrompt, buildHouseVoice,
 * STYLE_AUDIT_SYSTEM_PROMPT, buildStyleAuditPrompt, buildMarkupFieldPrompt
 * Depends on: ./types.ts, ./contract.ts
 */
import type { CorpusWord } from "./types.ts";
import { CRAWLER_ANNOTATION_FIELDS, EXAMS, TOPICS, type CrawlerAnnotationField } from "./contract.ts";

/** Fields the model is allowed to return, rendered into the prompt. */
const FIELD_LIST = CRAWLER_ANNOTATION_FIELDS.join(", ");

/** Topic list rendered into the prompt so the model cannot invent tags. */
const TOPIC_LIST = TOPICS.join(", ");

/** Exam list, rendered the same way and for the same reason. */
const EXAM_LIST = EXAMS.join(", ");

/** Who the cards are for; opens both the batch and the rewrite prompt. */
const AUDIENCE =
  'The reader is a Vietnamese learner who sees Vietnamese first and only later the English word.';

/**
 * How to pick a highlighted phrase. Shared by the batch prompt, where it picks
 * one phrase per field, and by a defVi/leadVi rewrite, which picks one anew.
 */
const EMPHASIS_CHOICE = `  CHOOSE BY MEANING FIRST. Pick the phrase that carries the POINT of the sentence - the idea the learner should walk away with. The test: if the sentence were cut down to two syllables, which two would have to survive for it still to mean anything? Those are the ones. A phrase chosen because it happened to sit next to another word is a DEFECT even when it satisfies every mechanical rule below.
  * Prefer, in this order: the compound that names the concept itself (sức_khỏe, quan_trọng, thư_viện), then a vivid verb or adjective phrase (chảy xiết, lấp_lánh), then a concrete noun phrase.
  * NEVER pick filler: a classifier and its noun ("con mèo"), a number and its noun ("hai người"), a time phrase ("mỗi ngày", "hằng ngày"), a verb with a generic object ("làm việc" when the sentence is not about work), or any span that crosses a comma.
  * It must be copied EXACTLY, diacritics included, from the defVi or leadVi you just wrote.
  * Write it PLAIN, with a space where the text has a join: for "quan_trọng" in defVi, the entry is "quan trọng".
  * exactly TWO syllables - never one, never three or more. A joined compound is the ideal case, because the join already says those two syllables are one word.
  * never a function word such as và, là, của, có, được, trong, cho, với, một, rất, cũng, đã, đang, sẽ, không, những, các, thì, mà,
  * at most 30 characters and unique inside the list,
  * appear MID-SENTENCE in lowercase where possible, so the highlight matcher finds it exactly.`;

/**
 * The rule for each card field, worded once. The batch prompt lists them all;
 * a single-field rewrite quotes only the one it rewrites, so the two prompts
 * can never disagree about what a field must be.
 */
export const FIELD_RULES: Record<CrawlerAnnotationField, string> = {
  word: "the English headword, copied exactly as given, lowercase.",
  pos: "one of noun, verb, adj, adv, prep, conj, phrase.",
  ipa: 'IPA in slashes, e.g. "/ˈwɔː.tər/".',
  meaningVi:
    'the short Vietnamese EQUIVALENT of the word, one or two words ("quả_táo", "kiên_nhẫn", "tò_mò"), at most 120 characters. This is what the app shows once the answer is revealed, so write the translation a dictionary would give - NOT a sentence, and never a description. defVi is the sentence; this is the word.',
  defVi:
    "ONE Vietnamese sentence defining the word, exactly 8-11 words, at most 140 characters, no English words, full diacritics.",
  leadVi:
    "a Vietnamese teaser hinting at the meaning without naming it, exactly 8-11 words, at most 120 characters, no English words.",
  anticipateVi:
    'a short playful Vietnamese invitation to guess, 3-8 words, at most 60 characters. It must be DIFFERENT for every word IN THE WHOLE DECK, not merely within this batch - the user message lists lines and openings already taken, and reusing one is a defect. Vary the opening as well as the wording; never fall back on a placeholder like "Đoán xem nào…".',
  usageEn:
    "ONE natural English example sentence of at most 20 words where the target word is replaced by exactly five underscores: _____",
  usageVi: "the Vietnamese meaning of that example sentence.",
  topics: `one to three lowercase tags from this closed list, most relevant FIRST: ${TOPIC_LIST}. Never invent a tag outside it — an unknown tag is discarded.`,
  exams: `the exams whose vocabulary lists this word genuinely belongs to, from: ${EXAM_LIST}. Use an empty array [] for ordinary everyday words — most words have none, and a wrong tag is worse than none.`,
  emphasisVi: `2 Vietnamese phrases that will glow on screen, one drawn from defVi and one from leadVi.\n${EMPHASIS_CHOICE}`,
};

/** The joining convention, for every prompt that writes Vietnamese. */
const WORD_JOINING = `Breaking marks (applies to every Vietnamese field: meaningVi, defVi, leadVi, anticipateVi, usageVi):
Vietnamese is written one syllable at a time, so nothing in the text says where a word ends or where a phrase ends, and a card may break a line in the worst possible place. Three marks say it. None of them is seen by the reader, and none of them changes a word count.
  _  ONE WORD. Join the syllables of a single word: ba_lô, học_sinh, quan_trọng.
  =  LEANS ON ITS NEIGHBOUR. Two words that must stay on one line but are NOT one word: con=mèo, đã=đi, của=tôi.
  |  PHRASE EDGE. Put it between phrases, with a space each side: "Việc thu_gom cây trái | sau một=mùa trồng_trọt dài."
  Sáng nào cũng đeo ba_lô ra cửa.
  Điều /quan_trọng/ nhất là sức_khỏe.
- A join is ONE underscore with a letter or digit directly on both sides: no space before it, no space after it.
- "_" JOINS a single lexical word: compounds (học_sinh, điện_thoại, thư_viện, sức_khỏe), reduplicated words (thình_thịch, lấp_lánh, nhẹ_nhàng), loanwords spelled as syllables (cà_phê, ba_lô, ô_tô), multi-syllable function words (bởi_vì, tuy_nhiên, mặc_dù, cho_nên) and proper names (Việt_Nam, Hà_Nội).
- QUICK TEST for "_": could another word sit between the two syllables without breaking the meaning? "ăn [nhiều] cơm" works, so that is two words and takes "=". Nothing fits inside "ba ... lô", so that is one word and takes "_".
- A joined word is normally two syllables, occasionally three, NEVER more than four: a joined unit must fit on one line, and a long chain shrinks the whole page. Join the real words inside a phrase rather than the phrase itself: "công_nghệ thông_tin", never "công_nghệ_thông_tin".
- NEVER join these three with "_". They take "=" instead, because they are two words that merely lean together:
  * a function word and what it leans on — "của=tôi", "rất=đẹp", "đã=đi", "sẽ=về", "không=biết", "đang=ngủ" (note the difference from a multi-syllable function word like "tuy_nhiên", which IS one word)
  * a classifier and its noun — "con=mèo", "cái=bàn", "chiếc=xe", "quyển=sách"
  * a free verb-object pair — "ăn=cơm", "đọc=sách", "uống=nước", "rửa=tay"
  A verb-object pair is free when it still means the sum of its parts. Give it "_" only when the pair means something the parts do not, which makes it one lexical word: "ăn_mừng" (to celebrate), "ăn_năn" (to repent).
- "_" is for compounds and reduplicated words only. Everything that merely has to stay together takes "=".
- The difference matters because a highlight may cover a "_" and may NEVER cover a "=": "con=mèo" is a classifier plus a noun, not a phrase worth glowing.
- When you are not sure two syllables are one word, use "=" rather than "_", and when you are not sure they belong together at all, leave a plain space. A missing mark only allows a line break; a wrong one glues words into a block that cannot wrap and shrinks the whole page.
- PHRASE EDGES: put "|" where the sentence would naturally pause - between a subject and its predicate, before a prepositional or time phrase, before a relative clause. Every phrase you create must be at least TWO syllables long: "|" exists so a break can land on a phrase edge instead of stranding a lone syllable, and a one-syllable phrase cannot do that. A sentence of 8-11 words usually wants one or two "|", never one after every word.
- A join does NOT change a word count. "quan_trọng" is TWO of the 8-11 words, not one. Count syllables exactly as if the underscores were spaces.
- Never use an underscore for anything else: no snake_case, no emphasis, no decoration. Any single underscore between two letters will be read as a join. The five-underscore blank "_____" in usageEn is not a join and is unaffected.
- "emphasisVi" entries are written PLAIN, with a space where the text has a join: for /quan_trọng/ in defVi, the emphasis entry is "quan trọng".
- NEVER put an underscore in "usageEn". That field carries the five-underscore answer blank, and a join beside it would be read as part of the blank. English words wrap safely on their own.
- The reader never sees the underscore; the app replaces it when the deck loads.`;

/** Hard rules about the Vietnamese itself, binding on a rewrite as much as a batch. */
const LANGUAGE_RULES = `- Write correct Vietnamese with full diacritics in every Vietnamese field.
- Never include the English target word, or any English word, in defVi, leadVi or anticipateVi.
- Never define a word with the word itself or an obvious cognate.`;

/**
 * System prompt. One constant so the contract, the parser and the UI all point
 * at the same source of truth.
 */
export const ANNOTATION_SYSTEM_PROMPT = `You write Vietnamese vocabulary cards for a mobile "learn one English word at a time" app.
${AUDIENCE}

For every requested word, return exactly one JSON object with these ${CRAWLER_ANNOTATION_FIELDS.length} fields and no others: ${FIELD_LIST}.

Field rules:
${CRAWLER_ANNOTATION_FIELDS.map((field) => `- "${field}": ${FIELD_RULES[field]}`).join("\n")}

${WORD_JOINING}

Hard rules:
${LANGUAGE_RULES}
- Never add a "level" field or any field outside the ${CRAWLER_ANNOTATION_FIELDS.length} listed - difficulty is handled outside this request.
- Return ONLY a JSON array with one object per requested word, in the requested order. No markdown fences, no headings, no commentary.

Minimal example of the expected format (one word, shortened):
[{"word":"water","pos":"noun","ipa":"/ˈwɔː.tər/","meaningVi":"nước","defVi":"Chất_lỏng trong suốt | mà ta uống=mỗi ngày.","leadVi":"Có thứ này thì cây_cối mới sống được.","anticipateVi":"Thứ gì chảy được nhỉ?","usageEn":"Please bring me a glass of _____.","usageVi":"Làm ơn mang cho tôi một cốc nước.","topics":["nature","daily"],"exams":[],"emphasisVi":["Chất lỏng","cây cối"]}]
(Note the example: "Chất_lỏng" is one word written as two syllables, so defVi still counts 9 words; the "|" marks the phrase edge and the "=" binds a function word to its neighbour; the emphasisVi entry is written plain as "Chất lỏng", and it may not span the "=" or the "|". "meaningVi" is the bare equivalent - "nước" - not a sentence.)`;

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
export type RefineField = "meaningVi" | "defVi" | "leadVi" | "anticipateVi" | "usageVi";

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
    id: "not-an-equivalent",
    label: "Not an equivalent",
    instruction:
      "It describes the word instead of translating it. Give the bare Vietnamese equivalent a dictionary would give, one or two words.",
    fields: ["meaningVi"],
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

/** Fields whose rewrite also picks the phrase that glows on screen. */
const HIGHLIGHTED_FIELDS: ReadonlySet<RefineField> = new Set(["defVi", "leadVi"]);

/**
 * Base system prompt for every single-field rewrite.
 *
 * Holds what is true whatever the field: the audience, the joining convention,
 * the language rules and the reply shape. The field's own rule travels in the
 * user message, quoted from {@link FIELD_RULES}, so a rewrite is held to the
 * same wording as the batch that first wrote the field — without the batch
 * prompt's instruction to return eleven fields, which a rewrite must not do.
 */
export const REWRITE_SYSTEM_PROMPT = `You rewrite ONE field of a Vietnamese vocabulary card for a mobile "learn one English word at a time" app.
${AUDIENCE}

The user message gives the English word, the ID of the field to rewrite, that field's requirements, the card as it stands, and what the reviewer wants fixed. Meet every requirement and fix everything listed in a single rewrite. Leave every other field alone.

${WORD_JOINING}

Hard rules:
${LANGUAGE_RULES}
- Return ONLY a JSON object, with no markdown fences and no commentary: {"value": "<the rewritten field>"}.
- When the user message asks for a highlight, add it as a second key: {"value": "<the rewritten field>", "emphasis": "<the phrase>"}.`;

/** The phrase a field currently highlights, written plain, or null. */
function highlightOf(text: string): string | null {
  const match = /\/([^/]+)\//.exec(text);
  return match === null ? null : match[1].replace(/_/g, " ");
}

/** A card field shown to the model: marker-free, with its highlight named beside it. */
function showField(text: string): string {
  const plain = text.replace(/\/([^/]+)\//g, "$1");
  const highlight = highlightOf(text);
  return highlight === null ? plain : `${plain}   (highlighted: "${highlight}")`;
}

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
 * User message sent with {@link REWRITE_SYSTEM_PROMPT} when a reviewer sends
 * one field back.
 *
 * Names the English word and the field ID, quotes that field's rule from the
 * batch prompt, keeps the whole card in view so the rewrite cannot drift from
 * the other fields, then states the complaint as one brief built from the
 * chips, the note and the validator.
 *
 * @param word - the deck word being refined
 * @param request - the field plus the reviewer's combined feedback
 * @param avoid - the deck's taken teaser lines, as rendered for a batch; only
 *   an anticipateVi rewrite uses it
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
  avoid = "",
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

  const highlighted = HIGHLIGHTED_FIELDS.has(field);
  const otherField = field === "defVi" ? "leadVi" : "defVi";
  const otherHighlight = highlighted ? highlightOf(word[otherField]) : null;

  // `null` is the only thing dropped here: optional sections vanish whole,
  // while the empty strings are deliberate blank lines between sections.
  const lines: Array<string | null> = [
    `Rewrite ONLY the "${field}" field for the English word "${word.word}".`,
    "",
    `English word: ${word.word}`,
    `Field ID: ${field}`,
    "",
    `Requirements for "${field}":`,
    `- "${field}": ${FIELD_RULES[field]}`,
    ...(highlighted
      ? [
          "",
          `Highlight: also return "emphasis", the ONE phrase of your new ${field} that will glow on screen.`,
          EMPHASIS_CHOICE.replace("from the defVi or leadVi you just wrote", `from the ${field} you just wrote`),
          otherHighlight !== null
            ? `  * different from "${otherHighlight}", which ${otherField} already highlights.`
            : null,
        ]
      : []),
    ...(field === "anticipateVi" && avoid.trim().length > 0 ? ["", avoid] : []),
    "",
    "The card as it stands:",
    `- defVi: ${showField(word.defVi)}`,
    `- leadVi: ${showField(word.leadVi)}`,
    `- anticipateVi: ${word.anticipateVi}`,
    example ? `- usageEn: ${example.en}` : null,
    example ? `- usageVi: ${example.vi}` : null,
    "",
    "What to fix, all of it in one rewrite:",
    brief.join("\n"),
    "",
    "Leave every other field alone.",
    highlighted
      ? 'Return ONLY {"value": "<the rewritten field>", "emphasis": "<the phrase>"}.'
      : 'Return ONLY {"value": "<the rewritten field>"}.',
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

// ── Verification ────────────────────────────────────────────────────────────

/**
 * System prompt for the second pass: a reviewer, not a writer.
 *
 * Separate from the annotation prompt on purpose. A model asked to check its
 * own work in the same breath as producing it tends to ratify whatever it just
 * said; given the card as someone else's output and a list of things to look
 * for, it finds real faults. The deterministic validator already covers counts,
 * markers and leaks — this pass is for what only a reader can judge: whether
 * the Vietnamese is natural, whether the definition actually defines the word,
 * and whether the highlighted phrase is the one that carries the meaning.
 */
export const VERIFY_SYSTEM_PROMPT = `You are a strict Vietnamese editor reviewing vocabulary cards written by someone else for a mobile app. The learner sees the Vietnamese first and only later the English word.

Judge what a human reader judges. Do NOT re-count words or characters, and do NOT comment on formatting: an automatic checker already covers those. Look for:
- MEANING: does defVi actually define the English word, without drifting to a near-synonym or a different sense?
- GLOSS: is meaningVi the Vietnamese EQUIVALENT of the word - what a dictionary would give - rather than a description or a sentence? It is shown once the answer is revealed, so a clue-shaped gloss is wrong there.
- LEAK: does any Vietnamese field give the English word away - a cognate, a transliteration, or a translation so direct that the guess becomes trivial?
- NATURALNESS: would a Vietnamese speaker say it this way? Flag translationese, wrong collocations, missing or wrong diacritics.
- TEASER: does leadVi hint at the meaning without naming it, and is anticipateVi a fresh invitation rather than a stock phrase?
- EXAMPLE: does usageEn read naturally with the blank, and does usageVi translate it faithfully?
- EMPHASIS: is the highlighted phrase the one carrying the point of the sentence? A highlight sitting on filler - a classifier and its noun, a time phrase, a number - is a defect worth reporting even though nothing is strictly wrong with it.

Severity: "blocker" for anything that would mislead a learner or give the answer away; "warn" for something a careful editor would change; "note" for a preference. Say nothing about a field that is fine.

Return ONLY a JSON object:
{"verdict":"pass"|"revise","findings":[{"field":"defVi","severity":"blocker"|"warn"|"note","problem":"<what is wrong, in English, one sentence>","suggestion":"<the corrected Vietnamese, or \\"\\" when you cannot fix it>"}]}
"verdict" is "pass" only when findings is empty or holds nothing above "note". No commentary outside the JSON.`;

/** One problem the verification pass reported. */
export interface VerifyFinding {
  field: string;
  severity: "blocker" | "warn" | "note";
  problem: string;
  suggestion: string;
}

/** The verification pass's answer for one word. */
export interface VerifyReport {
  verdict: "pass" | "revise";
  findings: VerifyFinding[];
}

/**
 * Render one finished card for review.
 *
 * The English headword is given last and labelled as the answer, so the model
 * reads the Vietnamese the way a learner does before it knows what the card is
 * hiding — which is the only way to judge whether the card gives it away.
 *
 * @param word - the deck word to check, markers and joins intact
 */
export function buildVerifyPrompt(word: {
  word: string;
  pos: string;
  level: string;
  meaningVi: string;
  defVi: string;
  leadVi: string;
  anticipateVi: string;
  usage: Array<{ en: string; vi: string }>;
}): string {
  const example = word.usage[0];
  const lines: Array<string | null> = [
    "Review this card.",
    "",
    word.meaningVi.length > 0 ? `- meaningVi: ${word.meaningVi}` : null,
    `- defVi: ${word.defVi}`,
    `- leadVi: ${word.leadVi}`,
    `- anticipateVi: ${word.anticipateVi}`,
    example ? `- usageEn: ${example.en}` : null,
    example ? `- usageVi: ${example.vi}` : null,
    "",
    `The word the learner must guess is "${word.word}" (${word.pos || "unknown part of speech"}, ${word.level}).`,
    "A phrase between /slashes/ is the highlight; an underscore joins the syllables of one word and is not a typo.",
    "",
    "Return the JSON object described in the system prompt.",
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

// ── Retrofitting marks onto text that predates them ─────────────────────────

/**
 * System prompt for the markup pass.
 *
 * Every deck written before the breaking marks existed is unmarked, and there
 * is no point adding the marks to new cards while a thousand old ones go
 * without. This pass retrofits them.
 *
 * It is deliberately NOT a rewrite. The one failure that matters here is a
 * model deciding the Vietnamese could be better while it is in there: the words
 * must come back identical, mark insertion and nothing else, so the result can
 * be checked by stripping the marks and comparing. A pass that improves the
 * prose cannot be verified and quietly rewrites a reviewed deck.
 */
export const MARKUP_SYSTEM_PROMPT = `You add breaking marks to Vietnamese vocabulary-card text that was written before the marks existed. You are a typesetter, not an editor.

ABSOLUTE RULE: return the SAME WORDS in the SAME ORDER. Insert marks and change nothing else. Do not fix spelling, do not improve wording, do not add or remove a single syllable, do not touch punctuation, capitalisation or diacritics. If the text reads badly, leave it reading badly — someone else decides that. Your output with every mark stripped out must equal the input character for character.

${WORD_JOINING}

How to work through one field:
1. Read it and find the lexical words. Join the syllables of each with "_".
2. Find the clitics - a classifier and its noun, a function word and what it leans on, a free verb-object pair - and bind each with "=".
3. Find where the sentence naturally pauses and put "|" there, with a space each side. Most card sentences want one "|", sometimes two, often none. Every phrase you create must be at least TWO syllables.
4. Check: strip every mark you added. Is the result identical to what you were given? If not, you edited the text. Start again.

Leave a field exactly as it is when it is empty, when it is already marked, or when you are unsure - an unmarked field is correct-but-plain, while a wrongly marked one is a defect.

Return ONLY a JSON object with one key per field you were given, each holding the marked text:
{"meaningVi":"...","defVi":"...","leadVi":"...","anticipateVi":"...","usageVi":"..."}
Include a key only for a field that was given to you. No commentary.`;

/** The fields a markup pass may touch. usageEn is excluded: it holds the blank. */
export const MARKUP_FIELDS = ["meaningVi", "defVi", "leadVi", "anticipateVi", "usageVi"] as const;

/** One field a markup pass may touch. */
export type MarkupField = (typeof MARKUP_FIELDS)[number];

/**
 * Render one card's unmarked fields for marking up.
 *
 * Emphasis markers are left in place rather than stripped: `/…/` tells the
 * model which phrase is highlighted, which is exactly the span it must not
 * break with a `=` or a `|`.
 *
 * @param word - the card to mark up
 * @returns the user message, or "" when every field is already marked or empty
 */
export function buildMarkupPrompt(word: {
  word: string;
  meaningVi: string;
  defVi: string;
  leadVi: string;
  anticipateVi: string;
  usage: Array<{ en: string; vi: string }>;
}): string {
  const given: Array<[MarkupField, string]> = [
    ["meaningVi", word.meaningVi],
    ["defVi", word.defVi],
    ["leadVi", word.leadVi],
    ["anticipateVi", word.anticipateVi],
    ["usageVi", word.usage[0]?.vi ?? ""],
  ];
  const pending = given.filter(([, value]) => value.trim().length > 0);
  if (pending.length === 0) return "";

  return [
    `Add breaking marks to these fields of the card for "${word.word}".`,
    "",
    ...pending.map(([field, value]) => `- ${field}: ${value}`),
    "",
    `Return the JSON object with exactly these key(s): ${pending.map(([field]) => field).join(", ")}.`,
  ].join("\n");
}

// ── The house voice ─────────────────────────────────────────────────────────

/**
 * Placeholder guide, shown on the Prompts tab until one is distilled.
 *
 * The style guide is the one prompt this app does not ship: it is written from
 * the reviewer's own edits, so there is nothing sensible to default it to. The
 * injection checks whether a real one has been saved and skips the block
 * entirely when it has not, which is why this text never reaches a model.
 */
export const STYLE_SYSTEM_PROMPT = `No style guide yet.

Mark a few cards you have edited as style samples (the ★ in the review table), then press "Rebuild from my samples". The distillation reads what you CHANGED — the model's version against yours — and writes the guide here, for you to correct.

Until then, generation runs on the field rules alone and this text is never sent.`;

/**
 * Prompt that reverse-engineers the reviewer's voice from their edits.
 *
 * Works from pairs rather than finished sentences because the content is held
 * constant across a pair: same word, same field, same length rules, so every
 * difference is voice. A guide built from finals alone has to guess which
 * properties of a good sentence were deliberate.
 */
export const DISTIL_SYSTEM_PROMPT = `You are a Vietnamese editor reverse-engineering one writer's voice.

You will be given pairs from a vocabulary-card deck. In each pair, BEFORE is what a general-purpose model wrote and AFTER is what the human editor changed it to. The content requirement was identical in both: same English word, same field, same length rules. So every difference between them is a difference of VOICE, not of task.

Your job is to write the style guide that would have produced the AFTERs.

Work from the evidence, not from what good Vietnamese writing is generally supposed to look like. If the editor consistently does something a style manual would frown at, that is a rule, and you must write it down without softening it.

Attend to, in roughly this order:
1. WORD CHOICE. Which words does the editor reach for, and which do they systematically avoid or replace? Name actual words, in pairs: "prefers X over Y". A guide that says "uses natural vocabulary" is worthless.
2. IMAGERY. Concrete or abstract? Sensory or functional? Does a definition tend to describe what a thing IS, what it DOES, or what it FEELS like?
3. SENTENCE SHAPE. Where does the sentence put its weight - front, middle, end? Does the editor use a pause, and where? Short runs or one long breath?
4. REGISTER AND ADDRESS. Formal or familiar? Is the reader addressed, implied, or absent? Any recurring pronoun or kinship term?
5. WHAT THE EDITOR REMOVES. Often the clearest signal. Filler, hedges, nominalisations, stock openers - name the specific things that got deleted.
6. WHAT THE EDITOR LEFT ALONE. If some BEFOREs came through nearly untouched, say what they already had right. This bounds the guide.

Write the guide PER FIELD. defVi, leadVi and anticipateVi have different jobs and the voice differs across them; a rule that only holds for the teaser must say so.

Rules for the guide itself:
- Every rule must be checkable by looking at one sentence. "Warmer tone" is not checkable. "Addresses the reader as 'bạn' in the teaser, never in the definition" is.
- Give each rule one BEFORE → AFTER pair from the evidence, quoted exactly.
- Claim nothing you saw once. Mark a rule you saw two or three times as TENTATIVE and say so; a human will confirm or cut it.
- Say what you could NOT determine. A short, honest guide beats a padded one, and the gaps tell the editor which samples to add next.
- Do not restate the mechanical rules - word counts, the breaking marks _ = |, the /…/ highlights, the no-English rule. Those are enforced elsewhere and repeating them wastes the space your observations need.

Return Markdown, no preamble, with exactly these headings:

## Voice in one paragraph
## defVi
## leadVi
## anticipateVi
## Across all fields
## Tentative — confirm or cut
## Could not determine from these samples`;

/** Render the reviewer's pairs as the distillation request. */
export function buildDistilPrompt(pairs: string, cardCount: number): string {
  return [
    `Here are the edits from ${cardCount} card(s). Write the style guide.`,
    "",
    "THE PAIRS:",
    pairs,
  ].join("\n");
}

/**
 * The block appended to a generation or rewrite request when a style guide
 * exists.
 *
 * Deliberately short. The guide is the stable half and the exemplars are the
 * fresh half, and the closing question is there because a model will satisfy
 * every rule and still produce something anonymous — naming that failure is
 * what catches it.
 *
 * @param guide - the reviewer's style guide
 * @param exemplars - rendered examples, already selected
 * @param whole - true when the exemplars are complete cards rather than one field
 */
export function buildHouseVoice(guide: string, exemplars: string, whole: boolean): string {
  if (guide.trim().length === 0) return "";
  const lines = [
    "HOUSE VOICE",
    "",
    "The deck has one writer and you are standing in for them. The rules above say what a field must contain; this says how it should sound. Where the two seem to conflict, the rules above win - but they rarely conflict, and reaching for a blander phrasing to stay safe is itself a failure.",
    "",
    guide.trim(),
  ];
  if (exemplars.trim().length > 0) {
    lines.push(
      "",
      whole
        ? "Finished cards by the writer. Match how they sound, never their subject matter, and never reuse their phrasing."
        : "Examples of the voice in the field you are writing now. These are finished work, not templates: match how they sound, never their subject matter, and never reuse their phrasing.",
      "",
      exemplars.trim(),
    );
  }
  lines.push(
    "",
    "Before you return a field, read it back and ask: would the writer of those examples have written this? If it reads like competent generic Vietnamese, it is wrong even when every rule above is satisfied.",
  );
  return lines.join("\n");
}

/**
 * Prompt that audits one generated sentence against the guide.
 *
 * The verdict is the point: output that is off-voice is either a guide that
 * never stated the thing or a guide that stated it and was ignored. Those look
 * identical in the output and have opposite fixes.
 */
export const STYLE_AUDIT_SYSTEM_PROMPT = `You are auditing whether a generated sentence matches a house style.

Both versions you are shown satisfy the mechanical rules - word counts, marks, no English. Judge ONLY voice.

For each difference that matters, give:
- which guide rule it relates to, quoted, or NEW RULE if the difference reveals something the guide does not cover
- what the writer did
- what the generator did instead
- whether this is the generator missing a rule it was given, or the GUIDE failing to state something the writer evidently does

End with one line: GUIDE GAP or GENERATOR MISS, whichever dominates, because they need different fixes - the first means edit the guide, the second means the rule is there but is not being followed and should be made louder or moved earlier.

No score. A number hides the thing worth reading.`;

/** Render one audit request. */
export function buildStyleAuditPrompt(input: {
  guide: string;
  field: string;
  word: string;
  human: string;
  machine: string;
}): string {
  return [
    "STYLE GUIDE:",
    input.guide.trim(),
    "",
    `Field: ${input.field}, for the English word "${input.word}".`,
    "",
    `The writer's own version:\n${input.human}`,
    "",
    `The generated version:\n${input.machine}`,
  ].join("\n");
}

/**
 * Render one field for marking up, in isolation.
 *
 * Used after a rewrite. A model asked to rewrite a field and honour the
 * breaking marks in the same breath tends to drop the marks — there is a lot
 * else in that request — so the marks are put back by a second pass whose only
 * job is marks. The card is shown for context, because a phrase edge depends on
 * how the sentence reads, but only the one field is asked for.
 *
 * @param word - the card the field belongs to
 * @param field - which field to mark
 * @param text - the text to mark, as the rewrite returned it
 */
export function buildMarkupFieldPrompt(
  word: { word: string },
  field: MarkupField,
  text: string,
): string {
  return [
    `Add breaking marks to this one field of the card for "${word.word}".`,
    "",
    `- ${field}: ${text}`,
    "",
    `Return the JSON object with exactly one key: ${field}.`,
  ].join("\n");
}

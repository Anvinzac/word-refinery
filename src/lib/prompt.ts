/**
 * Prompt builder — the instructions sent to whichever LLM provider is active.
 *
 * Encodes the quality bar proven on the KineMedia deck: tightly measured
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
 * STYLE_AUDIT_SYSTEM_PROMPT, buildStyleAuditPrompt, buildMarkupFieldPrompt,
 * VARIATION_SYSTEM_PROMPT, buildVariationPrompt,
 * SAFETY_SYSTEM_PROMPT, buildSafetyPrompt, REPAIR_SYSTEM_PROMPT, buildRepairPrompt
 * Depends on: ./types.ts, ./contract.ts
 */
import { activeGlossProfile } from "./lang.ts";
import type { CorpusWord } from "./types.ts";
import { CRAWLER_ANNOTATION_FIELDS, EXAMS, TOPICS, type CrawlerAnnotationField } from "./contract.ts";

/** Fields the model is allowed to return, rendered into the prompt. */
/**
 * The language this workspace writes in.
 *
 * Read once at module load. A workspace switch RELOADS the page, so this
 * cannot go stale under a prompt that has already been built from it - which
 * is the whole reason switching is a reload rather than a state swap.
 */
const L = activeGlossProfile();

const FIELD_LIST = CRAWLER_ANNOTATION_FIELDS.join(", ");

/** Topic list rendered into the prompt so the model cannot invent tags. */
const TOPIC_LIST = TOPICS.join(", ");

/** Exam list, rendered the same way and for the same reason. */
const EXAM_LIST = EXAMS.join(", ");

/** Who the cards are for; opens both the batch and the rewrite prompt. */
const AUDIENCE = L.audience;

/**
 * How to pick a highlighted phrase. Shared by the batch prompt, where it picks
 * one phrase per field, and by a defVi/leadVi rewrite, which picks one anew.
 */
const EMPHASIS_CHOICE = L.emphasisChoice;

/**
 * The rule for each card field, worded once. The batch prompt lists them all;
 * a single-field rewrite quotes only the one it rewrites, so the two prompts
 * can never disagree about what a field must be.
 */
export const FIELD_RULES: Record<CrawlerAnnotationField, string> = {
  word: "the English headword, copied exactly as given, lowercase.",
  pos: "one of noun, verb, adj, adv, prep, conj, phrase.",
  ipa: 'IPA in slashes, e.g. "/ˈwɔː.tər/".',
  meaningVi: L.fieldRules.meaning,
  defVi: L.fieldRules.def,
  leadVi: L.fieldRules.lead,
  anticipateVi: L.fieldRules.anticipate,
  usageEn:
    "ONE natural English example sentence of at most 20 words where the target word is replaced by exactly five underscores: _____",
  usageVi: L.fieldRules.usageGloss,
  topics: `one to three lowercase tags from this closed list, most relevant FIRST: ${TOPIC_LIST}. Never invent a tag outside it — an unknown tag is discarded.`,
  exams: `the exams whose vocabulary lists this word genuinely belongs to, from: ${EXAM_LIST}. Use an empty array [] for ordinary everyday words — most words have none, and a wrong tag is worse than none.`,
  emphasisVi: `${L.fieldRules.emphasis}\n${EMPHASIS_CHOICE}`,
};

/** The breaking-mark convention, in the terms of the language being written. */
const WORD_JOINING = L.joining;

/** Hard rules about the language itself, binding on a rewrite as much as a batch. */
const LANGUAGE_RULES = L.rules;

/**
 * System prompt. One constant so the contract, the parser and the UI all point
 * at the same source of truth.
 */
export const ANNOTATION_SYSTEM_PROMPT = `You write ${L.label} vocabulary cards for a mobile "learn one English word at a time" app.
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
${L.example}
${L.exampleNote}`;

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
    `The CEFR level in brackets only tells you how simple the ${L.label} must be - do not echo it.`,
    "",
    lines.join("\n"),
  ];
  if (avoid.trim().length > 0) parts.push("", avoid);
  parts.push("", `Return the JSON array with exactly ${words.length} objects, in this order.`);
  return parts.join("\n");
}

/** Gloss-language fields a reviewer can hand back for a rewrite. */
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

/**
 * The complaint vocabulary as written for Vietnamese, the original deck.
 *
 * Exported as {@link COMPLAINT_CHIPS} after the active language has had its say
 * - see the profile's `chips`. Most chips are about the card rather than the
 * language and pass through untouched.
 */
const BASE_COMPLAINT_CHIPS: readonly ComplaintChip[] = [
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

/** The complaint vocabulary, shared by the Review table and the prompt builder. */
export const COMPLAINT_CHIPS: readonly ComplaintChip[] = BASE_COMPLAINT_CHIPS.map((chip) => {
  const override = L.chips?.[chip.id];
  return override === undefined ? chip : { ...chip, ...override };
});

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
export const REWRITE_SYSTEM_PROMPT = `You rewrite ONE field of a ${L.label} vocabulary card for a mobile "learn one English word at a time" app.
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
 * the gloss language is natural, whether the definition actually defines the word,
 * and whether the highlighted phrase is the one that carries the meaning.
 */
export const VERIFY_SYSTEM_PROMPT = `You are a strict ${L.label} editor reviewing vocabulary cards written by someone else for a mobile app. The learner sees the ${L.label} first and only later the English word.

Judge what a human reader judges. Do NOT re-count words or characters, and do NOT comment on formatting: an automatic checker already covers those. Look for:
- MEANING: does defVi actually define the English word, without drifting to a near-synonym or a different sense?
- GLOSS: is meaningVi the ${L.label} EQUIVALENT of the word - what a dictionary would give - rather than a description or a sentence? It is shown once the answer is revealed, so a clue-shaped gloss is wrong there.
- LEAK: does any ${L.label} field give the English word away - a cognate, a transliteration, or a translation so direct that the guess becomes trivial?
- NATURALNESS: would a ${L.label} speaker say it this way? Flag translationese, wrong collocations, missing or wrong diacritics.
- TEASER: does leadVi hint at the meaning without naming it, and is anticipateVi a fresh invitation rather than a stock phrase?
- EXAMPLE: does usageEn read naturally with the blank, and does usageVi translate it faithfully?
- EMPHASIS: is the highlighted phrase the one carrying the point of the sentence? A highlight sitting on filler - a classifier and its noun, a time phrase, a number - is a defect worth reporting even though nothing is strictly wrong with it.

Severity: "blocker" for anything that would mislead a learner or give the answer away; "warn" for something a careful editor would change; "note" for a preference. Say nothing about a field that is fine.

Return ONLY a JSON object:
{"verdict":"pass"|"revise","findings":[{"field":"defVi","severity":"blocker"|"warn"|"note","problem":"<what is wrong, in English, one sentence>","suggestion":"<the corrected ${L.label}, or \\"\\" when you cannot fix it>"}]}
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
 * reads the gloss the way a learner does before it knows what the card is
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
 * model deciding the text could be better while it is in there: the words
 * must come back identical, mark insertion and nothing else, so the result can
 * be checked by stripping the marks and comparing. A pass that improves the
 * prose cannot be verified and quietly rewrites a reviewed deck.
 */
export const MARKUP_SYSTEM_PROMPT = `You add breaking marks to ${L.label} vocabulary-card text that was written before the marks existed. You are a typesetter, not an editor.

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
export const DISTIL_SYSTEM_PROMPT = `You are a ${L.label} editor reverse-engineering one writer's voice.

You will be given pairs from a vocabulary-card deck. In each pair, BEFORE is what a general-purpose model wrote and AFTER is what the human editor changed it to. The content requirement was identical in both: same English word, same field, same length rules. So every difference between them is a difference of VOICE, not of task.

Your job is to write the style guide that would have produced the AFTERs.

Work from the evidence, not from what good ${L.label} writing is generally supposed to look like. If the editor consistently does something a style manual would frown at, that is a rule, and you must write it down without softening it.

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
    `Before you return a field, read it back and ask: would the writer of those examples have written this? If it reads like competent generic ${L.label}, it is wrong even when every rule above is satisfied.`,
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

// ── Variations ──────────────────────────────────────────────────────────────

/**
 * The fields a variation writes, and therefore the only rules worth stating.
 * `usageEn` is deliberately absent: the English example is held fixed so the
 * two versions stay comparable, and listing its rule would invite a rewrite.
 */
const VARIATION_RULE_FIELDS = new Set(["meaningVi", "defVi", "leadVi", "anticipateVi", "usageVi"]);

/**
 * System prompt for one alternative take on a whole card.
 *
 * Separate from the rewrite prompt because the job is different: a rewrite
 * fixes a named complaint, while this one is asked for a DIFFERENT reading of
 * the same word, with nothing wrong with the version it replaces. Telling a
 * model to "do it again differently" without saying along which axis produces
 * four near-identical cards, so the axis is given and the rest of the quality
 * bar is held constant.
 */
export const VARIATION_SYSTEM_PROMPT = `You write ${L.label} vocabulary cards for a mobile "learn one English word at a time" app.
${AUDIENCE}

You are given a card that is already finished and acceptable. Your job is NOT to fix it. Write a DIFFERENT take on the same English word, along the one axis the user message names, so a reviewer can put the two side by side and choose.

What this means in practice:
- Change the writing, not the word's meaning. The learner must end up understanding the same sense of the same English word.
- Do not copy the existing card's phrasing. If your version would share a whole phrase with it, find another way to say that part.
- The axis is the ONLY thing you are free about. Every field rule below still binds: the word counts, the no-English rule, the diacritics, the marks.
- Write every field, even the ones you would barely change. A reviewer picks per field, so a field you skip is a column they cannot choose in.

Field rules:
${CRAWLER_ANNOTATION_FIELDS.filter((field) => VARIATION_RULE_FIELDS.has(field))
  .map((field) => `- "${field}": ${FIELD_RULES[field]}`)
  .join("\n")}

${WORD_JOINING}

Hard rules:
${LANGUAGE_RULES}
- Return ONLY a JSON object with these five keys and no others: meaningVi, defVi, leadVi, anticipateVi, usageVi. No markdown fences, no commentary.`;

/**
 * Render one variation request.
 *
 * The existing card is shown so the model can avoid repeating it, and labelled
 * as acceptable so it is not read as a thing to correct.
 *
 * @param word - the card as it stands
 * @param slant - what to change, in one instruction
 * @param slantLabel - the slant's name, for the model's own orientation
 */
export function buildVariationPrompt(
  word: {
    word: string;
    pos: string;
    level: string;
    meaningVi: string;
    defVi: string;
    leadVi: string;
    anticipateVi: string;
    usage: Array<{ en: string; vi: string }>;
  },
  slant: string,
  slantLabel: string,
): string {
  const example = word.usage[0];
  const lines: Array<string | null> = [
    `Write a "${slantLabel}" take on the card for "${word.word}" (${word.pos || "unknown part of speech"}, ${word.level}).`,
    "",
    `THE AXIS: ${slant}`,
    "",
    "The existing card, which is acceptable as it stands — do not repeat its phrasing:",
    `- meaningVi: ${word.meaningVi}`,
    `- defVi: ${word.defVi}`,
    `- leadVi: ${word.leadVi}`,
    `- anticipateVi: ${word.anticipateVi}`,
    example ? `- usageEn: ${example.en}` : null,
    example ? `- usageVi: ${example.vi}` : null,
    "",
    example
      ? `Keep usageEn exactly as it is — only usageVi is yours to rewrite, and it must still translate that English sentence.`
      : null,
    "",
    "Return the JSON object with all five keys.",
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

// ── Intake: safety review and repair ────────────────────────────────────────

/**
 * System prompt for the safety gate.
 *
 * Distinct from the verification pass, which asks whether a card is GOOD. This
 * asks whether it is publishable at all, and the difference matters because the
 * two have different costs when wrong: a dull card wastes a reader's minute, a
 * card that insults them loses the reader.
 *
 * It reads every field. A deck's unsafe material rarely sits in the definition
 * — it arrives in the example sentence, where the model needed a situation and
 * reached for one, or in the teaser, where it needed a stereotype to make the
 * hint land.
 */
export const SAFETY_SYSTEM_PROMPT = `You are reviewing ${L.label} vocabulary cards before publication, for a mobile app used by learners of all ages in ${L.country}.

You are NOT judging whether the card teaches well. Another pass does that. You are deciding whether it is fit to publish at all.

Read every field, not just the definition. Unsafe material in a vocabulary deck rarely sits in the definition: it arrives in the example sentence, where a situation was needed, or in the teaser, where a stereotype made the hint land.

Flag:
- IMPLICATION: does the card imply something harmful even though no single word is wrong? An example sentence that models self-harm, violence, substance use or crime as ordinary; a definition that assumes the reader is in an unsafe situation.
- FRAMING: does any field insult or demean? Stereotypes of a nationality, region, gender, age, disability, religion, caste, occupation or body. ${L.label} regional stereotypes count. So does contempt dressed as humour.
- SENSE: does the card teach a sense of the English word that is wrong, obsolete, or so rare the learner will misuse it? Does any field contradict another about what the word means?
- AUDIENCE: is the content unsuitable for a classroom — sexual material, graphic detail, political or religious advocacy, or an adult situation a younger learner would meet unprepared?

Do not flag: ordinary negative emotion, illness, death, poverty, conflict or difficulty treated factually. A vocabulary deck must be able to teach "grief", "war" and "poor". Flag the TREATMENT, never the topic.

Severity: "blocker" for anything that should not ship; "warn" for something a careful editor would change but that is not unsafe.

Return ONLY a JSON object:
{"findings":[{"field":"usageEn","severity":"blocker"|"warn","problem":"<one sentence, in English>"}]}
An empty findings array means the card is fit to publish. No commentary outside the JSON.`;

/** Render one card for the safety gate. */
export function buildSafetyPrompt(card: {
  word: string;
  pos: string;
  level: string;
  meaningVi: string;
  defVi: string;
  leadVi: string;
  anticipateVi: string;
  usage: Array<{ en: string; vi: string }>;
}): string {
  const example = card.usage[0];
  const lines: Array<string | null> = [
    `Review the card for "${card.word}" (${card.pos || "unknown part of speech"}, ${card.level}).`,
    "",
    `- meaningVi: ${card.meaningVi}`,
    `- defVi: ${card.defVi}`,
    `- leadVi: ${card.leadVi}`,
    `- anticipateVi: ${card.anticipateVi}`,
    example ? `- usageEn: ${example.en}` : null,
    example ? `- usageVi: ${example.vi}` : null,
    "",
    "An underscore joins the syllables of one word and a /slashed/ phrase is a highlight; neither is a defect.",
    "",
    "Return the JSON object described in the system prompt.",
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

/**
 * System prompt for the repair pass.
 *
 * Given a card and everything wrong with it, return the whole card fixed. Whole
 * rather than per-field because the fields constrain each other: shortening a
 * definition can orphan its emphasis phrase, and changing a sense can leave the
 * teaser pointing at the old one.
 */
export const REPAIR_SYSTEM_PROMPT = `You repair ${L.label} vocabulary cards that failed validation.

You are given one card and the complete list of what is wrong with it. Return the WHOLE card, fixed.

Whole, not just the fields named: the fields constrain each other. Shortening a definition can orphan the emphasis phrase that quoted it; correcting a sense can leave the teaser pointing at the old one. Every field you return will be revalidated from scratch.

- Fix every listed problem. A repair that resolves three of four failures is a failure.
- Change nothing else. If a field has no problem listed and no problem caused by your other fixes, return it exactly as given.
- Keep the same English headword and the same sense of it.

${WORD_JOINING}

Hard rules:
${LANGUAGE_RULES}
- Return ONLY a JSON object with these keys and no others: ${CRAWLER_ANNOTATION_FIELDS.join(", ")}. No markdown fences, no commentary.`;

/** Render one failed card with its findings, for repair. */
export function buildRepairPrompt(
  card: {
    word: string;
    pos: string;
    ipa: string;
    meaningVi: string;
    defVi: string;
    leadVi: string;
    anticipateVi: string;
    topics: string[];
    exams: string[];
    usage: Array<{ en: string; vi: string }>;
  },
  problems: readonly string[],
): string {
  const example = card.usage[0];
  return [
    `Repair the card for "${card.word}".`,
    "",
    "The card as it stands:",
    `- word: ${card.word}`,
    `- pos: ${card.pos}`,
    `- ipa: ${card.ipa}`,
    `- meaningVi: ${card.meaningVi}`,
    `- defVi: ${card.defVi}`,
    `- leadVi: ${card.leadVi}`,
    `- anticipateVi: ${card.anticipateVi}`,
    `- usageEn: ${example?.en ?? ""}`,
    `- usageVi: ${example?.vi ?? ""}`,
    `- topics: ${JSON.stringify(card.topics)}`,
    `- exams: ${JSON.stringify(card.exams)}`,
    "",
    `What is wrong with it (${problems.length}):`,
    problems.map((problem) => `- ${problem}`).join("\n"),
    "",
    "Return the whole card as JSON.",
  ].join("\n");
}

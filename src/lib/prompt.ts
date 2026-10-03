/**
 * Prompt builder — the instructions sent to whichever LLM provider is active.
 *
 * Encodes the quality bar proven on the KineMedia deck: 8–11 word Vietnamese
 * definitions and teasers, short unique invite-to-guess lines, blanked example
 * sentences, and TWO-syllable emphasis phrases copied verbatim from the text.
 * Emphasis is requested as a plain list; `lib/emphasis.ts` validates it and
 * injects the `/…/` markers, so the model never has to learn the delimiter.
 *
 * Exports: ANNOTATION_SYSTEM_PROMPT, buildBatchPrompt, buildRegeneratePrompt
 * Depends on: ./types.ts, ./contract.ts
 */
import type { CorpusWord } from "./types.ts";
import { CRAWLER_ANNOTATION_FIELDS, TOPICS } from "./contract.ts";

/** Fields the model is allowed to return, rendered into the prompt. */
const FIELD_LIST = CRAWLER_ANNOTATION_FIELDS.join(", ");

/** Topic list rendered into the prompt so the model cannot invent tags. */
const TOPIC_LIST = TOPICS.join(", ");

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
- "anticipateVi": a short playful Vietnamese invitation to guess, 3-8 words, at most 60 characters. It must be DIFFERENT for every word - never reuse a placeholder like "Đoán xem nào…" twice.
- "usageEn": ONE natural English example sentence of at most 20 words where the target word is replaced by exactly five underscores: _____
- "usageVi": the Vietnamese meaning of that example sentence.
- "topic": exactly one lowercase tag from: ${TOPIC_LIST}.
- "emphasisVi": 2 Vietnamese phrases that will glow on screen. Each phrase MUST:
  * be copied EXACTLY, diacritics included, from the defVi or leadVi you just wrote,
  * be exactly TWO syllables taken from one neighbouring pair of words (never one syllable, never three or more),
  * be a meaningful unit - a noun phrase, verb phrase, or adjective + noun,
  * never be a function word such as và, là, của, có, được, trong, cho, với, một, rất, cũng, đã, đang, sẽ, không, những, các, thì, mà,
  * be at most 30 characters and unique inside the list,
  * appear MID-SENTENCE in lowercase where possible, so the highlight matcher finds it exactly.

Hard rules:
- Write correct Vietnamese with full diacritics in every Vietnamese field.
- Never include the English target word, or any English word, in defVi, leadVi or anticipateVi.
- Never define a word with the word itself or an obvious cognate.
- Never add a "level" field or any field outside the ${CRAWLER_ANNOTATION_FIELDS.length} listed - difficulty is handled outside this request.
- Return ONLY a JSON array with one object per requested word, in the requested order. No markdown fences, no headings, no commentary.

Minimal example of the expected format (one word, shortened):
[{"word":"water","pos":"noun","ipa":"/ˈwɔː.tər/","defVi":"Chất lỏng trong suốt mà ta uống mỗi ngày.","leadVi":"Có thứ này thì cây mới sống được.","anticipateVi":"Thứ gì chảy được nhỉ?","usageEn":"Please bring me a glass of _____.","usageVi":"Làm ơn mang cho tôi một cốc nước.","topic":"nature","emphasisVi":["Chất lỏng","uống mỗi"]}]`;

/**
 * Render one batch of corpus words as the user message.
 * @param words - corpus words for this batch (already frequency-sorted)
 */
export function buildBatchPrompt(words: readonly CorpusWord[]): string {
  const lines = words.map((entry, index) => {
    const hint = entry.pos.length > 0 ? `, ${entry.pos}` : "";
    return `${index + 1}. ${entry.word} (${entry.level}${hint})`;
  });
  return [
    `Annotate these ${words.length} English words.`,
    "The CEFR level in brackets only tells you how simple the Vietnamese must be - do not echo it.",
    "",
    lines.join("\n"),
    "",
    `Return the JSON array with exactly ${words.length} objects, in this order.`,
  ].join("\n");
}

/**
 * Prompt used when a reviewer rejects one field and asks for a rewrite. Keeps
 * the surrounding context so the model does not drift from the original word.
 *
 * @param word - the deck word being refined
 * @param field - which Vietnamese field to rewrite
 * @param complaint - the reviewer's note, verbatim
 */
export function buildRegeneratePrompt(
  word: { word: string; defVi: string; leadVi: string; anticipateVi: string; usage: Array<{ en: string; vi: string }> },
  field: "defVi" | "leadVi" | "anticipateVi" | "usageVi",
  complaint: string,
): string {
  const example = word.usage[0];
  return [
    `Rewrite ONLY the "${field}" field for the English word "${word.word}".`,
    "",
    "Current content:",
    `- defVi: ${word.defVi}`,
    `- leadVi: ${word.leadVi}`,
    `- anticipateVi: ${word.anticipateVi}`,
    example ? `- usageEn: ${example.en}` : "",
    example ? `- usageVi: ${example.vi}` : "",
    "",
    `Reviewer complaint: ${complaint}`,
    "",
    "Rules: keep the same field constraints as the system prompt (word counts, no English words, full diacritics).",
    'Return ONLY a JSON object of the form {"value": "<the rewritten field>"} with no commentary.',
  ]
    .filter((line) => line !== "")
    .join("\n");
}

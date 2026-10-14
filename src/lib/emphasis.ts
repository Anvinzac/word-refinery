/**
 * Vietnamese emphasis validation and inline-marker injection.
 *
 * Two responsibilities:
 *   1. `validateEmphasis` — ported from the word-crawler package. Keeps only
 *      phrases that occur character-for-character in `defVi`/`leadVi`, are not
 *      pure function words, and are not a single syllable that reads as half of
 *      a compound. Diacritics are preserved throughout.
 *   2. `injectEmphasisMarkers` — the bridge to KineMedia's current catalog
 *      format. Wraps the surviving phrases in `/…/` inside the field they came
 *      from, at most one marker per field, because the feed highlights exactly
 *      one Vietnamese word per page and `defVi`/`leadVi` render as separate
 *      stages.
 *
 * Exports: VIETNAMESE_STOP_WORDS, emphasisTokenKey, isVietnameseStopWord,
 *          countSyllables, validateEmphasis, injectEmphasisMarkers,
 *          stripEmphasisMarkers, splitMarkedSyllables, joinMarkedSyllables,
 *          MarkedSyllable
 * Depends on: none
 */
import { CLITIC_BIND, PHRASE_BREAK, stripMarks } from "./joiner.ts";

/**
 * Vietnamese function words that can never be part of a highlight.
 * Matching keeps diacritics on purpose: an accent-stripped set would collapse
 * distinct words ("những" vs "nhưng", "nền" vs "nên").
 */
export const VIETNAMESE_STOP_WORDS: ReadonlySet<string> = new Set([
  "và", "là", "của", "có", "được", "trong", "cho", "với", "từ", "đến", "để",
  "do", "về", "theo", "tại", "qua", "ra", "lên", "xuống", "vào", "này", "đó",
  "các", "những", "một", "hai", "ba", "rất", "cũng", "đã", "đang", "sẽ",
  "không", "chưa", "còn", "nếu", "thì", "mà", "nhưng", "hay", "hoặc", "vì",
  "nên", "khi", "như", "vẫn", "đều", "chỉ", "ai", "gì", "nào", "đây", "kia",
  "ấy", "tôi", "bạn", "nó", "họ", "ta", "mình",
]);

/** Input for {@link validateEmphasis}. */
export interface EmphasisInput {
  defVi: string;
  leadVi?: string;
  emphasisVi: readonly string[];
}

/** Validation outcome: phrases to keep plus human-readable warnings. */
export interface EmphasisResult {
  emphasis: string[];
  warnings: string[];
}

/**
 * Comparison key for one Vietnamese token: NFC-unified, lowercased, reduced to
 * letters/digits. Diacritics are intentionally preserved.
 */
export function emphasisTokenKey(token: string): string {
  return token
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** True when a token is a Vietnamese function word. */
export function isVietnameseStopWord(token: string): boolean {
  return VIETNAMESE_STOP_WORDS.has(emphasisTokenKey(token));
}

/** Count syllables of a phrase (Vietnamese syllables are space-separated). */
export function countSyllables(phrase: string): number {
  return phrase.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

/** Escape a value for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Longest (and casing-correct) occurrence of a phrase inside the sources.
 *
 * Emphasis phrases are written plain ("quan trọng") while the text that holds
 * them may join those syllables ("quan_trọng"), so each space in the phrase
 * matches either a space or a join. Without this a highlight would silently
 * fail to attach to exactly the compounds most worth highlighting.
 */
function findOccurrence(
  haystacks: readonly string[],
  phrase: string,
): { text: string; start: number; end: number; haystack: string } | null {
  const spaced = escapeRegExp(phrase).replace(/\\?\s+/gu, "[\\s_]+");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${spaced}(?![\\p{L}\\p{N}])`, "iu");
  for (const haystack of haystacks) {
    const match = pattern.exec(haystack);
    if (match !== null && match.index !== undefined) {
      return {
        text: match[0],
        start: match.index,
        end: match.index + match[0].length,
        haystack,
      };
    }
  }
  return null;
}

/**
 * Why a phrase failed to match: the mark standing between its syllables, or
 * null when the text simply does not contain it.
 *
 * Only used to word the warning. The phrase is dropped either way — a highlight
 * may bridge a space or a word join and nothing else.
 */
function findBoundOccurrence(haystacks: readonly string[], phrase: string): string | null {
  for (const mark of [CLITIC_BIND, PHRASE_BREAK]) {
    const bridged = escapeRegExp(phrase).replace(/\\?\s+/gu, `[\\s_${mark === CLITIC_BIND ? "=" : "|"}]+`);
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${bridged}(?![\\p{L}\\p{N}])`, "iu");
    for (const haystack of haystacks) {
      const match = pattern.exec(haystack);
      if (match !== null && match[0].includes(mark)) return mark;
    }
  }
  return null;
}

/** Neighbouring token plus the characters joining it to the matched phrase. */
function neighbourToken(
  haystack: string,
  match: { start: number; end: number },
  direction: "left" | "right",
): { token: string; junction: string } | null {
  if (direction === "left") {
    const prefix = haystack.slice(0, match.start);
    const found = /([\p{L}\p{N}]+)([^\p{L}\p{N}]*)$/u.exec(prefix);
    if (found === null) return null;
    return { token: found[1], junction: found[2] };
  }
  const suffix = haystack.slice(match.end);
  const found = /^([^\p{L}\p{N}]*)([\p{L}\p{N}]+)/u.exec(suffix);
  if (found === null) return null;
  return { token: found[2], junction: found[1] };
}

/**
 * A neighbour can only form a compound when nothing but whitespace — or a word
 * join — separates them. A join is the strongest possible evidence of a
 * compound: it says outright that the two syllables are one word.
 */
function isTightJunction(junction: string): boolean {
  return /^[\s_]*$/u.test(junction);
}

/** Content syllable: at least two letters and not a function word. */
function isContentSyllable(token: string): boolean {
  const key = emphasisTokenKey(token);
  return key.length >= 2 && !VIETNAMESE_STOP_WORDS.has(key);
}

/** Validate one candidate phrase; `phrase: null` means drop it. */
function validateCandidate(
  candidate: string,
  haystacks: readonly string[],
): { phrase: string | null; warnings: string[] } {
  const warnings: string[] = [];
  const phrase = candidate.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (phrase.length === 0) return { phrase: null, warnings };

  const occurrence = findOccurrence(haystacks, phrase);
  if (occurrence === null) {
    // A phrase the text binds with "=" or splits with "|" cannot match, because
    // the matcher only bridges a space or a word join. Say which it was: the
    // difference is the whole point of having two bond marks.
    const bound = findBoundOccurrence(haystacks, phrase);
    warnings.push(
      bound === null
        ? `emphasisVi: dropped "${phrase}" — not present character-for-character in defVi or leadVi`
        : bound === CLITIC_BIND
          ? `emphasisVi: dropped "${phrase}" — it spans a "${CLITIC_BIND}" bind, so those syllables are two words leaning together, not one to highlight`
          : `emphasisVi: dropped "${phrase}" — it spans a "${PHRASE_BREAK}" phrase boundary; a highlight stays inside one phrase`,
    );
    return { phrase: null, warnings };
  }
  // The text may join the syllables this phrase spans; the phrase itself is
  // stored plain, because that is the form the app matches token by token.
  // Only a genuine difference in casing is worth reporting.
  const found = stripMarks(occurrence.text);
  if (found !== phrase) {
    warnings.push(`emphasisVi: "${phrase}" re-cased to "${found}" from the source text`);
  }

  const syllables = countSyllables(phrase);
  const tokens = phrase.match(/[\p{L}\p{N}]+/gu) ?? [];

  if (tokens.every((token) => VIETNAMESE_STOP_WORDS.has(emphasisTokenKey(token)))) {
    warnings.push(`emphasisVi: dropped "${phrase}" — only function words`);
    return { phrase: null, warnings };
  }

  if (syllables === 1) {
    const neighbours: string[] = [];
    const left = neighbourToken(occurrence.haystack, occurrence, "left");
    if (left !== null && isTightJunction(left.junction) && isContentSyllable(left.token)) {
      neighbours.push(`${left.token} ${occurrence.text}`);
    }
    const right = neighbourToken(occurrence.haystack, occurrence, "right");
    if (right !== null && isTightJunction(right.junction) && isContentSyllable(right.token)) {
      neighbours.push(`${occurrence.text} ${right.token}`);
    }
    if (neighbours.length > 0) {
      warnings.push(
        `emphasisVi: dropped single syllable "${occurrence.text}" — probably half of "${neighbours[0]}"`,
      );
      return { phrase: null, warnings };
    }
    warnings.push(`emphasisVi: kept single syllable "${found}" — multi-syllable is safer`);
    return { phrase: found, warnings };
  }

  // The feed caps Vietnamese emphasis at one word per page and the catalog
  // convention is 2-syllable compounds; a 3+ syllable span reads as a clause.
  if (syllables > 2) {
    warnings.push(
      `emphasisVi: dropped "${found}" — ${syllables} syllables; keep 2-syllable compounds`,
    );
    return { phrase: null, warnings };
  }

  return { phrase: found, warnings };
}

/**
 * Validate every emphasis candidate for one word.
 * @returns deduplicated phrases in source casing plus warnings for every change
 */
export function validateEmphasis(input: EmphasisInput): EmphasisResult {
  const haystacks = [input.defVi, input.leadVi ?? ""]
    .map((value) => value.normalize("NFC"))
    .filter((value) => value.trim().length > 0);

  const emphasis: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const candidate of input.emphasisVi) {
    const result = validateCandidate(candidate, haystacks);
    warnings.push(...result.warnings);
    if (result.phrase === null) continue;

    const key = result.phrase.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`emphasisVi: dropped duplicate "${result.phrase}"`);
      continue;
    }
    seen.add(key);
    emphasis.push(result.phrase);
  }

  return { emphasis, warnings };
}

/** The marker delimiter used by KineMedia's `parseEmphasisMarkers`. */
const MARKER = "/";

/**
 * Remove `/…/` markers, returning the clean display text.
 * Useful when a reviewer edits a field and the markers must be dropped.
 */
export function stripEmphasisMarkers(text: string): string {
  return text.replace(/\/([^/]+)\//g, "$1");
}

/**
 * One whitespace-separated syllable of a marked field. Punctuation hugging the
 * syllable sits in `lead`/`trail` so a marker never swallows it; `core` is
 * empty for a pure-punctuation token such as a dash.
 */
export interface MarkedSyllable {
  lead: string;
  core: string;
  trail: string;
  marked: boolean;
}

/** Split a field into syllables, recording which ones sit inside `/…/`. */
export function splitMarkedSyllables(text: string): MarkedSyllable[] {
  const syllables: MarkedSyllable[] = [];
  let inMarker = false;
  let token = "";
  let tokenMarked = false;

  const flush = () => {
    if (token.length === 0) return;
    const lead = /^[^\p{L}\p{N}]*/u.exec(token)?.[0] ?? "";
    const rest = token.slice(lead.length);
    const trail = /[^\p{L}\p{N}]*$/u.exec(rest)?.[0] ?? "";
    const core = rest.slice(0, rest.length - trail.length);
    syllables.push({ lead, core, trail, marked: core.length > 0 && tokenMarked });
    token = "";
    tokenMarked = false;
  };

  for (const char of text.normalize("NFC")) {
    if (char === MARKER) {
      inMarker = !inMarker;
    } else if (/\s/u.test(char)) {
      flush();
    } else {
      token += char;
      if (inMarker && /[\p{L}\p{N}]/u.test(char)) tokenMarked = true;
    }
  }
  flush();
  return syllables;
}

/**
 * Rebuild a field from syllables, wrapping each run of marked syllables in one
 * `/…/`. A run breaks at punctuation so a marker never spans a comma.
 */
export function joinMarkedSyllables(syllables: readonly MarkedSyllable[]): string {
  const joins = (left: MarkedSyllable | undefined, right: MarkedSyllable | undefined) =>
    left !== undefined &&
    right !== undefined &&
    left.marked &&
    right.marked &&
    left.trail.length === 0 &&
    right.lead.length === 0;

  return syllables
    .map((syllable, index) => {
      if (!syllable.marked || syllable.core.length === 0) {
        return `${syllable.lead}${syllable.core}${syllable.trail}`;
      }
      const open = joins(syllables[index - 1], syllable) ? "" : MARKER;
      const close = joins(syllable, syllables[index + 1]) ? "" : MARKER;
      return `${syllable.lead}${open}${syllable.core}${close}${syllable.trail}`;
    })
    .join(" ");
}

/**
 * Inject at most one `/…/` marker per field.
 *
 * Preference order: `defVi` first (the definition stage is where a highlight
 * teaches the most), then `leadVi`. A phrase is only marked in the field where
 * it actually occurs, and a field that already carries a marker is left alone
 * so re-running refinement never nests markers.
 *
 * @param defVi - definition text, may already contain a marker
 * @param leadVi - teaser text, may already contain a marker
 * @param phrases - validated emphasis phrases in priority order
 * @returns the marked texts plus a note for every phrase that could not be placed
 */
export function injectEmphasisMarkers(
  defVi: string,
  leadVi: string,
  phrases: readonly string[],
): { defVi: string; leadVi: string; warnings: string[] } {
  const warnings: string[] = [];
  let outDef = defVi;
  let outLead = leadVi;

  const markOnce = (text: string, phrase: string): string | null => {
    if (text.includes(MARKER)) return null; // already marked
    // The phrase is plain but the text may join the syllables it spans, so a
    // space in the phrase matches a space OR a join. The marker then wraps the
    // text's own form, joins intact — `/Chất_lỏng/`, never `/Chất lỏng/`.
    const spaced = escapeRegExp(phrase).replace(/\\?\s+/gu, "[\\s_]+");
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${spaced}(?![\\p{L}\\p{N}])`, "iu");
    const match = pattern.exec(text);
    if (match === null) return null;
    const start = match.index;
    const end = start + match[0].length;
    return `${text.slice(0, start)}${MARKER}${match[0]}${MARKER}${text.slice(end)}`;
  };

  for (const phrase of phrases) {
    if (outDef.includes(MARKER) && outLead.includes(MARKER)) break;

    if (!outDef.includes(MARKER)) {
      const marked = markOnce(outDef, phrase);
      if (marked !== null) {
        outDef = marked;
        continue;
      }
    }
    if (!outLead.includes(MARKER)) {
      const marked = markOnce(outLead, phrase);
      if (marked !== null) {
        outLead = marked;
        continue;
      }
    }
    warnings.push(`emphasisVi: "${phrase}" validated but neither field had a free marker slot`);
  }

  return { defVi: outDef, leadVi: outLead, warnings };
}

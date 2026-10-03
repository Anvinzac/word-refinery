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
 *          stripEmphasisMarkers
 * Depends on: none
 */

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

/** Longest (and casing-correct) occurrence of a phrase inside the sources. */
function findOccurrence(
  haystacks: readonly string[],
  phrase: string,
): { text: string; start: number; end: number; haystack: string } | null {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, "iu");
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

/** A neighbour can only form a compound when nothing but whitespace separates them. */
function isTightJunction(junction: string): boolean {
  return /^\s*$/u.test(junction);
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
    warnings.push(
      `emphasisVi: dropped "${phrase}" — not present character-for-character in defVi or leadVi`,
    );
    return { phrase: null, warnings };
  }
  if (occurrence.text !== phrase) {
    warnings.push(`emphasisVi: "${phrase}" re-cased to "${occurrence.text}" from the source text`);
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
    warnings.push(`emphasisVi: kept single syllable "${occurrence.text}" — multi-syllable is safer`);
    return { phrase: occurrence.text, warnings };
  }

  // The feed caps Vietnamese emphasis at one word per page and the catalog
  // convention is 2-syllable compounds; a 3+ syllable span reads as a clause.
  if (syllables > 2) {
    warnings.push(
      `emphasisVi: dropped "${occurrence.text}" — ${syllables} syllables; keep 2-syllable compounds`,
    );
    return { phrase: null, warnings };
  }

  return { phrase: occurrence.text, warnings };
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
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, "iu");
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

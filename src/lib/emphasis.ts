/**
 * Emphasis validation and inline-marker injection.
 *
 * WHAT A WORD BOUNDARY IS turns out to be the whole difficulty here. The rules
 * below were written for Vietnamese, where every syllable is a space apart, so
 * a highlight has visible edges and a phrase that reads as half a compound can
 * be spotted by looking at its neighbour. Japanese has no such edges: a
 * particle attaches directly to the word it marks, so 「知りたい」 inside
 * 「知りたいと」 has a letter on its right and a Vietnamese matcher refuses it.
 * Run against a Japanese deck, that one assumption dropped 876 highlights in
 * 1000 - so the language is now passed in rather than assumed.
 *
 * In a language with no spaces, the author carries the burden the boundary used
 * to: the rules require a highlight to occur exactly once in its own field and
 * never to cross a space, a "=" or a "|". The matcher takes them at their word
 * and simply locates it, allowing only a "_" to be crossed, because an idiom is
 * given whole.
 *
 * Two responsibilities:
 *   1. `validateEmphasis` — ported from the word-crawler package. Keeps only
 *      phrases that occur character-for-character in `defVi`/`leadVi`, are not
 *      pure function words, and are one syllable standing alone or one
 *      two-syllable word the text joins with "_" — never half of a joined
 *      word, never a "=" pair, never three syllables. Diacritics are preserved
 *      throughout.
 *   2. `injectEmphasisMarkers` — the bridge to KineMedia's current catalog
 *      format. Wraps the surviving phrases in `/…/` inside the field they came
 *      from, at most one marker per field, because the feed highlights exactly
 *      one Vietnamese word per page and `defVi`/`leadVi` render as separate
 *      stages.
 *
 * Exports: VIETNAMESE_STOP_WORDS, emphasisTokenKey, isVietnameseStopWord,
 *          countSyllables, emphasisShapeProblem, validateEmphasis, injectEmphasisMarkers,
 *          stripEmphasisMarkers, splitMarkedSyllables, joinMarkedSyllables,
 *          MarkedSyllable
 * Depends on: ./joiner.ts, ./lang.ts
 */
import { CLITIC_BIND, PHRASE_BREAK, stripMarks } from "./joiner.ts";
import { activeGlossProfile, displayText, measureLength, type GlossProfile } from "./lang.ts";

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
  /** The language the fields are written in. Defaults to the open workspace's. */
  profile?: GlossProfile;
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
 * The pattern that finds a phrase inside the text that holds it.
 *
 * Both languages store the phrase as the reader sees it and keep the marks in
 * the text, so the pattern has to be permissive about exactly the marks the
 * language uses - and strict about its edges, where it has any.
 *
 * Space-separated: a space in the phrase matches a space OR a join, so a
 * highlight attaches to "quan_trọng", and letters either side are refused, so
 * it cannot match the middle of a longer word.
 *
 * Not space-separated: no edge test exists to apply - a particle is a letter
 * sitting flush against the word it marks - so the phrase is located as a
 * substring, with a "_" allowed between any two characters so a whole "_"
 * idiom still matches. A space, a "=" or a "|" cannot be crossed, because
 * none of their characters is in the phrase.
 */
function emphasisPattern(phrase: string, profile: GlossProfile): RegExp {
  if (profile.measure === "words") {
    const spaced = escapeRegExp(phrase).replace(/\\?\s+/gu, "[\\s_]+");
    return new RegExp(`(?<![\\p{L}\\p{N}])${spaced}(?![\\p{L}\\p{N}])`, "iu");
  }
  return new RegExp([...phrase].map((char) => escapeRegExp(char)).join("_?"), "u");
}

/**
 * Longest (and casing-correct) occurrence of a phrase inside the sources.
 */
function findOccurrence(
  haystacks: readonly string[],
  phrase: string,
  profile: GlossProfile,
): { text: string; start: number; end: number; haystack: string } | null {
  const pattern = emphasisPattern(phrase, profile);
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

/**
 * Why a Vietnamese highlight has the wrong shape for the text it glows in, or
 * null when it is fine.
 *
 * A highlight is ONE word: a single syllable standing on its own, or a word of
 * exactly two syllables that the text itself joins with "_". Two syllables a
 * space apart are two words, a "=" pair is two words leaning together, and
 * anything of three syllables or more reads as a clause on a feed page, even
 * when the text joins it.
 */
export function emphasisShapeProblem(phrase: string, text: string): string | null {
  const syllables = phrase.normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? [];
  if (syllables.length === 0) return null;
  if (syllables.length > 2) {
    return `${syllables.length} syllables; a highlight is one syllable or one two-syllable "_" word`;
  }
  const whole = (joint: string) =>
    new RegExp(
      `(?<![\\p{L}\\p{N}_])${syllables.map(escapeRegExp).join(joint)}(?![\\p{L}\\p{N}_])`,
      "iu",
    ).test(text.normalize("NFC"));
  if (syllables.length === 1) {
    return whole("") ? null : `"${syllables[0]}" is only part of a "_" word here`;
  }
  if (whole("_")) return null;
  if (whole(CLITIC_BIND)) return `it spans a "${CLITIC_BIND}" bind; only a "_" word may glow as two syllables`;
  return `two syllables the text does not join with "_"; a two-syllable highlight must be one "_" word`;
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
 * Only a word join ("_") is evidence of a compound. It says outright that the
 * two syllables are one word, so highlighting one of them is highlighting half
 * a word.
 *
 * A plain space is NOT evidence. It is the default between every Vietnamese
 * syllable, so reading it as a compound dropped legitimate single-syllable
 * words wholesale — 586 defVi markers in one run. The deck marks a true
 * compound with "_"; where it did not, the syllables stand as the separate
 * words they are written as, and a lone syllable is kept.
 */
function isTightJunction(junction: string): boolean {
  return junction.includes("_") && /^[\s_]*$/u.test(junction);
}

/** Content syllable: at least two letters and not a function word. */
function isContentSyllable(token: string): boolean {
  const key = emphasisTokenKey(token);
  return key.length >= 2 && !VIETNAMESE_STOP_WORDS.has(key);
}

/**
 * Validate one candidate in a language with no spaces between words.
 *
 * Everything the space-separated path does by inspecting neighbours is a
 * question the author has already answered: the rules require one content word
 * with no particles, occurring exactly once in its own field, never across a
 * space, a "=" or a "|". So what is left to check is that it is THERE, that it
 * fits the length the profile allows, and that it is not pure padding.
 */
function validateUnspaced(
  candidate: string,
  haystacks: readonly string[],
  profile: GlossProfile,
): { phrase: string | null; warnings: string[] } {
  const warnings: string[] = [];
  // Stored as displayed: a phrase that arrived with a mark or a 文節 space in
  // it is reduced to what the reader sees, which is the form the text holds.
  const phrase = displayText(candidate.normalize("NFC").trim(), profile);
  if (phrase.length === 0) return { phrase: null, warnings };

  if (findOccurrence(haystacks, phrase, profile) === null) {
    warnings.push(
      `emphasisVi: dropped "${phrase}" — not present in defVi or leadVi, or it crosses a space, a "${CLITIC_BIND}" or a "${PHRASE_BREAK}"`,
    );
    return { phrase: null, warnings };
  }

  const size = measureLength(phrase, profile);
  if (size > profile.emphasis.max) {
    warnings.push(
      `emphasisVi: dropped "${phrase}" — ${size} ${profile.emphasis.unitWord}; a highlight is one word, at most ${profile.emphasis.max}`,
    );
    return { phrase: null, warnings };
  }

  if (profile.fillers.includes(phrase) || profile.intensifiers.includes(phrase)) {
    warnings.push(`emphasisVi: dropped "${phrase}" — padding, not a word that means something`);
    return { phrase: null, warnings };
  }

  return { phrase, warnings };
}

/** Validate one candidate phrase; `phrase: null` means drop it. */
function validateCandidate(
  candidate: string,
  haystacks: readonly string[],
  profile: GlossProfile,
): { phrase: string | null; warnings: string[] } {
  if (profile.measure !== "words") return validateUnspaced(candidate, haystacks, profile);

  const warnings: string[] = [];
  const phrase = candidate.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (phrase.length === 0) return { phrase: null, warnings };

  const occurrence = findOccurrence(haystacks, phrase, profile);
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

  const shape = haystacks.some((haystack) => emphasisShapeProblem(phrase, haystack) === null)
    ? null
    : emphasisShapeProblem(phrase, occurrence.haystack);
  if (shape !== null) {
    warnings.push(`emphasisVi: dropped "${found}" — ${shape}`);
    return { phrase: null, warnings };
  }

  return { phrase: found, warnings };
}

/**
 * Validate every emphasis candidate for one word.
 * @returns deduplicated phrases in source casing plus warnings for every change
 */
export function validateEmphasis(input: EmphasisInput): EmphasisResult {
  const profile = input.profile ?? activeGlossProfile();
  const haystacks = [input.defVi, input.leadVi ?? ""]
    .map((value) => value.normalize("NFC"))
    .filter((value) => value.trim().length > 0);

  const emphasis: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const candidate of input.emphasisVi) {
    const result = validateCandidate(candidate, haystacks, profile);
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
  profile: GlossProfile = activeGlossProfile(),
): { defVi: string; leadVi: string; warnings: string[] } {
  const warnings: string[] = [];
  let outDef = defVi;
  let outLead = leadVi;

  const markOnce = (text: string, phrase: string): string | null => {
    if (text.includes(MARKER)) return null; // already marked
    // The marker wraps the TEXT's own form rather than the phrase, marks
    // intact — `/Chất_lỏng/`, never `/Chất lỏng/`; `/気前が_いい/`, never
    // `/気前がいい/` — so stripping the marker gives the field back unchanged.
    const match = emphasisPattern(phrase, profile).exec(text);
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

/**
 * A deck sentence as a list of chips the reviewer can rearrange by hand.
 *
 * The text carries four kinds of mark — `_` joins, `=` binds, `|` phrase breaks
 * and `/…/` highlights — and a hand edit must keep every one of them intact.
 * Editing the raw string invites a stray slash or a lost join, so the editor
 * works on tokens instead and writes the string back only when it is saved:
 *
 *   word   one lexical word, `_` joins kept inside it ("Đạt_được")
 *   break  one `|`, sitting in a gap between two words
 *
 * A `=` is not a token: it is a flag on the word before it, so a bound pair
 * stays two chips that can be deleted or highlighted one at a time.
 *
 * Exports: SentenceToken, WordToken, parseSentence, serializeSentence,
 *          wordCount, moveBreak, removeToken, toggleHighlight, insertAtGap
 * Depends on: ./joiner.ts
 */
import { CLITIC_BIND, PHRASE_BREAK } from "./joiner.ts";

export interface WordToken {
  kind: "word";
  lead: string;
  core: string;
  trail: string;
  marked: boolean;
  /** Bound to the next word with `=` rather than a space. */
  bind: boolean;
}

export type SentenceToken = WordToken | { kind: "break" };

const MARKER = "/";

/** Split one whitespace-free piece into its `=`-bound words. */
function parsePiece(piece: string, inMarker: boolean): { words: WordToken[]; inMarker: boolean } {
  const words: WordToken[] = [];
  let text = "";
  let marked = false;
  const flush = (bind: boolean) => {
    if (text.length === 0) return;
    const lead = /^[^\p{L}\p{N}]*/u.exec(text)?.[0] ?? "";
    const rest = text.slice(lead.length);
    const trail = /[^\p{L}\p{N}]*$/u.exec(rest)?.[0] ?? "";
    const core = rest.slice(0, rest.length - trail.length);
    words.push({ kind: "word", lead, core, trail, marked: core.length > 0 && marked, bind });
    text = "";
    marked = false;
  };

  const chars = [...piece];
  chars.forEach((char, index) => {
    if (char === MARKER) {
      inMarker = !inMarker;
    } else if (
      char === CLITIC_BIND &&
      /[\p{L}\p{N}\p{M}]/u.test(chars[index - 1] ?? "") &&
      /[\p{L}\p{N}/]/u.test(chars[index + 1] ?? "")
    ) {
      flush(true);
    } else {
      text += char;
      if (inMarker && /[\p{L}\p{N}]/u.test(char)) marked = true;
    }
  });
  flush(false);
  return { words, inMarker };
}

/** Read a deck field into chips. */
export function parseSentence(text: string): SentenceToken[] {
  const tokens: SentenceToken[] = [];
  let inMarker = false;
  const spaced = text.normalize("NFC").replace(/\s*\|\s*/gu, ` ${PHRASE_BREAK} `);
  for (const piece of spaced.split(/\s+/u).filter(Boolean)) {
    if (piece === PHRASE_BREAK) {
      tokens.push({ kind: "break" });
      continue;
    }
    const parsed = parsePiece(piece, inMarker);
    inMarker = parsed.inMarker;
    tokens.push(...parsed.words);
  }
  return tokens;
}

/**
 * Write chips back as deck text.
 *
 * Breaks at either end or next to another break are dropped, and a `=` only
 * survives when a word follows it directly. A run of highlighted words shares
 * one `/…/` as long as only a plain space separates them.
 */
export function serializeSentence(tokens: readonly SentenceToken[]): string {
  const cleaned: SentenceToken[] = [];
  for (const token of tokens) {
    if (token.kind === "break") {
      const previous = cleaned[cleaned.length - 1];
      if (previous === undefined || previous.kind === "break") continue;
    }
    cleaned.push(token);
  }
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].kind === "break") cleaned.pop();

  const continuesRun = (left: SentenceToken | undefined, right: SentenceToken | undefined) =>
    left?.kind === "word" &&
    right?.kind === "word" &&
    left.marked &&
    right.marked &&
    !left.bind &&
    left.trail.length === 0 &&
    right.lead.length === 0;

  let out = "";
  cleaned.forEach((token, index) => {
    if (token.kind === "break") {
      out += ` ${PHRASE_BREAK} `;
      return;
    }
    const highlighted = token.marked && token.core.length > 0;
    const open = highlighted && !continuesRun(cleaned[index - 1], token) ? MARKER : "";
    const close = highlighted && !continuesRun(token, cleaned[index + 1]) ? MARKER : "";
    out += `${token.lead}${open}${token.core}${close}${token.trail}`;
    const next = cleaned[index + 1];
    if (next?.kind === "word") out += token.bind ? CLITIC_BIND : " ";
  });
  return out.trim();
}

/** Number of word chips, which is also the highest gap index. */
export function wordCount(tokens: readonly SentenceToken[]): number {
  return tokens.filter((token) => token.kind === "word").length;
}

/** Token index at which something inserted into word gap `gap` lands. */
function tokenIndexOfGap(tokens: readonly SentenceToken[], gap: number): number {
  let words = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== "word") continue;
    if (words === gap) return index;
    words += 1;
  }
  return tokens.length;
}

/**
 * Move the break at token index `from` into word gap `gap` — the gap before
 * the `gap`-th word. A break at either edge of the sentence means nothing, so
 * the gap is clamped inside it.
 */
export function moveBreak(tokens: readonly SentenceToken[], from: number, gap: number): SentenceToken[] {
  if (tokens[from]?.kind !== "break") return [...tokens];
  const rest = tokens.filter((_, index) => index !== from);
  const words = wordCount(rest);
  if (words < 2) return rest;
  const clamped = Math.min(Math.max(gap, 1), words - 1);
  const at = tokenIndexOfGap(rest, clamped);
  if (rest[at - 1]?.kind === "break") return rest;
  const previous = rest[at - 1];
  const unbound = previous?.kind === "word" && previous.bind ? { ...previous, bind: false } : previous;
  return [...rest.slice(0, at - 1), unbound, { kind: "break" }, ...rest.slice(at)] as SentenceToken[];
}

/** Drop one chip. A deleted word hands its `=` and trailing punctuation to its neighbour. */
export function removeToken(tokens: readonly SentenceToken[], index: number): SentenceToken[] {
  const target = tokens[index];
  if (target === undefined) return [...tokens];
  const next = tokens.filter((_, at) => at !== index);
  if (target.kind !== "word") return next;
  const previous = next[index - 1];
  if (previous?.kind === "word") next[index - 1] = { ...previous, bind: target.bind };
  const isLastWord = !next.slice(index).some((token) => token.kind === "word");
  if (isLastWord && target.trail.length > 0) {
    for (let at = index - 1; at >= 0; at -= 1) {
      const candidate = next[at];
      if (candidate.kind !== "word") continue;
      next[at] = { ...candidate, trail: candidate.trail.replace(/[,;:]+$/u, "") + target.trail };
      break;
    }
  }
  return next;
}

/** Flip the highlight on one word chip. */
export function toggleHighlight(tokens: readonly SentenceToken[], index: number): SentenceToken[] {
  return tokens.map((token, at) =>
    at === index && token.kind === "word" && token.core.length > 0 ? { ...token, marked: !token.marked } : token,
  );
}

/**
 * Insert typed text into word gap `gap`. The text is parsed like a field, so
 * "quan_trọng", "của=tôi" or a lone "|" all arrive as the right chips.
 */
export function insertAtGap(tokens: readonly SentenceToken[], gap: number, text: string): SentenceToken[] {
  const inserted = parseSentence(text);
  if (inserted.length === 0) return [...tokens];
  const at = tokenIndexOfGap(tokens, gap);
  const before = tokens.slice(0, at);
  const after = tokens.slice(at);
  // Text typed after the last word goes before its full stop, not after it.
  const last = before[before.length - 1];
  if (after.length === 0 && last?.kind === "word" && last.trail.length > 0) {
    const tailIndex = inserted.map((token) => token.kind).lastIndexOf("word");
    if (tailIndex >= 0) {
      const tail = inserted[tailIndex] as WordToken;
      inserted[tailIndex] = { ...tail, trail: tail.trail + last.trail };
      before[before.length - 1] = { ...last, trail: "" };
    }
  }
  const previous = before[before.length - 1];
  if (previous?.kind === "word" && previous.bind && inserted[0].kind === "break") {
    before[before.length - 1] = { ...previous, bind: false };
  }
  return [...before, ...inserted, ...after];
}

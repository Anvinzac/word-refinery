/**
 * The example-level ceiling, enforced against a real CEFR word list.
 *
 * U1 is the rule that an example sentence must never be harder than the word it
 * teaches: an A2 card may use A1 and A2 words and nothing else. Deciding it
 * needs a list that says what level every English word is, and this package
 * cannot carry one.
 *
 * WHY THE LIST IS AN INPUT RATHER THAN AN ASSET. Three candidates exist and
 * none of them can be committed here:
 *
 *   - The Oxford 3000/5000, which the prompts were written against, forbids
 *     redistribution outright (see NOTICE.md).
 *   - The CEFR-J Wordlist 1.5 is free to USE for research and commercial
 *     purposes with citation, but its terms do not plainly grant
 *     redistribution, and "probably fine" is not a licence.
 *   - The Octanove Vocabulary Profile 1.0 IS CC BY-SA 4.0, and so could ship —
 *     but it covers C1 and C2 only, which is no use to a ceiling at B2.
 *
 * So the list arrives the way a manifest does: chosen at verification time,
 * read in the browser, never written to disk by this app and never part of it.
 * That keeps every one of those three usable by whoever holds a copy, and it
 * means the ceiling is real for the list in front of the reviewer rather than
 * for the handful of words a prompt happened to name.
 *
 * Without a list the ceiling is SKIPPED and said to be skipped. A guessed
 * level is worse than an absent one: it would reject correct sentences and
 * pass wrong ones, and a reviewer could not tell which.
 *
 * Exports: CefrWordList, CountedToken, parseCefrWords, levelOf, countableTokens,
 *          candidateForms, describeWordList
 * Depends on: ./types.ts
 */
import { CEFR_LEVELS, type CefrLevel } from "./types.ts";

/** A word list that can answer "what level is this word?". */
export interface CefrWordList {
  /** Lower-cased headword to its LOWEST listed level. */
  levels: ReadonlyMap<string, CefrLevel>;
  /** What to call it in a message: the file name, or what the file said it is. */
  name: string;
}

/** Every level name, for recognising one in a cell. */
const LEVEL_SET = new Set<string>(CEFR_LEVELS);

/** Read a level from a cell, or undefined when the cell is not one. */
function asLevel(value: unknown): CefrLevel | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.trim().toUpperCase();
  return LEVEL_SET.has(upper) ? (upper as CefrLevel) : undefined;
}

/**
 * Keep the LOWEST level a word is listed at.
 *
 * A word often appears several times — once per part of speech, and across two
 * lists that overlap. The prompts settle it the same way: "the level of a word
 * is its lowest level in the list", because a learner who has met the word at
 * all has met it.
 */
function record(levels: Map<string, CefrLevel>, headword: string, level: CefrLevel): void {
  // A single row may carry variants: "a.m./A.M./am/AM".
  for (const part of headword.split("/")) {
    const word = part.trim().toLowerCase();
    if (word.length === 0 || /[^\p{L}\p{N}'.\- ]/u.test(word)) continue;
    const held = levels.get(word);
    if (held === undefined || CEFR_LEVELS.indexOf(level) < CEFR_LEVELS.indexOf(held)) {
      levels.set(word, level);
    }
  }
}

/** Split one CSV line, honouring double quotes. */
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

/** CSV with a header naming a headword column and a level column. */
function fromCsv(text: string, name: string): CefrWordList | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return null;
  const header = csvCells(lines[0]!).map((cell) => cell.trim().replace(/^﻿/, "").toLowerCase());
  const wordAt = header.findIndex((cell) => /^(headword|word|lemma|entry)$/.test(cell));
  const levelAt = header.findIndex((cell) => /^(cefr|level|cefr_level|band)$/.test(cell));
  if (wordAt === -1 || levelAt === -1) return null;

  const levels = new Map<string, CefrLevel>();
  for (const line of lines.slice(1)) {
    const cells = csvCells(line);
    const level = asLevel(cells[levelAt]);
    if (level === undefined) continue;
    record(levels, cells[wordAt] ?? "", level);
  }
  return levels.size === 0 ? null : { levels, name };
}

/**
 * One of the JSON shapes a levelled list comes in.
 *
 * Four are accepted because four exist in the wild and none is canonical: a
 * flat word-to-level map, a list of records, a level-keyed set of arrays, and
 * this app's own corpus file. Guessing between them is safe — they are
 * distinguishable by shape, and a file that is none of them returns null rather
 * than a half-read list.
 */
function fromJson(parsed: unknown, name: string): CefrWordList | null {
  const levels = new Map<string, CefrLevel>();

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const level = asLevel(row.level ?? row.cefr ?? row.CEFR);
      const word = row.word ?? row.headword ?? row.lemma;
      if (level !== undefined && typeof word === "string") record(levels, word, level);
    }
    return levels.size === 0 ? null : { levels, name };
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const record_ = parsed as Record<string, unknown>;

  // This app's own corpus document, and anything else with a `words` array.
  if (Array.isArray(record_.words)) return fromJson(record_.words, name);

  for (const [key, value] of Object.entries(record_)) {
    const keyLevel = asLevel(key);
    if (keyLevel !== undefined && Array.isArray(value)) {
      // { "A1": ["a", "about", ...], ... }
      for (const word of value) if (typeof word === "string") record(levels, word, keyLevel);
      continue;
    }
    // { "about": "A1", ... }
    const level = asLevel(value);
    if (level !== undefined) record(levels, key, level);
  }
  return levels.size === 0 ? null : { levels, name };
}

/**
 * Read a CEFR word list from a file's text.
 *
 * @param text - the file as read
 * @param name - what to call it in a message, usually the file name
 * @returns the list, or null when the text is not a levelled word list
 */
export function parseCefrWords(text: string, name: string): CefrWordList | null {
  const trimmed = text.replace(/^﻿/, "").trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return fromJson(JSON.parse(trimmed), name);
    } catch {
      return null;
    }
  }
  return fromCsv(trimmed, name);
}

/** How to describe a list in a notice. */
export function describeWordList(list: CefrWordList): string {
  return `${list.name} — ${list.levels.size.toLocaleString("en")} words`;
}

/**
 * Irregular forms, because a suffix rule cannot reach them.
 *
 * A levelled list is compiled from lemmas: CEFR-J 1.5 has `go` and not `went`,
 * `child` and not `children`. Measured over 500 B2 cards, suffix stripping
 * alone left nine words unresolved and EIGHT of them were irregular pasts —
 * won, began, spent, chose, sold, flew, wore. Reporting those as "not in the
 * list" would be the checker's failure dressed up as the card's.
 */
const IRREGULAR: Readonly<Record<string, string>> = {
  // be / have / do, which carry the most forms of all
  am: "be", is: "be", are: "be", was: "be", were: "be", been: "be", being: "be",
  has: "have", had: "have", having: "have", does: "do", did: "do", done: "do", doing: "do",
  // the common strong verbs
  went: "go", gone: "go", ate: "eat", eaten: "eat", saw: "see", seen: "see",
  took: "take", taken: "take", came: "come", got: "get", gotten: "get",
  made: "make", said: "say", told: "tell", gave: "give", given: "give",
  found: "find", thought: "think", brought: "bring", bought: "buy",
  caught: "catch", taught: "teach", felt: "feel", kept: "keep", left: "leave",
  lost: "lose", met: "meet", paid: "pay", ran: "run", sat: "sit",
  slept: "sleep", spoke: "speak", spoken: "speak", stood: "stand",
  wrote: "write", written: "write", knew: "know", known: "know",
  grew: "grow", grown: "grow", held: "hold", heard: "hear",
  won: "win", began: "begin", begun: "begin", spent: "spend",
  chose: "choose", chosen: "choose", sold: "sell", flew: "fly", flown: "fly",
  wore: "wear", worn: "wear", broke: "break", broken: "break",
  drove: "drive", driven: "drive", rode: "ride", ridden: "ride",
  rose: "rise", risen: "rise", sang: "sing", sung: "sing",
  swam: "swim", swum: "swim", threw: "throw", thrown: "throw",
  woke: "wake", woken: "wake", built: "build", sent: "send",
  meant: "mean", learnt: "learn", dealt: "deal",
  drew: "draw", drawn: "draw", fell: "fall", fallen: "fall",
  forgot: "forget", forgotten: "forget", hid: "hide", hidden: "hide",
  lain: "lie", led: "lead", lent: "lend",
  shone: "shine", shot: "shoot", shut: "shut", sought: "seek",
  stole: "steal", stolen: "steal", stuck: "stick", struck: "strike",
  understood: "understand", wrung: "wring", fought: "fight",
  drank: "drink", drunk: "drink", blew: "blow", blown: "blow",
  froze: "freeze", frozen: "freeze", hung: "hang", swept: "sweep",
  tore: "tear", torn: "tear", bled: "bleed",
  fed: "feed", fled: "flee", knelt: "kneel", lit: "light",
  shook: "shake", shaken: "shake", sank: "sink", sunk: "sink",
  spread: "spread", sprang: "spring", stung: "sting", swore: "swear",
  // ordinals, which a lemma list gives only as cardinals
  first: "one", second: "two", third: "three", fifth: "five",
  eighth: "eight", ninth: "nine", twelfth: "twelve",
  // irregular plurals
  children: "child", men: "man", women: "woman", feet: "foot", teeth: "tooth",
  geese: "goose", mice: "mouse", people: "person", lives: "life",
  knives: "knife", leaves: "leaf", wives: "wife", shelves: "shelf",
  // irregular comparison
  better: "good", best: "good", worse: "bad", worst: "bad",
  more: "much", most: "much", further: "far", furthest: "far",
  farther: "far", farthest: "far", less: "little", least: "little",
};

/**
 * Words written solid that a lemma list holds as two.
 *
 * "cannot" fired seven times on the Japanese deck as "not in the list", which
 * is the checker's spelling preference, not the card's vocabulary.
 */
const SOLID_PAIRS: Readonly<Record<string, readonly [string, string]>> = {
  cannot: ["can", "not"],
  everyone: ["every", "one"],
  everything: ["every", "thing"],
  everybody: ["every", "body"],
  someone: ["some", "one"],
  something: ["some", "thing"],
  somebody: ["some", "body"],
  anyone: ["any", "one"],
  anything: ["any", "thing"],
  anybody: ["any", "body"],
  nobody: ["no", "body"],
  nothing: ["no", "thing"],
  myself: ["my", "self"],
  yourself: ["your", "self"],
  himself: ["him", "self"],
  herself: ["her", "self"],
  itself: ["it", "self"],
  ourselves: ["our", "self"],
  themselves: ["them", "self"],
};

/** Contraction tails, longest first so "n't" wins over "t". */
const CONTRACTIONS: ReadonlyArray<readonly [string, string]> = [
  ["n't", "not"],
  ["'re", "be"],
  ["'ve", "have"],
  ["'ll", "will"],
  ["'d", "would"],
  ["'m", "be"],
  ["'s", ""],
];

/**
 * Every form of a token worth looking up, the token itself first.
 *
 * Deliberately generous: a false base form that happens to be in the list
 * would wrongly clear a word, but a missing one wrongly condemns a correct
 * sentence, and the second is the error a reviewer cannot act on. The list
 * itself is the authority on what exists; this only decides what to ask it.
 *
 * @param token - one lower-cased word
 */
export function candidateForms(token: string): string[] {
  const forms = [token];
  const irregular = IRREGULAR[token];
  if (irregular !== undefined) forms.push(irregular);

  const add = (form: string) => {
    if (form.length >= 2 && !forms.includes(form)) forms.push(form);
  };

  // tenth -> ten, twentieth -> twenty. A lemma list carries the cardinal only.
  if (token.endsWith("th") && token.length > 3) add(token.slice(0, -2));
  if (token.endsWith("ieth") && token.length > 5) add(`${token.slice(0, -4)}y`);

  for (const [suffix, replacement] of [
    ["ies", "y"], ["ied", "y"], ["ier", "y"], ["iest", "y"], ["ily", "y"],
    ["es", ""], ["s", ""], ["ed", ""], ["ing", ""],
    ["er", ""], ["est", ""], ["ly", ""],
  ] as const) {
    if (!token.endsWith(suffix) || token.length - suffix.length < 2) continue;
    const base = token.slice(0, token.length - suffix.length) + replacement;
    add(base);
    if (suffix === "ed" || suffix === "ing" || suffix === "er" || suffix === "est") {
      // hoped -> hope, running -> run, bigger -> big
      add(`${base}e`);
      if (base.length >= 3 && base[base.length - 1] === base[base.length - 2]) {
        add(base.slice(0, -1));
      }
    }
  }
  return forms;
}

/**
 * The level of one token, by the lowest level any of its forms is listed at.
 *
 * @param list - the word list in force
 * @param token - one lower-cased word
 * @returns its level, or undefined when no form of it is listed
 */
export function levelOf(list: CefrWordList, token: string): CefrLevel | undefined {
  let best: CefrLevel | undefined;
  for (const form of candidateForms(token)) {
    const level = list.levels.get(form);
    if (level === undefined) continue;
    if (best === undefined || CEFR_LEVELS.indexOf(level) < CEFR_LEVELS.indexOf(best)) best = level;
  }
  return best;
}

/** One word of an example, with what the sentence did to its first letter. */
export interface CountedToken {
  /** Lower-cased, contraction expanded, solid compound split. */
  token: string;
  /**
   * Whether it was written with a capital where a capital is not forced.
   *
   * A name is exempt from U1, and the lists that answer levels carry no names,
   * so an unlisted word is a U1 error only when nothing suggests it is a name.
   * A capital mid-sentence settles it; a capital at the start of a sentence
   * says nothing either way, which is why this is reported rather than acted
   * on there.
   */
  capitalised: boolean;
  /** True for the first word of the sentence, where a capital is forced. */
  opensSentence: boolean;
}

/**
 * The words of an example sentence that the ceiling actually counts.
 *
 * The prompts exempt four things, and each exemption is load-bearing: the blank
 * stands for the target word, which is by definition at the card's own level; a
 * name is not vocabulary; a digit has no level; and a contraction counts as its
 * base word, so "don't" must be read as "do" rather than condemned whole.
 *
 * A capitalised word MID-SENTENCE is dropped outright — it is a name, and that
 * is the rule. At the start of a sentence a capital is forced by position and
 * says nothing, so the word is counted and flagged instead: the caller can
 * then say "unlisted, and it looks like a name" rather than calling London a
 * vocabulary error. Doing better than that needs the names list the prompts
 * refer to, which is part of the list this app does not carry.
 *
 * @param usageEn - the example sentence, with its `_____` blank
 * @returns the countable words in order, duplicates kept
 */
export function countableTokens(usageEn: string): CountedToken[] {
  // The blank may carry an inflection: "_____s", "_____ed".
  const body = usageEn.replace(/_{3,}[a-z]*/gi, " \u0000 ");
  const counted: CountedToken[] = [];
  let first = true;

  for (const match of body.matchAll(/[\p{L}\p{N}'\u2019\u0000]+/gu)) {
    const raw = match[0]!;
    const opensSentence = first;
    first = false;
    if (raw.includes("\u0000")) continue;
    // A digit has no level, and a word with a digit in it is not a word.
    if (/\p{N}/u.test(raw)) continue;

    // Quotes and stray apostrophes are punctuation the regex swept up: a
    // leading one turned «"Nice» into «'nice», which is in no list.
    const bare = raw.replace(/^['\u2019]+/, "").replace(/['\u2019]+$/, "");
    if (bare.length === 0) continue;

    const capitalised = bare[0] !== bare[0]!.toLowerCase();
    if (capitalised && !opensSentence) continue;

    let token = bare.toLowerCase().replace(/\u2019/g, "'");
    const push = (value: string) => {
      if (value.length > 0) counted.push({ token: value, capitalised, opensSentence });
    };

    let expanded = false;
    for (const [tail, base] of CONTRACTIONS) {
      if (!token.endsWith(tail) || token.length <= tail.length) continue;
      const stem = token.slice(0, token.length - tail.length);
      // "can't" is "can" + "not", not "ca" + "not"; "won't" is "will" + "not".
      push(stem === "ca" ? "can" : stem === "wo" ? "will" : stem);
      if (base.length > 0) push(base);
      expanded = true;
      break;
    }
    if (expanded) continue;

    const pair = SOLID_PAIRS[token];
    if (pair !== undefined) {
      push(pair[0]);
      push(pair[1]);
      continue;
    }
    push(token.replace(/'/g, ""));
  }
  return counted;
}

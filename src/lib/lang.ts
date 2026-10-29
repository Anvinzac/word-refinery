/**
 * Gloss languages — what a card explains an English word IN.
 *
 * The headword is always English. What changes between workspaces is the
 * language the card is WRITTEN in, and almost everything the refinery enforces
 * turns out to be a fact about that language rather than about vocabulary
 * cards: how a sentence's length is measured, where a line may break, what
 * counts as giving the answer away, what a highlighted phrase may be.
 *
 * Those facts live here, one profile per language, so adding a language is
 * writing a profile rather than threading a flag through twenty files.
 *
 * Two of them are worth stating plainly, because they invert between the two
 * languages that exist today:
 *
 *   LENGTH. Vietnamese is written in syllables separated by spaces, so a
 *   sentence is measured in words. Japanese is written without spaces, so word
 *   counting is a parsing problem and the honest measure is characters.
 *
 *   BREAKING. Vietnamese puts a space between every syllable, so a line may
 *   break anywhere a word does not want it to, and the marks exist to say "not
 *   here". Japanese has no spaces, so a renderer may break between ANY two
 *   characters, and the useful mark is the one that says "here is fine". The
 *   same three marks carry the same three meanings in both; which of them does
 *   the work is what differs.
 *
 * Exports: GlossProfile, GLOSS_LANGS, glossProfile, activeGlossProfile,
 *          measureLength, describeLength, markRules
 * Depends on: ./joiner.ts, ./workspace.ts
 */
import { countUnits, stripMarks, type MarkRules } from "./joiner.ts";
import { activeWorkspace, type GlossLang } from "./workspace.ts";

/** A length rule for one field, in the profile's own unit. */
export interface LengthRule {
  min: number;
  max: number;
  /** A hard ceiling in characters, where it differs from `max`. */
  maxChars?: number;
}

/** Everything that differs between one gloss language and the next. */
export interface GlossProfile {
  id: GlossLang;
  /** English name, for prompts and column headers. */
  label: string;
  /** The language's own name, for the workspace switcher. */
  nativeLabel: string;
  locale: string;
  /** The default name for a deck written in it. */
  deckName: string;
  /** Where the learners are. Used by the safety prompt, which is about them. */
  country: string;

  /** How a sentence's length is measured, and what the unit is called. */
  measure: "words" | "characters";
  /** Singular/plural noun for the unit, for messages: "9 words", "22 characters". */
  unitWord: string;
  /** The unit as a noun phrase: "word count", "character count". */
  countPhrase: string;
  limits: {
    def: LengthRule;
    lead: LengthRule;
    anticipate: LengthRule;
    /**
     * The revealed gloss, measured ONE ALTERNATIVE at a time: a gloss may offer
     * two genuine senses ("anh_trai hoặc em_trai"), and the defect this catches
     * is a single long run, which is a definition wearing a gloss's clothes.
     */
    meaning: LengthRule;
  };
  /**
   * The whole gloss, both alternatives together, as card-prompt v3.7 states it.
   *
   * A different question from `limits.meaning`, and so a different number: that
   * one asks whether any one equivalent has turned into a description, this one
   * asks whether the field as a whole has outgrown the space the reveal panel
   * gives it.
   */
  glossUnits: number;
  /**
   * How long a highlighted phrase may be.
   *
   * Measured in the language's own unit but NAMED separately: a Vietnamese
   * highlight of four is four syllables of one word, not four words, and a
   * message that called them words would be telling the reviewer something
   * untrue about their own language.
   */
  emphasis: { min: number; max: number; maxChars: number; unitWord: string };

  /** Which breaking marks this language actually uses. */
  marks: {
    /** "_" joins the pieces of one word. */
    join: boolean;
    /** "=" binds two words that must share a line. */
    clitic: boolean;
    /** "|" marks a welcome break. "required" means a sentence without one is thin. */
    phrase: "required" | "optional";
    /** The smallest phrase a "|" may create, in the profile's own unit. */
    minPhrase: number;
  };

  /** One line naming the reader. Opens every prompt. */
  audience: string;
  /** The breaking-mark convention, in this language's terms. */
  joining: string;
  /** Orthography and register, binding on a rewrite as much as a batch. */
  rules: string;
  /** How to choose the phrase that glows. */
  emphasisChoice: string;
  /** Field rules that are language-specific; the rest are shared. */
  fieldRules: {
    meaning: string;
    def: string;
    lead: string;
    anticipate: string;
    usageGloss: string;
    emphasis: string;
  };
  /** A complete card, shown to the model as the shape of a reply. */
  example: string;
  /** What the example is demonstrating, in one parenthesis. */
  exampleNote: string;

  /**
   * Words that warm a sentence's tone but may never carry the highlight: the
   * glow has to land on a word that means something.
   */
  fillers: readonly string[];
  /** Padding that may never be the highlight either. */
  intensifiers: readonly string[];
  /** How a sentence ends. A gloss that ends this way has become a sentence. */
  sentenceEnd: readonly string[];

  /**
   * Rewrites for the complaint chips whose wording is language-specific.
   *
   * The chips are one vocabulary shared by the Review table and the prompt
   * builder, and most of them say nothing about the language. The few that do -
   * diacritics, "no native speaker would say this", the unit a length is
   * counted in - are replaced here rather than duplicated, so a new chip is
   * offered in every language the day it is written.
   */
  chips?: Readonly<Record<string, { label?: string; instruction?: string }>>;
}

/* ------------------------------------------------------------------ Vietnamese */

const VI_EMPHASIS_CHOICE = `  CHOOSE BY MEANING FIRST. Pick the phrase that carries the POINT of the sentence - the idea the learner should walk away with. The test: if the sentence were cut down to two syllables, which two would have to survive for it still to mean anything? Those are the ones. A phrase chosen because it happened to sit next to another word is a DEFECT even when it satisfies every mechanical rule below.
  * Prefer, in this order: the compound that names the concept itself (sức_khỏe, quan_trọng, thư_viện), then a vivid verb or adjective phrase (chảy xiết, lấp_lánh), then a concrete noun phrase.
  * NEVER pick filler: a classifier and its noun ("con mèo"), a number and its noun ("hai người"), a time phrase ("mỗi ngày", "hằng ngày"), a verb with a generic object ("làm việc" when the sentence is not about work), or any span that crosses a comma.
  * It must be copied EXACTLY, diacritics included, from the defVi or leadVi you just wrote.
  * Write it PLAIN, with a space where the text has a join: for "quan_trọng" in defVi, the entry is "quan trọng".
  * ONE word: either a single syllable that carries the meaning, or one joined word of up to four syllables. Never a phrase of separate words.
  * never a function word such as và, là, của, có, được, trong, cho, với, một, rất, cũng, đã, đang, sẽ, không, những, các, thì, mà,
  * at most 30 characters and unique inside the list,
  * appear MID-SENTENCE in lowercase where possible, so the highlight matcher finds it exactly.`;

const VI_JOINING = `Breaking marks (applies to every Vietnamese field: meaningVi, defVi, leadVi, anticipateVi, usageVi):
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

const VIETNAMESE: GlossProfile = {
  id: "vi",
  label: "Vietnamese",
  nativeLabel: "Tiếng Việt",
  locale: "vi-VN",
  deckName: "WordCrawler deck",
  country: "Vietnam",
  measure: "words",
  unitWord: "words",
  countPhrase: "word count",
  limits: {
    def: { min: 8, max: 11, maxChars: 140 },
    lead: { min: 8, max: 11, maxChars: 120 },
    anticipate: { min: 3, max: 8, maxChars: 60 },
    meaning: { min: 1, max: 5, maxChars: 120 },
  },
  glossUnits: 4,
  emphasis: { min: 1, max: 4, maxChars: 30, unitWord: "syllables" },
  marks: { join: true, clitic: true, phrase: "optional", minPhrase: 2 },
  audience:
    "The reader is a Vietnamese learner who sees Vietnamese first and only later the English word.",
  joining: VI_JOINING,
  rules: `- Write correct Vietnamese with full diacritics in every Vietnamese field.
- Never include the English target word, or any English word, in defVi, leadVi or anticipateVi.
- Never define a word with the word itself or an obvious cognate.`,
  emphasisChoice: VI_EMPHASIS_CHOICE,
  fillers: ["nhỉ", "nha", "này", "luôn", "hết cỡ", "ui", "ơi", "nè", "nhé", "thôi"],
  intensifiers: ["rất", "quá", "thật", "lắm"],
  sentenceEnd: ["."],
  fieldRules: {
    meaning:
      'the short Vietnamese EQUIVALENT of the word, one or two words ("quả_táo", "kiên_nhẫn", "tò_mò"), at most 120 characters. This is what the app shows once the answer is revealed, so write the translation a dictionary would give - NOT a sentence, and never a description. defVi is the sentence; this is the word.',
    def: "ONE Vietnamese sentence defining the word, exactly 8-11 words, at most 140 characters, no English words, full diacritics.",
    lead: "a Vietnamese teaser hinting at the meaning without naming it, exactly 8-11 words, at most 120 characters, no English words.",
    anticipate:
      'a short playful Vietnamese invitation to guess, 3-8 words, at most 60 characters. It must be DIFFERENT for every word IN THE WHOLE DECK, not merely within this batch - the user message lists lines and openings already taken, and reusing one is a defect. Vary the opening as well as the wording; never fall back on a placeholder like "Đoán xem nào…".',
    usageGloss: "the Vietnamese meaning of that example sentence.",
    emphasis: "2 Vietnamese phrases that will glow on screen, one drawn from defVi and one from leadVi.",
  },
  example: `[{"word":"water","pos":"noun","ipa":"/ˈwɔː.tər/","meaningVi":"nước","defVi":"Chất_lỏng trong suốt | mà ta uống=mỗi ngày.","leadVi":"Có thứ này thì cây_cối mới sống được.","anticipateVi":"Thứ gì chảy được nhỉ?","usageEn":"Please bring me a glass of _____.","usageVi":"Làm ơn mang cho tôi một cốc nước.","topics":["nature","daily"],"exams":[],"emphasisVi":["Chất lỏng","cây cối"]}]`,
  exampleNote: `(Note the example: "Chất_lỏng" is one word written as two syllables, so defVi still counts 9 words; the "|" marks the phrase edge and the "=" binds a function word to its neighbour; the emphasisVi entry is written plain as "Chất lỏng", and it may not span the "=" or the "|". "meaningVi" is the bare equivalent - "nước" - not a sentence.)`,
};

/* -------------------------------------------------------------------- Japanese */

const JA_EMPHASIS_CHOICE = `  CHOOSE BY MEANING FIRST. Pick the word that carries the POINT of the sentence - the idea the learner should walk away with. The test: if the sentence were cut to one word, which word would have to survive for it still to mean anything? That is the one. A word chosen because it happened to sit next to another is a DEFECT even when it satisfies every mechanical rule below.
  * Prefer, in this order: the noun that names the concept itself (安全、記憶、努力), then a vivid verb or adjective (輝く、たくましい), then a concrete noun.
  * NEVER pick filler: a particle on its own (は、が、を、に、で、と、も、の、へ), a formal noun (こと、もの、ところ、ため), a bare auxiliary (する、いる、ある、なる) or a demonstrative (この、その、あの).
  * It must be copied EXACTLY, character for character, from the defVi or leadVi you just wrote - same kanji, same okurigana, same kana. Do not convert kanji to kana or back.
  * Write it PLAIN, without any "|" inside it.
  * ONE word of 2-6 characters. A verb or adjective is given with its okurigana as it appears in the sentence (登って, not 登る) so the highlight matcher finds it.
  * Never a whole clause, and never a span that crosses a "|" or a 、.
  * It must be unique inside the list.`;

const JA_JOINING = `Breaking marks (applies to every Japanese field: meaningVi, defVi, leadVi, anticipateVi, usageVi):
Japanese is written without spaces, so a renderer may break a line between ANY two characters - in the middle of a word, between a verb and its ending, after a particle that belongs to the phrase before it. One mark fixes that, and it is the opposite of what a space-separated language needs: you are not saying "do not break here", you are saying "HERE is where a break is welcome".
  |  PHRASE EDGE. A space each side, at a 文節 boundary: "手足を使って | 高い所まで登っていくこと。"
- Put "|" at the natural pauses of the sentence - after a topic or subject phrase and its particle, before an adverbial or time phrase, before a subordinate clause, before the final predicate.
- Every stretch between two "|" must be at least 4 characters. "|" exists so a break can land on a phrase edge instead of stranding two characters on a line of their own.
- A sentence of this length wants TWO or THREE "|". One is thin; one after every 文節 is noise, and a line that can break everywhere is the problem you started with.
- A particle belongs to the phrase BEFORE it: write "山に | 登る", never "山 | に登る". The same for を, は, が, で, と, も, から, まで, より.
- Never put "|" inside a word, inside a compound, between a verb and its okurigana, between a number and its counter, or inside a katakana loanword.
- Never put "|" immediately before 、 or 。, and never at the very start or the very end of a field.
- "_" and "=" are NOT used in Japanese. They exist for languages that put spaces between syllables; here there is no space to suppress. An underscore anywhere in a Japanese field is a defect - except the five-underscore blank "_____" in usageEn, which is English and unaffected.
- "|" does not change a character count, and the reader never sees it; the app replaces it when the deck loads.`;

const JAPANESE: GlossProfile = {
  id: "ja",
  label: "Japanese",
  nativeLabel: "日本語",
  locale: "ja-JP",
  deckName: "WordCrawler deck (JA)",
  country: "Japan",
  // No spaces, so "how many words" is a parsing question with no answer the
  // model and the validator would reliably agree on. Characters are countable
  // by both, and they are what actually fills the card.
  measure: "characters",
  unitWord: "characters",
  countPhrase: "character count",
  limits: {
    def: { min: 16, max: 34 },
    lead: { min: 16, max: 34 },
    anticipate: { min: 8, max: 20 },
    meaning: { min: 1, max: 10, maxChars: 40 },
  },
  glossUnits: 10,
  emphasis: { min: 2, max: 6, maxChars: 12, unitWord: "characters" },
  marks: { join: false, clitic: false, phrase: "required", minPhrase: 4 },
  audience:
    "The reader is a Japanese learner of English who sees the Japanese first and only later the English word.",
  joining: JA_JOINING,
  rules: `- Write natural modern Japanese. Full-width punctuation only: 、and 。, never a comma, a full stop or half-width katakana.
- defVi and leadVi are written in PLAIN form (だ・である体). A definition normally ends in 〜こと。or 〜様子。or the plain predicate itself. anticipateVi is spoken, so it may be casual.
- Keep the kanji within reach of the level you are given: a word marked A1 or A2 is read by a beginner, so prefer kana for anything beyond the most common kanji. There is no furigana in these fields.
- NEVER give the answer away. In Japanese the usual leak is katakana: writing チャレンジ for "challenge", エネルギー for "energy" or クライミング for "climb" hands the learner the English word in Japanese clothing. Use a native equivalent (挑戦、活力、登ること) instead. A katakana loanword is allowed only when it is the ordinary Japanese word for the thing AND is not a transcription of the target word.
- No English letters at all in meaningVi, defVi, leadVi, anticipateVi or usageVi.
- Never define a word with the word itself.`,
  emphasisChoice: JA_EMPHASIS_CHOICE,
  fillers: ["ね", "よ", "かな", "だろう", "っけ", "さ", "なあ", "でしょう", "もの", "こと"],
  intensifiers: ["とても", "すごく", "かなり", "本当に", "めっちゃ", "ちょっと"],
  sentenceEnd: ["。", "."],
  fieldRules: {
    meaning:
      'the short Japanese EQUIVALENT of the word - the headword a dictionary would give (登る、思いやり、丈夫な), at most 10 characters. NOT a sentence and never a description: defVi is the sentence, this is the word. A verb is given in dictionary form, an adjective with its ending (丈夫な, 美しい).',
    def: "ONE Japanese sentence defining the word, 16-34 characters, plain form, no English letters, ending in 。",
    lead: "a Japanese teaser hinting at the meaning without naming it, 16-34 characters, ending in 。",
    anticipate:
      'a short playful Japanese invitation to guess, 8-20 characters. It must be DIFFERENT for every word IN THE WHOLE DECK, not merely within this batch - the user message lists lines and openings already taken, and reusing one is a defect. Vary the opening as well as the wording; never fall back on a placeholder like「さあ、何でしょう？」.',
    usageGloss: "the Japanese meaning of that example sentence, in natural Japanese rather than a word-for-word rendering.",
    emphasis: "2 Japanese words that will glow on screen, one drawn from defVi and one from leadVi.",
  },
  example: `[{"word":"water","pos":"noun","ipa":"/ˈwɔː.tər/","meaningVi":"水","defVi":"色も味もなく | 毎日飲んでいる | 透明な液体のこと。","leadVi":"これがなければ | どんな植物も | 育つことはない。","anticipateVi":"流れていくもの、何かな？","usageEn":"Please bring me a glass of _____.","usageVi":"コップ一杯の水を持ってきてください。","topics":["nature","daily"],"exams":[],"emphasisVi":["液体","植物"]}]`,
  chips: {
    "too-long": { instruction: "It runs past the allowed length. Cut it down to the required character count." },
    "too-short": { instruction: "It is shorter than the required character count. Expand it without padding." },
    awkward: {
      instruction: "The phrasing is clumsy. Rewrite it so it reads like fluent written Japanese.",
    },
    unnatural: {
      instruction: "No Japanese speaker would phrase it this way. Use an idiomatic turn of phrase instead.",
    },
    "too-hard": {
      instruction:
        "The vocabulary or the kanji is too advanced for a beginner. Use everyday words, and kana where the kanji is beyond the level.",
    },
    diacritics: {
      label: "Wrong characters",
      instruction:
        "A kanji, its okurigana or a kana is wrong, or the text uses half-width katakana or half-width punctuation. Write correct Japanese orthography with 、and 。.",
    },
    "not-an-equivalent": {
      instruction:
        "It describes the word instead of translating it. Give the bare Japanese equivalent a dictionary would give - a verb in dictionary form, an adjective with its ending.",
    },
    "leaks-answer": {
      instruction:
        "It gives the English headword away - most likely as katakana (チャレンジ for \"challenge\"). Replace it with a native Japanese equivalent so the word stays guessable.",
    },
  },
  exampleNote: `(Note the example: defVi is 22 characters and carries two "|", each at a 文節 boundary with the particle kept on the phrase before it; there is no "_" and no "=" anywhere, because Japanese has no spaces to suppress; "meaningVi" is the bare equivalent 「水」, not a sentence; and each emphasis word - 「液体」 from defVi, 「植物」 from leadVi - is copied exactly as it appears and does not cross a "|".)`,
};

/* ----------------------------------------------------------------------------- */

/** Every gloss language the refinery can write, in the order the picker shows. */
export const GLOSS_LANGS: readonly GlossProfile[] = [VIETNAMESE, JAPANESE];

/** The profile for one language. Falls back to Vietnamese, the original deck. */
export function glossProfile(id: GlossLang): GlossProfile {
  return GLOSS_LANGS.find((profile) => profile.id === id) ?? VIETNAMESE;
}

/**
 * The profile of the open workspace.
 *
 * Read once, where it is used, rather than threaded through every call: a
 * workspace switch RELOADS the page, so this value cannot change under a module
 * that has already read it. That reload is what makes the shortcut sound, and
 * removing it would make this wrong rather than merely untidy.
 */
export function activeGlossProfile(): GlossProfile {
  return glossProfile(activeWorkspace().gloss);
}

/**
 * Measure a field the way its language counts.
 *
 * Marks are stripped first in both cases: joining two syllables must never make
 * a field look shorter than it reads, and a phrase edge is not a character.
 *
 * @param text - the field, with its breaking marks still in it
 * @param profile - the language it is written in
 */
export function measureLength(text: string, profile: GlossProfile): number {
  const clean = stripMarks(text);
  if (profile.measure === "words") return countUnits(clean);
  // Whitespace is not content in a language that does not use it to separate
  // words, and counting it would reward padding.
  return [...clean.replace(/\s+/gu, "")].length;
}

/**
 * Say a measured length the way the message should read.
 * @returns e.g. "9 words" or "22 characters"
 */
export function describeLength(count: number, profile: GlossProfile): string {
  return `${count} ${profile.unitWord}`;
}

/**
 * The mark rules the stray-mark checker should hold this language to.
 *
 * @param profile - the language being checked
 */
export function markRules(profile: GlossProfile): MarkRules {
  return {
    join: profile.marks.join,
    clitic: profile.marks.clitic,
    minPhrase: profile.marks.minPhrase,
    measure: (text) => measureLength(text, profile),
    unitWord: profile.measure === "words" ? "syllable(s)" : profile.unitWord,
  };
}

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
 *   BREAKING. Both languages use all three marks, and both use them to carve a
 *   sentence into the units a phone screen may break between - but they start
 *   from opposite defaults. Vietnamese puts a space between every syllable, so
 *   a line may break anywhere, and "_" and "=" exist to say "not here".
 *   Japanese writes nothing between words, so the marks are laid over 文節 -
 *   the units Japanese school grammar teaches - and the SPACE is markup too.
 *   Which means a bond unstrips differently: "_" in Vietnamese stands where a
 *   space would be, "_" in Japanese stands where nothing would be, and getting
 *   that backwards puts gaps into every quoted Japanese phrase.
 *
 * Exports: GlossProfile, GLOSS_LANGS, glossProfile, activeGlossProfile,
 *          displayText, measureLength, describeLength, markRules
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
  /**
   * True when the range is ADVICE rather than a limit.
   *
   * The two prompts differ here, and the difference is not cosmetic. v3.7 gives
   * Vietnamese a hard 8-11 words. The Japanese rules say "about 12 to 36
   * characters" and their own validator warns rather than errors - what is hard
   * there is the chunk ceiling, the gloss and the highlight. Encoding an aim as
   * a limit would report a tight, correct definition as a defect, and 31 of the
   * 500 Japanese cards write one.
   */
  aim?: boolean;
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

  /**
   * Which field each positional emphasis entry glows in, in order.
   *
   * Both prompts map highlights BY POSITION rather than by searching every
   * field, which is what keeps one sentence from ever showing two glows. But
   * they disagree about the third: card-prompt v3.7 puts it in anticipateVi,
   * the teaser, while the Japanese rules put it in the usage sentence, where it
   * is the answer reveal, and give the teaser no glow at all. A checker that
   * assumed either one would report every card of the other language as having
   * a highlight that does not occur in the sentence it belongs to.
   */
  emphasisSlots: readonly ("def" | "lead" | "anticipate" | "usageGloss")[];

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
    /**
     * The largest, where the language states one. A chunk that fills the screen
     * on its own has not given the line anywhere to break either.
     */
    maxPhrase?: number;
  };

  /**
   * What a bond ("_" or "=") stands in for once it is taken out.
   *
   * "space" where the language writes a space between the pieces a bond joins,
   * so removing the bond has to leave one behind: Vietnamese "ba_lô" is read
   * "ba lô". "none" where it writes them flush: Japanese "見て=いる" is read
   * "見ている", and leaving a space would put a gap into every phrase this app
   * quotes back at a reviewer, and into every emphasis match.
   */
  bondSpacing: "space" | "none";
  /**
   * Whether a reading may ride along as 漢字《かんじ》.
   *
   * It is an aid to the reader rather than part of the sentence, so no length
   * rule counts it and no highlight may contain it.
   */
  ruby: boolean;

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
  emphasisSlots: ["def", "lead", "anticipate"],
  marks: { join: true, clitic: true, phrase: "optional", minPhrase: 2 },
  // Every syllable is already a space apart, so a bond replaces a space.
  bondSpacing: "space",
  ruby: false,
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

const JA_EMPHASIS_CHOICE = `  ONE GLOW PER SENTENCE, chosen by MEANING. The three entries are positional - [0] glows in defVi, [1] in leadVi, [2] in usageVi - and each is searched only in its own field, so no sentence ever shows two highlights.
  * [2] THE TARGET: the Japanese that fills the English blank, exactly as it appears in usageVi, inflected as written (空港, 着く, 怒って, 気前がいい). This is the answer reveal.
  * [0] and [1] are MEANING WORDS: the content word nearest in meaning to the target. Prefer, in this order: an equivalent or near-synonym of the target (achieve: 成し遂げる), then its core quality or state (stubborn: 変えない), then what it typically does or causes (embarrassed: 熱くなる).
  * The two must DIFFER and must approach the meaning from different sides - in defVi usually the equivalent, in leadVi the word in the scene that SHOWS it (angry: 怒り in defVi, 腹が_立った in leadVi).
  * SHAPE: ONE content word with its okurigana and its verb or adjective ending, but no particles (成し遂げる, 変えない, 気前, 熱くなる - not 気前が, not 顔が熱くなる); or ONE "_" idiom given whole (腹が立つ, 気を配る). A final で, と, に or も that belongs to the word stays: te-forms (進んで), mimetics (すっと, 次々と), adverbs (何度も, 一気に). Only a real case particle is dropped.
  * Written exactly as DISPLAYED: no spaces, no marks, no ruby. At most 8 characters. Never across a space, a "=" or a "|" - a "=" unit is not one word, so 忘れて=しまう gives 忘れて.
  * NEVER a word that only names the topic, object or place (ひこうき on an airport card), scene decoration, a generic degree adverb (とても, すごく, 本当に), a time phrase (毎日, 今日), or grammar alone (a pronoun, a number, a 形式名詞, an ordinary particle, a 補助動詞, a bare ない/まだ/だけ).
  * QUALITY TEST: if only this word glowed and the rest stayed plain, would the glow point at the MEANING? If no word in the sentence passes, rewrite the sentence rather than glow an unrelated one.`;

const JA_JOINING = `Breaking marks (applies to every Japanese field: meaningVi, defVi, leadVi, anticipateVi, usageVi):
Japanese is written without spaces, so the marks work on 文節 - the units Japanese school grammar already teaches, and the same 分かち書き a 小1 textbook is printed in. All four are markup: the reader sees none of them, and none of them changes a character count.
  " "  ONE ASCII SPACE separates 文節 inside a chunk. A 文節 is one content word plus the particles and endings stuck to it: 目を / とじるだけで / 白い / 砂の / 海辺に. Never inside a word, a kanji compound, a katakana word, or between a stem and its okurigana. Never a full-width space.
  _   IDIOM JOIN. Joins 文節 that are ONE dictionary entry, an idiom whose meaning is not the sum of its parts: 気が_付く, 手を_貸す, 腹が_立つ, 気前が_いい, 目を_丸くする. Only for real idioms - 本を 読む stays spaced.
  =   GRAMMAR BIND. Joins a dependent 文節 to the one it leans on: a 補助動詞 after the て-form (見えて=くる, 忘れて=しまう), a 補助形容詞 (来て=ほしい), a 形式名詞 to what modifies it (思いうかべる=こと, 人の=ために), a compound particle (私に=とって, 雨に=よって), or a degree adverb directly before the word it grades (すごく=はずかしかった). Chains are fine: 目に=した=ことの ない.
  |   CHUNK EDGE, written with a space each side: the pause or reveal unit.
- Break only between 文節, at a natural breath: after 、, after a topic or subject (〜は, 〜が), after a て/で clause, before the predicate.
- Aim for 3 to 12 displayed characters per chunk; 14 is the hard ceiling. Keep chunks roughly even - never a one-character chunk next to a thirteen-character one. One idea per chunk, and the last chunk carries the predicate or the punchline.
- A chunk never starts with a bare particle, 、 or 。, and a "_" or "=" unit is never split by a "|".
- Punctuation stays at the end of its chunk, before the pipe: 目を とじるだけで、 | 白い 砂の…
- Marks never touch each other or a space (no "_ ", no "=|", no "__"), and none of them may begin or end a field.`;

const JAPANESE: GlossProfile = {
  id: "ja",
  label: "Japanese",
  nativeLabel: "日本語",
  locale: "ja-JP",
  deckName: "WordCrawler deck (JA)",
  country: "Japan",
  // Japanese IS spaced in these cards - but the spaces separate 文節, not
  // words, and they are markup the reader never sees. So "how many words" is
  // still unanswerable, and the rules measure what both the writer and the
  // validator can agree on: DISPLAYED characters, with every mark, every 文節
  // space and every ruby reading taken out first.
  measure: "characters",
  unitWord: "characters",
  countPhrase: "character count",
  limits: {
    // "About" is the rules' own word for these three, and their validator
    // warns on them. The hard numbers in Japanese are elsewhere: a chunk of 14
    // characters, a gloss of 14, a highlight of 8.
    def: { min: 12, max: 36, aim: true },
    lead: { min: 12, max: 38, aim: true },
    anticipate: { min: 3, max: 16, aim: true },
    meaning: { min: 1, max: 14, maxChars: 14 },
  },
  glossUnits: 14,
  // No floor worth enforcing: 神 is one character and a perfectly good glow.
  // The ceiling is what the rule is about.
  emphasis: { min: 1, max: 8, maxChars: 8, unitWord: "characters" },
  // All three marks, and all three for their own reason. "_" says these 文節
  // are one dictionary entry, so a highlight may cover them; "=" says this
  // 文節 leans on the next and may not be split from it; "|" says a break is
  // welcome here. A chunk has a CEILING rather than a floor, because the mark
  // exists to offer a line somewhere to break.
  emphasisSlots: ["def", "lead", "usageGloss"],
  marks: { join: true, clitic: true, phrase: "required", minPhrase: 1, maxPhrase: 14 },
  // The pieces a bond joins are written flush in Japanese, so a bond comes out
  // as nothing. 見て=いる is 見ている, never 見て いる.
  bondSpacing: "none",
  ruby: true,
  audience:
    "The reader is a Japanese student - 小学生 to 大学生, with 大学生 as the core audience - learning English, who sees the Japanese first and only later the English word.",
  joining: JA_JOINING,
  rules: `- Write natural modern Japanese. Full-width punctuation only: 、。？！「」『』…（）・ー. Never , . ? ! : ; " ( ) in Japanese text, and never 〜 or ～ - use から, まで or a rewrite. The ellipsis is a pair, ……, or a single … at the end of anticipateVi.
- defVi is dictionary register, plain form, no です/ます: usually …こと。 for a verb, …様子。 / …気持ち。 / …性格。 for an adjective, …もの。 / …人。 / …場所。 for a noun. leadVi is plain-form narration and may carry タメ口 dialogue in 「」. anticipateVi is the playful field, spoken to the reader. usageVi is natural spoken Japanese, です/ます only where the English is polite.
- Keep the kanji within reach of the reader you are given, and never mix kanji and kana inside one compound (交ぜ書き): rephrase, write the whole word in kana, or attach a reading as 漢字《かんじ》, at most twice per card. Words normally written in kana stay kana at every level: こと, もの, とき, ところ, ため, よう, わけ, はず, いる, ある, おく, しまう, くる, いく, みる, できる, など, ほど, たくさん, いろいろ, ほとんど, もちろん, ぜひ, すべて, しかし.
- NEVER give the answer away. In Japanese the usual leak is katakana: writing チャレンジ for "challenge", エネルギー for "energy" or クライミング for "climb" hands the learner the English word in Japanese clothing. Use a native equivalent (挑戦、活力、登ること). A katakana loanword is allowed only when it is the ordinary Japanese word for the thing AND is not a transcription of the target word. leadVi must never name the meaning or its stem at all - show the scene, do not say the word.
- Compact Japanese: one word per idea. Never stack two near-synonyms with や, と, し just to sound complete (楽しくて うれしい gives うれしい). Drop the empty helpers - 〜を 行う, 〜を 実施する, 〜する=ことが できる, 〜という=こと, 〜において, 〜に関して - and spend the freed room on a concrete detail.
- No English letters in meaningVi, defVi, leadVi, anticipateVi or usageVi. Never define a word with the word itself.
- Safe and publishable: no alcohol, tobacco, gambling, politics, religious observance, violence, humiliation or sensationalised illness, and no real prefecture, city or region names - use 地元, 都会, 海の 近くの 町.`,
  emphasisChoice: JA_EMPHASIS_CHOICE,
  // Rule 3.7: at most ONE of these ends a sentence, and none of them ends a
  // definition.
  fillers: ["ね", "よ", "な", "かな", "じゃん", "よね", "ってば"],
  intensifiers: ["とても", "すごく", "すごい", "本当に", "かなり", "少し", "ちょっと", "めっちゃ", "もっと"],
  sentenceEnd: ["。", "？", "！", "."],
  fieldRules: {
    meaning:
      'the standard Japanese EQUIVALENT in dictionary form - what a dictionary would give as the headword (想像する, 忘れる, うれしい, 親切な, 空港). At most 14 characters, at most two senses separated by 、 (はずかしい、気まずい), no "|", no closing punctuation. An idiom takes "_" (気前が_いい). NOT a sentence and never a description: defVi is the sentence, this is the word.',
    def: "ONE Japanese definition, 2 to 4 chunks (3 is normal) and about 12 to 36 characters, plain form, ending in 。. It may use the meaning word, but should explain it in simpler words.",
    lead: "a concrete scene in plain form, 2 to 4 chunks and about 12 to 38 characters, ending in 。, ？, ！ or 」. Who, where, one telling detail - set in the reader's own Japanese life. SHOW the meaning; the meaning word and its stem must not appear.",
    anticipate:
      'a casual, playful hook spoken to the reader - …かな？, …じゃん？, …かも！, え、まさか…？ - in 1 or 2 chunks and about 3 to 16 characters, ending in ？, ！ or …. It must be DIFFERENT for every word IN THE WHOLE DECK, not merely within this batch; the user message lists lines and openings already taken, and reusing one is a defect. Never fall back on a placeholder like「さあ、何でしょう？」.',
    usageGloss:
      "a natural Japanese translation of the English example with the blank filled in, 1 to 4 chunks and about 8 to 34 characters, ending the way the English does. The meaning word should normally appear. Drop pronouns where Japanese would, and prefer あの人 or a name to 彼 or 彼女.",
    emphasis:
      "exactly 3 Japanese words that will glow on screen, by position: the meaning word of defVi, a different meaning word from leadVi, and the target as it appears in usageVi.",
  },
  example: `[{"word":"imagine","pos":"verb","ipa":"/ɪˈmædʒ.ɪn/","meaningVi":"想像する","defVi":"実際には 見て=いない ものを | 頭の 中に | 思い浮かべる=こと。","leadVi":"目を 閉じるだけで、 | 砂浜に 寝転ぶ | 自分の 姿が | 浮かんで=くる。","anticipateVi":"頭の 中で | 旅に 出よう！","usageEn":"Can you _____ a world without the internet?","usageVi":"ネットの ない | 生活なんて、 | 想像できる？","topics":["mind","daily"],"exams":[],"emphasisVi":["思い浮かべる","浮かんで","想像できる"]}]`,
  chips: {
    "too-long": { instruction: "It runs past the allowed length. Cut it down to the required character count." },
    "too-short": { instruction: "It is shorter than the required character count. Expand it with a concrete detail, not with padding." },
    awkward: {
      instruction: "The phrasing is clumsy. Rewrite it so it reads like fluent written Japanese.",
    },
    unnatural: {
      instruction: "No Japanese speaker would phrase it this way. Use an idiomatic turn of phrase instead.",
    },
    "too-hard": {
      instruction:
        "The vocabulary or the kanji is beyond this reader. Use everyday 和語, and kana or a 《》 reading where the kanji is above the level.",
    },
    diacritics: {
      label: "Wrong characters",
      instruction:
        "A kanji, its okurigana or a kana is wrong, or the text mixes kanji and kana inside one compound, or uses half-width punctuation. Write correct Japanese orthography with 、and 。.",
    },
    chunks: {
      label: "Chunking",
      instruction:
        'The " | " chunks are wrong: a chunk is too long, too short, starts with a bare particle, or breaks somewhere that is not a 文節 boundary. Re-chunk it at the natural breaths, 3 to 12 characters each.',
    },
    "not-an-equivalent": {
      instruction:
        "It describes the word instead of translating it. Give the bare Japanese equivalent a dictionary would give - a verb in dictionary form, an adjective with its ending.",
    },
    "leaks-answer": {
      instruction:
        "It gives the answer away - either the meaning word itself in the scene, or the English headword as katakana (チャレンジ for \"challenge\"). Replace it so the word stays guessable.",
    },
  },
  exampleNote: `(Note the example: defVi is 25 displayed characters in 3 chunks, each at a 文節 boundary with the particle kept on the chunk before it; the 文節 inside a chunk are separated by one ASCII space; "=" binds 見て to いない and 思い浮かべる to こと, because a 補助動詞 and a 形式名詞 lean on what they follow; "meaningVi" is the bare equivalent 「想像する」, not a sentence; and the three emphasis entries are POSITIONAL - 「思い浮かべる」 glows only in defVi, 「浮かんで」 only in leadVi, 「想像できる」 only in usageVi - each written as the reader sees it, with no space, mark or ruby inside.)`,
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
  const shown = displayText(text, profile);
  if (profile.measure === "words") return countUnits(shown);
  return [...shown].length;
}

/** A reading attached to the kanji run before it: 漢字《かんじ》. */
const RUBY_READING = /([\p{Script=Han}\u3005]+)《[\p{Script=Hiragana}ー]+》/gu;

/**
 * The text a reader actually sees.
 *
 * Every mark comes out, and in a language that writes no spaces the 文節 spaces
 * come out with them: they are markup saying where a unit ends, not typography
 * the reader is shown. This is the form a length rule counts, the form an
 * emphasis phrase is stored in, and the form the app renders - so all three
 * agree by construction rather than by three separate strips.
 *
 * @param text - a field, with its marks and any ruby still in it
 * @param profile - the language it is written in
 */
export function displayText(text: string, profile: GlossProfile): string {
  const plain = profile.ruby ? text.replace(RUBY_READING, "$1") : text;
  if (profile.bondSpacing === "space") return stripMarks(plain);
  return plain.replace(/[_=|\s]/gu, "");
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
    ...(profile.marks.maxPhrase === undefined ? {} : { maxPhrase: profile.marks.maxPhrase }),
    measure: (text) => measureLength(text, profile),
    display: (text) => displayText(text, profile),
    unitWord: profile.measure === "words" ? "syllable(s)" : profile.unitWord,
  };
}

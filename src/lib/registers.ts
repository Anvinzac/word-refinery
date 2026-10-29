/**
 * The reader registers a Japanese pack is written in.
 *
 * `JA_GENERATION_RULES` v3.9 does not emit one card per word. It emits one
 * entry holding a version of the SAME scene per reader group — all four for an
 * A-level batch, three for a B1 one, which has no 小学生 to write for — that
 * differ only in script and difficulty. The app has one card per word, so
 * something has to choose, and it chooses the register the pack itself declares
 * in `defaultLevel`.
 *
 * This module is that choice, written once. It is imported by both consumers,
 * `scripts/bundle-batches.mjs` (which flattens on the way into a deck) and
 * `scripts/verify-batch.ts` (which flattens on the way into the gates), because
 * the mapping is twelve fields of hand-matched renames: `meaningJP` lands in
 * `meaningVi`, `defJa` in `defVi`, and so on. Two copies of that would drift,
 * and a drift here does not fail loudly — it silently puts a Japanese
 * definition in the wrong slot for every card in every batch.
 *
 * The app's slots carry Vietnamese names because they were named before a
 * second gloss language existed. They are slots, not languages: `defVi` holds
 * whatever the deck's gloss language is.
 *
 * Exports: REGISTER_CODES, RegisterCode, RegisterBody, RegisterCard,
 *          isRegisterCard, flattenRegisters
 * Depends on: none
 */

/**
 * The reader groups, in ascending difficulty.
 *
 * The four a pack MAY hold, not the four every card does: `levels` is partial,
 * and the B1 batches omit JPRIM.
 *
 * | code  | reader   | kanjiTier |
 * | ----- | -------- | --------- |
 * | JPRIM | 小学生   | 0 — 小1-小3 kanji only |
 * | JSEC  | 中学生   | 1 — 教育漢字 |
 * | JHIGH | 高校生   | 2 — the DEFAULT |
 * | JCOLL | 大学生   | 3 — all 常用漢字 |
 */
export const REGISTER_CODES = ["JPRIM", "JSEC", "JHIGH", "JCOLL"] as const;

/** One reader group's code. */
export type RegisterCode = (typeof REGISTER_CODES)[number];

/** One register's telling of the scene. */
export interface RegisterBody {
  /** How hard the kanji in this telling is allowed to be. */
  kanjiTier: number;
  /** The gloss. Named `meaningJP`, not `meaningJa`, in the pack. */
  meaningJP: string;
  defJa: string;
  leadJa: string;
  anticipateJa: string;
  usageJa: string;
  /** The positional emphasis triple: [def, lead, usageGloss]. */
  emphasisJa: string[];
}

/**
 * One entry as a Japanese pack delivers it.
 *
 * `defVi` / `leadVi` / `anticipateVi` also appear at this level: plain-prose
 * Vietnamese translations of the Japanese, there so a Vietnamese reviewer can
 * check Japanese they do not read. The app has no slot for them, and flattening
 * overwrites them with the chosen register's own text — which is correct, since
 * the slot belongs to the deck's gloss language, not to the reviewer's.
 */
export interface RegisterCard {
  word: string;
  pos: string;
  ipa: string;
  kanaReading: string;
  usageEn: string;
  topics: string[];
  exams: string[];
  defaultLevel: RegisterCode;
  levels: Partial<Record<RegisterCode, RegisterBody>>;
  defVi?: string;
  leadVi?: string;
  anticipateVi?: string;
}

/**
 * True when a card carries registers and so has to be flattened.
 *
 * Deliberately the ONLY test of "is this a Japanese pack card", and shared by
 * both consumers so they cannot disagree about which cards need flattening.
 * A card with no `levels` is a Vietnamese card, or an already-flattened one,
 * and passes through untouched.
 */
export function isRegisterCard(card: unknown): card is RegisterCard {
  if (typeof card !== "object" || card === null) return false;
  const levels = (card as { levels?: unknown }).levels;
  return typeof levels === "object" && levels !== null;
}

/**
 * Flatten a card that carries registers down to the one the app holds.
 *
 * @param card - one entry as the pack delivers it, of any shape
 * @returns the flat card, or `card` unchanged when it carries no registers
 * @throws when `defaultLevel` names a register the card does not have
 *
 * The throw is the point of the strictness. A pack that says `JHIGH` and
 * delivers no `JHIGH` has no card to ship, and guessing another register would
 * put a different reader's text in the deck under the default's name — the
 * quietest possible way to be wrong. Both callers surface it rather than
 * swallow it: the bundler aborts the build, the verifier records a blocker.
 *
 * The twelve keys come out in `CRAWLER_ANNOTATION_FIELDS` order, which is what
 * the schema gate checks a card against. `test/registers.test.ts` pins the two
 * lists together, so a rename in the contract shows up as a failure here rather
 * than as a thousand "fields are out of order" findings later.
 */
export function flattenRegisters(card: unknown): unknown {
  if (!isRegisterCard(card)) return card;

  const code = card.defaultLevel;
  const body = card.levels[code];
  if (body === undefined) {
    throw new Error(
      `${card.word}: defaultLevel is "${String(code)}", which is not one of its levels ` +
        `(${Object.keys(card.levels).join(", ") || "none"})`,
    );
  }

  return {
    word: card.word,
    pos: card.pos,
    ipa: card.ipa,
    meaningVi: body.meaningJP,
    defVi: body.defJa,
    leadVi: body.leadJa,
    anticipateVi: body.anticipateJa,
    usageEn: card.usageEn,
    usageVi: body.usageJa,
    topics: card.topics,
    exams: card.exams,
    emphasisVi: body.emphasisJa,
  };
}

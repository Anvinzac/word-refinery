/**
 * Four ways to say the same card.
 *
 * Regenerating a field gives you another sentence, and judging whether it is
 * better than the last one means holding both in your head. This instead asks
 * for several at once and puts them side by side, so the choice is a comparison
 * rather than a memory test.
 *
 * The four differ by DESIGN, not by sampling temperature. Four rolls of the
 * same prompt cluster around the same answer and the differences between them
 * are noise; four named slants give a reviewer axes they can actually choose
 * along — and when none of them fits, that itself says something about the
 * word. Each slant pushes one dial and leaves the field rules alone.
 *
 * Exports: VariationSlant, VARIATION_SLANTS, VARIATION_FIELDS, slantById,
 *          VariationRow, emptyRow
 * Depends on: ./prompt.ts
 */
import type { MarkupField } from "./prompt.ts";

/** One way of slanting a card, offered as a row of the grid. */
export interface VariationSlant {
  id: string;
  label: string;
  /** What the writer is told, in place of nothing. */
  instruction: string;
  /** The one-line description under the row's label. */
  note: string;
}

/**
 * The four slants, in the order they are shown.
 *
 * Ordered from least to most liberty: a reviewer reading down the grid meets
 * the safe option first and the risky one last, which is the order you want
 * when the safe one is often right.
 */
export const VARIATION_SLANTS: readonly VariationSlant[] = [
  {
    id: "plain",
    label: "Plain",
    note: "shortest, no flourish",
    instruction:
      "Strip it to the bone. Use the commonest word for every idea, the shortest sentence that still teaches, and no image or figure of speech at all. Aim at the LOW end of every length rule. This is the version that would survive translation into any language.",
  },
  {
    id: "warm",
    label: "Warm",
    note: "familiar, speaks to the reader",
    instruction:
      "Write it the way you would say it to one person sitting beside you. Everyday register, contractions of speech, the rhythm of talk rather than of print. Address the reader where the field allows it. Never slangy, never cute - just close.",
  },
  {
    id: "vivid",
    label: "Vivid",
    note: "one concrete image",
    instruction:
      "Build it around ONE concrete sensory image - something a reader can see, hear or feel - and let that image carry the meaning instead of an abstract description. One image, not three; a sentence crowded with pictures reads as decoration.",
  },
  {
    id: "playful",
    label: "Playful",
    note: "wit, surprise, a turn",
    instruction:
      "Allow yourself wit: a turn the reader does not see coming, a wry observation, a small joke that still teaches the word. The humour must come from the MEANING of the word, never from a pun on its spelling, and the card must still work for someone who misses the joke.",
  },
];

/** The fields a variation rewrites. */
export const VARIATION_FIELDS: readonly MarkupField[] = [
  "meaningVi",
  "defVi",
  "leadVi",
  "anticipateVi",
  "usageVi",
];

/** Look a slant up by id. */
export function slantById(id: string): VariationSlant | undefined {
  return VARIATION_SLANTS.find((slant) => slant.id === id);
}

/** One row of the grid: a slant's take on each field. */
export interface VariationRow {
  slant: string;
  fields: Partial<Record<MarkupField, string>>;
  /** Set when the row failed, so the grid can say so in place of the cells. */
  error: string | null;
  /** True while the row is being written. */
  busy: boolean;
}

/** A row with nothing in it yet. */
export function emptyRow(slant: string): VariationRow {
  return { slant, fields: {}, error: null, busy: false };
}

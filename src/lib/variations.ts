/**
 * Eight ways to say the same card.
 *
 * Regenerating a field gives you another sentence, and judging whether it is
 * better than the last one means holding both in your head. This instead asks
 * for several at once and puts them side by side, so the choice is a comparison
 * rather than a memory test.
 *
 * The takes differ by DESIGN, not by sampling temperature. Several rolls of the
 * same prompt cluster around the same answer and the differences between them
 * are noise; named slants give a reviewer axes they can actually choose
 * along — and when none of them fits, that itself says something about the
 * word. Each slant pushes one dial and leaves the field rules alone.
 *
 * Each row can also be written by a different model, picked from a short list
 * of inexpensive frontier models and remembered on this device.
 *
 * Exports: VariationSlant, VARIATION_SLANTS, VARIATION_FIELDS, slantById,
 *          VariationModel, VARIATION_MODELS, SlantModels, readSlantModels,
 *          writeSlantModels, modelLabel, searchVariationWords, VariationRow,
 *          emptyRow
 * Depends on: ./prompt.ts, ./types.ts
 */
import type { MarkupField } from "./prompt.ts";
import type { CefrLevel, ReviewEntry } from "./types.ts";

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
 * The eight slants, in the order they are shown.
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
    id: "formal",
    label: "Formal",
    note: "precise, exam register",
    instruction:
      "Write in the careful register of a good textbook or an IELTS reading passage: exact wording, Sino-Vietnamese vocabulary where it is the precise term, no colloquialism, no address to the reader. Precise is not stiff - every sentence must still read naturally aloud.",
  },
  {
    id: "warm",
    label: "Warm",
    note: "familiar, speaks to the reader",
    instruction:
      "Write it the way you would say it to one person sitting beside you. Everyday register, contractions of speech, the rhythm of talk rather than of print. Address the reader where the field allows it. Never slangy, never cute - just close.",
  },
  {
    id: "scene",
    label: "Scene",
    note: "a moment of Vietnamese daily life",
    instruction:
      "Set it inside ONE ordinary moment of Vietnamese life - a market stall, a motorbike at a red light, a family meal, a classroom, a rainy afternoon - and let the word happen there. A recognisable place and people, not an abstract situation; one moment, not a story with a plot.",
  },
  {
    id: "contrast",
    label: "Contrast",
    note: "taught by what it is not",
    instruction:
      "Teach the word by contrast: set it against its opposite, or against the near-synonym a learner would confuse it with, so the edge of its meaning becomes visible. The contrast must be explicit enough to see in one reading, and the word itself must still be the subject, not the thing it is compared with.",
  },
  {
    id: "vivid",
    label: "Vivid",
    note: "one concrete image",
    instruction:
      "Build it around ONE concrete sensory image - something a reader can see, hear or feel - and let that image carry the meaning instead of an abstract description. One image, not three; a sentence crowded with pictures reads as decoration.",
  },
  {
    id: "rhythmic",
    label: "Rhythmic",
    note: "cadence, balance, sound",
    instruction:
      "Write for the ear: balanced halves, a parallel structure, a pleasing alternation of level and sharp tones, the cadence of a well-made saying. Rhyme only if it comes naturally - a forced rhyme is worse than none. The meaning must survive intact; sound decorates it, never replaces it.",
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

/** A model a row can be written by, offered in each row's picker. */
export interface VariationModel {
  /** OpenRouter model id. */
  id: string;
  label: string;
  /** USD per million input / output tokens, as listed when this was chosen. */
  price: string;
}

/**
 * Inexpensive current models from the frontier labs, as OpenRouter ids, one
 * per lab. No "contributor" listing: those train on the prompts, and an
 * OpenRouter account that forbids paid training gets a 404 for them.
 *
 * Different labs write Vietnamese with different habits, so the same slant
 * from two of them differs more than two rolls from one. Prices are a guide
 * for choosing, not a bill: they were read off OpenRouter in October 2026.
 */
export const VARIATION_MODELS: readonly VariationModel[] = [
  { id: "openai/gpt-6-luna", label: "GPT-6 Luna", price: "$0.10 / $0.50" },
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", price: "$0.10 / $0.50" },
  { id: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite", price: "$0.30 / $2.50" },
  { id: "deepseek/deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash", price: "$0.15 / $0.60" },
  { id: "qwen/qwen3.8-flash", label: "Qwen3.8 Flash", price: "$0.15 / $0.47" },
  { id: "meta/muse-glimmer-30b", label: "Muse Glimmer 30B", price: "$0.30 / $1.20" },
  { id: "x-ai/grok-4.3", label: "Grok 4.3", price: "$1.25 / $2.50" },
  { id: "mistralai/mistral-small-2603", label: "Mistral Small 4", price: "$0.15 / $0.60" },
  { id: "moonshotai/kimi-k2.5", label: "Kimi K2.5", price: "$0.50 / $2.50" },
  { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", price: "$0.01 / $0.20" },
];

/** Per-slant model picks; a slant that is absent uses the model from Settings. */
export type SlantModels = Partial<Record<string, string>>;

const SLANT_MODELS_KEY = "word-refinery.variation-models";

/**
 * The picks last made on this device. A pick of a model no longer offered is
 * dropped, so the row falls back to Settings instead of calling a model its
 * picker cannot show.
 */
export function readSlantModels(): SlantModels {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SLANT_MODELS_KEY) ?? "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const offered = new Set(VARIATION_MODELS.map((model) => model.id));
    return Object.fromEntries(
      Object.entries(parsed).filter(([, id]) => typeof id === "string" && offered.has(id)),
    ) as SlantModels;
  } catch {
    return {};
  }
}

/** Remember the picks. Quota and private-mode failures are ignored. */
export function writeSlantModels(models: SlantModels): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SLANT_MODELS_KEY, JSON.stringify(models));
  } catch {
    // The in-memory picks still apply for this session.
  }
}

/** Label for a model id: the curated name when there is one, else the id's tail. */
export function modelLabel(id: string): string {
  return VARIATION_MODELS.find((model) => model.id === id)?.label ?? id.slice(id.lastIndexOf("/") + 1);
}

/** Levels the word search offers; A1 and A2 cards are too plain to be worth eight takes. */
const SEARCHABLE_LEVELS: readonly CefrLevel[] = ["B1", "B2", "C1", "C2"];

/**
 * Words matching a search, B1 first and up to C2, A1 and A2 left out.
 * Within a level a word that starts with the query comes before one that
 * merely contains it.
 */
export function searchVariationWords(
  entries: readonly ReviewEntry[],
  query: string,
  limit = 8,
): ReviewEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const rank = (entry: ReviewEntry) => {
    const word = entry.deckWord.word.toLowerCase();
    const match = word === needle ? 0 : word.startsWith(needle) ? 1 : 2;
    return SEARCHABLE_LEVELS.indexOf(entry.deckWord.level) * 3 + match;
  };
  return entries
    .filter(
      (entry) =>
        SEARCHABLE_LEVELS.includes(entry.deckWord.level) &&
        entry.deckWord.word.toLowerCase().includes(needle),
    )
    .sort((left, right) => rank(left) - rank(right) || left.deckWord.word.localeCompare(right.deckWord.word))
    .slice(0, limit);
}

/** One row of the grid: a slant's take on each field. */
export interface VariationRow {
  slant: string;
  fields: Partial<Record<MarkupField, string>>;
  /** The model that wrote this take, once it has been written. */
  model?: string;
  /** Set when the row failed, so the grid can say so in place of the cells. */
  error: string | null;
  /** True while the row is being written. */
  busy: boolean;
}

/** A row with nothing in it yet. */
export function emptyRow(slant: string): VariationRow {
  return { slant, fields: {}, error: null, busy: false };
}

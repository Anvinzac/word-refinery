/**
 * Model family taxonomy for the Settings picker.
 *
 * The provider catalogues mix image/video/audio generators, embedders and
 * sub-20B variants into the same list. The picker instead shows the
 * mainstream text-LLM families as tappable groups (Claude, GPT, Gemini,
 * NVIDIA, Meta Llama & Muse, Qwen, DeepSeek, Mistral, GLM, Kimi, MiniMax;
 * the list is not capped), hides anything that generates non-text output,
 * and hides models whose advertised parameter count is not above 20B.
 *
 * Keep this file pure: no network calls and no React, so the rules are fully
 * unit-testable.
 *
 * Exports: ModelFamily, modelFamilyOf, estimateParamsB, formatParamsB,
 *          isPresentableModel, groupModels
 * Depends on: ./llm.ts (type only)
 */
import type { ListedModel } from "./llm.ts";

/** One collapsed group of model options in the picker. */
export interface ModelFamily {
  /** Stable key, also used to open the group in the UI. */
  id: string;
  /** Human-readable family name. */
  label: string;
  /** Presentable models in this family, sorted alphabetically by name. */
  models: ListedModel[];
}

/**
 * The curated mainstream families, in fixed display order. Vendor matches
 * come before product-name catch-alls so derived models land with their
 * maker (e.g. nvidia's Nemotron variants of Llama under NVIDIA). Presentable
 * models that match none of them are collected into a trailing "other"
 * bucket so the picker can tuck the less-known offerings behind its own
 * folder.
 */
const FAMILY_MATCHERS: ReadonlyArray<{ id: string; label: string; matches: (lowerId: string) => boolean }> = [
  {
    id: "claude",
    label: "Anthropic Claude",
    matches: (id) => /claude/.test(id) || /(^|\/)anthropic\//.test(id),
  },
  {
    id: "gpt",
    label: "OpenAI GPT",
    matches: (id) => /(^|\/)openai\//.test(id) || /(^|[^a-z])gpt[\d._-]/.test(id),
  },
  {
    id: "gemini",
    label: "Google Gemini",
    matches: (id) => /gemini|gemma/.test(id) || /(^|\/)google\//.test(id),
  },
  {
    id: "nvidia",
    label: "NVIDIA",
    matches: (id) => /(^|\/)nvidia\//.test(id) || /nemotron/.test(id),
  },
  {
    id: "meta",
    label: "Meta",
    matches: (id) => /llama|muse/.test(id) || /(^|\/)meta(-llama)?\//.test(id),
  },
  {
    id: "qwen",
    label: "Alibaba Qwen",
    matches: (id) => /qwen/.test(id),
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    matches: (id) => /deepseek/.test(id),
  },
  {
    id: "mistral",
    label: "Mistral",
    matches: (id) => /mistral|mixtral/.test(id) || /(^|\/)mistralai\//.test(id),
  },
  {
    id: "glm",
    label: "Z.ai GLM",
    matches: (id) => /glm/.test(id) || /(^|\/)z-ai\//.test(id),
  },
  {
    id: "kimi",
    label: "Moonshot Kimi",
    matches: (id) => /kimi|moonshot/.test(id),
  },
  {
    id: "minimax",
    label: "MiniMax",
    matches: (id) => /minimax/.test(id),
  },
];

/** Families whose models generate media instead of text, matched in ids as a fallback. */
const MEDIA_ID_WORDS = /(^|[^a-z])(image|video|audio|speech|tts|dall-?e|sora|veo|flux|whisper)([^a-z]|$)/;

/** Variants too small to bother with when the id gives no parameter count. */
const TINY_ID_WORDS = /(^|[^a-z])(nano|mini|lite|smol|tiny)([^a-z]|$)/;

/** Safety/classifier/embedding heads that are not chat LLMs at all. */
const NON_CHAT_ID_WORDS = /(^|[^a-z])(guard|moderation|moderator|safety|embedding)([^a-z]|$)/;

/** Advertised parameter counts up to this size are hidden from the picker. */
const MIN_PARAMS_B = 20;

/**
 * Match a raw model id (lowercased by the caller or safe to receive mixed) to
 * one of the curated families, or null when it belongs to none.
 */
export function modelFamilyOf(id: string): null | { id: string; label: string } {
  const lower = id.toLowerCase();
  for (const family of FAMILY_MATCHERS) {
    if (family.matches(lower)) return { id: family.id, label: family.label };
  }
  return null;
}

/**
 * Estimate the parameter count in billions from an id or display name.
 *
 * Handles plain sizes ("70b", "1.6b") and mixture-of-experts products
 * ("8x7b" → 56). Returns the largest plausible count, or null when the text
 * advertises none — an absent count is never treated as small, so flagship
 * models like gpt-4o or deepseek-r1 stay listed.
 */
export function estimateParamsB(text: string): number | null {
  const lower = text.toLowerCase();
  // Mixture-of-experts: "8x7b", "8x22b", "2.4x60b".
  const moe = /(?<![\d.])(\d+(?:\.\d+)?)[x×](\d+(?:\.\d+)?)b(?![a-z0-9])/.exec(lower);
  if (moe !== null) {
    const experts = Number.parseFloat(moe[1]);
    const perExpert = Number.parseFloat(moe[2]);
    if (Number.isFinite(experts) && Number.isFinite(perExpert)) {
      return experts * perExpert;
    }
  }
  let best = 0;
  for (const match of lower.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)b(?![a-z0-9])/g)) {
    best = Math.max(best, Number.parseFloat(match[1]));
  }
  return best > 0 ? best : null;
}

/** Render an estimated size for the picker's chips: 70 → "70B". */
export function formatParamsB(billions: number): string {
  const rounded = billions >= 100 ? Math.round(billions) : Math.round(billions * 10) / 10;
  return `${rounded}B`;
}

/**
 * The picker's quality bar: text-only output, and not a tiny model.
 *
 * - Media generators are dropped on the identity word ("image", "sora"…)
 *   and on the modality metadata OpenRouter reports when present.
 * - Sub-20B models are dropped when the id advertises a size; ids without a
 *   size are only dropped when they carry a small-variant word ("nano",
 *   "mini", "lite").
 * - Vision-*understanding* models stay: they are ordinary LLMs with an
 *   extra, ignored modality on the input side.
 */
export function isPresentableModel(row: ListedModel): boolean {
  const haystack = `${row.id} ${row.name}`.toLowerCase();
  if (MEDIA_ID_WORDS.test(haystack)) return false;
  if (NON_CHAT_ID_WORDS.test(haystack)) return false;
  if (row.outputModalities?.some((modality) => modality !== "text")) return false;

  const params = estimateParamsB(haystack);
  if (params !== null) return params > MIN_PARAMS_B;
  return !TINY_ID_WORDS.test(haystack);
}

/**
 * Filter the catalogue down to presentable models and group them into the
 * curated families, in fixed order. Models that pass the quality bar but
 * belong to none of the curated families are collected into a trailing
 * "other" bucket; the picker shows that one behind a "More…" expander.
 * Empty families are omitted; within a family, models are sorted
 * alphabetically by name so the list is stable.
 */
export function groupModels(rows: readonly ListedModel[]): ModelFamily[] {
  const grouped = new Map<string, ModelFamily>();
  for (const row of rows) {
    if (!isPresentableModel(row)) continue;
    const family = modelFamilyOf(row.id) ?? { id: "other", label: "Other" };
    let bucket = grouped.get(family.id);
    if (bucket === undefined) {
      bucket = { id: family.id, label: family.label, models: [] };
      grouped.set(family.id, bucket);
    }
    bucket.models.push(row);
  }
  const families: ModelFamily[] = [];
  for (const spec of FAMILY_MATCHERS) {
    const bucket = grouped.get(spec.id);
    if (bucket === undefined) continue;
    bucket.models.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    families.push(bucket);
  }
  const other = grouped.get("other");
  if (other !== undefined) {
    other.models.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    families.push(other);
  }
  return families;
}

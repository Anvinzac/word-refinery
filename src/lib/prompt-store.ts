/**
 * Editable prompts.
 *
 * The prompts carry the whole quality bar — every rule about word counts,
 * joins, emphasis and leaks lives in prose, not in code. Tuning that prose is
 * the fastest lever on output quality, and until now it meant editing a source
 * file and redeploying. This keeps the defaults in code and lets an operator
 * override them in their own browser, so a rule can be tried on tonight's batch
 * and kept or dropped on the evidence.
 *
 * Only the SYSTEM prompts are overridable. They are static prose, so an
 * edit cannot break them. The user messages are assembled per request from the
 * corpus words, the reviewer's chips and the avoid list; making those editable
 * would mean inventing a placeholder language and letting a typo drop the word
 * list from the request. The prompts panel shows them live instead, built from
 * real data, so what is sent is inspectable even where it is not editable.
 *
 * An override is stored verbatim. It is never merged with the default: a
 * half-applied prompt would be harder to reason about than a wrong one.
 *
 * Exports: PromptId, PROMPT_DEFINITIONS, readPromptOverrides, writePromptOverride,
 *          resetPromptOverride, resolvePrompt, isPromptOverridden,
 *          setCommittedStyleGuide, hasStyleGuide
 * Depends on: ./prompt.ts
 */
import {
  ANNOTATION_SYSTEM_PROMPT,
  DISTIL_SYSTEM_PROMPT,
  STYLE_SYSTEM_PROMPT,
  REPAIR_SYSTEM_PROMPT,
  SAFETY_SYSTEM_PROMPT,
  VARIATION_SYSTEM_PROMPT,
  MARKUP_SYSTEM_PROMPT,
  REWRITE_SYSTEM_PROMPT,
  VERIFY_SYSTEM_PROMPT,
} from "./prompt.ts";

/** The prompts an operator may override. */
export type PromptId =
  | "annotation"
  | "rewrite"
  | "verify"
  | "markup"
  | "style"
  | "distil"
  | "variation"
  | "safety"
  | "repair";

/** What the panel needs to show one prompt. */
export interface PromptDefinition {
  id: PromptId;
  title: string;
  /** What this prompt is for, and when it is sent. */
  purpose: string;
  /** The shipped text, restored by Reset. */
  fallback: string;
}

export const PROMPT_DEFINITIONS: readonly PromptDefinition[] = [
  {
    id: "annotation",
    title: "Annotation (system)",
    purpose:
      "Sent with every generation batch. Holds the field rules, the word-joining convention and the emphasis-selection rules.",
    fallback: ANNOTATION_SYSTEM_PROMPT,
  },
  {
    id: "rewrite",
    title: "Single-field rewrite (system)",
    purpose:
      "Sent when you regenerate one cell. The base for every field: audience, word joining, language rules and reply shape. The field's own rule is quoted into the request from the shipped batch rules, so edits to the Annotation prompt above do not reach it.",
    fallback: REWRITE_SYSTEM_PROMPT,
  },
  {
    id: "verify",
    title: "Verification (system)",
    purpose:
      "Sent when you check a finished card. Judges meaning, naturalness, leaks and whether the highlight sits on the phrase that carries the sentence.",
    fallback: VERIFY_SYSTEM_PROMPT,
  },
  {
    id: "markup",
    title: "Markup (system)",
    purpose:
      "Sent when you add breaking marks to cards written before the marks existed. A typesetting pass, not an edit: the words must come back identical, and a field that changed is discarded.",
    fallback: MARKUP_SYSTEM_PROMPT,
  },
  {
    id: "variation",
    title: "Variations (system)",
    purpose:
      "Sent once per row on the Variations page. Asks for a different take on a finished card along one named axis, rather than a fix for something wrong with it.",
    fallback: VARIATION_SYSTEM_PROMPT,
  },
  {
    id: "safety",
    title: "Safety gate (system)",
    purpose:
      "Sent once per card on the Intake page. Asks whether a card is fit to publish at all — implication, framing, sense, audience — rather than whether it teaches well.",
    fallback: SAFETY_SYSTEM_PROMPT,
  },
  {
    id: "repair",
    title: "Repair (system)",
    purpose:
      "Sent for a card that failed intake, with the full list of what is wrong. Returns the whole card fixed, because the fields constrain each other.",
    fallback: REPAIR_SYSTEM_PROMPT,
  },
  {
    id: "style",
    title: "House voice (your style guide)",
    purpose:
      "Appended to generation and rewrite requests, with a few of your marked cards as examples. This is the one prompt the app does not ship: it is distilled from your own edits, and it is yours to correct. Nothing is sent while it is empty.",
    fallback: STYLE_SYSTEM_PROMPT,
  },
  {
    id: "distil",
    title: "Distillation (system)",
    purpose:
      "Reads the before/after pairs from your style samples and writes the guide above. Change this if the guide it produces is the wrong shape — too mechanical, too vague, or missing something you care about.",
    fallback: DISTIL_SYSTEM_PROMPT,
  },
];

/**
 * The style guide committed to the repository, when one has been loaded.
 *
 * Three layers, narrowest wins: this browser's edit, then the guide the repo
 * ships in `style-samples.json`, then the placeholder. That ordering is what
 * lets a team share a voice while leaving any one reviewer free to try a
 * change without committing it.
 */
let committedGuide = "";

/** Install the guide carried by a style file, or "" to forget it. */
export function setCommittedStyleGuide(guide: string): void {
  committedGuide = guide.trim();
}

/**
 * Whether a REAL style guide exists — an edit or a committed one.
 *
 * The shipped default is a placeholder explaining the feature, so "is there
 * text" is the wrong question; sending that placeholder to a model would be
 * worse than sending nothing.
 */
export function hasStyleGuide(): boolean {
  return readPromptOverrides().style !== undefined || committedGuide.length > 0;
}

/** localStorage key. Separate from settings so a prompt edit cannot corrupt a key. */
const STORAGE_KEY = "word-refinery.prompts";

/** Overrides as stored: id to replacement text. A missing id means "use the default". */
export type PromptOverrides = Partial<Record<PromptId, string>>;

/** Read the overrides this browser holds. */
export function readPromptOverrides(): PromptOverrides {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null) return {};
    const parsed = JSON.parse(stored) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const overrides: PromptOverrides = {};
    for (const definition of PROMPT_DEFINITIONS) {
      const value = (parsed as Record<string, unknown>)[definition.id];
      // An empty override would silently send an empty system prompt, so it is
      // treated as "no override" rather than stored.
      if (typeof value === "string" && value.trim().length > 0) overrides[definition.id] = value;
    }
    return overrides;
  } catch {
    return {};
  }
}

/** Persist one override, replacing whatever was there. */
export function writePromptOverride(id: PromptId, text: string): PromptOverrides {
  const next = { ...readPromptOverrides(), [id]: text };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A browser refusing storage keeps the in-memory value for this session.
  }
  return next;
}

/** Drop one override, returning that prompt to the shipped text. */
export function resetPromptOverride(id: PromptId): PromptOverrides {
  const next = readPromptOverrides();
  delete next[id];
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Nothing to do: the default is what the caller gets either way.
  }
  return next;
}

/** The default text for one prompt. */
export function promptFallback(id: PromptId): string {
  return PROMPT_DEFINITIONS.find((definition) => definition.id === id)?.fallback ?? "";
}

/**
 * The text actually sent for one prompt: the override when there is one,
 * otherwise the shipped default.
 */
export function resolvePrompt(id: PromptId): string {
  const override = readPromptOverrides()[id];
  if (override !== undefined && override.trim().length > 0) return override;
  if (id === "style" && committedGuide.length > 0) return committedGuide;
  return promptFallback(id);
}

/** Whether this browser is running on an edited version of one prompt. */
export function isPromptOverridden(id: PromptId): boolean {
  return readPromptOverrides()[id] !== undefined;
}

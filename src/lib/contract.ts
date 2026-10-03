/**
 * Annotation contract — the exact shape the LLM must produce, before deck
 * conversion. Ported from the word-crawler package so both tools enforce the
 * same quality bar.
 *
 * Validates untrusted model output with Zod and repairs the two leaks that
 * would break the feed: the English target appearing in Vietnamese text, and
 * example sentences missing their `_____` blank. Levels are NEVER taken from
 * the model — they come from the corpus.
 *
 * Exports: CRAWLER_ANNOTATION_FIELDS, CrawlerAnnotation, crawlerAnnotationSchema,
 *          containsTargetWord, blankOutTarget, parseAnnotation, parseAnnotationList
 * Depends on: zod
 */
import { z } from "zod";

/** The contract fields. `level` is deliberately absent: it comes from the corpus. */
export const CRAWLER_ANNOTATION_FIELDS = [
  "word",
  "pos",
  "ipa",
  "defVi",
  "leadVi",
  "anticipateVi",
  "usageEn",
  "usageVi",
  "topic",
  "emphasisVi",
] as const;

/** One contract field name. */
export type CrawlerAnnotationField = (typeof CRAWLER_ANNOTATION_FIELDS)[number];

/** A validated annotation for one English word. */
export interface CrawlerAnnotation {
  word: string;
  pos: string;
  ipa: string;
  defVi: string;
  leadVi: string;
  anticipateVi: string;
  usageEn: string;
  usageVi: string;
  topic: string;
  emphasisVi: string[];
}

/** Plain-English headword pattern shared with the downstream deck contract. */
export const annotationWordPattern = /^[a-z]+(?:['’-][a-z]+)*$/;

/** Topic tags the feed's category filter understands. */
export const TOPICS = [
  "work", "study", "daily", "communication", "emotion", "thinking",
  "character", "attention", "time", "travel", "health", "money",
  "nature", "society", "technology", "general",
] as const;

const text = (max: number) => z.string().trim().max(max);

/**
 * Zod schema for one annotation. Unknown keys are stripped rather than
 * rejected, so a model that echoes `level` still yields a usable annotation —
 * the caller records a warning when that happens.
 */
export const crawlerAnnotationSchema = z.object({
  word: z.string().trim().min(2).max(64),
  pos: text(40).optional().default(""),
  ipa: text(120).optional().default(""),
  defVi: z.string().trim().min(2).max(400),
  leadVi: text(240).optional().default(""),
  anticipateVi: text(180).optional().default(""),
  usageEn: z.string().trim().min(1).max(400),
  usageVi: text(400).optional().default(""),
  topic: text(60).optional().default("general"),
  emphasisVi: z.array(z.string().trim().min(2).max(60)).max(8).optional().default([]),
});

/** Escape a word for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word test respecting Unicode boundaries, so "art" never matches inside
 * "artist". Mirrors the downstream app's answer-pattern rule.
 */
export function containsTargetWord(textValue: string, word: string): boolean {
  const pattern = new RegExp(`(?<![\\p{L}])${escapeRegExp(word)}(?![\\p{L}])`, "iu");
  return pattern.test(textValue);
}

/** Replace every standalone occurrence of the target with the deck blank. */
export function blankOutTarget(
  sentence: string,
  word: string,
): { text: string; replaced: number } {
  const pattern = new RegExp(`(?<![\\p{L}])${escapeRegExp(word)}(?![\\p{L}])`, "giu");
  let replaced = 0;
  const rewritten = sentence.replace(pattern, () => {
    replaced += 1;
    return "_____";
  });
  return { text: rewritten, replaced };
}

/** The five-underscore blank the feed renders as the missing answer. */
const BLANK = "_____";

/**
 * Validate and repair one raw annotation object. Every repair is reported as a
 * warning — nothing is changed silently.
 *
 * @param raw - one item from the model's JSON array
 * @param expectedWord - corpus word this item should describe (null = accept any)
 */
export function parseAnnotation(
  raw: unknown,
  expectedWord: string | null,
): { annotation: CrawlerAnnotation | null; issues: string[] } {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { annotation: null, issues: ["item is not a JSON object"] };
  }

  const record = raw as Record<string, unknown>;
  const extraKeys = Object.keys(record).filter(
    (key) => !CRAWLER_ANNOTATION_FIELDS.includes(key as CrawlerAnnotationField),
  );
  if (extraKeys.length > 0) {
    issues.push(`ignored extra field(s): ${extraKeys.join(", ")} (level is always corpus-assigned)`);
  }

  const parsed = crawlerAnnotationSchema.safeParse(record);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`${issue.path.join(".") || "item"}: ${issue.message}`);
    }
    return { annotation: null, issues };
  }

  const data = parsed.data;
  const word = data.word.normalize("NFC").toLowerCase();
  if (!annotationWordPattern.test(word)) {
    issues.push(`word: "${data.word}" is not a plain English word`);
    return { annotation: null, issues };
  }
  if (expectedWord !== null && word !== expectedWord) {
    issues.push(`word: model returned "${word}" but "${expectedWord}" was requested`);
    return { annotation: null, issues };
  }

  // Example sentence: blank the answer, or flag a sentence that leaks it.
  let usageEn = data.usageEn;
  if (!usageEn.includes(BLANK)) {
    const blanked = blankOutTarget(usageEn, word);
    usageEn = blanked.text;
    if (blanked.replaced > 0) {
      issues.push(`usageEn: target word auto-blanked (${blanked.replaced} occurrence(s))`);
    } else {
      issues.push("usageEn: no _____ placeholder and the target word is absent");
    }
  } else if (containsTargetWord(usageEn, word)) {
    usageEn = blankOutTarget(usageEn, word).text;
    issues.push("usageEn: leaked the answer next to the blank; blanked it out");
  }

  // The Vietnamese teaser must never contain the English answer.
  let anticipateVi = data.anticipateVi;
  if (containsTargetWord(anticipateVi, word)) {
    anticipateVi = "";
    issues.push("anticipateVi: leaked the English answer and was emptied");
  }

  // Vietnamese fields must not carry the English answer either.
  if (containsTargetWord(data.defVi, word)) {
    issues.push("defVi: contains the English target word — rewrite it");
  }
  if (containsTargetWord(data.leadVi, word)) {
    issues.push("leadVi: contains the English target word — rewrite it");
  }

  return {
    annotation: {
      word,
      pos: data.pos,
      ipa: data.ipa,
      defVi: data.defVi,
      leadVi: data.leadVi,
      anticipateVi,
      usageEn,
      usageVi: data.usageVi,
      topic: data.topic.toLowerCase(),
      emphasisVi: data.emphasisVi,
    },
    issues,
  };
}

/**
 * Validate a whole model response against the batch that was requested. Words
 * are matched one-to-one by normalized surface form; anything missing,
 * duplicated or unexpected becomes an issue instead of passing silently.
 */
export function parseAnnotationList(
  rawItems: readonly unknown[],
  requestedWords: readonly string[],
): { annotations: Map<string, CrawlerAnnotation>; issues: string[] } {
  const issues: string[] = [];
  const requested = new Set(requestedWords);
  const annotations = new Map<string, CrawlerAnnotation>();
  const seen = new Set<string>();

  for (const [index, item] of rawItems.entries()) {
    const rawWord =
      typeof item === "object" && item !== null
        ? String((item as Record<string, unknown>).word ?? "")
        : "";
    const normalized = rawWord.normalize("NFC").toLowerCase();
    const expected = requested.has(normalized) ? normalized : null;

    if (expected === null) {
      issues.push(`item ${index}: "${rawWord || "<missing word>"}" was not requested`);
      continue;
    }
    if (seen.has(expected)) {
      issues.push(`item ${index}: duplicate annotation for "${expected}"`);
      continue;
    }

    const result = parseAnnotation(item, expected);
    for (const issue of result.issues) issues.push(`${expected}: ${issue}`);
    if (result.annotation !== null) {
      annotations.set(expected, result.annotation);
      seen.add(expected);
    }
  }

  for (const word of requestedWords) {
    if (!annotations.has(word)) issues.push(`${word}: no usable annotation in this batch`);
  }

  return { annotations, issues };
}

/**
 * Extract a JSON array from a model reply that may wrap it in prose or fences.
 * Takes the outermost balanced `[ … ]` span so nested arrays survive.
 */
export function extractJsonArray(reply: string): unknown[] | null {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

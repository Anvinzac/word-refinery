/**
 * Browser-side LLM client.
 *
 * Speaks the OpenAI chat/completions format for OpenRouter and Together, and
 * the Messages API for Anthropic, so one call site covers all three. Retries
 * only on transient statuses (429/500/502/503/504/529) with exponential
 * backoff plus jitter, honouring `retry-after` when the provider sends it.
 *
 * The API key is read from localStorage at call time and is sent only to the
 * endpoint the user picked. Nothing is proxied: GitHub Pages has no server.
 *
 * Exports: LlmError, chat, annotateBatch, regenerateField, testConnection
 * Depends on: ./settings.ts, ./prompt.ts, ./contract.ts, ./types.ts
 */
import type { Settings } from "./settings.ts";
import { ANNOTATION_SYSTEM_PROMPT, buildBatchPrompt, buildRegeneratePrompt } from "./prompt.ts";
import { extractJsonArray, parseAnnotationList, type CrawlerAnnotation } from "./contract.ts";
import type { CorpusWord, DeckWord } from "./types.ts";

/** Error carrying enough context for the UI to explain what went wrong. */
export class LlmError extends Error {
  readonly status: number | null;
  readonly provider: string;
  readonly body: string;

  constructor(message: string, options: { status?: number | null; provider?: string; body?: string } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = options.status ?? null;
    this.provider = options.provider ?? "unknown";
    this.body = options.body ?? "";
  }
}

/** Statuses worth retrying; everything else is a permanent failure. */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

/** Endpoint per provider. */
const ENDPOINTS = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  together: "https://api.together.xyz/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
} as const;

/** Sleep helper kept injectable so callers could stub it in tests. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One chat message. */
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Send one chat request and return the assistant's text.
 *
 * @param settings - active LLM settings (provider, model, key, maxTokens)
 * @param messages - system + user turns
 * @param attempts - total tries including the first
 * @param signal - optional AbortSignal so the UI can cancel a long run
 */
export async function chat(
  settings: Settings["llm"],
  messages: readonly ChatMessage[],
  options: { attempts?: number; signal?: AbortSignal } = {},
): Promise<string> {
  if (settings.apiKey.trim().length === 0) {
    throw new LlmError("No API key set. Open Settings and paste a key first.", {
      provider: settings.provider,
    });
  }
  const maxAttempts = Math.max(1, options.attempts ?? 3);
  let lastError: LlmError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw new LlmError("Cancelled", { provider: settings.provider });
    try {
      return await sendOnce(settings, messages, options.signal);
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      lastError = error;
      const retryable = error.status !== null && RETRYABLE.has(error.status);
      if (!retryable || attempt === maxAttempts - 1) throw error;
      // Exponential backoff with jitter, capped so a long run stays usable.
      const base = Math.min(30_000, 1_000 * 2 ** attempt);
      const jitter = Math.random() * 500;
      await sleep(base + jitter);
    }
  }
  throw lastError ?? new LlmError("Request failed", { provider: settings.provider });
}

/** One network round-trip, provider-specific request and response shaping. */
async function sendOnce(
  settings: Settings["llm"],
  messages: readonly ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const provider = settings.provider;

  if (provider === "anthropic") {
    const system = messages.filter((message) => message.role === "system").map((m) => m.content).join("\n");
    const turns = messages.filter((message) => message.role !== "system");
    const response = await fetch(ENDPOINTS.anthropic, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        // Required for a direct browser call; see the warning in Settings.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: settings.maxTokens,
        system: system.length > 0 ? system : undefined,
        messages: turns.map((turn) => ({ role: turn.role, content: turn.content })),
      }),
    });
    return finish(response, provider, (json) => {
      const blocks = (json as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
      const text = blocks.find((block) => block?.type === "text")?.text;
      if (typeof text !== "string" || text.length === 0) {
        throw new LlmError("Anthropic returned no text block", { provider });
      }
      return text;
    });
  }

  // OpenRouter and Together share the OpenAI chat/completions shape.
  const endpoint = provider === "together" ? ENDPOINTS.together : ENDPOINTS.openrouter;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${settings.apiKey}`,
  };
  if (provider === "openrouter") {
    // OpenRouter asks for these two so it can attribute traffic.
    headers["HTTP-Referer"] = typeof window === "undefined" ? "https://localhost/" : window.location.origin;
    headers["X-Title"] = "Word Refinery";
  }

  const response = await fetch(endpoint, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify({
      model: settings.model,
      max_tokens: settings.maxTokens,
      temperature: 0.7,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
    }),
  });

  return finish(response, provider, (json) => {
    const choice = (json as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === "string" && content.length > 0) return content;
    // Some OpenRouter models return an array of content parts.
    if (Array.isArray(content)) {
      const text = content
        .map((part) => (typeof part === "object" && part !== null ? String((part as { text?: unknown }).text ?? "") : ""))
        .join("");
      if (text.length > 0) return text;
    }
    throw new LlmError(`${provider} returned no assistant text`, { provider });
  });
}

/** Parse a response, turning HTTP and body problems into LlmError. */
async function finish(
  response: Response,
  provider: string,
  extract: (json: unknown) => string,
): Promise<string> {
  const raw = await response.text();
  if (!response.ok) {
    throw new LlmError(
      `${provider} responded ${response.status} ${response.statusText}`.trim(),
      { status: response.status, provider, body: raw.slice(0, 600) },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new LlmError(`${provider} returned a non-JSON body`, { provider, body: raw.slice(0, 600) });
  }
  return extract(json);
}

/** Progress callback fired between batches. */
export interface AnnotateProgress {
  (event: { done: number; total: number; batch: number; words: readonly string[] }): void;
}

/** Outcome of one annotation run. */
export interface AnnotateResult {
  annotations: Map<string, CrawlerAnnotation>;
  issues: string[];
}

/**
 * Annotate a list of corpus words in batches.
 *
 * Each batch is one LLM call. A batch that fails to parse is reported as issues
 * rather than aborting the whole run, so a partial result is still usable and
 * the reviewer can re-run just the missing words.
 *
 * @param settings - active LLM settings
 * @param words - corpus words to annotate
 * @param batchSize - words per call
 * @param onProgress - optional per-batch callback for the progress bar
 * @param signal - optional AbortSignal
 */
export async function annotateBatch(
  settings: Settings["llm"],
  words: readonly CorpusWord[],
  batchSize: number,
  onProgress?: AnnotateProgress,
  signal?: AbortSignal,
): Promise<AnnotateResult> {
  const annotations = new Map<string, CrawlerAnnotation>();
  const issues: string[] = [];

  const batches: CorpusWord[][] = [];
  const size = Math.max(1, Math.floor(batchSize));
  for (let start = 0; start < words.length; start += size) {
    batches.push(words.slice(start, start + size));
  }

  let done = 0;
  for (const [index, batch] of batches.entries()) {
    if (signal?.aborted) {
      issues.push(`cancelled after ${done} of ${words.length} words`);
      break;
    }
    const requested = batch.map((entry) => entry.word);
    try {
      const reply = await chat(
        settings,
        [
          { role: "system", content: ANNOTATION_SYSTEM_PROMPT },
          { role: "user", content: buildBatchPrompt(batch) },
        ],
        { signal },
      );
      const items = extractJsonArray(reply);
      if (items === null) {
        issues.push(`batch ${index + 1}: reply contained no JSON array`);
      } else {
        const parsed = parseAnnotationList(items, requested);
        for (const [word, annotation] of parsed.annotations) annotations.set(word, annotation);
        issues.push(...parsed.issues.map((issue) => `batch ${index + 1}: ${issue}`));
      }
    } catch (error) {
      const message = error instanceof LlmError ? `${error.message}${error.body ? ` — ${error.body}` : ""}` : String(error);
      issues.push(`batch ${index + 1} failed: ${message}`);
      // An auth or billing failure will repeat for every batch; stop early.
      if (error instanceof LlmError && (error.status === 401 || error.status === 402 || error.status === 403)) {
        issues.push("stopping: the provider rejected the key or the account has no credit");
        break;
      }
    }
    done += batch.length;
    onProgress?.({ done, total: words.length, batch: index + 1, words: requested });
  }

  return { annotations, issues };
}

/**
 * Ask the model to rewrite one Vietnamese field, used by the review UI's
 * "regenerate" action. Returns the replacement text or throws.
 */
export async function regenerateField(
  settings: Settings["llm"],
  word: DeckWord,
  field: "defVi" | "leadVi" | "anticipateVi" | "usageVi",
  complaint: string,
  signal?: AbortSignal,
): Promise<string> {
  const reply = await chat(
    settings,
    [
      { role: "system", content: ANNOTATION_SYSTEM_PROMPT },
      { role: "user", content: buildRegeneratePrompt(word, field, complaint) },
    ],
    { attempts: 2, signal },
  );

  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(reply.slice(start, end + 1)) as { value?: unknown };
      if (typeof parsed.value === "string" && parsed.value.trim().length > 0) {
        return parsed.value.trim();
      }
    } catch {
      // fall through to the raw-text path
    }
  }
  const trimmed = reply.trim();
  if (trimmed.length === 0) throw new LlmError("Model returned an empty rewrite", { provider: settings.provider });
  return trimmed;
}

/**
 * Cheap connectivity check used by the Settings panel's "Test" button.
 * @returns the model's reply, so the UI can show proof it worked
 */
export async function testConnection(settings: Settings["llm"]): Promise<string> {
  return chat(
    { ...settings, maxTokens: 64 },
    [
      { role: "system", content: "Reply with exactly the word: OK" },
      { role: "user", content: "Ping" },
    ],
    { attempts: 1 },
  );
}

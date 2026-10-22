/**
 * Browser-side LLM client.
 *
 * Speaks the OpenAI chat/completions format for OpenRouter, Together and
 * Alibaba (Bailian compatible-mode), and the Messages API for Anthropic, so
 * one call site covers all four. Retries
 * only on transient statuses (429/500/502/503/504/529) with exponential
 * backoff plus jitter, honouring `retry-after` when the provider sends it.
 *
 * The API key is read from localStorage at call time and is sent only to the
 * endpoint the user picked. Nothing is proxied: GitHub Pages has no server.
 *
 * Exports: LlmError, ListedModel, chat, readChatText, listModels, annotateBatch, regenerateField,
 *          verifyWord, markupWord, distilStyle, testConnection
 * Depends on: ./settings.ts, ./prompt.ts, ./contract.ts, ./types.ts
 */
import type { LlmProvider, Settings } from "./settings.ts";
import {
  buildBatchPrompt,
  buildRegeneratePrompt,
  buildDistilPrompt,
  buildHouseVoice,
  buildMarkupPrompt,
  buildVerifyPrompt,
  MARKUP_FIELDS,
  type MarkupField,
  type RefineRequest,
  type VerifyFinding,
  type VerifyReport,
} from "./prompt.ts";
import { hasStyleGuide, resolvePrompt } from "./prompt-store.ts";
import { findStrayMarks, stripMarks } from "./joiner.ts";
import { extractJsonArray, parseAnnotationList, type CrawlerAnnotation } from "./contract.ts";
import type { CorpusWord, DeckWord } from "./types.ts";
import type { AvoidList } from "./uniqueness.ts";

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
  alibaba:
    "https://ws-qc87cpgqq7pnch88.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
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

  // OpenRouter, Together and Alibaba share the OpenAI chat/completions shape.
  const endpoint = ENDPOINTS[provider];
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${settings.apiKey}`,
  };
  if (provider === "openrouter") {
    // OpenRouter asks for these two so it can attribute traffic.
    // Optional chaining rather than a `typeof` guard: the non-browser callers
    // this module already supports may have a window without a location.
    headers["HTTP-Referer"] = globalThis.window?.location?.origin ?? "https://localhost/";
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

  return finish(response, provider, (json) => readChatText(provider, json, settings.maxTokens));
}

/** The parts of an OpenAI-shaped completion this client reads. */
interface ChatCompletion {
  error?: { message?: unknown; code?: unknown };
  choices?: Array<{
    finish_reason?: unknown;
    error?: { message?: unknown; code?: unknown };
    message?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown };
  }>;
}

/**
 * Pull the assistant text out of an OpenAI-shaped completion, or explain why
 * there is none.
 *
 * OpenRouter answers 200 even when the upstream model failed, putting the
 * failure in the body, and reasoning models can spend the whole token budget
 * thinking and leave `content` empty. Both need a different fix from the user,
 * so each gets its own message.
 *
 * @param provider - provider name for messages
 * @param json - parsed response body
 * @param maxTokens - the budget the request was sent with
 * @returns the assistant text
 */
export function readChatText(provider: string, json: unknown, maxTokens: number): string {
  const body = json as ChatCompletion;
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string" && content.trim().length > 0) return content;
  // Some OpenRouter models return an array of content parts.
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part === "object" && part !== null ? String((part as { text?: unknown }).text ?? "") : ""))
      .join("");
    if (text.trim().length > 0) return text;
  }

  const snippet = JSON.stringify(json).slice(0, 600);
  const upstream = body.error ?? choice?.error;
  if (upstream !== undefined) {
    const code = typeof upstream.code === "number" ? upstream.code : null;
    const detail = typeof upstream.message === "string" ? upstream.message : "unknown error";
    throw new LlmError(`${provider}: the model's provider failed — ${detail}`, {
      provider,
      status: code,
      body: snippet,
    });
  }

  const reasoning = choice?.message?.reasoning ?? choice?.message?.reasoning_content;
  const thought = typeof reasoning === "string" && reasoning.length > 0;
  const finish = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  if (finish === "length") {
    throw new LlmError(
      thought
        ? `${provider}: the model spent all ${maxTokens} tokens reasoning and wrote no answer. Raise Max tokens in Settings or pick a non-reasoning model.`
        : `${provider}: the reply hit the ${maxTokens}-token limit before any text. Raise Max tokens in Settings.`,
      { provider, body: snippet },
    );
  }
  if (finish === "content_filter") {
    throw new LlmError(`${provider}: the reply was blocked by the model's content filter.`, {
      provider,
      body: snippet,
    });
  }
  throw new LlmError(`${provider} returned no assistant text${finish ? ` (finish reason: ${finish})` : ""}`, {
    provider,
    body: snippet,
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

// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------

/** Catalogue endpoint per provider. */
const MODEL_ENDPOINTS = {
  openrouter: "https://openrouter.ai/api/v1/models",
  together: "https://api.together.xyz/v1/models",
  anthropic: "https://api.anthropic.com/v1/models",
  alibaba:
    "https://ws-qc87cpgqq7pnch88.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models",
} as const;

/** One row from a provider's model catalogue. */
export interface ListedModel {
  /** The exact id to pass as `model` when chatting. */
  id: string;
  /** Display name when the provider sends one; falls back to the id. */
  name: string;
  /** Context window in tokens, when the provider reports one. */
  contextLength: number | null;
  /** Output modalities when the provider reports them (OpenRouter). */
  outputModalities?: readonly string[];
}

/** De-duplicate by id and sort alphabetically so the picker order is stable. */
function normalizeRows(rows: readonly ListedModel[]): ListedModel[] {
  const byId = new Map<string, ListedModel>();
  for (const row of rows) {
    if (row.id.length > 0 && !byId.has(row.id)) byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Read an optional integer field without trusting the payload shape. */
function readContextLength(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/**
 * Normalise one provider's catalogue payload into rows.
 *
 * Exported so the tests can cover every response shape without a network.
 * Malformed entries are skipped rather than throwing: a half-broken catalogue
 * still beats no picker at all.
 */
export function parseModelList(provider: LlmProvider, payload: unknown): ListedModel[] {
  const rows: ListedModel[] = [];
  const push = (entry: Record<string, unknown>) => {
    const id = typeof entry.id === "string" ? entry.id : "";
    if (id.length === 0) return;
    const name =
      typeof entry.name === "string" && entry.name.length > 0
        ? entry.name
        : typeof entry.display_name === "string" && entry.display_name.length > 0
          ? entry.display_name
          : id;
    const architecture =
      typeof entry.architecture === "object" && entry.architecture !== null
        ? (entry.architecture as Record<string, unknown>)
        : null;
    const outputs = architecture?.output_modalities;
    const row: ListedModel = {
      id,
      name,
      contextLength: readContextLength(entry.context_length),
    };
    if (Array.isArray(outputs)) {
      const modalities = outputs.filter((value): value is string => typeof value === "string");
      if (modalities.length > 0) row.outputModalities = modalities;
    }
    rows.push(row);
  };

  if (provider === "together") {
    // Together returns a bare array mixing chat, code, embedding, moderation
    // and rerank models; only chat models answer the chat/completions call.
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (typeof item !== "object" || item === null) continue;
        const entry = item as Record<string, unknown>;
        if (entry.type !== undefined && entry.type !== "chat") continue;
        push(entry);
      }
    }
    return rows;
  }

  // OpenRouter and Anthropic both wrap the list in { data: [...] }.
  const data = (payload as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      push(item as Record<string, unknown>);
    }
  }
  return rows;
}

/** Auth headers for the catalogue call, mirroring the chat request. */
function catalogueHeaders(provider: LlmProvider, apiKey: string): Record<string, string> {
  if (provider === "anthropic") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required for a direct browser call; see the warning in Settings.
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = typeof window === "undefined" ? "https://localhost/" : window.location.origin;
    headers["X-Title"] = "Word Refinery";
  }
  return headers;
}

/** GET a JSON document, surfacing HTTP and body problems as LlmError. */
async function getJson(
  url: string,
  provider: LlmProvider,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, { method: "GET", headers, signal });
  const raw = await response.text();
  if (!response.ok) {
    throw new LlmError(
      `${provider} responded ${response.status} ${response.statusText}`.trim(),
      { status: response.status, provider, body: raw.slice(0, 600) },
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new LlmError(`${provider} returned a non-JSON body`, { provider, body: raw.slice(0, 600) });
  }
}

/**
 * Fetch the provider's model catalogue so the Settings picker can offer exact
 * ids instead of making the user memorise them.
 *
 * Anthropic paginates with `after_id`; the OpenAI-style endpoints return a
 * single page. Auth failures throw LlmError with the HTTP status so the UI
 * can tell a bad key from a network blip.
 *
 * @param settings - active LLM settings (provider, apiKey)
 * @param signal - optional AbortSignal so the UI can cancel a stale fetch
 */
export async function listModels(
  settings: Settings["llm"],
  signal?: AbortSignal,
): Promise<ListedModel[]> {
  const provider = settings.provider;
  const apiKey = settings.apiKey.trim();
  if (apiKey.length === 0) {
    throw new LlmError("No API key set. Open Settings and paste a key first.", { provider });
  }
  const headers = catalogueHeaders(provider, apiKey);

  try {
    if (provider === "anthropic") {
      const rows: ListedModel[] = [];
      let afterId: string | null = null;
      // Hard cap so a malformed `has_more` can never loop forever.
      for (let page = 0; page < 50; page += 1) {
        const url = new URL(MODEL_ENDPOINTS.anthropic);
        url.searchParams.set("limit", "100");
        if (afterId !== null) url.searchParams.set("after_id", afterId);
        const payload = (await getJson(url.toString(), provider, headers, signal)) as {
          data?: unknown;
          has_more?: unknown;
          last_id?: unknown;
        };
        rows.push(...parseModelList(provider, payload));
        const lastId = typeof payload.last_id === "string" ? payload.last_id : "";
        if (payload.has_more !== true || lastId.length === 0) break;
        afterId = lastId;
      }
      return normalizeRows(rows);
    }

    const payload = await getJson(MODEL_ENDPOINTS[provider], provider, headers, signal);
    return normalizeRows(parseModelList(provider, payload));
  } catch (error) {
    if (error instanceof LlmError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // fetch() failures (DNS, CORS, offline) arrive as plain TypeErrors.
    throw new LlmError(`Could not reach ${provider}: ${message}`, { provider });
  }
}

/** Progress callback fired between batches. */
export interface AnnotateProgress {
  (event: { done: number; total: number; batch: number; words: readonly string[] }): void;
}


/**
 * The house-voice block for one request, or "" when there is no guide yet.
 *
 * Keyed on whether a real guide exists — this browser's edit or one committed
 * to the repository — rather than on the text being non-empty: the shipped
 * default is a placeholder explaining the feature, and sending that to a model
 * would be worse than sending nothing.
 *
 * @param exemplars - rendered examples, already selected by the caller
 * @param whole - true when the exemplars are complete cards
 */
function houseVoice(exemplars: string, whole: boolean): string {
  if (!hasStyleGuide()) return "";
  return buildHouseVoice(resolvePrompt("style"), exemplars, whole);
}

/** Append a block to a system prompt, with a blank line between. */
function withBlock(systemPrompt: string, block: string): string {
  return block.length > 0 ? `${systemPrompt}\n\n${block}` : systemPrompt;
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
 * @param options.onProgress - optional per-batch callback for the progress bar
 * @param options.signal - optional AbortSignal
 * @param options.avoid - running list of `anticipateVi` lines already taken; each
 *   batch is told about it and feeds its own output back, so a multi-batch run
 *   cannot collide with itself
 */
export async function annotateBatch(
  settings: Settings["llm"],
  words: readonly CorpusWord[],
  batchSize: number,
  options: {
    onProgress?: AnnotateProgress;
    signal?: AbortSignal;
    avoid?: AvoidList;
    /** Rendered whole-card examples of the house voice, or "" for none. */
    exemplars?: string;
  } = {},
): Promise<AnnotateResult> {
  const { onProgress, signal, avoid, exemplars = "" } = options;
  const system = withBlock(resolvePrompt("annotation"), houseVoice(exemplars, true));
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
          { role: "system", content: system },
          { role: "user", content: buildBatchPrompt(batch, avoid?.section() ?? "") },
        ],
        { signal },
      );
      const items = extractJsonArray(reply);
      if (items === null) {
        issues.push(`batch ${index + 1}: reply contained no JSON array`);
      } else {
        const parsed = parseAnnotationList(items, requested);
        for (const [word, annotation] of parsed.annotations) annotations.set(word, annotation);
        // Fed back before the next batch is built, so later calls in this run
        // see what the earlier ones just used.
        avoid?.add([...parsed.annotations.values()].map((item) => item.anticipateVi));
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
 * Ask the model to rewrite one Vietnamese field, used by the Review table's
 * inline refine control. The request carries the reviewer's chips, note and the
 * validator's own findings together, so a single rewrite answers all of them.
 *
 * @param avoid - the deck's taken teaser lines, rendered for the prompt
 * @returns the replacement text, plus the phrase to highlight when the model
 *   chose one (defVi and leadVi only)
 * @throws LlmError when the reply is empty
 */
export async function regenerateField(
  settings: Settings["llm"],
  word: DeckWord,
  request: RefineRequest,
  options: {
    avoid?: string;
    signal?: AbortSignal;
    /** Rendered examples of the house voice in this field, or "" for none. */
    exemplars?: string;
  } = {},
): Promise<{ value: string; emphasis: string | null }> {
  const reply = await chat(
    settings,
    [
      { role: "system", content: withBlock(resolvePrompt("rewrite"), houseVoice(options.exemplars ?? "", false)) },
      { role: "user", content: buildRegeneratePrompt(word, request, options.avoid) },
    ],
    { attempts: 2, signal: options.signal },
  );

  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(reply.slice(start, end + 1)) as { value?: unknown; emphasis?: unknown };
      if (typeof parsed.value === "string" && parsed.value.trim().length > 0) {
        const emphasis =
          typeof parsed.emphasis === "string" && parsed.emphasis.trim().length > 0
            ? parsed.emphasis.trim()
            : null;
        return { value: parsed.value.trim(), emphasis };
      }
    } catch {
      // fall through to the raw-text path
    }
  }
  const trimmed = reply.trim();
  if (trimmed.length === 0) throw new LlmError("Model returned an empty rewrite", { provider: settings.provider });
  return { value: trimmed, emphasis: null };
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

/**
 * Ask the model to review one finished card.
 *
 * A second pass with a reviewer's prompt rather than a writer's, for the things
 * the deterministic validator cannot judge: whether the Vietnamese reads
 * naturally, whether the definition defines the right sense, and whether the
 * highlight landed on the phrase that carries the sentence.
 *
 * @param settings - active LLM settings
 * @param word - the deck word to check
 * @param signal - optional AbortSignal
 * @returns the verdict and findings
 * @throws LlmError when the reply cannot be read as a report
 */
export async function verifyWord(
  settings: Settings["llm"],
  word: DeckWord,
  signal?: AbortSignal,
): Promise<VerifyReport> {
  const reply = await chat(
    settings,
    [
      { role: "system", content: resolvePrompt("verify") },
      { role: "user", content: buildVerifyPrompt(word) },
    ],
    { attempts: 2, signal },
  );

  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new LlmError("The review reply contained no JSON object", {
      provider: settings.provider,
      body: reply.slice(0, 300),
    });
  }
  let parsed: { verdict?: unknown; findings?: unknown };
  try {
    parsed = JSON.parse(reply.slice(start, end + 1)) as typeof parsed;
  } catch {
    throw new LlmError("The review reply was not valid JSON", {
      provider: settings.provider,
      body: reply.slice(0, 300),
    });
  }

  const severities = new Set(["blocker", "warn", "note"]);
  const findings: VerifyFinding[] = Array.isArray(parsed.findings)
    ? parsed.findings
        .map((item): VerifyFinding | null => {
          if (typeof item !== "object" || item === null) return null;
          const record = item as Record<string, unknown>;
          const problem = typeof record.problem === "string" ? record.problem.trim() : "";
          if (problem.length === 0) return null;
          const severity =
            typeof record.severity === "string" && severities.has(record.severity)
              ? (record.severity as VerifyFinding["severity"])
              : "note";
          return {
            field: typeof record.field === "string" ? record.field : "word",
            severity,
            problem,
            suggestion: typeof record.suggestion === "string" ? record.suggestion.trim() : "",
          };
        })
        .filter((finding): finding is VerifyFinding => finding !== null)
    : [];

  // The verdict is derived rather than trusted: a model that lists a blocker
  // and still says "pass" has contradicted itself, and the findings are the
  // part a reviewer acts on.
  const worst = findings.some((finding) => finding.severity !== "note");
  const claimed = parsed.verdict === "pass" || parsed.verdict === "revise" ? parsed.verdict : null;
  return { verdict: worst ? "revise" : (claimed ?? "pass"), findings };
}

/**
 * Ask the model to add breaking marks to one card's existing text.
 *
 * The pass is only trustworthy because its output is checkable: strip the marks
 * off what comes back and it must equal what went in. A model that rewrote a
 * word, fixed a diacritic or dropped a comma fails that check, and the field is
 * discarded rather than written over a reviewed deck. Marking up is cheap to
 * redo; silently losing reviewed Vietnamese is not.
 *
 * @param settings - active LLM settings
 * @param word - the card to mark up
 * @param signal - optional AbortSignal
 * @returns the fields that changed, plus a note for every field refused
 */
export async function markupWord(
  settings: Settings["llm"],
  word: DeckWord,
  signal?: AbortSignal,
): Promise<{ patch: Partial<Record<MarkupField, string>>; issues: string[] }> {
  const request = buildMarkupPrompt(word);
  if (request.length === 0) return { patch: {}, issues: [] };

  const reply = await chat(
    settings,
    [
      { role: "system", content: resolvePrompt("markup") },
      { role: "user", content: request },
    ],
    { attempts: 2, signal },
  );

  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new LlmError("The markup reply contained no JSON object", {
      provider: settings.provider,
      body: reply.slice(0, 300),
    });
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new LlmError("The markup reply was not valid JSON", {
      provider: settings.provider,
      body: reply.slice(0, 300),
    });
  }

  const current: Record<MarkupField, string> = {
    meaningVi: word.meaningVi,
    defVi: word.defVi,
    leadVi: word.leadVi,
    anticipateVi: word.anticipateVi,
    usageVi: word.usage[0]?.vi ?? "",
  };

  const patch: Partial<Record<MarkupField, string>> = {};
  const issues: string[] = [];
  for (const field of MARKUP_FIELDS) {
    const value = parsed[field];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const before = current[field];
    if (before.trim().length === 0) continue;
    if (value === before) continue;
    // The whole safety of this pass: marks may be added, nothing else may move.
    if (stripMarks(value) !== stripMarks(before)) {
      issues.push(
        `${word.word}: ${field} was edited rather than marked up, so it was discarded — ` +
          `expected "${stripMarks(before)}", got "${stripMarks(value)}"`,
      );
      continue;
    }
    for (const problem of findStrayMarks(value)) {
      issues.push(`${word.word}: ${field} ${problem}`);
    }
    if (findStrayMarks(value).length === 0) patch[field] = value;
  }

  return { patch, issues };
}

/**
 * Distil the reviewer's edits into a style guide.
 *
 * @param settings - active LLM settings
 * @param pairs - rendered before/after pairs
 * @param cardCount - how many cards they came from, for the request
 * @param signal - optional AbortSignal
 * @returns the guide as Markdown
 */
export async function distilStyle(
  settings: Settings["llm"],
  pairs: string,
  cardCount: number,
  signal?: AbortSignal,
): Promise<string> {
  const reply = await chat(
    settings,
    [
      { role: "system", content: resolvePrompt("distil") },
      { role: "user", content: buildDistilPrompt(pairs, cardCount) },
    ],
    { attempts: 2, signal },
  );
  const guide = reply.replace(/^```(?:markdown)?\n?|```$/g, "").trim();
  if (guide.length === 0) {
    throw new LlmError("The distillation returned nothing", { provider: settings.provider });
  }
  return guide;
}

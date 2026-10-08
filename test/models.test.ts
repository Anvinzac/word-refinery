/**
 * Tests for the model catalogue client: response normalisation for all three
 * providers, request shaping, Anthropic pagination, and error mapping.
 *
 * fetch is stubbed per test, so no network is touched. Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/llm.ts, ../src/lib/settings.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import { LlmError, listModels, parseModelList, type ListedModel } from "../src/lib/llm.ts";
import {
  estimateParamsB,
  formatParamsB,
  groupModels,
  isPresentableModel,
  modelFamilyOf,
} from "../src/lib/models.ts";
import { defaultSettings, type Settings } from "../src/lib/settings.ts";

/** Build LLM settings with a throwaway key for the tests. */
function llmSettings(overrides: Partial<Settings["llm"]> = {}): Settings["llm"] {
  return { ...defaultSettings().llm, apiKey: "sk-test-key", ...overrides };
}

/** Quick catalogue row for picker tests. */
function row(id: string, extra: Partial<ListedModel> = {}): ListedModel {
  return { id, name: id, contextLength: null, ...extra };
}

/** A JSON Response for stubbed fetch. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const realFetch = globalThis.fetch;

/** Replace fetch for the duration of one test. */
function stubFetch(implementation: (input: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = implementation as typeof fetch;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// parseModelList
// ---------------------------------------------------------------------------

test("parses the OpenRouter { data: [...] } shape", () => {
  const rows = parseModelList("openrouter", {
    data: [
      { id: "openai/gpt-4", name: "GPT-4", context_length: 8192 },
      { id: "anthropic/claude-3.5-haiku", name: "Claude 3.5 Haiku" },
    ],
  });
  assert.deepEqual(rows, [
    { id: "openai/gpt-4", name: "GPT-4", contextLength: 8192 },
    { id: "anthropic/claude-3.5-haiku", name: "Claude 3.5 Haiku", contextLength: null },
  ]);
});

test("parses Together's bare array and keeps only chat models", () => {
  const rows = parseModelList("together", [
    { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", type: "chat", display_name: "Llama 3.3 70B", context_length: 131072 },
    { id: "some/embedding-model", type: "embedding", display_name: "Embedder" },
    { id: "some/rerank-model", type: "rerank" },
    { id: "legacy/chat-model", display_name: "Legacy" },
  ]);
  assert.deepEqual(rows, [
    { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Llama 3.3 70B", contextLength: 131072 },
    { id: "legacy/chat-model", name: "Legacy", contextLength: null },
  ]);
});

test("parses the Anthropic { data: [...] } shape using display_name", () => {
  const rows = parseModelList("anthropic", {
    data: [{ id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" }],
  });
  assert.deepEqual(rows, [
    { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", contextLength: null },
  ]);
});

test("skips malformed entries instead of throwing", () => {
  const rows = parseModelList("openrouter", {
    data: [null, "oops", { not_id: true }, { id: "good/model", name: "Good" }],
  });
  assert.deepEqual(rows, [{ id: "good/model", name: "Good", contextLength: null }]);
});

test("falls back to the id when no display name exists", () => {
  const rows = parseModelList("anthropic", { data: [{ id: "claude-x" }] });
  assert.equal(rows[0]?.name, "claude-x");
});

test("returns no rows for an unexpected payload shape", () => {
  assert.deepEqual(parseModelList("openrouter", { unexpected: true }), []);
  assert.deepEqual(parseModelList("together", { data: [] }), []);
});


// ---------------------------------------------------------------------------
// listModels
// ---------------------------------------------------------------------------

test("listModels hits the OpenRouter catalogue with the key", async () => {
  let seenUrl = "";
  let seenAuth = "";
  stubFetch(async (url, init) => {
    seenUrl = String(url);
    seenAuth = new Headers(init?.headers).get("authorization") ?? "";
    return jsonResponse({ data: [{ id: "openai/gpt-4", name: "GPT-4" }] });
  });

  const rows = await listModels(llmSettings({ provider: "openrouter" }));
  assert.equal(seenUrl, "https://openrouter.ai/api/v1/models");
  assert.equal(seenAuth, "Bearer sk-test-key");
  assert.deepEqual(rows.map((row) => row.id), ["openai/gpt-4"]);
});

test("listModels hits the Together catalogue with the key", async () => {
  let seenUrl = "";
  stubFetch(async (url) => {
    seenUrl = String(url);
    return jsonResponse([{ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", type: "chat" }]);
  });

  const rows = await listModels(llmSettings({ provider: "together" }));
  assert.equal(seenUrl, "https://api.together.xyz/v1/models");
  assert.deepEqual(rows.map((row) => row.id), ["meta-llama/Llama-3.3-70B-Instruct-Turbo"]);
});

test("listModels hits the Alibaba catalogue with the key", async () => {
  let seenUrl = "";
  let seenAuth = "";
  stubFetch(async (url, init) => {
    seenUrl = String(url);
    seenAuth = new Headers(init?.headers).get("authorization") ?? "";
    return jsonResponse({ object: "list", data: [{ id: "qwen3-max" }, { id: "deepseek-v4-pro" }] });
  });

  const rows = await listModels(llmSettings({ provider: "alibaba" }));
  assert.equal(
    seenUrl,
    "https://ws-qc87cpgqq7pnch88.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models",
  );
  assert.equal(seenAuth, "Bearer sk-test-key");
  assert.deepEqual(rows.map((row) => row.id), ["deepseek-v4-pro", "qwen3-max"]);
});

test("listModels follows Anthropic pagination via after_id", async () => {
  const seenQueries: Array<Record<string, string>> = [];
  // Holder object so TypeScript doesn't narrow the closure-assigned value.
  const seen: { headers: Headers | null } = { headers: null };
  let calls = 0;
  stubFetch(async (url, init) => {
    calls += 1;
    seen.headers = new Headers(init?.headers);
    seenQueries.push(Object.fromEntries(new URL(String(url)).searchParams));
    if (calls === 1) {
      return jsonResponse({
        data: [{ id: "claude-1", display_name: "One" }],
        has_more: true,
        last_id: "claude-1",
      });
    }
    return jsonResponse({
      data: [{ id: "claude-2", display_name: "Two" }],
      has_more: false,
      last_id: null,
    });
  });

  const rows = await listModels(llmSettings({ provider: "anthropic" }));
  assert.equal(calls, 2);
  assert.equal(seenQueries[0]?.limit, "100");
  assert.equal(seenQueries[0]?.after_id, undefined);
  assert.equal(seenQueries[1]?.after_id, "claude-1");
  assert.deepEqual(rows.map((row) => row.id), ["claude-1", "claude-2"]);
  assert.equal(seen.headers?.get("x-api-key"), "sk-test-key");
  assert.equal(seen.headers?.get("anthropic-dangerous-direct-browser-access"), "true");
});

test("listModels de-duplicates and sorts rows", async () => {
  stubFetch(async () =>
    jsonResponse({
      data: [
        { id: "z/model", name: "Z" },
        { id: "a/model", name: "A" },
        { id: "z/model", name: "Z again" },
      ],
    }),
  );
  const rows = await listModels(llmSettings({ provider: "openrouter" }));
  assert.deepEqual(rows.map((row) => row.id), ["a/model", "z/model"]);
  assert.equal(rows[1]?.name, "Z");
});

test("listModels rejects an empty key without touching the network", async () => {
  stubFetch(async () => {
    assert.fail("fetch must not be called without a key");
  });
  await assert.rejects(
    listModels(llmSettings({ apiKey: "   " })),
    (error: unknown) => error instanceof LlmError && /No API key/.test(error.message),
  );
});

test("listModels surfaces HTTP errors as LlmError with the status", async () => {
  stubFetch(async () => jsonResponse({ error: { message: "invalid key" } }, 401));
  await assert.rejects(
    listModels(llmSettings({ provider: "together" })),
    (error: unknown) =>
      error instanceof LlmError && error.status === 401 && /401/.test(error.message),
  );
});

test("listModels wraps network failures in a readable LlmError", async () => {
  stubFetch(async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(
    listModels(llmSettings({ provider: "openrouter" })),
    (error: unknown) =>
      error instanceof LlmError && error.status === null && /Could not reach openrouter/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// Family picker: catalogue metadata, quality bar, grouping
// ---------------------------------------------------------------------------

test("records OpenRouter output modalities from architecture metadata", () => {
  const rows = parseModelList("openrouter", {
    data: [
      {
        id: "a/keep",
        name: "Keep",
        context_length: 4096,
        architecture: { output_modalities: ["text"], input_modalities: ["text", "image"] },
      },
      { id: "b/media", name: "Media", architecture: { output_modalities: ["image"] } },
      { id: "c/bare", name: "Bare", architecture: {} },
    ],
  });
  assert.deepEqual(rows, [
    { id: "a/keep", name: "Keep", contextLength: 4096, outputModalities: ["text"] },
    { id: "b/media", name: "Media", contextLength: null, outputModalities: ["image"] },
    { id: "c/bare", name: "Bare", contextLength: null },
  ]);
});

test("maps ids onto the curated families", () => {
  assert.equal(modelFamilyOf("anthropic/claude-sonnet-4.5")?.id, "claude");
  assert.equal(modelFamilyOf("claude-opus-4-20250514")?.id, "claude");
  assert.equal(modelFamilyOf("openai/gpt-oss-120b")?.id, "gpt");
  assert.equal(modelFamilyOf("openai/o3")?.id, "gpt");
  assert.equal(modelFamilyOf("google/gemini-2.5-pro")?.id, "gemini");
  assert.equal(modelFamilyOf("google/gemma-3-27b-it")?.id, "gemini");
  assert.equal(modelFamilyOf("nvidia/nemotron-3-ultra-550b-a55b")?.id, "nvidia");
  assert.equal(modelFamilyOf("nvidia/llama-3.1-nemotron-70b-instruct")?.id, "nvidia");
  assert.equal(modelFamilyOf("meta-llama/llama-3.3-70b-instruct")?.id, "meta");
  assert.equal(modelFamilyOf("meta/muse-spark-1.3")?.id, "meta");
  assert.equal(modelFamilyOf("Qwen/Qwen2.5-72B-Instruct-Turbo")?.id, "qwen");
  assert.equal(modelFamilyOf("deepseek-ai/DeepSeek-V3")?.id, "deepseek");
  assert.equal(modelFamilyOf("mistralai/Mistral-Small-24B-Instruct-2501")?.id, "mistral");
  assert.equal(modelFamilyOf("z-ai/glm-4.6")?.id, "glm");
  assert.equal(modelFamilyOf("moonshotai/kimi-k2.6")?.id, "kimi");
  assert.equal(modelFamilyOf("minimax/minimax-m2")?.id, "minimax");
  assert.equal(modelFamilyOf("cohere/command-r-plus-08-2024"), null);
  assert.equal(modelFamilyOf("upstage/solar-pro"), null);
});

test("estimateParamsB reads plain and MoE sizes", () => {
  assert.equal(estimateParamsB("meta-llama/llama-3.3-70b-instruct"), 70);
  assert.equal(estimateParamsB("Qwen/Qwen2.5-72B-Instruct-Turbo"), 72);
  assert.equal(estimateParamsB("mistralai/mixtral-8x7b-instruct"), 56);
  assert.equal(estimateParamsB("mistralai/mixtral-8x22b-2024"), 176);
  assert.equal(estimateParamsB("qwen/qwen3-235b-a22b-instruct-2507-fp8"), 235);
  assert.equal(estimateParamsB("google/gemini-2.0-flash-001"), null);
  assert.equal(estimateParamsB("claude-sonnet-4-5-20250929"), null);
  assert.equal(formatParamsB(70), "70B");
  assert.equal(formatParamsB(1.6), "1.6B");
});

test("the picker hides media generators", () => {
  assert.equal(isPresentableModel(row("openai/sora-2")), false);
  assert.equal(isPresentableModel(row("openai/gpt-image-1")), false);
  assert.equal(isPresentableModel(row("openai/gpt-4o-audio-preview")), false);
  assert.equal(isPresentableModel(row("google/veo-3.1-generate-preview")), false);
  assert.equal(isPresentableModel(row("google/gemini-2.5-flash-image-preview")), false);
  assert.equal(isPresentableModel(row("google/gemini-2.0-flash-001", { outputModalities: ["text"] })), true);
  assert.equal(
    isPresentableModel(row("google/gemini-2.5-flash-image", { outputModalities: ["text", "image"] })),
    false,
  );
});

test("the picker keeps known LLMs only, above the size bar", () => {
  assert.equal(isPresentableModel(row("meta-llama/Llama-3.2-3B-Instruct")), false);
  assert.equal(isPresentableModel(row("meta-llama/llama-guard-3-8b")), false);
  assert.equal(isPresentableModel(row("openai/gpt-4o-mini")), false);
  assert.equal(isPresentableModel(row("google/gemini-2.5-flash-lite")), false);
  assert.equal(isPresentableModel(row("openai/gpt-oss-20b")), false);
  assert.equal(isPresentableModel(row("google/gemma-3-27b-it")), true);
  assert.equal(isPresentableModel(row("mistralai/mixtral-8x7b-instruct")), true);
  assert.equal(isPresentableModel(row("openai/gpt-oss-120b")), true);
  assert.equal(isPresentableModel(row("meta-llama/llama-4-scout")), true);
  assert.equal(isPresentableModel(row("claude-haiku-4-5-20251001")), true);
  assert.equal(isPresentableModel(row("deepseek-ai/deepseek-r1")), true);
});

test("groupModels buckets in curated order and drops families with no survivors", () => {
  const families = groupModels([
    row("mistralai/mistral-small-24b-instruct-2501"),
    row("cohere/command-r-plus-08-2024"),
    row("openai/sora-2"),
    row("meta-llama/Llama-3.2-3B-Instruct"),
    row("qwen/qwen3-32b-instruct"),
    row("deepseek-ai/deepseek-v3-0324"),
    row("google/gemini-2.5-pro"),
    row("openai/gpt-4o-audio-preview"),
    row("anthropic/claude-sonnet-4.5"),
    row("openai/gpt-oss-120b"),
    row("nvidia/nemotron-3-super-120b-a12b"),
    row("meta/muse-spark-1.3"),
    row("z-ai/glm-4.6"),
    row("moonshotai/kimi-k2.6"),
    row("minimax/minimax-m2"),
  ]);
  assert.deepEqual(families.map((family) => family.id), [
    "claude",
    "gpt",
    "gemini",
    "nvidia",
    "meta",
    "qwen",
    "deepseek",
    "mistral",
    "glm",
    "kimi",
    "minimax",
    "other",
  ]);
  assert.deepEqual(families[1]?.models.map((model) => model.id), ["openai/gpt-oss-120b"]);
  assert.deepEqual(families[2]?.models.map((model) => model.id), ["google/gemini-2.5-pro"]);
  assert.deepEqual(families[3]?.models.map((model) => model.id), ["nvidia/nemotron-3-super-120b-a12b"]);
  assert.deepEqual(families[4]?.models.map((model) => model.id), ["meta/muse-spark-1.3"]);
});

test("nvidia classifiers are hidden; flagship nemotron sizes keep it listed", () => {
  assert.equal(isPresentableModel(row("nvidia/nemotron-3.5-content-safety")), false);
  assert.equal(isPresentableModel(row("nvidia/nemotron-3-ultra-550b-a55b")), true);
  assert.equal(estimateParamsB("nvidia/nemotron-3-ultra-550b-a55b"), 550);
});

test("off-family survivors land in a trailing other bucket, still behind the quality bar", () => {
  const families = groupModels([
    row("cohere/command-r-plus-08-2024"),
    row("x-ai/grok-4"),
    row("upstage/solar-pro"),
    row("openai/sora-2"),
    row("mistralai/mistral-nemo-12b"), // 12B: dropped even though off-family too
  ]);
  // sora is media and mistral-nemo is sub-20B, so only the Other bucket remains.
  assert.equal(families.length, 1);
  assert.equal(families[0]?.label, "Other");
  assert.deepEqual(families[0]?.models.map((model) => model.id), [
    "cohere/command-r-plus-08-2024",
    "upstage/solar-pro",
    "x-ai/grok-4",
  ]);
});

test("groupModels sorts members alphabetically and stays stable for suggested rows", () => {
  const families = groupModels([
    row("anthropic/claude-sonnet-4.5", { name: "Claude Sonnet 4.5" }),
    row("claude-haiku-4-5-20251001", { name: "Claude Haiku 4.5" }),
  ]);
  assert.deepEqual(
    families[0]?.models.map((model) => model.name),
    ["Claude Haiku 4.5", "Claude Sonnet 4.5"],
  );
});

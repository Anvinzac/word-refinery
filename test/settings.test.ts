/**
 * Per-provider keys: switching services must never lose a pasted key.
 *
 * Depends on: node:test, ../src/lib/settings.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  SETTINGS_KEY,
  defaultSettings,
  patchLlmSettings,
  readSettings,
  switchProvider,
} from "../src/lib/settings.ts";

test("each provider keeps its own key and model across switches", () => {
  let llm = defaultSettings().llm;
  llm = switchProvider(llm, "together");
  llm = patchLlmSettings(llm, { apiKey: "together-key", model: "Qwen/Qwen2.5-72B-Instruct-Turbo" });
  llm = switchProvider(llm, "openrouter");
  llm = patchLlmSettings(llm, { apiKey: "openrouter-key" });

  assert.equal(llm.apiKey, "openrouter-key");
  llm = switchProvider(llm, "together");
  assert.equal(llm.apiKey, "together-key");
  assert.equal(llm.model, "Qwen/Qwen2.5-72B-Instruct-Turbo");
  llm = switchProvider(llm, "openrouter");
  assert.equal(llm.apiKey, "openrouter-key");
});

test("all four providers, Alibaba included, hold separate keys at once", () => {
  const providers = ["alibaba", "openrouter", "together", "anthropic"] as const;
  let llm = defaultSettings().llm;
  for (const provider of providers) {
    llm = patchLlmSettings(switchProvider(llm, provider), { apiKey: `${provider}-key` });
  }
  for (const provider of ["together", "alibaba", "anthropic", "openrouter", "alibaba"] as const) {
    llm = switchProvider(llm, provider);
    assert.equal(llm.apiKey, `${provider}-key`);
  }
  assert.equal(llm.model, "qwen3-max");
});

test("a provider never used starts empty with its first suggested model", () => {
  const llm = switchProvider(patchLlmSettings(defaultSettings().llm, { apiKey: "or" }), "alibaba");
  assert.equal(llm.apiKey, "");
  assert.equal(llm.model, "qwen3-max");
});

test("an old single-key payload becomes the active provider's profile", () => {
  const stored = new Map<string, string>();
  stored.set(
    SETTINGS_KEY,
    JSON.stringify({ version: 1, llm: { provider: "together", model: "m", apiKey: "legacy" } }),
  );
  const globals = globalThis as { window?: unknown };
  globals.window = { localStorage: { getItem: (key: string) => stored.get(key) ?? null } };
  try {
    const llm = readSettings().llm;
    assert.deepEqual(llm.profiles.together, { apiKey: "legacy", model: "m" });
    assert.equal(switchProvider(switchProvider(llm, "openrouter"), "together").apiKey, "legacy");
  } finally {
    delete globals.window;
  }
});

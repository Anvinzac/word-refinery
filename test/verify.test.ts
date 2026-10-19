/**
 * Tests for the second-pass review and the editable prompts.
 *
 * Two things carry real risk. The verdict is derived rather than trusted: a
 * model that lists a blocker and still says "pass" has contradicted itself, and
 * the findings are what a reviewer acts on. And an override must never be able
 * to send an EMPTY system prompt — a blank override is treated as "no
 * override", because a request with no rules at all would silently produce
 * garbage that looks like output. Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/prompt.ts, ../src/lib/prompt-store.ts, ../src/lib/llm.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import { VERIFY_SYSTEM_PROMPT, buildVerifyPrompt, ANNOTATION_SYSTEM_PROMPT } from "../src/lib/prompt.ts";
import {
  PROMPT_DEFINITIONS,
  promptFallback,
  readPromptOverrides,
  resetPromptOverride,
  resolvePrompt,
  writePromptOverride,
} from "../src/lib/prompt-store.ts";
import { verifyWord } from "../src/lib/llm.ts";
import type { DeckWord } from "../src/lib/types.ts";

/** A minimal localStorage so the store can be exercised outside a browser. */
function installStorage(): void {
  const data = new Map<string, string>();
  (globalThis as Record<string, unknown>).window = {
    location: { origin: "https://localhost" },
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
  };
}
installStorage();

const CARD: DeckWord = {
  id: "harvest",
  word: "harvest",
  pos: "noun",
  ipa: "/x/",
  defVi: "Việc thu_gom cây trái sau một /mùa_màng/ dài.",
  leadVi: "Nông_dân chờ cả năm mới tới lúc này.",
  anticipateVi: "Mùa gì vui nhất nhỉ?",
  meaningVi: "vụ_mùa",
  topic: "nature",
  topics: ["nature"],
  exams: [],
  level: "B1",
  chars: 7,
  initial: "H",
  usage: [{ en: "The _____ was poor this year.", vi: "Vụ mùa năm nay kém." }],
  addedAt: "2026-01-01T00:00:00.000Z",
  batchId: "run-1",
};

const LLM = {
  provider: "openrouter",
  model: "m",
  apiKey: "k",
  profiles: {},
  batchSize: 5,
  maxTokens: 1024,
} as const;

const realFetch = globalThis.fetch;
function stubReply(content: string): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
    })) as typeof fetch;
}
test.afterEach(() => {
  globalThis.fetch = realFetch;
  for (const definition of PROMPT_DEFINITIONS) resetPromptOverride(definition.id);
});

// ── the review prompt ──────────────────────────────────────────────────────

test("the review prompt asks a reader's questions, not the validator's", () => {
  // Re-counting words is the deterministic checker's job; a second LLM pass
  // spent on it would be cost without signal.
  assert.match(VERIFY_SYSTEM_PROMPT, /Do NOT re-count words/);
  for (const concern of [/MEANING/, /LEAK/, /NATURALNESS/, /TEASER/, /EXAMPLE/, /EMPHASIS/]) {
    assert.match(VERIFY_SYSTEM_PROMPT, concern);
  }
  assert.match(VERIFY_SYSTEM_PROMPT, /highlight sitting on filler/);
});

test("the card is shown before the answer it hides", () => {
  const prompt = buildVerifyPrompt(CARD);
  assert.ok(
    prompt.indexOf("defVi") < prompt.indexOf('must guess is "harvest"'),
    "the Vietnamese is read first, as a learner reads it",
  );
  assert.match(prompt, /underscore joins the syllables/, "joins are explained, not mistaken for typos");
  assert.match(prompt, /between \/slashes\/ is the highlight/);
});

// ── the verdict ────────────────────────────────────────────────────────────

test("a clean reply passes", async () => {
  stubReply('{"verdict":"pass","findings":[]}');
  const report = await verifyWord(LLM, CARD);
  assert.equal(report.verdict, "pass");
  assert.deepEqual(report.findings, []);
});

test("a blocker forces revise even when the model claims pass", async () => {
  stubReply(
    '{"verdict":"pass","findings":[{"field":"defVi","severity":"blocker","problem":"Gives the answer away","suggestion":"Thu hoạch mùa."}]}',
  );
  const report = await verifyWord(LLM, CARD);
  assert.equal(report.verdict, "revise", "the findings win over a contradictory verdict");
  assert.equal(report.findings[0].severity, "blocker");
  assert.equal(report.findings[0].suggestion, "Thu hoạch mùa.");
});

test("notes alone leave the verdict at pass", async () => {
  stubReply('{"verdict":"pass","findings":[{"field":"leadVi","severity":"note","problem":"Could be livelier"}]}');
  const report = await verifyWord(LLM, CARD);
  assert.equal(report.verdict, "pass");
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].suggestion, "", "a missing suggestion is empty, not undefined");
});

test("malformed findings are dropped rather than shown as blanks", async () => {
  stubReply(
    '{"verdict":"revise","findings":[{"field":"defVi","problem":"   "},null,7,{"problem":"Real one"}]}',
  );
  const report = await verifyWord(LLM, CARD);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].problem, "Real one");
  assert.equal(report.findings[0].severity, "note", "an unknown severity falls back to the mildest");
  assert.equal(report.findings[0].field, "word");
});

test("a reply with no JSON object is an error, not an empty pass", async () => {
  stubReply("The card looks good to me!");
  await assert.rejects(() => verifyWord(LLM, CARD), /no JSON object/);
  stubReply("{not json at all}");
  await assert.rejects(() => verifyWord(LLM, CARD), /not valid JSON/);
});

test("prose around the JSON is tolerated", async () => {
  stubReply('Sure! {"verdict":"pass","findings":[]} Hope that helps.');
  assert.equal((await verifyWord(LLM, CARD)).verdict, "pass");
});

// ── editable prompts ───────────────────────────────────────────────────────

test("with no override, the shipped prompt is what gets sent", () => {
  assert.equal(resolvePrompt("annotation"), ANNOTATION_SYSTEM_PROMPT);
  assert.equal(resolvePrompt("verify"), VERIFY_SYSTEM_PROMPT);
  assert.deepEqual(readPromptOverrides(), {});
});

test("an override replaces the shipped prompt, and reset restores it", () => {
  writePromptOverride("annotation", "MY OWN RULES");
  assert.equal(resolvePrompt("annotation"), "MY OWN RULES");
  assert.equal(resolvePrompt("verify"), VERIFY_SYSTEM_PROMPT, "the other prompt is untouched");

  resetPromptOverride("annotation");
  assert.equal(resolvePrompt("annotation"), ANNOTATION_SYSTEM_PROMPT);
});

test("an empty override is never sent as the system prompt", () => {
  // An empty system prompt would produce confident nonsense that still parses,
  // which is worse than a badly worded rule.
  writePromptOverride("annotation", "   ");
  assert.equal(resolvePrompt("annotation"), ANNOTATION_SYSTEM_PROMPT);
  assert.deepEqual(readPromptOverrides(), {}, "a blank override is not even stored");
});

test("an override survives being read back, and reset is durable", () => {
  writePromptOverride("verify", "CHECK IT");
  assert.equal(readPromptOverrides().verify, "CHECK IT");
  resetPromptOverride("verify");
  assert.equal(readPromptOverrides().verify, undefined);
});

test("every definition carries a non-empty shipped text", () => {
  for (const definition of PROMPT_DEFINITIONS) {
    assert.ok(promptFallback(definition.id).length > 100, `${definition.id} has no fallback`);
    assert.ok(definition.purpose.length > 0);
  }
});

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

// ── what a failure tells the reviewer ──────────────────────────────────────

test("an LLM error carries the provider's own explanation, not just the status", async () => {
  const { describeLlmError, LlmError } = await import("../src/lib/llm.ts");
  const described = describeLlmError(
    new LlmError("openrouter responded 404 Not Found", {
      status: 404,
      provider: "openrouter",
      body: '{"error":{"message":"No endpoints found for some/retired-model"}}',
    }),
  );
  assert.match(described, /responded 404/);
  assert.match(described, /No endpoints found for some\/retired-model/, "the body is shown");
  assert.match(described, /almost always the MODEL/, "and what to do about it");
});

test("each status that has a specific fix says what it is", async () => {
  const { describeLlmError, LlmError } = await import("../src/lib/llm.ts");
  const cases: Array<[number, RegExp]> = [
    [401, /rejected the key/],
    [402, /out of credit/],
    [403, /not allowed to use this model/],
    [429, /Rate limited/],
  ];
  for (const [status, expected] of cases) {
    assert.match(describeLlmError(new LlmError("x", { status })), expected, `status ${status}`);
  }
});

test("a status with no specific fix is reported without inventing one", async () => {
  const { describeLlmError, LlmError } = await import("../src/lib/llm.ts");
  const described = describeLlmError(new LlmError("provider responded 500", { status: 500 }));
  assert.equal(described, "provider responded 500");
});

test("an ordinary error passes through unchanged", async () => {
  const { describeLlmError } = await import("../src/lib/llm.ts");
  assert.equal(describeLlmError(new Error("network down")), "network down");
  assert.equal(describeLlmError("a string"), "a string");
});

// ── putting the marks back after a rewrite ─────────────────────────────────

test("a marking pass that only adds marks is accepted", async () => {
  const { markupField } = await import("../src/lib/llm.ts");
  stubReply(JSON.stringify({ defVi: "Di_chuyển lên trên | bề_mặt dốc bằng tay." }));
  const result = await markupField(LLM, CARD, "defVi", "Di chuyển lên trên bề mặt dốc bằng tay.");
  assert.equal(result.issue, null);
  assert.equal(result.text, "Di_chuyển lên trên | bề_mặt dốc bằng tay.");
});

test("a marking pass that edited the words is discarded, keeping the rewrite", async () => {
  const { markupField } = await import("../src/lib/llm.ts");
  // One word changed under cover of marking up.
  stubReply(JSON.stringify({ defVi: "Di_chuyển lên trên | bề_mặt núi bằng tay." }));
  const original = "Di chuyển lên trên bề mặt dốc bằng tay.";
  const result = await markupField(LLM, CARD, "defVi", original);
  assert.equal(result.text, original, "the reviewer keeps their rewrite");
  assert.match(result.issue ?? "", /edited the words/);
});

test("a marking pass that produced a stray mark is discarded", async () => {
  const { markupField } = await import("../src/lib/llm.ts");
  stubReply(JSON.stringify({ defVi: "Di chuyển lên trên bề_ mặt dốc bằng tay." }));
  const original = "Di chuyển lên trên bề mặt dốc bằng tay.";
  const result = await markupField(LLM, CARD, "defVi", original);
  assert.equal(result.text, original);
  assert.match(result.issue ?? "", /stray/);
});

test("a failed marking pass never costs the reviewer their rewrite", async () => {
  const { markupField } = await import("../src/lib/llm.ts");
  const original = "Di chuyển lên trên bề mặt dốc bằng tay.";
  for (const reply of ["not json at all", JSON.stringify({ defVi: "" }), JSON.stringify({})]) {
    stubReply(reply);
    const result = await markupField(LLM, CARD, "defVi", original);
    assert.equal(result.text, original, `kept the rewrite for: ${reply}`);
    assert.ok(result.issue !== null, "and says why");
  }
});

test("an HTTP failure in the marking pass is reported, not thrown", async () => {
  const { markupField } = await import("../src/lib/llm.ts");
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  const original = "Di chuyển lên trên bề mặt dốc bằng tay.";
  const result = await markupField(LLM, CARD, "defVi", original);
  assert.equal(result.text, original);
  assert.ok(result.issue !== null);
});

test("empty text is returned untouched without a request", async () => {
  const { markupField } = await import("../src/lib/llm.ts");
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
  const result = await markupField(LLM, CARD, "leadVi", "   ");
  assert.equal(called, false, "no call is made for an empty field");
  assert.equal(result.issue, null);
});

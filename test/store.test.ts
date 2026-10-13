/**
 * Tests for deck persistence — the behaviour that decides whether a large deck
 * survives a round trip.
 *
 * Three things are covered: the stored form drops the duplicated `deck.words`
 * and rebuilds them on read; the Gist backend follows `raw_url` when GitHub
 * truncates the inlined content; and a read that finds something unparseable
 * blocks the next save instead of reporting an empty resource. fetch is
 * stubbed per test, so no network is touched. Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/store.ts, ../src/lib/types.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createStore,
  fromStoredDoc,
  parseJsonText,
  toStoredDoc,
  StoreError,
  STORED_SCHEMA_VERSION,
} from "../src/lib/store.ts";
import type { DeckWord, RefineryDoc, ReviewEntry } from "../src/lib/types.ts";

/** One deck word, enough to be carried through storage. */
function word(id: string): DeckWord {
  return {
    id,
    word: id,
    pos: "noun",
    ipa: "/test/",
    defVi: "Một thứ quen thuộc mà người ta gặp mỗi ngày.",
    leadVi: "Thứ này ở quanh ta mà ít ai để ý tới.",
    anticipateVi: `Đoán xem ${id} là gì?`,
    topic: "general",
    topics: ["general"],
    exams: [],
    level: "A1",
    chars: id.length,
    initial: id.charAt(0).toUpperCase(),
    usage: [{ en: "She saw the _____ there.", vi: "Cô ấy thấy nó ở đó." }],
    addedAt: "2026-01-01T00:00:00.000Z",
    batchId: "test-batch",
  };
}

/** A document with `count` words, in the shape the app holds in memory. */
function doc(count: number): RefineryDoc {
  const words = Array.from({ length: count }, (_, index) => word(`w${index}`));
  const review: ReviewEntry[] = words.map((deckWord) => ({
    id: deckWord.id,
    deckWord,
    status: "pending",
    warnings: [],
  }));
  return {
    schemaVersion: 1,
    deck: { meta: { name: "t" } as RefineryDoc["deck"]["meta"], words },
    review,
    savedAt: "2026-01-01T00:00:00.000Z",
  };
}

const realFetch = globalThis.fetch;

function stubFetch(implementation: (input: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = implementation as typeof fetch;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── stored form ────────────────────────────────────────────────────────────

test("a bare array of words parses like a batch with no review rows", () => {
  const doc = parseJsonText(JSON.stringify([{ word: "achieve" }, { word: "borrow" }]));
  assert.ok(doc !== null);
  assert.equal(doc.deck.words.length, 2);
  assert.equal(doc.review.length, 0);
  assert.equal(parseJsonText("[1, 2"), null);
});

test("toStoredDoc drops the deck words that review already carries", () => {
  const stored = toStoredDoc(doc(3));
  assert.equal(stored.deck.words.length, 0);
  assert.equal(stored.review.length, 3);
  assert.equal(stored.schemaVersion, STORED_SCHEMA_VERSION);
  // The meta must survive: it is the half of the deck that is NOT duplicated.
  assert.equal(stored.deck.meta.name, "t");
});

test("the stored form is materially smaller than the in-memory one", () => {
  const full = JSON.stringify(doc(200)).length;
  const stored = JSON.stringify(toStoredDoc(doc(200))).length;
  // Each word is carried once instead of twice, so the saving is close to half.
  assert.ok(stored < full * 0.6, `expected a large saving, got ${stored} vs ${full}`);
});

test("fromStoredDoc rebuilds the deck words from the review rows", () => {
  const restored = fromStoredDoc(toStoredDoc(doc(3)));
  assert.deepEqual(
    restored.deck.words.map((entry) => entry.id),
    ["w0", "w1", "w2"],
  );
  assert.deepEqual(restored.deck.words, restored.review.map((entry) => entry.deckWord));
});

test("fromStoredDoc leaves a document that already has words alone", () => {
  // A v1 document, a deck export and a WordCrawler batch all arrive this way,
  // and a batch has no review rows to rebuild from.
  const bare = { ...doc(2), review: [] as ReviewEntry[] };
  const restored = fromStoredDoc(bare);
  assert.equal(restored.deck.words.length, 2);
  assert.equal(restored.review.length, 0);
});

test("a round trip through the stored form preserves the document", () => {
  const original = doc(5);
  const restored = fromStoredDoc(JSON.parse(JSON.stringify(toStoredDoc(original))));
  assert.deepEqual(restored.review, original.review);
  assert.deepEqual(restored.deck.words, original.deck.words);
});

// ── Gist truncation ────────────────────────────────────────────────────────

test("the gist backend follows raw_url when GitHub truncates the content", async () => {
  const stored = toStoredDoc(doc(4));
  const requested: string[] = [];
  stubFetch(async (input) => {
    requested.push(input);
    if (input.includes("api.github.com")) {
      return new Response(
        JSON.stringify({
          files: {
            "word-refinery-deck.json": {
              // What GitHub does past its inline limit: a clipped body, flagged.
              content: JSON.stringify(stored).slice(0, 120),
              truncated: true,
              raw_url: "https://gist.githubusercontent.com/raw/full",
            },
          },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(stored), { status: 200 });
  });

  const store = createStore({ kind: "gist", id: "abc", token: "t" });
  const loaded = await store.load();
  assert.ok(loaded !== null);
  assert.equal(loaded.review.length, 4);
  assert.equal(loaded.deck.words.length, 4, "words are rebuilt after the raw fetch");
  assert.ok(requested.some((url) => url.includes("raw")), "the raw URL was fetched");
});

test("an untruncated gist is read without a second request", async () => {
  const stored = toStoredDoc(doc(2));
  let calls = 0;
  stubFetch(async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        files: { "word-refinery-deck.json": { content: JSON.stringify(stored), truncated: false } },
      }),
      { status: 200 },
    );
  });
  const store = createStore({ kind: "gist", id: "abc", token: "t" });
  const loaded = await store.load();
  assert.equal(loaded?.review.length, 2);
  assert.equal(calls, 1);
});

test("a truncated gist with no raw URL refuses rather than returning half a deck", async () => {
  stubFetch(async () =>
    new Response(
      JSON.stringify({
        files: { "word-refinery-deck.json": { content: "{\"deck\":", truncated: true } },
      }),
      { status: 200 },
    ),
  );
  const store = createStore({ kind: "gist", id: "abc", token: "t" });
  await assert.rejects(() => store.load(), StoreError);
});

// ── the overwrite guard ────────────────────────────────────────────────────

test("an unreadable remote throws on load instead of reporting an empty resource", async () => {
  stubFetch(async () =>
    new Response(
      JSON.stringify({
        files: { "word-refinery-deck.json": { content: '{"deck":{"meta":{},"wor' } },
      }),
      { status: 200 },
    ),
  );
  const store = createStore({ kind: "gist", id: "abc", token: "t" });
  await assert.rejects(() => store.load(), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.match(error.message, /truncated|not valid JSON/i);
    return true;
  });
  assert.ok(store.blocked !== null, "the failed read blocks the next save");
});

test("a save after an unreadable read is refused, and allowed only when forced", async () => {
  let written: string | null = null;
  stubFetch(async (_input, init) => {
    if (init?.method === "PATCH") {
      written = String(init.body);
      return new Response("{}", { status: 200 });
    }
    return new Response(
      JSON.stringify({ files: { "word-refinery-deck.json": { content: "not json at all" } } }),
      { status: 200 },
    );
  });

  const store = createStore({ kind: "gist", id: "abc", token: "t" });
  await assert.rejects(() => store.load(), StoreError);

  await assert.rejects(
    () => store.save(doc(2)),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.match(error.message, /Refusing to overwrite/);
      return true;
    },
  );
  assert.equal(written, null, "nothing was written by the refused save");

  await store.save(doc(2), { force: true });
  assert.ok(written !== null, "the forced save went through");
  assert.equal(store.blocked, null, "a deliberate write spends the block");
});

test("an empty resource is still an ordinary empty, not a block", async () => {
  stubFetch(async () =>
    new Response(JSON.stringify({ files: { "word-refinery-deck.json": { content: "" } } }), {
      status: 200,
    }),
  );
  const store = createStore({ kind: "gist", id: "abc", token: "t" });
  assert.equal(await store.load(), null);
  assert.equal(store.blocked, null);
});

test("a clean read clears a block left by an earlier failure", async () => {
  const stored = JSON.stringify(toStoredDoc(doc(1)));
  let first = true;
  stubFetch(async () => {
    const content = first ? "broken{" : stored;
    first = false;
    return new Response(
      JSON.stringify({ files: { "word-refinery-deck.json": { content } } }),
      { status: 200 },
    );
  });
  const store = createStore({ kind: "gist", id: "abc", token: "t" });
  await assert.rejects(() => store.load(), StoreError);
  assert.ok(store.blocked !== null);
  await store.load();
  assert.equal(store.blocked, null);
});

test("the gist backend writes compact JSON in the stored form", async () => {
  let body = "";
  stubFetch(async (_input, init) => {
    if (init?.method === "PATCH") {
      body = String(init.body);
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  const store = createStore({ kind: "gist", id: "abc", token: "t" });
  await store.save(doc(3));
  const content = (JSON.parse(body) as { files: Record<string, { content: string }> }).files[
    "word-refinery-deck.json"
  ].content;
  assert.ok(!content.includes("\n  "), "no pretty-printing in the stored payload");
  const parsed = JSON.parse(content) as RefineryDoc;
  assert.equal(parsed.deck.words.length, 0, "words are dropped on the wire");
  assert.equal(parsed.review.length, 3);
});

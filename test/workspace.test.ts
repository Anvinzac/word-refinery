/**
 * Tests for workspaces.
 *
 * Two decks on one device, and the whole value of the feature is that neither
 * can touch the other. What is asserted here is that separation: scoped keys
 * that never collide, an original workspace whose data stays exactly where it
 * has always been, and the one thing that is deliberately SHARED - the API key,
 * which belongs to the device rather than to a deck.
 * Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/workspace.ts, ../src/lib/settings.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ORIGINAL_WORKSPACE_ID,
  activeScope,
  addWorkspace,
  readWorkspaces,
  removeWorkspace,
  scopedKey,
  setActiveWorkspace,
  workspaceSlug,
  writeWorkspaces,
} from "../src/lib/workspace.ts";
import { SETTINGS_KEY, SHARED_KEYS_KEY, readSettings, writeSettings } from "../src/lib/settings.ts";

/** A localStorage good enough to be the device, for one test. */
function withStorage<T>(work: (store: Map<string, string>) => T): T {
  const store = new Map<string, string>();
  const globals = globalThis as { window?: unknown };
  globals.window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  };
  try {
    return work(store);
  } finally {
    delete globals.window;
  }
}

test("a device that has never heard of workspaces has exactly one", () => {
  withStorage(() => {
    const registry = readWorkspaces();
    assert.equal(registry.list.length, 1);
    assert.equal(registry.activeId, ORIGINAL_WORKSPACE_ID);
    assert.equal(registry.list[0]!.gloss, "vi");
  });
});

test("the original workspace keeps the keys its data is already under", () => {
  withStorage(() => {
    // The deck of a reviewer who has been using this app for months lives under
    // the unscoped key. Scoping it on upgrade would be a migration whose only
    // outcomes are "no change" and "lost the deck".
    assert.equal(activeScope(), ORIGINAL_WORKSPACE_ID);
    assert.equal(scopedKey("word-refinery.prompts"), "word-refinery.prompts");
  });
});

test("a second workspace stores nothing where the first stores it", () => {
  withStorage(() => {
    const { workspace } = addWorkspace({ label: "English → Japanese", gloss: "ja" });
    assert.equal(activeScope(), workspace.id);
    for (const base of ["word-refinery.prompts", "word-refinery.settings", "current"]) {
      assert.notEqual(scopedKey(base, workspace.id), scopedKey(base, ORIGINAL_WORKSPACE_ID));
    }
  });
});

test("a new workspace never lands on the original's scope", () => {
  // "current" is not a reserved word a reviewer would think to avoid, and a
  // workspace that took it would open the old deck under a new name.
  assert.notEqual(workspaceSlug("current", []), ORIGINAL_WORKSPACE_ID);
  assert.notEqual(workspaceSlug("Current!", []), ORIGINAL_WORKSPACE_ID);
});

test("two workspaces named the same get different scopes", () => {
  const first = workspaceSlug("Japanese deck", []);
  const second = workspaceSlug("Japanese deck", [first]);
  assert.notEqual(first, second);
  assert.equal(workspaceSlug("Tiếng Nhật", []), "tieng-nhat", "diacritics fold rather than vanish");
});

test("an active id pointing at a workspace that is gone falls back, it does not strand", () => {
  withStorage((store) => {
    store.set(
      "word-refinery.workspaces",
      JSON.stringify({ version: 1, activeId: "deleted-elsewhere", list: [] }),
    );
    const registry = readWorkspaces();
    assert.equal(registry.activeId, ORIGINAL_WORKSPACE_ID);
    assert.equal(registry.list.length, 1, "the original is always present");
  });
});

test("forgetting a workspace removes the entry, not the deck", () => {
  withStorage((store) => {
    const { workspace } = addWorkspace({ label: "Japanese", gloss: "ja" });
    // Something the workspace owned, written where its scope says.
    store.set(scopedKey(SETTINGS_KEY, workspace.id), JSON.stringify({ version: 1 }));
    const registry = removeWorkspace(workspace.id);
    assert.ok(!registry.list.some((entry) => entry.id === workspace.id));
    assert.equal(registry.activeId, ORIGINAL_WORKSPACE_ID, "it does not leave a dead workspace open");
    assert.ok(
      store.has(scopedKey(SETTINGS_KEY, workspace.id)),
      "tidying the switcher must not be a way to destroy a deck",
    );
  });
});

test("the original workspace cannot be forgotten", () => {
  withStorage(() => {
    addWorkspace({ label: "Japanese", gloss: "ja" });
    const registry = removeWorkspace(ORIGINAL_WORKSPACE_ID);
    assert.ok(registry.list.some((entry) => entry.id === ORIGINAL_WORKSPACE_ID));
  });
});

test("an API key entered in one workspace is already there in the next", () => {
  withStorage(() => {
    const base = readSettings();
    writeSettings({
      ...base,
      llm: { ...base.llm, provider: "openrouter", apiKey: "sk-device", model: "model-a" },
    });
    const { workspace } = addWorkspace({ label: "Japanese", gloss: "ja" });
    assert.equal(activeScope(), workspace.id);
    const fresh = readSettings();
    assert.equal(fresh.llm.apiKey, "sk-device", "the key belongs to the device");
    assert.notEqual(fresh.llm.model, "model-a", "the model belongs to the deck");
  });
});

test("the key is written once, not copied into every workspace", () => {
  withStorage((store) => {
    const base = readSettings();
    writeSettings({ ...base, llm: { ...base.llm, apiKey: "sk-secret" } });
    const payload = store.get(scopedKey(SETTINGS_KEY)) ?? "";
    assert.ok(!payload.includes("sk-secret"), "a key is never in the per-workspace payload");
    assert.ok((store.get(SHARED_KEYS_KEY) ?? "").includes("sk-secret"));
  });
});

test("clearing the key clears it for the device, not just this workspace", () => {
  withStorage(() => {
    const base = readSettings();
    writeSettings({ ...base, llm: { ...base.llm, apiKey: "sk-secret" } });
    const held = readSettings();
    assert.equal(held.llm.apiKey, "sk-secret");
    writeSettings({ ...held, llm: { ...held.llm, apiKey: "" } });
    assert.equal(readSettings().llm.apiKey, "", "an emptied field is a deliberate clearing");
    setActiveWorkspace(ORIGINAL_WORKSPACE_ID);
    assert.equal(readSettings().llm.apiKey, "");
  });
});

test("the remote store is per workspace, so two decks cannot save over each other", () => {
  withStorage(() => {
    const base = readSettings();
    writeSettings({ ...base, store: { kind: "gist", id: "vi-gist", token: "t" } });
    const { workspace } = addWorkspace({ label: "Japanese", gloss: "ja" });
    assert.equal(readSettings().store.id, "", `${workspace.id} starts with no store of its own`);
    setActiveWorkspace(ORIGINAL_WORKSPACE_ID);
    assert.equal(readSettings().store.id, "vi-gist");
  });
});

test("a registry that cannot be parsed still opens the original deck", () => {
  withStorage((store) => {
    store.set("word-refinery.workspaces", "{ not json");
    assert.equal(activeScope(), ORIGINAL_WORKSPACE_ID);
  });
});

test("a workspace record missing its language is discarded rather than guessed", () => {
  withStorage(() => {
    writeWorkspaces({
      version: 1,
      activeId: "half-written",
      // A record with no gloss language cannot drive a prompt, so it is not a
      // workspace. Keeping it would mean generating in a language nobody chose.
      list: [{ id: "half-written", label: "?", createdAt: "" } as never],
    });
    const registry = readWorkspaces();
    assert.ok(!registry.list.some((entry) => entry.id === "half-written"));
    assert.equal(registry.activeId, ORIGINAL_WORKSPACE_ID);
  });
});

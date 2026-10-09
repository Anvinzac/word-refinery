/**
 * Pluggable deck storage.
 *
 * GitHub Pages has no server, so persistence is delegated to a tiny JSON HTTP
 * store the user configures in Settings. Three backends ship:
 *
 *   jsonbin - a single "bin" holding the whole document, keyed by an
 *             X-Master-Key or X-Access-Key. Chosen for its simple REST shape.
 *   gist    - a secret GitHub Gist used as the document. Verified reachable and
 *             the most durable option, since it lives in the user's own account.
 *   none    - local file download/upload only. Always works, zero infrastructure.
 *
 * Every backend implements the same four operations, so the UI never branches
 * on provider. Writes are whole-document (the deck is small) and the document
 * carries `schemaVersion` so a future reader can migrate it.
 *
 * Exports: StoreError, DeckStore, createStore, downloadJson, readJsonFile
 * Depends on: ./types.ts, ./settings.ts
 */
import type { RefineryDoc } from "./types.ts";
import type { Settings } from "./settings.ts";

/** Error with the HTTP status attached so the UI can hint at the cause. */
export class StoreError extends Error {
  readonly status: number | null;
  readonly body: string;

  constructor(message: string, options: { status?: number | null; body?: string } = {}) {
    super(message);
    this.name = "StoreError";
    this.status = options.status ?? null;
    this.body = options.body ?? "";
  }
}

/** The four operations every backend must provide. */
export interface DeckStore {
  /** Human-readable backend name for the status bar. */
  readonly label: string;
  /** True when the backend is ready to read/write. */
  readonly ready: boolean;
  /** What the user still has to configure, or null when ready. */
  readonly missing: string | null;
  /** Load the document, or null when nothing has been saved yet. */
  load(): Promise<RefineryDoc | null>;
  /** Persist the document. May create the resource on first write. */
  save(document: RefineryDoc): Promise<{ id: string }>;
}

/** Filename used inside a Gist and for local downloads. */
export const DOC_FILENAME = "word-refinery-deck.json";

/** Build the store the current settings ask for. */
export function createStore(store: Settings["store"]): DeckStore {
  switch (store.kind) {
    case "jsonbin":
      return new JsonBinStore(store.id, store.token);
    case "gist":
      return new GistStore(store.id, store.token);
    default:
      return new LocalOnlyStore();
  }
}

/** Shared response handling: non-2xx becomes a StoreError with the body tail. */
async function expectOk(response: Response, label: string): Promise<string> {
  const text = await response.text();
  if (!response.ok) {
    throw new StoreError(`${label} failed: ${response.status} ${response.statusText}`.trim(), {
      status: response.status,
      body: text.slice(0, 500),
    });
  }
  return text;
}

/** Parse a stored payload, tolerating both a bare document and a wrapper. */
function parseDoc(text: string): RefineryDoc | null {
  if (text.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Partial<RefineryDoc>;
    if (candidate.deck === undefined || !Array.isArray(candidate.review)) return null;
    return parsed as RefineryDoc;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// jsonbin.io
// ---------------------------------------------------------------------------

/**
 * jsonbin.io v3 backend.
 *
 * With a bin id configured it reads and updates that bin. Without one, the
 * first save creates a bin and reports the new id back so the UI can store it.
 */
class JsonBinStore implements DeckStore {
  readonly label = "jsonbin.io";
  private binId: string;
  private token: string;

  constructor(binId: string, token: string) {
    this.binId = binId.trim();
    this.token = token.trim();
  }

  get ready(): boolean {
    return this.token.length > 0;
  }

  get missing(): string | null {
    if (this.token.length === 0) return "a jsonbin.io API key (X-Master-Key)";
    return null;
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", "X-Master-Key": this.token };
  }

  async load(): Promise<RefineryDoc | null> {
    if (!this.ready) throw new StoreError(`jsonbin.io is not configured: ${this.missing}`);
    if (this.binId.length === 0) return null;
    const response = await fetch(`https://api.jsonbin.io/v3/bins/${this.binId}/latest`, {
      headers: this.headers(),
    });
    const text = await expectOk(response, "jsonbin read");
    const envelope = JSON.parse(text) as { record?: unknown };
    return parseDoc(JSON.stringify(envelope.record ?? null));
  }

  async save(document: RefineryDoc): Promise<{ id: string }> {
    if (!this.ready) throw new StoreError(`jsonbin.io is not configured: ${this.missing}`);
    const body = JSON.stringify(document);
    if (this.binId.length === 0) {
      const response = await fetch("https://api.jsonbin.io/v3/bins", {
        method: "POST",
        headers: this.headers(),
        body,
      });
      const text = await expectOk(response, "jsonbin create");
      const created = JSON.parse(text) as { metadata?: { id?: string } };
      const id = created.metadata?.id;
      if (typeof id !== "string" || id.length === 0) {
        throw new StoreError("jsonbin created a bin but returned no id", { body: text.slice(0, 300) });
      }
      this.binId = id;
      return { id };
    }
    const response = await fetch(`https://api.jsonbin.io/v3/bins/${this.binId}`, {
      method: "PUT",
      headers: this.headers(),
      body,
    });
    await expectOk(response, "jsonbin update");
    return { id: this.binId };
  }
}

// ---------------------------------------------------------------------------
// GitHub Gist
// ---------------------------------------------------------------------------

/**
 * GitHub Gist backend. The document is stored as one file inside a Gist.
 * A fine-grained PAT with the `gists` scope is enough; the Gist should be
 * created secret so the deck is not publicly indexed.
 */
class GistStore implements DeckStore {
  readonly label = "GitHub Gist";
  private gistId: string;
  private token: string;

  constructor(gistId: string, token: string) {
    this.gistId = gistId.trim();
    this.token = token.trim();
  }

  get ready(): boolean {
    return this.token.length > 0;
  }

  get missing(): string | null {
    if (this.token.length === 0) return "a GitHub token with the gists scope";
    return null;
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async load(): Promise<RefineryDoc | null> {
    if (!this.ready) throw new StoreError(`GitHub Gist is not configured: ${this.missing}`);
    if (this.gistId.length === 0) return null;
    const response = await fetch(`https://api.github.com/gists/${this.gistId}`, {
      headers: this.headers(),
    });
    if (response.status === 404) return null;
    const text = await expectOk(response, "gist read");
    const gist = JSON.parse(text) as { files?: Record<string, { content?: string } | undefined> };
    const file = gist.files?.[DOC_FILENAME] ?? Object.values(gist.files ?? {})[0];
    if (file?.content === undefined) return null;
    return parseDoc(file.content);
  }

  async save(document: RefineryDoc): Promise<{ id: string }> {
    if (!this.ready) throw new StoreError(`GitHub Gist is not configured: ${this.missing}`);
    const content = JSON.stringify(document, null, 2);
    if (this.gistId.length === 0) {
      const response = await fetch("https://api.github.com/gists", {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          description: "Word Refinery vocabulary deck",
          public: false,
          files: { [DOC_FILENAME]: { content } },
        }),
      });
      const text = await expectOk(response, "gist create");
      const created = JSON.parse(text) as { id?: string };
      if (typeof created.id !== "string" || created.id.length === 0) {
        throw new StoreError("GitHub created a gist but returned no id", { body: text.slice(0, 300) });
      }
      this.gistId = created.id;
      return { id: created.id };
    }
    const response = await fetch(`https://api.github.com/gists/${this.gistId}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ files: { [DOC_FILENAME]: { content } } }),
    });
    await expectOk(response, "gist update");
    return { id: this.gistId };
  }
}

// ---------------------------------------------------------------------------
// Local only
// ---------------------------------------------------------------------------

/** No remote backend: the UI falls back to download/upload. */
class LocalOnlyStore implements DeckStore {
  readonly label = "local file";
  get ready(): boolean {
    return false;
  }
  get missing(): string | null {
    return "a jsonbin.io key or a GitHub Gist token (or use download / upload)";
  }
  async load(): Promise<RefineryDoc | null> {
    return null;
  }
  async save(): Promise<{ id: string }> {
    throw new StoreError(
      "No remote store configured. Use Download to save a file, or set one up in Settings.",
    );
  }
}

// ---------------------------------------------------------------------------
// Local file helpers
// ---------------------------------------------------------------------------

/** Trigger a browser download of the document as pretty-printed JSON. */
export function downloadJson(document: RefineryDoc, filename = DOC_FILENAME): void {
  const blob = new Blob([JSON.stringify(document, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = globalThis.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  globalThis.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Read a user-picked JSON file into a document, or null when it is not one. */
export async function readJsonFile(file: File): Promise<RefineryDoc | null> {
  const text = await file.text();
  const parsed = parseDoc(text);
  if (parsed !== null) return parsed;
  // Tolerate a bare deck export or WordCrawler batch (meta + words) by wrapping
  // it. `meta` is optional: a batch may carry only a name, or none at all.
  try {
    const bare = JSON.parse(text) as { meta?: unknown; words?: unknown };
    if (Array.isArray(bare.words)) {
      const meta =
        typeof bare.meta === "object" && bare.meta !== null
          ? (bare.meta as Record<string, unknown>)
          : {};
      return {
        schemaVersion: 1,
        deck: { meta, words: bare.words } as RefineryDoc["deck"],
        review: [],
        savedAt: new Date().toISOString(),
      };
    }
  } catch {
    // not JSON at all
  }
  return null;
}

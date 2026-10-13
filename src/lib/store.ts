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
 * on provider. Writes are whole-document and the document carries
 * `schemaVersion` so a future reader can migrate it.
 *
 * Two things keep a large deck safe. The stored form drops `deck.words`, which
 * is pure duplication of `review[].deckWord` and roughly halves the payload —
 * at 1000 words the old form was 1.3 MB, past the size at which GitHub
 * truncates a Gist file on read. And a read that finds something it cannot
 * parse now throws instead of reporting "empty", so the UI can refuse to
 * overwrite a deck it failed to load.
 *
 * Exports: StoreError, DeckStore, SaveOptions, createStore, downloadJson,
 *          readJsonFile, toStoredDoc, fromStoredDoc, STORED_SCHEMA_VERSION
 * Depends on: ./types.ts, ./settings.ts
 */
import type { RefineryDoc } from "./types.ts";
import { migrateDeckWord } from "./deck.ts";
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

/** Extra instructions for one save. */
export interface SaveOptions {
  /**
   * Overwrite even though the last read of this resource could not be parsed.
   * Only ever set from an explicit confirmation: the unreadable remote may
   * still hold the only full copy of the deck.
   */
  force?: boolean;
}

/** The operations every backend must provide. */
export interface DeckStore {
  /** Human-readable backend name for the status bar. */
  readonly label: string;
  /** True when the backend is ready to read/write. */
  readonly ready: boolean;
  /** What the user still has to configure, or null when ready. */
  readonly missing: string | null;
  /**
   * Why an unforced save is currently refused, or null when saving is safe.
   * Set when a read found a resource it could not parse.
   */
  readonly blocked: string | null;
  /**
   * Load the document, or null when nothing has been saved yet.
   * @throws StoreError when the resource exists but cannot be read
   */
  load(): Promise<RefineryDoc | null>;
  /** Persist the document. May create the resource on first write. */
  save(document: RefineryDoc, options?: SaveOptions): Promise<{ id: string }>;
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

/** Schema version written by this build. v2 omits the duplicated `deck.words`. */
export const STORED_SCHEMA_VERSION = 2;

/**
 * Shrink a document for storage.
 *
 * Every deck word is already carried by its review row, so `deck.words` is an
 * exact duplicate. Dropping it halves the payload, which is what keeps a
 * 1000-word deck well under the size at which GitHub truncates a Gist file.
 *
 * @param document - the in-memory document
 * @returns the same document with its deck words omitted
 */
export function toStoredDoc(document: RefineryDoc): RefineryDoc {
  return {
    ...document,
    schemaVersion: STORED_SCHEMA_VERSION as RefineryDoc["schemaVersion"],
    deck: { ...document.deck, words: [] },
  };
}

/**
 * Restore `deck.words` after reading a stored document.
 *
 * Only a document that actually lacks words is rebuilt, so a v1 document, a
 * bare deck export and a WordCrawler batch — none of which have review rows to
 * rebuild from — all keep the words they came with.
 *
 * @param document - a document straight from storage or a file
 * @returns the document with its deck words present
 */
export function fromStoredDoc(document: RefineryDoc): RefineryDoc {
  // Every word is brought up to the current shape here, because this is the one
  // place every read passes through: remote load, file upload and local mirror.
  // A document saved before the topics/exams axes existed would otherwise reach
  // the app with `topics` undefined.
  const review = document.review.map((entry) => ({
    ...entry,
    deckWord: migrateDeckWord(entry.deckWord),
  }));
  const stored = document.deck?.words;
  const words =
    Array.isArray(stored) && stored.length > 0
      ? stored.map(migrateDeckWord)
      : review.map((entry) => entry.deckWord);
  return { ...document, deck: { ...document.deck, words }, review };
}

/** Whether a parsed value has the two fields that make it a refinery document. */
function looksLikeDoc(parsed: unknown): parsed is RefineryDoc {
  if (typeof parsed !== "object" || parsed === null) return false;
  const candidate = parsed as Partial<RefineryDoc>;
  return candidate.deck !== undefined && Array.isArray(candidate.review);
}

/**
 * Parse a payload read from a remote store.
 *
 * An empty resource is a legitimate "nothing saved yet" and returns null.
 * Anything else that fails to parse THROWS rather than returning null: the
 * resource holds something, and reporting that as "empty" is what previously
 * invited the reviewer to overwrite a deck that was merely unreadable.
 *
 * @param text - the raw payload
 * @param label - backend name, for the error message
 * @throws StoreError when the resource is present but unreadable
 */
function parseRemoteDoc(text: string, label: string): RefineryDoc | null {
  if (text.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StoreError(
      `${label} returned something that is not valid JSON. The stored deck may be truncated — ` +
        "do not save over it until you have a copy.",
      { body: text.slice(0, 300) },
    );
  }
  if (parsed === null) return null;
  if (!looksLikeDoc(parsed)) {
    throw new StoreError(
      `${label} holds JSON that is not a refinery document. Do not save over it until you have ` +
        "checked what is there.",
      { body: JSON.stringify(parsed).slice(0, 300) },
    );
  }
  return fromStoredDoc(parsed);
}

/** Parse a payload from a user-picked file, where "not one" is an ordinary answer. */
function parseDoc(text: string): RefineryDoc | null {
  if (text.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!looksLikeDoc(parsed)) return null;
    return fromStoredDoc(parsed);
  } catch {
    return null;
  }
}

/**
 * Bookkeeping shared by the remote backends: remembering that a read found
 * something it could not parse, so the next save refuses instead of destroying
 * it. The flag lives on the store instance, which the UI keeps for as long as
 * the backend settings are unchanged.
 */
abstract class GuardedStore {
  /** Why saving is refused, or null. Set by a failed read, cleared by a clean one. */
  protected blockedReason: string | null = null;

  get blocked(): string | null {
    return this.blockedReason;
  }

  /** Parse a payload, recording a parse failure as a save block before rethrowing. */
  protected parse(text: string, label: string): RefineryDoc | null {
    try {
      const document = parseRemoteDoc(text, label);
      this.blockedReason = null;
      return document;
    } catch (error) {
      if (error instanceof StoreError) this.blockedReason = error.message;
      throw error;
    }
  }

  /**
   * Refuse a save that would overwrite a resource whose contents could not be
   * read, unless the caller has explicitly confirmed it.
   */
  protected guard(options: SaveOptions | undefined, label: string): void {
    if (this.blockedReason === null) return;
    if (options?.force === true) return;
    throw new StoreError(
      `Refusing to overwrite ${label}. The last read of it failed, so it may still hold the only ` +
        `full copy of the deck — download a backup first, then confirm the overwrite. (${this.blockedReason})`,
    );
  }

  /** A deliberate write replaces whatever was unreadable, so the block is spent. */
  protected clearBlock(): void {
    this.blockedReason = null;
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
class JsonBinStore extends GuardedStore implements DeckStore {
  readonly label = "jsonbin.io";
  private binId: string;
  private token: string;

  constructor(binId: string, token: string) {
    super();
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
    return this.parse(JSON.stringify(envelope.record ?? null), this.label);
  }

  async save(document: RefineryDoc, options?: SaveOptions): Promise<{ id: string }> {
    if (!this.ready) throw new StoreError(`jsonbin.io is not configured: ${this.missing}`);
    this.guard(options, `the ${this.label} bin`);
    const body = JSON.stringify(toStoredDoc(document));
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
      this.clearBlock();
      return { id };
    }
    const response = await fetch(`https://api.jsonbin.io/v3/bins/${this.binId}`, {
      method: "PUT",
      headers: this.headers(),
      body,
    });
    await expectOk(response, "jsonbin update");
    this.clearBlock();
    return { id: this.binId };
  }
}

// ---------------------------------------------------------------------------
// GitHub Gist
// ---------------------------------------------------------------------------

/** The parts of a Gist file entry this backend reads. */
interface GistFile {
  content?: string;
  truncated?: boolean;
  raw_url?: string;
}

/**
 * GitHub Gist backend. The document is stored as one file inside a Gist.
 * A fine-grained PAT with the `gists` scope is enough; the Gist should be
 * created secret so the deck is not publicly indexed.
 */
class GistStore extends GuardedStore implements DeckStore {
  readonly label = "GitHub Gist";
  private gistId: string;
  private token: string;

  constructor(gistId: string, token: string) {
    super();
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
    const gist = JSON.parse(text) as {
      files?: Record<string, GistFile | undefined>;
    };
    const file = gist.files?.[DOC_FILENAME] ?? Object.values(gist.files ?? {})[0];
    if (file === undefined) return null;
    // GitHub inlines at most 1 MB of a file and sets `truncated`; past that the
    // full text is only at `raw_url`. Reading `content` regardless is what made
    // a large deck come back as unparseable JSON and be reported as "empty".
    const content = file.truncated === true ? await this.readRaw(file) : file.content;
    if (content === undefined) return null;
    return this.parse(content, this.label);
  }

  /**
   * Fetch a truncated file's full text from its raw URL.
   * The URL is unguessable and already carries its own authorisation, so it is
   * requested WITHOUT the API token — githubusercontent rejects that header.
   */
  private async readRaw(file: GistFile): Promise<string | undefined> {
    if (typeof file.raw_url !== "string" || file.raw_url.length === 0) {
      throw new StoreError(
        "The stored deck is larger than GitHub will inline, and the gist gave no raw URL to " +
          "fetch the rest from. Do not save over it until you have a copy.",
      );
    }
    const response = await fetch(file.raw_url);
    return expectOk(response, "gist raw read");
  }

  async save(document: RefineryDoc, options?: SaveOptions): Promise<{ id: string }> {
    if (!this.ready) throw new StoreError(`GitHub Gist is not configured: ${this.missing}`);
    this.guard(options, `gist ${this.gistId || "(new)"}`);
    // Compact, not pretty-printed: indentation added ~40% to the payload for a
    // file no human reads in place. Use Download for a readable copy.
    const content = JSON.stringify(toStoredDoc(document));
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
      this.clearBlock();
      return { id: created.id };
    }
    const response = await fetch(`https://api.github.com/gists/${this.gistId}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ files: { [DOC_FILENAME]: { content } } }),
    });
    await expectOk(response, "gist update");
    this.clearBlock();
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
  /** Nothing is ever read, so nothing can be at risk of being overwritten. */
  get blocked(): string | null {
    return null;
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

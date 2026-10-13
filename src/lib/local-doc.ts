/**
 * Local mirror of the working document.
 *
 * The remote store is explicit — the reviewer decides when to Save — which left
 * a refresh, a crash or a closed tab destroying everything generated since the
 * last push. This mirror closes that window: every change is written to
 * IndexedDB a moment later, and the next page load restores it.
 *
 * IndexedDB rather than localStorage because the document is large (a
 * 1000-word deck is roughly a megabyte of JSON, close to the 5 MB localStorage
 * ceiling) and because localStorage writes block the main thread.
 *
 * The mirror is a safety net, never the source of truth: it is per-browser,
 * survives nothing but this origin, and the remote store is still what makes
 * the deck portable.
 *
 * Exports: MirroredDoc, saveLocalDoc, loadLocalDoc, clearLocalDoc, localMirrorAvailable,
 *          saveLocalCorpus, loadLocalCorpus, clearLocalCorpus
 * Depends on: ./types.ts, ./store.ts
 */
import type { Corpus, RefineryDoc } from "./types.ts";
import { fromStoredDoc } from "./store.ts";

const DB_NAME = "word-refinery";
/** v2 adds the corpus store beside the working document. */
const DB_VERSION = 2;
const STORE_NAME = "working-doc";
/** Imported corpus, kept in the same database so one upgrade covers both. */
const CORPUS_STORE = "corpus";
/** One document per browser, so a fixed key is enough. */
const DOC_KEY = "current";

/** A document read back from the mirror, with the bookkeeping it was stored with. */
export interface MirroredDoc {
  doc: RefineryDoc;
  /** When the mirror was written, ISO 8601. */
  mirroredAt: string;
  /** Whether the document still had changes the remote store had not seen. */
  dirty: boolean;
}

/** Shape actually written to IndexedDB. */
interface MirrorRecord extends MirroredDoc {
  key: string;
}

/** True when this browser can mirror at all (private modes may refuse). */
export function localMirrorAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

/** Open the database, creating the object store on first use. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Both stores are created on any upgrade path, so a browser arriving from
      // v1 gains the corpus store without losing the document already mirrored.
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(CORPUS_STORE)) {
        db.createObjectStore(CORPUS_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB refused to open"));
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
  });
}

/** Run one transaction and resolve when it commits, not merely when it is queued. */
function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
  storeName: string = STORE_NAME,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = work(transaction.objectStore(storeName));
        let result: T;
        request.onsuccess = () => {
          result = request.result;
        };
        // Resolving on `complete` rather than on the request means a write is
        // only reported as saved once it is actually durable.
        transaction.oncomplete = () => {
          db.close();
          resolve(result);
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error ?? new Error("IndexedDB transaction failed"));
        };
        transaction.onabort = () => {
          db.close();
          reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
        };
      }),
  );
}

/**
 * Write the working document to the mirror, replacing whatever was there.
 *
 * @param document - the document as it stands
 * @param dirty - whether it still holds changes the remote store has not seen
 */
export async function saveLocalDoc(document: RefineryDoc, dirty: boolean): Promise<void> {
  if (!localMirrorAvailable()) return;
  const record: MirrorRecord = {
    key: DOC_KEY,
    doc: document,
    mirroredAt: new Date().toISOString(),
    dirty,
  };
  await withStore("readwrite", (store) => store.put(record));
}

/**
 * Read the mirrored document back.
 * @returns the mirror, or null when this browser has none
 */
export async function loadLocalDoc(): Promise<MirroredDoc | null> {
  if (!localMirrorAvailable()) return null;
  const record = await withStore<MirrorRecord | undefined>("readonly", (store) =>
    store.get(DOC_KEY),
  );
  if (record === undefined || record.doc === undefined) return null;
  // A mirror written by an older build carries older words, so it is migrated
  // on the way out exactly as a remote document is.
  return { doc: fromStoredDoc(record.doc), mirroredAt: record.mirroredAt, dirty: record.dirty };
}

/** Drop the mirror — used when the reviewer deliberately starts over. */
export async function clearLocalDoc(): Promise<void> {
  if (!localMirrorAvailable()) return;
  await withStore("readwrite", (store) => store.delete(DOC_KEY));
}

/**
 * Persist an imported corpus so it outlives the tab that loaded it.
 *
 * The corpus is the one piece of state a reviewer should never have to supply
 * twice: it is a file they went and downloaded, and losing it on refresh would
 * send them back to the 381-word bundle without saying why.
 *
 * @param corpus - the corpus to make active
 */
export async function saveLocalCorpus(corpus: Corpus): Promise<void> {
  if (!localMirrorAvailable()) return;
  await withStore(
    "readwrite",
    (store) => store.put({ key: DOC_KEY, corpus, importedAt: new Date().toISOString() }),
    CORPUS_STORE,
  );
}

/**
 * Read the imported corpus back.
 * @returns the corpus and when it was imported, or null when none was ever loaded
 */
export async function loadLocalCorpus(): Promise<{ corpus: Corpus; importedAt: string } | null> {
  if (!localMirrorAvailable()) return null;
  const record = await withStore<{ corpus?: Corpus; importedAt?: string } | undefined>(
    "readonly",
    (store) => store.get(DOC_KEY),
    CORPUS_STORE,
  );
  if (record?.corpus === undefined) return null;
  return { corpus: record.corpus, importedAt: record.importedAt ?? "" };
}

/** Drop the imported corpus, returning the app to the bundled subset. */
export async function clearLocalCorpus(): Promise<void> {
  if (!localMirrorAvailable()) return;
  await withStore("readwrite", (store) => store.delete(DOC_KEY), CORPUS_STORE);
}

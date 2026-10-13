/**
 * Word Refinery — application shell.
 *
 * Owns three pieces of state: settings (localStorage), the working document
 * (deck + per-word review rows), and the active tab. Pushing to the REMOTE
 * store stays explicit — the reviewer decides when to Save, so a half-edited
 * batch is never silently published. Locally the document is mirrored to
 * IndexedDB a moment after every change and restored on the next load, so a
 * refresh or a crash no longer costs everything since the last push.
 *
 * Exports: App
 * Depends on: ./lib/*, ./components/*
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GeneratePanel } from "./components/GeneratePanel";
import { Library } from "./components/Library";
import { CoveragePanel } from "./components/CoveragePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { loadCorpus, setActiveCorpus } from "./lib/corpus";
import { approvedEntries } from "./lib/deck";
import { buildDeck, coerceDeckWord, validateDeck } from "./lib/deck";
import {
  DOC_FILENAME,
  createStore,
  downloadJson,
  parseJsonText,
  readJsonFile,
  StoreError,
} from "./lib/store";
import {
  loadLocalCorpus,
  loadLocalDoc,
  localMirrorAvailable,
  saveLocalDoc,
} from "./lib/local-doc";
import { CorpusPanel } from "./components/CorpusPanel";
import { PromptsPanel } from "./components/PromptsPanel";
import { EMPTY_FILTER, type LibraryFilter } from "./lib/library";
import { readSettings, writeSettings, type Settings } from "./lib/settings";
import type { CefrLevel, Deck, RefineryDoc, ReviewEntry } from "./lib/types";

/** Tabs in the workspace. */
type Tab = "generate" | "review" | "coverage" | "sync" | "prompts" | "settings";

/** An empty working document, used before anything is generated or loaded. */
function emptyDoc(settings: Settings): RefineryDoc {
  const corpus = loadCorpus();
  return {
    schemaVersion: 1,
    deck: buildDeck({
      name: settings.generation.deckName,
      version: settings.generation.deckVersion,
      words: [],
      model: settings.llm.model,
      corpusName: corpus.meta.name ?? "bundled corpus",
      corpusLicense: corpus.meta.license ?? "unknown",
    }),
    review: [],
    savedAt: new Date().toISOString(),
  };
}

/** Bundled with the site; loaded when a browser has no words of its own yet. */
const DEFAULT_DECK_URL = `${import.meta.env.BASE_URL}default-deck.json`;

/** Review rows for a parsed file: its own rows, or every word queued as pending. */
function reviewEntriesFrom(parsed: RefineryDoc): ReviewEntry[] {
  // A working document already carries its own review state.
  if (parsed.review.length > 0) return parsed.review;
  // A bare deck or WordCrawler batch has no review rows. Normalise each word
  // into deck shape (topics array, missing chars/initial, …) and queue it as
  // pending so it lands in the Review table ready to be refined.
  const usedIds = new Set<string>();
  // One batch identity for the whole import, so these words stay findable
  // together later — the same bookkeeping a generation run stamps on.
  const addedAt = new Date().toISOString();
  const batchId = `import-${addedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  const review: ReviewEntry[] = [];
  for (const raw of parsed.deck.words) {
    const deckWord = coerceDeckWord(raw, usedIds, { batchId, addedAt });
    if (deckWord === null) continue;
    review.push({ id: deckWord.id, deckWord, status: "pending", warnings: [] });
  }
  return review;
}

export function App() {
  const [settings, setSettings] = useState<Settings>(() => readSettings());
  const [doc, setDoc] = useState<RefineryDoc>(() => emptyDoc(readSettings()));
  const [tab, setTab] = useState<Tab>("generate");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error" | "warn"; text: string } | null>(null);
  const [levels, setLevels] = useState<CefrLevel[]>([]);
  const [dirty, setDirty] = useState(false);
  // Gates the local mirror: nothing is written until the restore has run, so an
  // empty initial document cannot overwrite the mirror it is about to load.
  const [hydrated, setHydrated] = useState(false);
  // Set when a save was refused because the remote holds something unreadable.
  // Clearing it is an explicit act, which is the whole point of the guard.
  const [overwriteBlocked, setOverwriteBlocked] = useState(false);
  // The active corpus lives in a module rather than in state, so swapping it has
  // to be announced: this counter is what re-renders the panels that read it.
  const [corpusEpoch, setCorpusEpoch] = useState(0);
  // The library filter lives here so the coverage matrix can hand one over and
  // switch tabs, which is what makes a thin cell actionable in one click.
  const [filter, setFilter] = useState<LibraryFilter>(EMPTY_FILTER);
  const fileInput = useRef<HTMLInputElement>(null);

  const store = useMemo(() => createStore(settings.store), [settings.store]);

  /** Persist settings whenever they change. */
  useEffect(() => {
    writeSettings(settings);
  }, [settings]);

  /** Install the imported corpus, if this browser holds one, before anything reads it. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await loadLocalCorpus();
        if (!cancelled && stored !== null) {
          setActiveCorpus(stored.corpus);
          setCorpusEpoch((epoch) => epoch + 1);
        }
      } catch {
        // A browser without IndexedDB simply runs on the bundled subset.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Restore the local mirror once, before the autosave below is allowed to run.
   * A browser that refuses IndexedDB simply starts empty — the mirror is a
   * safety net, never a prerequisite.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mirror = await loadLocalDoc();
        if (!cancelled && mirror !== null && mirror.doc.review.length > 0) {
          setDoc(mirror.doc);
          setDirty(mirror.dirty);
          setNotice({
            kind: "ok",
            text:
              `Restored ${mirror.doc.review.length} word(s) from this browser ` +
              `(mirrored ${new Date(mirror.mirroredAt).toLocaleString()}).` +
              (mirror.dirty ? " They were never pushed to the remote store." : ""),
          });
          return;
        }
      } catch {
        // An unreadable mirror must not stop the app from opening.
      }
      try {
        const response = await fetch(DEFAULT_DECK_URL, { cache: "no-store" });
        const parsed = response.ok ? parseJsonText(await response.text()) : null;
        const review = parsed === null ? [] : reviewEntriesFrom(parsed);
        if (!cancelled && review.length > 0) {
          setDoc(rebuild(review));
          setNotice({
            kind: "ok",
            text: `Loaded the default dataset — ${review.length} word(s) ready to review.`,
          });
        }
      } catch {
        // No default dataset is fine; the app simply starts empty.
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Mirror the working document locally, shortly after it settles. */
  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      void saveLocalDoc(doc, dirty).catch(() => {
        // Best-effort: a full or blocked quota must not interrupt reviewing.
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [doc, dirty, hydrated]);

  /** Warn before navigating away with unsaved work. */
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const existingWords = useMemo(
    () => new Set(doc.review.map((entry) => entry.deckWord.word.toLowerCase())),
    [doc.review],
  );

  /** Teaser lines already in use, so a generation run cannot repeat one. */
  const existingAnticipate = useMemo(
    () => doc.review.map((entry) => entry.deckWord.anticipateVi).filter((line) => line.length > 0),
    [doc.review],
  );

  /** Rebuild the deck from the current review rows and re-validate. */
  const rebuild = useCallback(
    (review: ReviewEntry[]): RefineryDoc => {
      const corpus = loadCorpus();
      const deck: Deck = buildDeck({
        name: settings.generation.deckName,
        version: settings.generation.deckVersion,
        words: review.map((entry) => entry.deckWord),
        model: settings.llm.model,
        corpusName: corpus.meta.name ?? "bundled corpus",
        corpusLicense: corpus.meta.license ?? "unknown",
      });
      return { schemaVersion: 1, deck, review, savedAt: new Date().toISOString() };
    },
    [settings.generation.deckName, settings.generation.deckVersion, settings.llm.model],
  );

  const issues = useMemo(() => validateDeck(doc.deck), [doc.deck]);
  const approved = useMemo(() => approvedEntries(doc.review), [doc.review]);

  const onGenerated = useCallback(
    (entries: ReviewEntry[], runIssues: string[]) => {
      setDoc((previous) => rebuild([...previous.review, ...entries]));
      setDirty(true);
      setNotice({
        kind: entries.length > 0 ? "ok" : "warn",
        text:
          entries.length > 0
            ? `Added ${entries.length} word(s) to the review queue (${runIssues.length} note(s) logged).`
            : "Nothing was added — see the run log for why.",
      });
      if (entries.length > 0) setTab("review");
    },
    [rebuild],
  );

  const onReviewChange = useCallback(
    (next: ReviewEntry[]) => {
      setDoc(rebuild(next));
      setDirty(true);
    },
    [rebuild],
  );

  // ── Persistence ────────────────────────────────────────────────────────

  const save = async (force = false) => {
    setNotice(null);
    try {
      const { id } = await store.save(doc, { force });
      setDirty(false);
      setOverwriteBlocked(false);
      setNotice({
        kind: "ok",
        text:
          settings.store.id === id
            ? `Saved to ${store.label}.`
            : `Created ${store.label} resource ${id} — copy that id into Settings so the next save updates it.`,
      });
      if (settings.store.id !== id) {
        setSettings((previous) => ({ ...previous, store: { ...previous.store, id } }));
      }
    } catch (error) {
      // A refused overwrite is not a failure to report and forget: the remote
      // may hold the only full copy, so the way past it stays visible.
      setOverwriteBlocked(store.blocked !== null && !force);
      setNotice({
        kind: "error",
        text: error instanceof StoreError ? `${error.message}${error.body ? `\n${error.body}` : ""}` : String(error),
      });
    }
  };

  const load = async () => {
    setNotice(null);
    try {
      const remote = await store.load();
      if (remote === null) {
        setNotice({
          kind: "warn",
          text: settings.store.id.length === 0
            ? `Nothing stored yet on ${store.label}. Save once to create it.`
            : "That resource is empty. Nothing was loaded, and your working document is untouched.",
        });
        return;
      }
      setDoc(remote);
      setDirty(false);
      setOverwriteBlocked(false);
      setNotice({ kind: "ok", text: `Loaded ${remote.review.length} word(s) from ${store.label}.` });
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof StoreError ? `${error.message}${error.body ? `\n${error.body}` : ""}` : String(error),
      });
    }
  };

  const upload = async (file: File) => {
    setNotice(null);
    const parsed = await readJsonFile(file);
    if (parsed === null) {
      setNotice({
        kind: "error",
        text: "That file is not a refinery document, a deck export, or a WordCrawler batch.",
      });
      return;
    }
    const review = reviewEntriesFrom(parsed);
    if (review.length === 0) {
      setNotice({ kind: "error", text: `No usable words found in ${file.name}.` });
      return;
    }
    setDoc(rebuild(review));
    setDirty(true);
    setNotice({
      kind: "ok",
      text: `Imported ${review.length} word(s) from ${file.name} — queued for review.`,
    });
    setTab("review");
  };

  /** Export only the rows a reviewer signed off on, in importer shape. */
  const exportDeck = () => {
    const corpus = loadCorpus();
    const deck = buildDeck({
      name: settings.generation.deckName,
      version: settings.generation.deckVersion,
      words: approved.map((entry) => entry.deckWord),
      model: settings.llm.model,
      corpusName: corpus.meta.name ?? "bundled corpus",
      corpusLicense: corpus.meta.license ?? "unknown",
      notes:
        "Generated by word-refinery. Emphasis is inline /phrase/ markers inside defVi and leadVi. " +
        "Corpus is a CC BY-SA 4.0 derivative; see NOTICE.md.",
    });
    downloadJson({ schemaVersion: 1, deck, review: approved, savedAt: new Date().toISOString() });
    setNotice({
      kind: approved.length > 0 ? "ok" : "warn",
      text:
        approved.length > 0
          ? `Downloaded ${approved.length} approved word(s). Run \`npm run vocab:import -- <file>\` in KineMedia.`
          : "No approved words yet — the file contains an empty deck.",
    });
  };

  const tabCounts: Record<Tab, number | null> = {
    generate: null,
    review: doc.review.length,
    coverage: null,
    sync: approved.length,
    prompts: null,
    settings: null,
  };

  return (
    <div className="shell">
      <header className="shell-head">
        <h1>Word Refinery</h1>
        <span className="tag">vocabulary deck studio</span>
      </header>
      <p className="shell-sub">
        Generate Vietnamese vocabulary cards from an openly licensed CEFR corpus, refine them by
        hand, and export a deck for KineMedia. Everything runs in this browser — keys stay in
        localStorage, and the deck persists to whichever small JSON store you configure.
      </p>

      <nav className="tabs" aria-label="Workspace sections">
        {(
          [
            ["generate", "Generate"],
            ["review", "Library"],
            ["coverage", "Coverage"],
            ["sync", "Sync & export"],
            ["prompts", "Prompts"],
            ["settings", "Settings"],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="tab"
            data-active={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
            {tabCounts[id] !== null && tabCounts[id]! > 0 && (
              <span className="count">{tabCounts[id]}</span>
            )}
          </button>
        ))}
      </nav>

      {notice !== null && <div className={`banner ${notice.kind}`}>{notice.text}</div>}

      {tab === "generate" && (
        <>
          {/* Not keyed on the epoch: remounting it would throw away the import
              report it had just produced. It reads the corpus during render, so
              the parent's re-render is enough to keep it current. */}
          <CorpusPanel onCorpusChange={() => setCorpusEpoch((epoch) => epoch + 1)} />
          <GeneratePanel
            key={`gen-${corpusEpoch}`}
            settings={settings}
            existingWords={existingWords}
            existingAnticipate={existingAnticipate}
            selectedLevels={levels}
            onLevels={setLevels}
            onGenerated={onGenerated}
            busy={busy}
            onBusy={setBusy}
          />
        </>
      )}

      {tab === "review" && (
        <Library
          entries={doc.review}
          settings={settings}
          filter={filter}
          onFilter={setFilter}
          onChange={onReviewChange}
        />
      )}

      {tab === "coverage" && (
        <CoveragePanel
          entries={doc.review}
          onDrillDown={(next) => {
            setFilter(next);
            setTab("review");
          }}
        />
      )}

      {tab === "sync" && (
        <>
          <section className="panel">
            <h2>Remote store</h2>
            <p className="hint">
              Backend: <strong>{store.label}</strong>
              {store.missing !== null && <> — not configured ({store.missing})</>}
            </p>
            <div className="row">
              <button type="button" className="btn primary" onClick={() => void save()} disabled={!store.ready}>
                Save to {store.label}
              </button>
              <button type="button" className="btn" onClick={() => void load()} disabled={!store.ready}>
                Load from {store.label}
              </button>
              {settings.store.id.length > 0 && (
                <span className="note" style={{ color: "var(--muted)", fontSize: 12 }}>
                  resource id <code className="k">{settings.store.id}</code>
                </span>
              )}
            </div>
            {overwriteBlocked && (
              <div className="banner error" style={{ marginTop: 12 }}>
                <p style={{ margin: "0 0 10px" }}>
                  The last read of {store.label} failed, so this save was refused — what is stored
                  there may be the only full copy of the deck. Download a backup first; overwrite
                  only once you are sure the working document is the one to keep.
                </p>
                <div className="row">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      downloadJson(doc);
                      setNotice({ kind: "ok", text: `Downloaded ${DOC_FILENAME} as a backup.` });
                    }}
                  >
                    Download backup first
                  </button>
                  <button type="button" className="btn danger" onClick={() => void save(true)}>
                    Overwrite {store.label} anyway
                  </button>
                </div>
              </div>
            )}
            {!store.ready && (
              <div className="banner warn" style={{ marginTop: 12 }}>
                Pick a backend and add its credential in Settings, or use the local file buttons
                below. Nothing is lost either way — the working document stays in this browser.
              </div>
            )}
            <p className="hint" style={{ marginTop: 12, marginBottom: 0 }}>
              {localMirrorAvailable()
                ? "This browser also keeps its own copy of the working document, restored automatically when you come back. It is a crash guard, not a backup — only the remote store and downloaded files survive this machine."
                : "This browser will not allow a local copy (private mode?), so unsaved work is lost on refresh. Save or download often."}
            </p>
          </section>

          <section className="panel">
            <h2>Local file</h2>
            <p className="hint">
              Download the whole working document (deck plus review state), or upload a refinery
              document, a deck export, or a <strong>WordCrawler batch</strong> ({"{ meta, words }"})
              to preview and refine it here. Imported words land in the Review tab as
              <em> pending</em> rows.
            </p>
            <div className="row">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  downloadJson(doc);
                  setNotice({ kind: "ok", text: `Downloaded ${DOC_FILENAME}.` });
                }}
              >
                Download working document
              </button>
              <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
                Upload deck / batch JSON
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) void upload(file);
                  event.target.value = "";
                }}
              />
            </div>
          </section>

          <section className="panel">
            <h2>Export for KineMedia</h2>
            <p className="hint">
              Writes only the <strong>{approved.length}</strong> approved/edited word(s) as a deck
              file. Then in the KineMedia repo:
            </p>
            <div className="log">
              {`npm run vocab:import -- /path/to/${DOC_FILENAME}\n# restart the dev server: catalog.json is imported statically`}
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button type="button" className="btn primary" onClick={exportDeck}>
                Export approved deck
              </button>
              <span className="note" style={{ color: "var(--muted)", fontSize: 12 }}>
                {issues.length > 0
                  ? `${issues.length} validation issue(s) remain across the whole deck — check the Review tab.`
                  : "No validation issues."}
              </span>
            </div>
          </section>

          <section className="panel">
            <h2>Licensing</h2>
            <p className="hint">
              The bundled corpus is a derivative of the NGSL 1.2 / NAWL 1.2 word lists, licensed{" "}
              {loadCorpus().meta.license}. Share-alike applies to the word list itself; the
              Vietnamese annotations you generate are yours. See <code className="k">NOTICE.md</code>{" "}
              in this repository before redistributing a deck.
            </p>
          </section>
        </>
      )}

      {tab === "prompts" && <PromptsPanel />}

      {tab === "settings" && <SettingsPanel settings={settings} onChange={setSettings} />}

      <footer className="statusbar">
        <span>
          <b>{doc.review.length}</b> words in progress
        </span>
        <span>
          <b>{approved.length}</b> approved
        </span>
        <span>
          <b>{issues.length}</b> issue(s)
        </span>
        <div className="spacer" />
        <span>{dirty ? "unsaved changes" : "saved"}</span>
        <span>{store.label}</span>
      </footer>
    </div>
  );
}

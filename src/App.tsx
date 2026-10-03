/**
 * Word Refinery — application shell.
 *
 * Owns three pieces of state: settings (localStorage), the working document
 * (deck + per-word review rows), and the active tab. Persistence is explicit —
 * the reviewer decides when to Save, so a half-edited batch is never silently
 * pushed to the remote store.
 *
 * Exports: App
 * Depends on: ./lib/*, ./components/*
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GeneratePanel } from "./components/GeneratePanel";
import { ReviewTable } from "./components/ReviewTable";
import { SettingsPanel } from "./components/SettingsPanel";
import { loadCorpus } from "./lib/corpus";
import { approvedEntries } from "./lib/deck";
import { buildDeck, validateDeck } from "./lib/deck";
import {
  DOC_FILENAME,
  createStore,
  downloadJson,
  readJsonFile,
  StoreError,
} from "./lib/store";
import { readSettings, writeSettings, type Settings } from "./lib/settings";
import type { CefrLevel, Deck, RefineryDoc, ReviewEntry } from "./lib/types";

/** Tabs in the workspace. */
type Tab = "generate" | "review" | "sync" | "settings";

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

export function App() {
  const [settings, setSettings] = useState<Settings>(() => readSettings());
  const [doc, setDoc] = useState<RefineryDoc>(() => emptyDoc(readSettings()));
  const [tab, setTab] = useState<Tab>("generate");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error" | "warn"; text: string } | null>(null);
  const [levels, setLevels] = useState<CefrLevel[]>([]);
  const [dirty, setDirty] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const store = useMemo(() => createStore(settings.store), [settings.store]);

  /** Persist settings whenever they change. */
  useEffect(() => {
    writeSettings(settings);
  }, [settings]);

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

  const save = async () => {
    setNotice(null);
    try {
      const { id } = await store.save(doc);
      setDirty(false);
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
            : "That resource is empty or does not contain a refinery document.",
        });
        return;
      }
      setDoc(remote);
      setDirty(false);
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
      setNotice({ kind: "error", text: "That file is not a refinery document or a deck export." });
      return;
    }
    // A bare deck export has no review rows; synthesise them as approved.
    const review: ReviewEntry[] =
      parsed.review.length > 0
        ? parsed.review
        : parsed.deck.words.map((deckWord) => ({
            id: deckWord.id,
            deckWord,
            status: "approved" as const,
            warnings: [],
          }));
    setDoc({ ...parsed, review });
    setDirty(true);
    setNotice({ kind: "ok", text: `Imported ${review.length} word(s) from ${file.name}.` });
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
    sync: approved.length,
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
            ["review", "Review"],
            ["sync", "Sync & export"],
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
        <GeneratePanel
          settings={settings}
          existingWords={existingWords}
          selectedLevels={levels}
          onLevels={setLevels}
          onGenerated={onGenerated}
          busy={busy}
          onBusy={setBusy}
        />
      )}

      {tab === "review" && (
        <ReviewTable entries={doc.review} settings={settings} onChange={onReviewChange} />
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
            {!store.ready && (
              <div className="banner warn" style={{ marginTop: 12 }}>
                Pick a backend and add its credential in Settings, or use the local file buttons
                below. Nothing is lost either way — the working document stays in memory.
              </div>
            )}
          </section>

          <section className="panel">
            <h2>Local file</h2>
            <p className="hint">
              Download the whole working document (deck plus review state), or upload one to
              continue a session on another machine.
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
                Upload working document
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

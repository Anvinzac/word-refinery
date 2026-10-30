/**
 * Intake — the gate a batch passes through before it is vocabulary.
 *
 * Four stages, cheapest first, so a batch that fails on structure never costs a
 * model call. Everything that arrives stays visible: a rejected candidate keeps
 * the reason it was rejected, and the counts never let a candidate be mistaken
 * for a card. That distinction is the point of the page.
 *
 * The result is written to a SQLite file rather than another JSON batch,
 * because twenty batches is twenty things to keep in step and one file is one
 * thing to send.
 *
 * Exports: IntakePanel
 * Depends on: ../lib/intake.ts, ../lib/intake-db.ts, ../lib/local-doc.ts, ../lib/llm.ts
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  asManifest,
  candidateId,
  checkBatchRules,
  checkManifest,
  checkContent,
  checkPromptRules,
  checkSchema,
  partitionRecords,
  summarize,
  verdictOf,
  type IntakeFinding,
  type ManifestRow,
  type IntakeRecord,
  type IntakeStage,
} from "../lib/intake";
import { openCatalog, type CatalogDb, type CatalogStats } from "../lib/intake-db";
import { clearLocalCatalog, loadLocalCatalog, saveLocalCatalog } from "../lib/local-doc";
import { describeLlmError, repairCard, reviewSafety } from "../lib/llm";
import {
  describeWordList,
  parseCefrWords,
  type CefrWordList,
} from "../lib/cefr-words";
import { coerceDeckWord } from "../lib/deck";
import { exportCatalogForKineMedia } from "../lib/kinemedia-export";
import { activeGlossProfile } from "../lib/lang";
import type { Settings } from "../lib/settings";

/** What the run is doing, for the progress line. */
interface Progress {
  stage: IntakeStage | "done";
  done: number;
  total: number;
}

/** Turn a parsed file into candidates. */
function candidatesFrom(parsed: unknown, batchId: string): Array<{ id: string; raw: unknown }> {
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { words?: unknown }).words)
      ? ((parsed as { words: unknown[] }).words)
      : [];
  return list.map((raw, index) => ({
    id: candidateId(batchId, String((raw as { word?: unknown })?.word ?? ""), index),
    raw,
  }));
}

export function IntakePanel({ settings }: { settings: Settings }) {
  const [records, setRecords] = useState<IntakeRecord[]>([]);
  const [batchId, setBatchId] = useState("");
  /**
   * The batch's manifest, when one was loaded with it.
   *
   * It is what the batch was ASKED for, which the cards themselves cannot say:
   * v3.7 passes the level in and forbids it in the output, so without this the
   * level ceiling and the whole of B1 are unenforceable.
   */
  const [manifest, setManifest] = useState<ManifestRow[] | null>(null);
  /**
   * A CEFR word list, when the reviewer chose one alongside the batch.
   *
   * It stays in memory for the session and is never written anywhere: the
   * lists that can answer U1 cannot be redistributed, so this app reads one
   * and does not keep it. See lib/cefr-words.ts.
   */
  const [wordList, setWordList] = useState<CefrWordList | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogDb | null>(null);
  const [stats, setStats] = useState<CatalogStats | null>(null);
  // The stored file, held so the session CONTINUES it rather than starting a
  // new one that claims to be the whole catalogue.
  const [storedBytes, setStoredBytes] = useState<Uint8Array | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // Set when this browser's copy could not be read. A catalogue we failed to
  // read is NOT one we may overwrite, so releasing stops keeping it.
  const [catalogUnreadable, setCatalogUnreadable] = useState(false);
  const [keepWarning, setKeepWarning] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const [openedFile, setOpenedFile] = useState<string | null>(null);
  const [safetyOn, setSafetyOn] = useState(true);
  const [repairOn, setRepairOn] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const catalogInput = useRef<HTMLInputElement>(null);

  /**
   * Pick up the catalogue this browser already holds.
   *
   * Only the bytes and the counts, not the database: opening it would pull 672
   * KB of WebAssembly for a reviewer who came to read a number. The file is
   * opened when something is actually written to or queried.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const held = await loadLocalCatalog();
        if (cancelled || held === null) return;
        setStoredBytes(held.bytes);
        setStats(held.stats);
        setSavedAt(held.savedAt);
      } catch {
        if (!cancelled) setCatalogUnreadable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const summary = useMemo(() => summarize(records), [records]);
  const split = useMemo(() => partitionRecords(records), [records]);

  /** Stages one and two, which cost nothing and so always run. */
  const runLocal = (
    candidates: Array<{ id: string; raw: unknown }>,
    rows: ManifestRow[] | null,
    // Passed rather than read from state: a list chosen in the same click has
    // not reached state yet when this runs, and reading the stale value would
    // silently skip the ceiling on the very batch it was chosen for.
    words: CefrWordList | null = wordList,
  ): IntakeRecord[] => {
    const used = new Set<string>();
    return candidates.map(({ id, raw }, index) => {
      const findings: IntakeFinding[] = [
        ...checkSchema(raw),
        ...checkPromptRules(raw, rows?.[index]?.level, words ?? undefined),
      ];
      const word = String((raw as { word?: unknown })?.word ?? "");
      // Coerce only when the shape is sound; a broken candidate must not be
      // smoothed into a plausible card by the importer.
      const blocked = findings.some((finding) => finding.severity === "blocker");
      // The level comes from the manifest, because the card does not carry one:
      // without it every card is stamped B1 (see coerceDeckWord).
      const card = blocked
        ? null
        : coerceDeckWord(raw, used, { batchId, addedAt: "", level: rows?.[index]?.level });
      if (card !== null) findings.push(...checkContent(card));
      return {
        id,
        word,
        batchId,
        raw,
        card,
        findings,
        verdict: verdictOf(findings, ["schema", "content"]),
      };
    });
  };

  /**
   * Load a batch, and its manifest when one comes with it.
   *
   * Both arrive through one control because they are one thing: a batch and
   * the list of targets it answers. Which file is which is read from its
   * SHAPE rather than its name, so a manifest saved under any name still
   * works and a card file can never be mistaken for one.
   */
  const loadBatch = async (chosen: readonly File[]) => {
    setError(null);
    setNotice(null);
    try {
      const read = await Promise.all(
        chosen.map(async (file) => ({ file, text: await file.text() })),
      );
      // Which file is which is read from its SHAPE, and the order matters.
      //
      // A MANIFEST IS TRIED FIRST, because a manifest row carries `word` and
      // `level` and so is a perfectly good `[{word, level}]` word list by
      // shape. Tried the other way round, the list parser swallows the
      // manifest: the batch then loads with no manifest, and the level ceiling
      // and B1 are skipped — silently, and for the batch the reviewer just
      // chose a word list for. A manifest is the narrower shape (it has ids,
      // and no Vietnamese), so it gets to claim its file first.
      //
      // A word list is then recognised before JSON.parse, because the lists
      // that exist are CSV as often as JSON and a CSV would simply fail.
      const parsed: Array<{ file: File; json: unknown }> = [];
      const lists: Array<{ file: File; list: CefrWordList }> = [];
      for (const entry of read) {
        let json: unknown;
        try {
          json = JSON.parse(entry.text) as unknown;
        } catch {
          json = undefined;
        }
        if (json !== undefined && asManifest(json) !== null) {
          parsed.push({ file: entry.file, json });
          continue;
        }
        const list = parseCefrWords(entry.text, entry.file.name);
        if (list !== null) {
          lists.push({ file: entry.file, list });
          continue;
        }
        if (json === undefined) {
          setError(`${entry.file.name} is neither JSON nor a CEFR word list.`);
          return;
        }
        parsed.push({ file: entry.file, json });
      }
      if (lists.length > 0) setWordList(lists[0]!.list);
      const words = lists[0]?.list ?? wordList;
      const manifests = parsed.filter((entry) => asManifest(entry.json) !== null);
      const batches = parsed.filter((entry) => asManifest(entry.json) === null);
      if (batches.length === 0) {
        if (lists.length > 0 && manifests.length === 0) {
          setNotice(
            `Word list held: ${describeWordList(lists[0]!.list)}. ` +
              "Choose a batch now and every word of every example is checked against it.",
          );
          return;
        }
        setError(
          manifests.length > 0
            ? "That is a manifest with no batch beside it. Choose the cards file too."
            : "No cards found in what you chose.",
        );
        return;
      }
      if (batches.length > 1) {
        setError("Choose one batch at a time, with its manifest if it has one.");
        return;
      }
      const source = batches[0]!;
      const rows = manifests.length > 0 ? asManifest(manifests[0]!.json) : null;
      const id = source.file.name.replace(/\.json$/i, "");
      setBatchId(id);
      setManifest(rows);

      const candidates = candidatesFrom(source.json, id);
      if (candidates.length === 0) {
        setError(`${source.file.name} holds no candidates.`);
        return;
      }
      setProgress({ stage: "content", done: candidates.length, total: candidates.length });
      // The batch-shaped rules need every record, so they run last and fold
      // their findings back in before a verdict is settled.
      const local = runLocal(candidates, rows, words);
      const batchFindings = checkBatchRules(local);
      const integrity = rows === null ? null : checkManifest(local, rows);
      setRecords(
        local.map((record) => {
          const extra = [
            ...(batchFindings.get(record.id) ?? []),
            ...(integrity?.byRecord.get(record.id) ?? []),
          ];
          if (extra.length === 0) return record;
          const findings = [...record.findings, ...extra];
          return { ...record, findings, verdict: verdictOf(findings, ["schema", "content"]) };
        }),
      );
      setProgress({ stage: "done", done: candidates.length, total: candidates.length });
      const whole = integrity?.batch ?? [];
      setNotice(
        rows === null
          ? "No manifest came with this batch, so the level ceiling and the batch-integrity rule (B1) were skipped — a card cannot say what level it was asked for."
          : whole.length > 0
            ? `Checked against ${rows.length} manifest row(s). ${whole.map((finding) => finding.message).join(" ")}`
            : `Checked against ${rows.length} manifest row(s): every target has exactly one card, in order.`,
      );
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    }
  };

  /** Stage three, then stage four, both of which cost calls. */
  const runModelStages = async () => {
    if (settings.llm.apiKey.length === 0) {
      setError("Add an API key in Settings before running the safety gate.");
      return;
    }
    setError(null);
    let working = [...records];

    if (safetyOn) {
      const targets = working.filter((record) => record.card !== null && record.verdict !== "rejected");
      for (const [index, record] of targets.entries()) {
        setProgress({ stage: "safety", done: index, total: targets.length });
        try {
          const found = await reviewSafety(settings.llm, record.card!);
          const findings: IntakeFinding[] = found.map((item) => ({
            stage: "safety" as const,
            field: item.field,
            severity: item.severity,
            message: item.problem,
          }));
          working = working.map((row) =>
            row.id === record.id
              ? {
                  ...row,
                  findings: [...row.findings, ...findings],
                  verdict: verdictOf([...row.findings, ...findings], ["schema", "content", "safety"]),
                }
              : row,
          );
        } catch (thrown) {
          // A gate that could not be reached is not a gate that passed.
          const message = describeLlmError(thrown).split("\n")[0] ?? "the safety gate failed";
          working = working.map((row) =>
            row.id === record.id
              ? {
                  ...row,
                  findings: [
                    ...row.findings,
                    { stage: "safety" as const, field: "card", severity: "blocker" as const, message },
                  ],
                  verdict: "rejected" as const,
                }
              : row,
          );
        }
        setRecords([...working]);
      }
    }

    if (repairOn) {
      const failed = working.filter((row) => row.verdict === "rejected" && row.card !== null);
      for (const [index, record] of failed.entries()) {
        setProgress({ stage: "repair", done: index, total: failed.length });
        try {
          const problems = record.findings
            .filter((finding) => finding.severity === "blocker")
            .map((finding) => `${finding.field}: ${finding.message}`);
          const raw = await repairCard(settings.llm, record.card!, problems);
          // Revalidated from the top: a fix to one field can break another, and
          // rechecking only the trigger would ship exactly that.
          const used = new Set<string>();
          // Revalidated against the level it was ASKED for, not a fresh guess:
          // a repair that quietly raised the example's vocabulary would pass a
          // recheck that had forgotten the ceiling.
          const level = manifest?.[working.findIndex((row) => row.id === record.id)]?.level;
          const fresh: IntakeFinding[] = [
            ...checkSchema(raw, record.word),
            ...checkPromptRules(raw, level, wordList ?? undefined),
          ];
          const blocked = fresh.some((finding) => finding.severity === "blocker");
          const card = blocked ? null : coerceDeckWord(raw, used, { batchId, addedAt: "", level });
          if (card !== null) fresh.push(...checkContent(card));
          working = working.map((row) =>
            row.id === record.id
              ? {
                  ...row,
                  raw,
                  card,
                  findings: fresh,
                  repaired: true,
                  verdict: verdictOf(fresh, ["schema", "content", "safety"]),
                }
              : row,
          );
        } catch {
          // Leave the original rejection and its reasons in place.
        }
        setRecords([...working]);
      }
    }

    setProgress({ stage: "done", done: working.length, total: working.length });
  };

  /**
   * The open catalogue, continuing whatever this browser already held.
   *
   * The ordering matters: a release that opened a FRESH database while a stored
   * file existed would write one batch into an empty catalogue and then save it
   * over the real one. So the stored bytes are the starting point, and a
   * catalogue that could not be read stops the write rather than replacing it.
   */
  const ensureCatalog = async (): Promise<CatalogDb> => {
    if (catalog !== null) return catalog;
    if (catalogUnreadable) {
      throw new Error(
        "This browser's stored catalogue could not be read, so nothing will be written over it. " +
          "Reload the page; if it still fails, open your downloaded .sqlite file instead.",
      );
    }
    const db = await openCatalog(storedBytes ?? undefined);
    setCatalog(db);
    return db;
  };

  /** Keep the catalogue in this browser, so it outlives the tab. */
  const persist = async (db: CatalogDb): Promise<void> => {
    const bytes = db.toBytes();
    setStoredBytes(bytes);
    if (catalogUnreadable) {
      setKeepWarning(
        "Released into the open catalogue, but NOT kept in this browser — the copy stored here could not be read, and overwriting it would lose it. Download the .sqlite file.",
      );
      return;
    }
    try {
      await saveLocalCatalog(bytes, db.stats());
      setSavedAt(new Date().toISOString());
      setKeepWarning(null);
    } catch (thrown) {
      // The release itself succeeded; only the keeping failed, and saying so is
      // the difference between a reviewer downloading the file and losing it.
      setKeepWarning(
        `Released, but this browser would not store the catalogue (${thrown instanceof Error ? thrown.message : String(thrown)}). Download the .sqlite file before you close the tab.`,
      );
    }
  };

  /** Stage four: write the run into the catalogue, both populations. */
  const release = async () => {
    setError(null);
    try {
      const db = await ensureCatalog();
      db.ingest({ batchId, source: batchId, model: settings.llm.model, records });
      setStats(db.stats());
      const replaced = openedFile === null ? "" : ` The catalogue opened from ${openedFile} is now the one this browser keeps.`;
      setNotice(
        `Released into the catalogue: ${summary.accepted} card(s), ${summary.rejected} rejection(s) kept with their reasons.${replaced}`,
      );
      setOpenedFile(null);
      await persist(db);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    }
  };

  const downloadCatalog = async () => {
    setError(null);
    try {
      const db = await ensureCatalog();
      const blob = new Blob([db.toBytes() as BlobPart], { type: "application/vnd.sqlite3" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "word-catalog.sqlite";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    }
  };

  /** The verified cards only, in the format KineMedia's importer reads. */
  const downloadForKineMedia = async () => {
    setError(null);
    try {
      const db = await ensureCatalog();
      const { deck, report } = exportCatalogForKineMedia(db.query, { gloss: activeGlossProfile().id });
      if (deck.words.length === 0) {
        setError("The catalogue holds no verified cards yet; release a batch first.");
        return;
      }
      const blob = new Blob([`${JSON.stringify(deck, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `word-refinery-kinemedia-${deck.meta.locale}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const notes = [
        report.superseded.length ? `${report.superseded.length} older duplicate(s) left out` : "",
        report.emphasisDropped.length ? `${report.emphasisDropped.length} stale highlight(s) left out` : "",
        report.skipped.length ? `${report.skipped.length} card(s) skipped` : "",
      ].filter(Boolean);
      setNotice(
        `Exported ${report.exported} verified word(s) for KineMedia${notes.length ? ` (${notes.join(", ")})` : ""}. ` +
          "In KineMedia: npm run vocab:import-refinery -- <file>",
      );
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    }
  };

  /**
   * Open a catalogue from a file.
   *
   * It becomes the session's catalogue but is NOT stored yet: a reviewer
   * opening a colleague's file to look at it should not thereby lose their own.
   * Releasing into it, or "Keep in this browser", is what makes it theirs.
   */
  const openExisting = async (file: File) => {
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const db = await openCatalog(bytes);
      catalog?.close();
      setCatalog(db);
      setStats(db.stats());
      setOpenedFile(file.name);
      setNotice(
        stats !== null && stats.cards > 0
          ? `Opened ${file.name}. It is not stored in this browser yet — the catalogue kept here still holds ${stats.cards} card(s).`
          : `Opened ${file.name}.`,
      );
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    }
  };

  /** Store the open catalogue, replacing whatever this browser held. */
  const keepOpened = async () => {
    if (catalog === null) return;
    setOpenedFile(null);
    await persist(catalog);
    setNotice("Kept in this browser. It will be there on the next visit.");
  };

  /** Drop this browser's copy. The open catalogue is untouched. */
  const forgetStored = async () => {
    setError(null);
    try {
      await clearLocalCatalog();
      setStoredBytes(null);
      setSavedAt(null);
      setConfirmForget(false);
      setCatalogUnreadable(false);
      setStats(catalog?.stats() ?? null);
      setNotice(
        catalog === null
          ? "This browser no longer keeps a catalogue. The next release starts a fresh file."
          : "This browser no longer keeps a catalogue. The one open in this tab is untouched — releasing into it will store it again.",
      );
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    }
  };

  return (
    <>
      <section className="panel">
        <h2>Intake</h2>
        <p className="hint">
          Four gates, cheapest first, so a batch that fails on structure never costs a model call.
          Everything that arrives stays visible with the reason it was judged — a candidate only
          becomes a card by passing, never by not having been checked.
        </p>
        <p className="hint" style={{ marginTop: 8 }}>
          Choose the cards file and its <code className="k">.meta.json</code> manifest together. The
          manifest is what the batch was asked for, and the cards cannot say it: without one, the
          example-level ceiling and the batch-integrity rule are skipped rather than guessed.
        </p>
        <p className="note">
          A <b>CEFR word list</b> may come with them, CSV or JSON. With one, the example-level rule
          is checked on every word of every sentence instead of the handful the prompt names — which
          at B2 is nothing at all. The lists that can answer it cannot be redistributed, so this app
          reads one and never stores it: it is held for this session only.
          {wordList !== null && (
            <>
              {" "}
              <b>Held now:</b> {describeWordList(wordList)}.
            </>
          )}
        </p>

        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" className="btn primary" onClick={() => fileInput.current?.click()}>
            Load a batch
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="application/json,.json,text/csv,.csv"
            style={{ display: "none" }}
            onChange={(event) => {
              const chosen = [...(event.target.files ?? [])];
              if (chosen.length > 0) void loadBatch(chosen);
              event.target.value = "";
            }}
          />
          {records.length > 0 && (
            <button
              type="button"
              className="btn"
              disabled={progress !== null && progress.stage !== "done"}
              onClick={() => void runModelStages()}
            >
              Run safety{repairOn ? " and repair" : ""}
            </button>
          )}
          <label className="intake-toggle">
            <input type="checkbox" checked={safetyOn} onChange={() => setSafetyOn(!safetyOn)} />
            safety gate
          </label>
          <label className="intake-toggle">
            <input type="checkbox" checked={repairOn} onChange={() => setRepairOn(!repairOn)} />
            repair failures
          </label>
        </div>

        {error !== null && <div className="banner error" style={{ marginTop: 12 }}>{error}</div>}
        {notice !== null && <div className="banner" style={{ marginTop: 12 }}>{notice}</div>}

        {progress !== null && progress.stage !== "done" && (
          <>
            <div className="progress" aria-hidden="true" style={{ marginTop: 12 }}>
              <i style={{ width: `${progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)}%` }} />
            </div>
            <p className="note" style={{ color: "var(--muted)", fontSize: 12, margin: "6px 0 0" }}>
              {progress.stage} — {progress.done} of {progress.total}
            </p>
          </>
        )}

        {records.length > 0 && (
          <div className="intake-counts">
            <div className="intake-count" data-kind="accepted">
              <strong>{summary.accepted}</strong> cards
              <span>passed every gate</span>
            </div>
            <div className="intake-count" data-kind="rejected">
              <strong>{summary.rejected}</strong> rejected
              <span>kept, with reasons</span>
            </div>
            <div className="intake-count">
              <strong>{summary.repaired}</strong> repaired
              <span>fixed and rechecked</span>
            </div>
            <div className="intake-count">
              <strong>{summary.total}</strong> candidates
              <span>arrived in {batchId || "this batch"}</span>
            </div>
          </div>
        )}
      </section>

      {records.length > 0 && (
        <section className="panel">
          <h2>What failed, and why</h2>
          {split.rejected.length === 0 ? (
            <div className="empty">Nothing was rejected.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="review-table">
                <thead>
                  <tr>
                    <th>Word</th>
                    <th>Stage</th>
                    <th>Field</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {split.rejected.flatMap((record) =>
                    record.findings
                      .filter((finding) => finding.severity === "blocker")
                      .map((finding, index) => (
                        <tr key={`${record.id}:${index}`}>
                          <td className="word-cell">
                            {index === 0 ? record.word : ""}
                            {index === 0 && record.repaired === true && (
                              <div className="meta-cell">repaired, still failing</div>
                            )}
                          </td>
                          <td className="meta-cell">{finding.stage}</td>
                          <td className="meta-cell">{finding.field}</td>
                          <td className="vi-cell">{finding.message}</td>
                        </tr>
                      )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="panel">
        <h2>Catalogue</h2>
        <p className="hint">
          One SQLite file holding every batch: the cards that passed, the candidates that did not,
          and why. It is kept in this browser between visits, so a release adds to the catalogue
          rather than starting another one — and it downloads as one file to send.
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn primary"
            disabled={records.length === 0}
            onClick={() => void release()}
          >
            Release this batch
          </button>
          <button type="button" className="btn" onClick={() => catalogInput.current?.click()}>
            Open a catalogue
          </button>
          <input
            ref={catalogInput}
            type="file"
            accept=".sqlite,.db,application/vnd.sqlite3"
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void openExisting(file);
              event.target.value = "";
            }}
          />
          {(catalog !== null || storedBytes !== null) && (
            <button type="button" className="btn" onClick={() => void downloadCatalog()}>
              Download .sqlite
            </button>
          )}
          {(catalog !== null || storedBytes !== null) && (
            <button type="button" className="btn" onClick={() => void downloadForKineMedia()}>
              Export for KineMedia
            </button>
          )}
          {openedFile !== null && (
            <button type="button" className="btn" onClick={() => void keepOpened()}>
              Keep {openedFile} in this browser
            </button>
          )}
          {(storedBytes !== null || catalogUnreadable) &&
            (confirmForget ? (
              <>
                <button type="button" className="btn danger" onClick={() => void forgetStored()}>
                  Yes, forget it
                </button>
                <button type="button" className="btn" onClick={() => setConfirmForget(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={() => setConfirmForget(true)}>
                Forget the stored copy
              </button>
            ))}
        </div>

        {catalogUnreadable && (
          <div className="banner error" style={{ marginTop: 12 }}>
            This browser holds a catalogue that could not be read. Nothing will be written over it,
            so a release will not be kept here until the problem clears — reload the page, or open
            your downloaded .sqlite file and keep that instead.
          </div>
        )}
        {keepWarning !== null && (
          <div className="banner warn" style={{ marginTop: 12 }}>
            {keepWarning}
          </div>
        )}
        {savedAt !== null && (
          <p className="note" style={{ color: "var(--muted)", fontSize: 12, margin: "10px 0 0" }}>
            Kept in this browser, last written {new Date(savedAt).toLocaleString()}. It never leaves
            the device on its own — the download is how it travels.
          </p>
        )}
        {openedFile !== null && (
          <p className="note" style={{ color: "var(--muted)", fontSize: 12, margin: "6px 0 0" }}>
            Showing {openedFile}, opened from a file. Releasing into it, or keeping it, is what
            replaces the copy stored here.
          </p>
        )}

        {stats !== null && (
          <div className="intake-counts" style={{ marginTop: 14 }}>
            <div className="intake-count" data-kind="accepted">
              <strong>{stats.cards}</strong> cards<span>in the catalogue</span>
            </div>
            <div className="intake-count" data-kind="rejected">
              <strong>{stats.rejected}</strong> rejected<span>with their reasons</span>
            </div>
            <div className="intake-count">
              <strong>{stats.candidates}</strong> candidates<span>seen in total</span>
            </div>
            <div className="intake-count">
              <strong>{stats.batches}</strong> batches<span>ingested</span>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

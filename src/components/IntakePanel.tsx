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
 * Depends on: ../lib/intake.ts, ../lib/intake-db.ts, ../lib/llm.ts
 */
import { useMemo, useRef, useState } from "react";
import {
  candidateId,
  checkBatchRules,
  checkContent,
  checkPromptRules,
  checkSchema,
  partitionRecords,
  summarize,
  verdictOf,
  type IntakeFinding,
  type IntakeRecord,
  type IntakeStage,
} from "../lib/intake";
import { openCatalog, type CatalogDb } from "../lib/intake-db";
import { describeLlmError, repairCard, reviewSafety } from "../lib/llm";
import { coerceDeckWord } from "../lib/deck";
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
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogDb | null>(null);
  const [stats, setStats] = useState<ReturnType<CatalogDb["stats"]> | null>(null);
  const [safetyOn, setSafetyOn] = useState(true);
  const [repairOn, setRepairOn] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const catalogInput = useRef<HTMLInputElement>(null);

  const summary = useMemo(() => summarize(records), [records]);
  const split = useMemo(() => partitionRecords(records), [records]);

  /** Stages one and two, which cost nothing and so always run. */
  const runLocal = (candidates: Array<{ id: string; raw: unknown }>): IntakeRecord[] => {
    const used = new Set<string>();
    return candidates.map(({ id, raw }) => {
      const findings: IntakeFinding[] = [...checkSchema(raw), ...checkPromptRules(raw)];
      const word = String((raw as { word?: unknown })?.word ?? "");
      // Coerce only when the shape is sound; a broken candidate must not be
      // smoothed into a plausible card by the importer.
      const blocked = findings.some((finding) => finding.severity === "blocker");
      const card = blocked ? null : coerceDeckWord(raw, used, { batchId, addedAt: "" });
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

  const loadBatch = async (file: File) => {
    setError(null);
    setNotice(null);
    const id = file.name.replace(/\.json$/i, "");
    setBatchId(id);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const candidates = candidatesFrom(parsed, id);
      if (candidates.length === 0) {
        setError(`${file.name} holds no candidates.`);
        return;
      }
      setProgress({ stage: "content", done: candidates.length, total: candidates.length });
      // The batch-shaped rules need every record, so they run last and fold
      // their findings back in before a verdict is settled.
      const local = runLocal(candidates);
      const batchFindings = checkBatchRules(local);
      setRecords(
        local.map((record) => {
          const extra = batchFindings.get(record.id);
          if (extra === undefined) return record;
          const findings = [...record.findings, ...extra];
          return { ...record, findings, verdict: verdictOf(findings, ["schema", "content"]) };
        }),
      );
      setProgress({ stage: "done", done: candidates.length, total: candidates.length });
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
          const fresh: IntakeFinding[] = [...checkSchema(raw, record.word), ...checkPromptRules(raw)];
          const blocked = fresh.some((finding) => finding.severity === "blocker");
          const card = blocked ? null : coerceDeckWord(raw, used, { batchId, addedAt: "" });
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

  /** Stage four: write the run into the catalogue, both populations. */
  const release = async () => {
    setError(null);
    try {
      const db = catalog ?? (await openCatalog());
      db.ingest({ batchId, source: batchId, model: settings.llm.model, records });
      setCatalog(db);
      setStats(db.stats());
      setNotice(
        `Released into the catalogue: ${summary.accepted} card(s), ${summary.rejected} rejection(s) kept with their reasons.`,
      );
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    }
  };

  const downloadCatalog = () => {
    if (catalog === null) return;
    const blob = new Blob([catalog.toBytes() as BlobPart], { type: "application/vnd.sqlite3" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "word-catalog.sqlite";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const openExisting = async (file: File) => {
    setError(null);
    try {
      const db = await openCatalog(new Uint8Array(await file.arrayBuffer()));
      setCatalog(db);
      setStats(db.stats());
      setNotice(`Opened ${file.name}.`);
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

        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" className="btn primary" onClick={() => fileInput.current?.click()}>
            Load a batch
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void loadBatch(file);
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
          and why. One thing to send, and a format other tools already read.
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
          {catalog !== null && (
            <button type="button" className="btn" onClick={downloadCatalog}>
              Download .sqlite
            </button>
          )}
        </div>

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

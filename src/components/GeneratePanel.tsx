/**
 * Generate panel — pick how many words to annotate and run the pipeline.
 *
 * Shows corpus coverage per CEFR band, a live progress bar fed by the batch
 * callback, and the run log. A run can be cancelled mid-flight; whatever
 * batches already succeeded is still handed back as review entries.
 *
 * Exports: GeneratePanel
 * Depends on: ../lib/corpus.ts, ../lib/pipeline.ts, ../lib/settings.ts, ../lib/types.ts
 */
import { useMemo, useState } from "react";
import { countByLevel, loadCorpus } from "../lib/corpus";
import { buildReviewEntries, runGeneration } from "../lib/pipeline";
import type { Settings } from "../lib/settings";
import { CEFR_LEVELS, type CefrLevel, type ReviewEntry } from "../lib/types";

export function GeneratePanel({
  settings,
  existingWords,
  selectedLevels,
  onLevels,
  onGenerated,
  busy,
  onBusy,
}: {
  settings: Settings;
  existingWords: ReadonlySet<string>;
  selectedLevels: readonly CefrLevel[];
  onLevels: (levels: CefrLevel[]) => void;
  onGenerated: (entries: ReviewEntry[], issues: string[]) => void;
  busy: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const [count, setCount] = useState(10);
  const [shuffle, setShuffle] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aborter, setAborter] = useState<AbortController | null>(null);

  const corpus = useMemo(() => loadCorpus(), []);
  const remaining = useMemo(
    () => countByLevel(corpus.words.filter((entry) => !existingWords.has(entry.word.toLowerCase()))),
    [corpus.words, existingWords],
  );
  const totalRemaining = useMemo(
    () => Object.values(remaining).reduce((sum, value) => sum + value, 0),
    [remaining],
  );

  const hasKey = settings.llm.apiKey.trim().length > 0;
  const hasModel = settings.llm.model.trim().length > 0;

  const toggleLevel = (level: CefrLevel) => {
    onLevels(
      selectedLevels.includes(level)
        ? selectedLevels.filter((entry) => entry !== level)
        : [...selectedLevels, level],
    );
  };

  const append = (line: string) => setLog((previous) => [...previous, line]);

  const run = async () => {
    if (busy) return;
    setError(null);
    setLog([]);
    setProgress({ done: 0, total: count });
    onBusy(true);

    const controller = new AbortController();
    setAborter(controller);
    append(
      `Requesting ${count} word(s) — provider ${settings.llm.provider}, model ${settings.llm.model}, ${settings.llm.batchSize} per call.`,
    );

    try {
      const result = await runGeneration({
        settings,
        existingWords,
        levels: selectedLevels,
        count,
        shuffle,
        signal: controller.signal,
        onProgress: (event) => {
          setProgress({ done: event.done, total: event.total });
          append(`batch ${event.batch}: ${event.done}/${event.total} words returned`);
        },
      });

      const entries = buildReviewEntries(result.words);
      for (const issue of result.issues) append(`• ${issue}`);
      if (result.missed.length > 0) {
        append(`${result.missed.length} word(s) produced no usable annotation and were skipped.`);
      }
      append(`Run finished: ${entries.length} new word(s), ${result.issues.length} note(s).`);
      onGenerated(entries, result.issues);
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      setError(message);
      append(`FAILED: ${message}`);
    } finally {
      setAborter(null);
      onBusy(false);
    }
  };

  const cancel = () => {
    aborter?.abort();
    append("Cancel requested — finishing the in-flight batch, then stopping.");
  };

  const percent =
    progress === null || progress.total === 0
      ? 0
      : Math.min(100, Math.round((progress.done / progress.total) * 100));

  return (
    <>
      <section className="panel">
        <h2>Corpus coverage</h2>
        <p className="hint">
          {corpus.meta.name} — {corpus.words.length} words, {corpus.meta.license}. Words already in
          the deck are excluded automatically.
        </p>
        <div className="chips">
          {CEFR_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className="chip"
              data-active={selectedLevels.includes(level)}
              onClick={() => toggleLevel(level)}
              title={`${remaining[level]} unannotated word(s) at ${level}`}
            >
              {level}
              <span style={{ opacity: 0.7, marginLeft: 5 }}>{remaining[level]}</span>
            </button>
          ))}
          <button
            type="button"
            className="chip"
            data-active={selectedLevels.length === 0}
            onClick={() => onLevels([])}
          >
            All bands
          </button>
        </div>
        <p className="note" style={{ color: "var(--muted)", fontSize: 12, marginTop: 10 }}>
          {totalRemaining} word(s) left to annotate with the current filter
          {selectedLevels.length > 0 ? ` (${selectedLevels.join(", ")})` : ""}.
        </p>
      </section>

      <section className="panel">
        <h2>Generate</h2>
        <p className="hint">
          Each word becomes one deck entry with Vietnamese definition, teaser, example and two
          inline <code className="k">/emphasis/</code> markers.
        </p>

        <div className="grid cols-3">
          <div className="field">
            <label htmlFor="count">How many words</label>
            <input
              id="count"
              type="number"
              min={1}
              max={Math.max(1, totalRemaining)}
              value={count}
              onChange={(event) => setCount(Math.max(1, Number(event.target.value) || 1))}
            />
            <span className="note">
              About {Math.ceil(count / Math.max(1, settings.llm.batchSize))} LLM call(s).
            </span>
          </div>
          <div className="field">
            <label htmlFor="shuffle">Order</label>
            <select
              id="shuffle"
              value={shuffle ? "shuffle" : "frequency"}
              onChange={(event) => setShuffle(event.target.value === "shuffle")}
            >
              <option value="shuffle">Varied — different words each run</option>
              <option value="frequency">Frequency — most common first</option>
            </select>
          </div>
        </div>

        {!hasKey && (
          <div className="banner warn" style={{ marginTop: 12 }}>
            No API key yet. Open the Settings tab and paste one — nothing is sent anywhere until you
            do.
          </div>
        )}
        {hasKey && !hasModel && (
          <div className="banner warn" style={{ marginTop: 12 }}>
            A model id is required. Pick one from the suggestions in Settings.
          </div>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn primary"
            onClick={() => void run()}
            disabled={busy || !hasKey || !hasModel || totalRemaining === 0}
          >
            {busy ? "Generating…" : `Generate ${count} word${count === 1 ? "" : "s"}`}
          </button>
          {busy && (
            <button type="button" className="btn danger" onClick={cancel}>
              Cancel
            </button>
          )}
          <div className="spacer" />
          {log.length > 0 && (
            <button type="button" className="btn sm" onClick={() => setLog([])}>
              Clear log
            </button>
          )}
        </div>

        {progress !== null && (
          <>
            <div className="progress" aria-hidden="true">
              <i style={{ width: `${percent}%` }} />
            </div>
            <p className="note" style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>
              {progress.done} of {progress.total} words · {percent}%
            </p>
          </>
        )}

        {error !== null && <div className="banner error" style={{ marginTop: 12 }}>{error}</div>}

        {log.length > 0 && (
          <div className="log" style={{ marginTop: 12 }}>
            {log.join("\n")}
          </div>
        )}
      </section>
    </>
  );
}

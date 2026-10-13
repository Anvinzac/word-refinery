/**
 * Corpus panel — see which word list is in force, and load a bigger one.
 *
 * The bundled subset is 381 words, so a deck heading for a thousand runs out of
 * source material long before it gets there. The way past that is a file the
 * operator downloads themselves: the lists are CC BY-SA, which means whoever
 * redistributes them states the attribution, so this panel asks for it rather
 * than assuming. Presets fill it in for the two lists this project is built
 * around; anything else has to be typed, and Oxford data is refused outright.
 *
 * Exports: CorpusPanel
 * Depends on: ../lib/corpus.ts, ../lib/corpus-import.ts, ../lib/local-doc.ts
 */
import { useMemo, useRef, useState } from "react";
import { countByLevel, isBundledCorpus, loadCorpus, setActiveCorpus } from "../lib/corpus";
import { buildCorpus, type ImportSummary } from "../lib/corpus-import";
import { clearLocalCorpus, saveLocalCorpus } from "../lib/local-doc";
import { CEFR_LEVELS, type CefrLevel } from "../lib/types";

/** The provenance a reviewer can see and edit before importing. */
interface CorpusFields {
  label: string;
  name: string;
  source: string;
  license: string;
  licenseUrl: string;
  url: string;
  attribution: string;
  /** Empty means "derive the level from each word's frequency rank". */
  level: "" | CefrLevel;
}

/** Provenance for the lists this project is built around, so it is never mistyped. */
const PRESETS: Record<"ngsl" | "nawl" | "other", CorpusFields> = {
  ngsl: {
    label: "NGSL 1.2",
    name: "New General Service List 1.2 (imported)",
    source: "ngsl",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    url: "https://www.newgeneralservicelist.com",
    attribution:
      "Browne, C., Culligan, B., & Phillips, J. (2013). The New General Service List. " +
      "https://www.newgeneralservicelist.com",
    level: "",
  },
  nawl: {
    label: "NAWL 1.2",
    name: "New Academic Word List 1.2 (imported)",
    source: "nawl",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    url: "https://www.newgeneralservicelist.com",
    attribution:
      "Browne, C., Culligan, B., & Phillips, J. (2013). The New Academic Word List. " +
      "https://www.newgeneralservicelist.com",
    // Academic vocabulary is uniformly advanced; its file carries no useful rank.
    level: "C1",
  },
  other: {
    label: "Another list",
    name: "",
    source: "custom",
    license: "",
    licenseUrl: "",
    url: "",
    attribution: "",
    level: "",
  },
};

type PresetId = keyof typeof PRESETS;

export function CorpusPanel({ onCorpusChange }: { onCorpusChange: () => void }) {
  const corpus = loadCorpus();
  const bundled = isBundledCorpus();
  const [preset, setPreset] = useState<PresetId>("ngsl");
  const [fields, setFields] = useState<CorpusFields>(() => ({ ...PRESETS.ngsl }));
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const perLevel = useMemo(() => countByLevel(corpus.words), [corpus]);

  const choosePreset = (id: PresetId) => {
    setPreset(id);
    setFields({ ...PRESETS[id] });
    setError(null);
    setSummary(null);
  };

  const importFile = async (file: File) => {
    setError(null);
    setSummary(null);
    setBusy(true);
    try {
      const text = await file.text();
      const built = buildCorpus(text, {
        name: fields.name.trim().length > 0 ? fields.name : file.name,
        source: fields.source,
        license: fields.license,
        licenseUrl: fields.licenseUrl,
        attribution: fields.attribution,
        url: fields.url,
        level: fields.level === "" ? undefined : fields.level,
      });
      await saveLocalCorpus(built.corpus);
      setActiveCorpus(built.corpus);
      setSummary(built.summary);
      onCorpusChange();
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    setError(null);
    setSummary(null);
    await clearLocalCorpus();
    setActiveCorpus(null);
    onCorpusChange();
  };

  return (
    <section className="panel">
      <h2>Corpus</h2>
      <p className="hint">
        {corpus.meta.name} — <strong>{corpus.words.length}</strong> words, {corpus.meta.license}.
        {bundled
          ? " This is the bundled starter subset; import an official list below to go past it."
          : " Imported into this browser and kept until you revert."}
      </p>

      <div className="chips" style={{ marginBottom: 10 }}>
        {CEFR_LEVELS.map((level) => (
          <span key={level} className="chip" data-static="true">
            {level} <span style={{ opacity: 0.7, marginLeft: 4 }}>{perLevel[level]}</span>
          </span>
        ))}
      </div>

      {bundled && (
        <div className="banner warn">
          At 381 words this subset runs dry about seven weeks into a fifty-a-week cadence. Download
          the official list from{" "}
          <a href="https://www.newgeneralservicelist.com" target="_blank" rel="noreferrer noopener">
            newgeneralservicelist.com
          </a>{" "}
          (CC BY-SA 4.0) and load the CSV below — it stays in this browser, and nothing is uploaded
          anywhere.
        </div>
      )}

      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="corpus-preset">Which list</label>
        <select
          id="corpus-preset"
          value={preset}
          onChange={(event) => choosePreset(event.target.value as PresetId)}
        >
          {(Object.keys(PRESETS) as PresetId[]).map((id) => (
            <option key={id} value={id}>
              {PRESETS[id].label}
            </option>
          ))}
        </select>
        <span className="note">
          The license and attribution travel with the data into every deck you export.
        </span>
      </div>

      <div className="grid cols-3" style={{ marginTop: 10 }}>
        <div className="field">
          <label htmlFor="corpus-license">License</label>
          <input
            id="corpus-license"
            type="text"
            value={fields.license}
            placeholder="e.g. CC BY-SA 4.0"
            onChange={(event) => setFields((f) => ({ ...f, license: event.target.value }))}
          />
        </div>
        <div className="field">
          <label htmlFor="corpus-level">Level</label>
          <select
            id="corpus-level"
            value={fields.level}
            onChange={(event) =>
              setFields((f) => ({ ...f, level: event.target.value as "" | CefrLevel }))
            }
          >
            <option value="">From frequency rank</option>
            {CEFR_LEVELS.map((level) => (
              <option key={level} value={level}>
                Force every word to {level}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="corpus-attribution">Attribution</label>
        <input
          id="corpus-attribution"
          type="text"
          value={fields.attribution}
          placeholder="Author, year, list name, URL"
          onChange={(event) => setFields((f) => ({ ...f, attribution: event.target.value }))}
        />
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {busy ? "Importing…" : "Load word list (CSV / TSV)"}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/plain"
          style={{ display: "none" }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void importFile(file);
            event.target.value = "";
          }}
        />
        {!bundled && (
          <button type="button" className="btn" onClick={() => void revert()} disabled={busy}>
            Revert to bundled subset
          </button>
        )}
      </div>

      {error !== null && (
        <div className="banner error" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
      {summary !== null && (
        <div className="banner ok" style={{ marginTop: 12 }}>
          Imported {summary.wordsKept} word(s). {summary.rowsSkipped} row(s) skipped as headers or
          non-words, {summary.duplicatesDropped} duplicate(s) collapsed.
        </div>
      )}
    </section>
  );
}

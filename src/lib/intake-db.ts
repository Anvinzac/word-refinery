/**
 * The accepted catalogue, as a SQLite file.
 *
 * Twenty JSON batches is twenty things to keep in step, and answering "which
 * B2 words about money were rejected, and why" means opening all of them. One
 * SQLite file is one artifact to send, and the questions become queries. It is
 * also a format other people's tools already read, which a bespoke JSON shape
 * is not.
 *
 * The schema keeps the two populations apart, because conflating them is the
 * failure this whole pipeline exists to prevent: `cards` holds what passed,
 * `candidates` holds everything that arrived, and `findings` holds why each
 * rejection happened. A candidate is not a card until a row exists in `cards`.
 *
 * sql.js is loaded on demand — it is 672 KB of WebAssembly, and a reviewer who
 * never opens the Intake tab should never pay for it.
 *
 * Exports: openCatalog, CatalogDb
 * Depends on: sql.js, ./intake.ts
 */
import type { Database, SqlJsStatic } from "sql.js";
import type { IntakeRecord } from "./intake.ts";

/** The schema, created on an empty database. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT ''
);

-- Everything that arrived, accepted or not. A row here is a CANDIDATE.
CREATE TABLE IF NOT EXISTS candidates (
  id        TEXT PRIMARY KEY,
  batch_id  TEXT NOT NULL REFERENCES batches(id),
  word      TEXT NOT NULL,
  verdict   TEXT NOT NULL CHECK (verdict IN ('accepted','rejected','pending')),
  repaired  INTEGER NOT NULL DEFAULT 0,
  raw       TEXT NOT NULL
);

-- Why each candidate failed, one row per finding, kept after rejection.
CREATE TABLE IF NOT EXISTS findings (
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  stage        TEXT NOT NULL,
  field        TEXT NOT NULL,
  severity     TEXT NOT NULL,
  message      TEXT NOT NULL
);

-- What passed. A row here is a CARD, and nothing else is.
CREATE TABLE IF NOT EXISTS cards (
  id            TEXT PRIMARY KEY,
  candidate_id  TEXT NOT NULL REFERENCES candidates(id),
  batch_id      TEXT NOT NULL REFERENCES batches(id),
  word          TEXT NOT NULL,
  pos           TEXT NOT NULL DEFAULT '',
  ipa           TEXT NOT NULL DEFAULT '',
  level         TEXT NOT NULL DEFAULT '',
  meaning_vi    TEXT NOT NULL DEFAULT '',
  def_vi        TEXT NOT NULL DEFAULT '',
  lead_vi       TEXT NOT NULL DEFAULT '',
  anticipate_vi TEXT NOT NULL DEFAULT '',
  usage_en      TEXT NOT NULL DEFAULT '',
  usage_vi      TEXT NOT NULL DEFAULT '',
  accepted_at   TEXT NOT NULL
);

-- Many-to-many rather than a comma string, so a tag is queryable.
CREATE TABLE IF NOT EXISTS card_topics (
  card_id TEXT NOT NULL REFERENCES cards(id),
  topic   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS card_exams (
  card_id TEXT NOT NULL REFERENCES cards(id),
  exam    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS findings_candidate ON findings(candidate_id);
CREATE INDEX IF NOT EXISTS candidates_batch ON candidates(batch_id);
CREATE INDEX IF NOT EXISTS cards_word ON cards(word);
CREATE INDEX IF NOT EXISTS card_topics_topic ON card_topics(topic);
`;

/** sql.js, fetched once per session. */
let runtime: Promise<SqlJsStatic> | null = null;

/** Load the WebAssembly, once, only when a catalogue is actually opened. */
async function loadRuntime(): Promise<SqlJsStatic> {
  if (runtime === null) {
    runtime = import("sql.js").then((module) =>
      module.default({
        // Always our own copy, whatever name the bundled build asks for. Vite
        // resolves sql.js to its browser entry, which looks for
        // "sql-wasm-browser.wasm"; that is the same binary as "sql-wasm.wasm"
        // byte for byte, and shipping it twice would cost 672 KB to spell a
        // filename differently. Served from this origin so the app still works
        // offline once cached.
        locateFile: () => `${import.meta.env.BASE_URL}sql-wasm.wasm`,
      }),
    );
  }
  return runtime;
}

/** A catalogue, open for reading and writing. */
export interface CatalogDb {
  /** Write one completed run into the catalogue. */
  ingest(input: {
    batchId: string;
    source: string;
    model: string;
    records: readonly IntakeRecord[];
  }): void;
  /** Run a read-only query, for the page's own panels and for ad-hoc use. */
  query(sql: string): Array<Record<string, unknown>>;
  /** Counts worth showing without writing SQL. */
  stats(): { batches: number; candidates: number; cards: number; rejected: number };
  /** The file, for download. */
  toBytes(): Uint8Array;
  close(): void;
}

/** Escape a value for a single-quoted SQL literal. */
function literal(value: unknown): string {
  if (value === null || value === undefined) return "''";
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Open a catalogue: an existing file, or a fresh one.
 *
 * @param bytes - an existing .sqlite file, or undefined for a new catalogue
 */
export async function openCatalog(bytes?: Uint8Array): Promise<CatalogDb> {
  const SQL = await loadRuntime();
  const db: Database = bytes === undefined ? new SQL.Database() : new SQL.Database(bytes);
  db.run(SCHEMA);

  const query = (sql: string): Array<Record<string, unknown>> => {
    const results = db.exec(sql);
    if (results.length === 0) return [];
    const { columns, values } = results[0]!;
    return values.map((row) =>
      Object.fromEntries(columns.map((column, index) => [column, row[index]])),
    );
  };

  return {
    query,

    ingest({ batchId, source, model, records }) {
      db.run("BEGIN");
      try {
        db.run(
          `INSERT OR REPLACE INTO batches (id, source, ingested_at, model)
           VALUES (${literal(batchId)}, ${literal(source)}, ${literal(new Date().toISOString())}, ${literal(model)})`,
        );
        for (const record of records) {
          db.run(
            `INSERT OR REPLACE INTO candidates (id, batch_id, word, verdict, repaired, raw)
             VALUES (${literal(record.id)}, ${literal(batchId)}, ${literal(record.word)},
                     ${literal(record.verdict)}, ${record.repaired === true ? 1 : 0},
                     ${literal(JSON.stringify(record.raw))})`,
          );
          db.run(`DELETE FROM findings WHERE candidate_id = ${literal(record.id)}`);
          for (const finding of record.findings) {
            db.run(
              `INSERT INTO findings (candidate_id, stage, field, severity, message)
               VALUES (${literal(record.id)}, ${literal(finding.stage)}, ${literal(finding.field)},
                       ${literal(finding.severity)}, ${literal(finding.message)})`,
            );
          }
          // A card row exists only for an accepted candidate. That is the whole
          // point of the separation, so it is enforced here rather than assumed.
          if (record.verdict !== "accepted" || record.card === null) continue;
          const card = record.card;
          db.run(
            `INSERT OR REPLACE INTO cards
               (id, candidate_id, batch_id, word, pos, ipa, level, meaning_vi, def_vi,
                lead_vi, anticipate_vi, usage_en, usage_vi, accepted_at)
             VALUES (${literal(card.id)}, ${literal(record.id)}, ${literal(batchId)},
                     ${literal(card.word)}, ${literal(card.pos)}, ${literal(card.ipa)},
                     ${literal(card.level)}, ${literal(card.meaningVi)}, ${literal(card.defVi)},
                     ${literal(card.leadVi)}, ${literal(card.anticipateVi)},
                     ${literal(card.usage[0]?.en ?? "")}, ${literal(card.usage[0]?.vi ?? "")},
                     ${literal(new Date().toISOString())})`,
          );
          db.run(`DELETE FROM card_topics WHERE card_id = ${literal(card.id)}`);
          for (const topic of card.topics) {
            db.run(
              `INSERT INTO card_topics (card_id, topic) VALUES (${literal(card.id)}, ${literal(topic)})`,
            );
          }
          db.run(`DELETE FROM card_exams WHERE card_id = ${literal(card.id)}`);
          for (const exam of card.exams) {
            db.run(
              `INSERT INTO card_exams (card_id, exam) VALUES (${literal(card.id)}, ${literal(exam)})`,
            );
          }
        }
        db.run("COMMIT");
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }
    },

    stats() {
      const one = (sql: string): number => Number(query(sql)[0]?.n ?? 0);
      return {
        batches: one("SELECT COUNT(*) AS n FROM batches"),
        candidates: one("SELECT COUNT(*) AS n FROM candidates"),
        cards: one("SELECT COUNT(*) AS n FROM cards"),
        rejected: one("SELECT COUNT(*) AS n FROM candidates WHERE verdict = 'rejected'"),
      };
    },

    toBytes: () => db.export(),
    close: () => db.close(),
  };
}

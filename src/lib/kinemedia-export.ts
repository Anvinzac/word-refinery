/**
 * The verified catalogue, as the file KineMedia imports.
 *
 * The catalogue's `cards` table is the only population that counts as verified:
 * a row there passed every gate. This module reads that table and writes the
 * agreed hand-off format (docs/kinemedia-export.md, mirrored in KineMedia as
 * docs/word-refinery-import.md). The format is KineMedia's own deck shape plus a
 * stamped header, so its importer validates it with the same schema every other
 * deck goes through, and nothing here has to know about share codes, packs or
 * ids already in use there — the importer owns those.
 *
 * Kept pure: the browser button and the Node script both hand in a query
 * function over an open database.
 *
 * Exports: KINEMEDIA_FORMAT, KINEMEDIA_FORMAT_VERSION, VERIFIED_CARDS_SQL,
 *          VerifiedCardRow, KineMediaWord, KineMediaDeck, KineMediaExportReport,
 *          buildKineMediaDeck, exportCatalogForKineMedia
 * Depends on: ./deck.ts, ./joiner.ts, ./types.ts
 */
import { slugifyWord } from "./deck.ts";
import { stripMarks } from "./joiner.ts";
import { CEFR_LEVELS, type CefrLevel } from "./types.ts";

/** Stamped into the header so KineMedia can refuse a file it was not written for. */
export const KINEMEDIA_FORMAT = "word-refinery.kinemedia-deck";
/** Bumped on any change a version-1 importer would misread. */
export const KINEMEDIA_FORMAT_VERSION = 1;

/** A tag list travels as one column; the unit separator cannot occur in a slug. */
const TAG_SEPARATOR = "\u001f";

/**
 * Every verified card with what the export needs from around it.
 *
 * The highlight triple is not a column of `cards`, so it is read from the
 * candidate's `raw` — which a repair pass rewrites along with the card, so it
 * is the text that was verified, not the text that first arrived. Tags keep
 * insertion order because the first topic is the word's primary one.
 */
export const VERIFIED_CARDS_SQL = `
SELECT c.id AS card_id, c.batch_id, c.word, c.pos, c.ipa, c.level,
       c.meaning_vi, c.def_vi, c.lead_vi, c.anticipate_vi, c.usage_en, c.usage_vi,
       c.accepted_at, cand.raw AS raw,
       (SELECT group_concat(topic, char(31)) FROM
          (SELECT topic FROM card_topics WHERE card_id = c.id ORDER BY rowid)) AS topics,
       (SELECT group_concat(exam, char(31)) FROM
          (SELECT exam FROM card_exams WHERE card_id = c.id ORDER BY rowid)) AS exams
FROM cards c
JOIN candidates cand ON cand.id = c.candidate_id
WHERE cand.verdict = 'accepted'
ORDER BY c.accepted_at, c.rowid`;

/** One row of VERIFIED_CARDS_SQL. */
export interface VerifiedCardRow {
  card_id: string;
  batch_id: string;
  word: string;
  pos: string;
  ipa: string;
  level: string;
  meaning_vi: string;
  def_vi: string;
  lead_vi: string;
  anticipate_vi: string;
  usage_en: string;
  usage_vi: string;
  accepted_at: string;
  raw: string;
  topics: string | null;
  exams: string | null;
}

/** One word in KineMedia's deck shape. */
export interface KineMediaWord {
  id: string;
  word: string;
  pos: string;
  ipa: string;
  level: CefrLevel;
  meaningVi: string;
  defVi: string;
  leadVi: string;
  anticipateVi: string;
  // NO `emphasis` ARRAY. KineMedia's own schema marks it [LEGACY] and says the
  // feed renderer no longer reads it: the highlights that reach a reader are
  // the inline `/…/` markers, which `coerceDeckWord` has already placed inside
  // defVi and leadVi before the card reached the catalogue. Sending the array
  // as well was duplication that could only cost us — `reign`'s third
  // highlight is the year "1010", and `emphasisPhrase` requires letters, so one
  // card in 4,889 made normalizeDeck refuse the whole file.
  usage: Array<{ en: string; vi: string }>;
  topics: string[];
  exams: string[];
  /** Where the card came from, so a word on the feed can be traced back. */
  source: { batchId: string; cardId: string; acceptedAt: string };
}

/** The whole hand-off file. */
export interface KineMediaDeck {
  meta: {
    format: typeof KINEMEDIA_FORMAT;
    formatVersion: typeof KINEMEDIA_FORMAT_VERSION;
    name: string;
    /** `en_<gloss>`: English headwords, glossed in that language. */
    locale: string;
    gloss: string;
    exportedAt: string;
    catalogSchemaVersion: number;
    batches: string[];
    count: number;
  };
  words: KineMediaWord[];
}

/** What the export did that a reviewer should know about. */
export interface KineMediaExportReport {
  exported: number;
  /** The same headword verified more than once: the latest wins. */
  superseded: Array<{ word: string; kept: string; dropped: string }>;
  /** Highlights that no longer occur in their sentence, left out rather than shipped dark. */
  emphasisDropped: Array<{ word: string; field: string; phrase: string }>;
  /** Rows that could not become a word at all. */
  skipped: Array<{ word: string; reason: string }>;
}

const EMPHASIS_FIELDS = ["defVi", "leadVi", "anticipateVi"] as const;

/** Text the way the reader sees it: highlight slashes and breaking marks gone. */
function plain(text: string): string {
  return stripMarks(text.replace(/\/([^/]+)\//g, "$1")).toLowerCase();
}

function tags(column: string | null): string[] {
  return column ? [...new Set(column.split(TAG_SEPARATOR).filter(Boolean))] : [];
}

function emphasisOf(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as { emphasisVi?: unknown };
    return Array.isArray(parsed.emphasisVi) ? parsed.emphasisVi : [];
  } catch {
    return [];
  }
}

/**
 * Turn verified rows into the hand-off deck.
 *
 * @param rows - VERIFIED_CARDS_SQL output, oldest first
 * @param options.gloss - the workspace's gloss language id ("vi", "ja")
 * @param options.catalogSchemaVersion - the catalogue's stamped schema version
 * @param options.exportedAt - ISO time, injectable for tests
 */
export function buildKineMediaDeck(
  rows: readonly VerifiedCardRow[],
  options: { gloss: string; catalogSchemaVersion: number; exportedAt?: string; name?: string },
): { deck: KineMediaDeck; report: KineMediaExportReport } {
  const report: KineMediaExportReport = { exported: 0, superseded: [], emphasisDropped: [], skipped: [] };
  const byHead = new Map<string, KineMediaWord>();

  for (const row of rows) {
    const head = row.word.trim().toLowerCase();
    if (!head) {
      report.skipped.push({ word: row.card_id, reason: "no headword" });
      continue;
    }
    if (!(CEFR_LEVELS as readonly string[]).includes(row.level)) {
      report.skipped.push({ word: row.word, reason: `level "${row.level}" is not a CEFR band` });
      continue;
    }
    const text = { defVi: row.def_vi, leadVi: row.lead_vi, anticipateVi: row.anticipate_vi };
    // The highlights are not sent, only CHECKED: each should already be inline
    // in the field it belongs to. One that is not present at all is reported,
    // because it means the card was verified carrying a highlight the reader
    // will never see.
    emphasisOf(row.raw).forEach((entry, index) => {
      const field = EMPHASIS_FIELDS[index];
      if (field === undefined || typeof entry !== "string" || !entry.trim()) return;
      if (!plain(text[field]).includes(plain(entry))) {
        report.emphasisDropped.push({ word: row.word, field, phrase: entry });
      }
    });

    const word: KineMediaWord = {
      id: slugifyWord(row.word),
      word: row.word.trim(),
      pos: row.pos,
      ipa: row.ipa,
      level: row.level as CefrLevel,
      meaningVi: row.meaning_vi,
      ...text,
      usage: row.usage_en ? [{ en: row.usage_en, vi: row.usage_vi }] : [],
      topics: tags(row.topics),
      exams: tags(row.exams),
      source: { batchId: row.batch_id, cardId: row.card_id, acceptedAt: row.accepted_at },
    };
    const earlier = byHead.get(head);
    if (earlier) {
      report.superseded.push({ word: row.word, kept: row.batch_id, dropped: earlier.source.batchId });
      byHead.delete(head);
    }
    byHead.set(head, word);
  }

  const words = [...byHead.values()];
  report.exported = words.length;
  return {
    deck: {
      meta: {
        format: KINEMEDIA_FORMAT,
        formatVersion: KINEMEDIA_FORMAT_VERSION,
        name: options.name ?? `Word Refinery verified (en_${options.gloss})`,
        locale: `en_${options.gloss}`,
        gloss: options.gloss,
        exportedAt: options.exportedAt ?? new Date().toISOString(),
        catalogSchemaVersion: options.catalogSchemaVersion,
        batches: [...new Set(words.map((word) => word.source.batchId))].sort(),
        count: words.length,
      },
      words,
    },
    report,
  };
}

/**
 * Export an open catalogue.
 *
 * @param query - a read-only query over the catalogue (CatalogDb.query, or sql.js in Node)
 */
export function exportCatalogForKineMedia(
  query: (sql: string) => Array<Record<string, unknown>>,
  options: { gloss: string; exportedAt?: string; name?: string },
): { deck: KineMediaDeck; report: KineMediaExportReport } {
  let stamp: unknown;
  try {
    stamp = query("SELECT value FROM meta WHERE key = 'schema_version'")[0]?.value;
  } catch {
    // No meta table: a file from before the stamp, which is schema 1 by definition.
  }
  const rows = query(VERIFIED_CARDS_SQL) as unknown as VerifiedCardRow[];
  return buildKineMediaDeck(rows, {
    ...options,
    catalogSchemaVersion: stamp === undefined ? 1 : Number(stamp),
  });
}

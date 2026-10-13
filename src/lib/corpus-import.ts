/**
 * Corpus importer — turn an official word-list download into a usable corpus.
 *
 * The bundled starter subset is 381 words, which runs dry about seven weeks
 * into a fifty-a-week cadence. This is the supported way past that: the
 * operator downloads the official list themselves and loads it here. Data
 * volume stays a file, never a code change, and because the lists are CC BY-SA
 * the importer insists on license and attribution text rather than guessing.
 *
 * Ported from word-crawler's `corpus-import.ts` so both tools read the same
 * files and band them the same way. The one deliberate difference is the CEFR
 * mapping: word-crawler maps three coarse bands, while a rank-bearing list has
 * the resolution for five, and the level filter is central enough here to be
 * worth the extra granularity. Both are product heuristics, not claims by the
 * list authors.
 *
 * Exports: ImportedRow, ImportSummary, ImportOptions, parseImportList,
 *          bandForRank, levelForRank, levelForBand, buildCorpus, OXFORD_REFUSAL
 * Depends on: ./types.ts
 */
import type { CefrLevel, Corpus, CorpusWord } from "./types.ts";

/** One usable row of an imported list. */
export interface ImportedRow {
  word: string;
  rank: number | null;
}

/** Counts describing what an import parsed and skipped. */
export interface ImportSummary {
  rowsSkipped: number;
  duplicatesDropped: number;
  wordsKept: number;
}

/** Caller-supplied provenance. Every license field is copied into the corpus meta. */
export interface ImportOptions {
  /** Corpus name, e.g. "NGSL 1.2 (full)". */
  name: string;
  /** Source id stamped on every word, e.g. "ngsl". */
  source: string;
  /** Human-readable license name. Required: these lists are CC BY-SA 4.0. */
  license: string;
  /** License URL. */
  licenseUrl: string;
  /** Attribution line reproduced in the corpus meta. */
  attribution: string;
  /** Optional upstream URL. */
  url?: string;
  /** Force one CEFR level for every word instead of the rank mapping. */
  level?: CefrLevel;
}

/**
 * Column names that appear in official export headers ("Rank,Word,Frequency,…").
 * A row counts as a header when it has at least two cells and every one of them
 * is a known column name — the length guard keeps a bare word line such as
 * "list" usable in files that carry no ranks.
 */
const HEADER_CELLS = new Set([
  "rank", "word", "words", "wordlist", "list", "frequency", "freq", "dispersion",
  "pos", "lemma", "definition", "meaning", "translation", "no", "index", "order",
  "level", "cefr", "band", "count", "percent", "coverage", "statistics", "stat",
]);

/** Refusal message for a list this project has committed never to redistribute. */
export const OXFORD_REFUSAL =
  "The Oxford 3000/5000 lists are not redistributable and must never enter this project — " +
  "see NOTICE.md. Import a CC BY-SA list such as NGSL or NAWL instead.";

/** True when every cell of a multi-cell row is a known column name. */
function isHeaderRow(cells: readonly string[]): boolean {
  const named = cells.filter((cell) => cell.length > 0);
  return named.length >= 2 && named.every((cell) => HEADER_CELLS.has(cell.toLowerCase()));
}

/** Lowercase and strip anything that is not part of an English headword. */
function normalizeWord(value: string): string {
  return value.trim().toLowerCase().replace(/^["']+|["']+$/g, "");
}

/**
 * Parse a CSV/TSV word list into rows.
 *
 * Deliberately forgiving, because official files change layout between
 * releases: each line is split on tab (or comma when the file has no tab), the
 * first cell that looks like an English word becomes the headword, and the
 * first numeric cell becomes the rank. Headers, comments and unrelated rows are
 * skipped rather than failing the import.
 *
 * @param text - raw file contents
 * @returns usable rows in file order, duplicates collapsed to their best rank
 */
export function parseImportList(text: string): { rows: ImportedRow[]; summary: ImportSummary } {
  const lines = text.split(/\r?\n/);
  const delimiter = text.includes("\t") ? "\t" : ",";
  const byWord = new Map<string, ImportedRow>();
  let rowsSkipped = 0;
  let duplicatesDropped = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const cells = trimmed.split(delimiter).map((cell) => cell.trim().replace(/^"(.*)"$/, "$1"));

    if (isHeaderRow(cells)) {
      rowsSkipped += 1;
      continue;
    }

    const wordCell = cells.find((cell) => /^[A-Za-z][A-Za-z'’-]*$/.test(cell));
    if (wordCell === undefined) {
      rowsSkipped += 1;
      continue;
    }

    const word = normalizeWord(wordCell);
    if (word.length < 2) {
      // Single letters are not useful feed words.
      rowsSkipped += 1;
      continue;
    }

    const rankCell = cells.find((cell) => /^\d{1,7}$/.test(cell));
    const rank = rankCell === undefined ? null : Number(rankCell);

    const previous = byWord.get(word);
    if (previous === undefined) {
      byWord.set(word, { word, rank });
      continue;
    }
    duplicatesDropped += 1;
    if (rank !== null && (previous.rank === null || rank < previous.rank)) {
      byWord.set(word, { word, rank });
    }
  }

  const rows = [...byWord.values()];
  return { rows, summary: { rowsSkipped, duplicatesDropped, wordsKept: rows.length } };
}

/**
 * Map an official frequency rank to this project's coarse band.
 * Kept identical to word-crawler so a corpus file means the same thing in both.
 *
 * @param rank - 1-based frequency rank, or null when the list carries none
 * @returns band 1 (top 1000), 2 (1001-2000) or 3 (2001 and beyond)
 */
export function bandForRank(rank: number | null): number {
  if (rank === null || rank <= 0) return 3;
  if (rank <= 1000) return 1;
  if (rank <= 2000) return 2;
  return 3;
}

/** Coarse band → CEFR, used when a list carries no ranks at all. */
export function levelForBand(band: number): CefrLevel {
  if (band === 1) return "A2";
  if (band === 2) return "B1";
  return "B2";
}

/**
 * Map a frequency rank to a CEFR level.
 *
 * Finer than the band mapping because a ranked list supports it, and because
 * the level filter is how a reviewer aims a weekly batch. The thresholds are a
 * documented product heuristic: no official list tags words with CEFR levels.
 *
 * @param rank - 1-based frequency rank, or null when unranked
 * @returns the band this project treats the word as belonging to
 */
export function levelForRank(rank: number | null): CefrLevel {
  if (rank === null || rank <= 0) return levelForBand(3);
  if (rank <= 500) return "A1";
  if (rank <= 1000) return "A2";
  if (rank <= 2000) return "B1";
  if (rank <= 2800) return "B2";
  return "C1";
}

/**
 * Build a corpus document from a parsed list.
 *
 * @param text - raw file contents
 * @param options - provenance; license and attribution are required
 * @returns the corpus plus what the parse skipped
 * @throws when attribution is missing, or the list is one we may not carry
 */
export function buildCorpus(
  text: string,
  options: ImportOptions,
): { corpus: Corpus; summary: ImportSummary } {
  if (options.license.trim().length === 0 || options.attribution.trim().length === 0) {
    throw new Error(
      "An import needs a license and an attribution line: NGSL/NAWL are CC BY-SA 4.0 and " +
        "redistributing them requires crediting the authors.",
    );
  }
  // The project has committed in writing never to carry Oxford data, so the
  // commitment is enforced here rather than left to whoever runs the import.
  const declared = `${options.name} ${options.attribution} ${options.source} ${options.url ?? ""}`;
  if (/\boxford\b/i.test(declared)) throw new Error(OXFORD_REFUSAL);

  const { rows, summary } = parseImportList(text);
  if (rows.length === 0) {
    throw new Error("No usable words found. Expected a CSV or TSV with one word per row.");
  }

  const words: CorpusWord[] = rows.map((row) => ({
    word: row.word,
    pos: "",
    level: options.level ?? levelForRank(row.rank),
    band: bandForRank(row.rank),
    source: options.source,
  }));

  const ranked = rows.filter((row) => row.rank !== null).length;
  const corpus: Corpus = {
    meta: {
      name: options.name,
      version: "imported",
      kind: options.level ? "imported-official-list" : "imported-official-list-band-mapped",
      locale: "en",
      license: options.license,
      licenseUrl: options.licenseUrl,
      derivedFrom: options.attribution,
      disclaimer:
        "Imported from an official download in the browser. Bands are coarse frequency tiers and " +
        "CEFR levels are this project's documented heuristic" +
        (options.level
          ? ` (overridden to ${options.level} for this import).`
          : ", not an official claim by the list authors.") +
        ` ${ranked} of ${rows.length} words carried a rank.`,
      sources: [
        {
          id: options.source,
          name: options.name,
          authors: options.attribution,
          url: options.url ?? "",
          license: options.license,
          licenseUrl: options.licenseUrl,
          note: "Imported in word-refinery. Keep this attribution with the data.",
        },
      ],
      wordCount: words.length,
    },
    words,
  };

  return { corpus, summary: { ...summary, wordsKept: words.length } };
}

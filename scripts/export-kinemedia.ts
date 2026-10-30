/**
 * Export a downloaded catalogue (.sqlite) as the file KineMedia imports.
 *
 * Usage:
 *   npm run export:kinemedia -- <word-catalog.sqlite> [--out <file.json>] [--gloss vi]
 *
 * The same conversion as the Intake tab's "Export for KineMedia" button, for a
 * catalogue that lives as a file rather than in this browser. Read-only: the
 * catalogue is opened, queried and closed, never written.
 *
 * Then, in KineMedia: npm run vocab:import -- <file.json>
 * (There is no `vocab:import-refinery`; the export is an ordinary deck to
 * KineMedia's importer, which is the point of matching its shape.)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import initSqlJs from "sql.js";

import { exportCatalogForKineMedia } from "../src/lib/kinemedia-export.ts";

const argv = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = argv[at + 1] ?? fallback;
  argv.splice(at, 2);
  return value;
}
const out = resolve(flag("out", "word-refinery-kinemedia.json"));
const gloss = flag("gloss", "vi");
const input = argv[0];
if (!input || argv.length !== 1) {
  console.error("Usage: npm run export:kinemedia -- <word-catalog.sqlite> [--out <file.json>] [--gloss vi]");
  process.exit(1);
}

const SQL = await initSqlJs();
const db = new SQL.Database(readFileSync(resolve(input)));
const query = (sql: string): Array<Record<string, unknown>> => {
  const results = db.exec(sql);
  if (results.length === 0) return [];
  const { columns, values } = results[0]!;
  return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
};

const { deck, report } = exportCatalogForKineMedia(query, { gloss });
db.close();
if (deck.words.length === 0) {
  console.error("The catalogue holds no verified cards; nothing to export.");
  process.exit(1);
}
writeFileSync(out, `${JSON.stringify(deck, null, 2)}\n`);

console.log(`Exported ${report.exported} verified word(s) from ${deck.meta.batches.length} batch(es) → ${out}`);
for (const item of report.superseded) {
  console.log(`  "${item.word}" was verified again in ${item.kept}; the ${item.dropped} card is left out`);
}
for (const item of report.emphasisDropped) {
  console.log(`  "${item.word}": highlight "${item.phrase}" is not in ${item.field}, left out`);
}
for (const item of report.skipped) console.log(`  skipped "${item.word}": ${item.reason}`);

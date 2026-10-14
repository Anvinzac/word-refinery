/**
 * Bundle every batch file in data/batches/ into public/default-deck.json, the
 * dataset the site ships with.
 *
 * Each file becomes one batch: its words are stamped with a `batchId` taken
 * from the file name, so the batch picker lists them separately, and with the
 * CEFR level the name carries ("deck-v3-A1", "vocab_b2_100"), because the raw
 * model output has no level field of its own. A word that appears in two files
 * stays in both batches; the app gives the second copy its own id.
 *
 * `addedAt` only orders the picker: files are stamped a minute apart in name
 * order, the first file newest, so the menu reads in the same order as the
 * folder and opens on the first file.
 *
 * Run with `npm run bundle-batches` after adding or replacing a file.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const SOURCE = "data/batches";
const TARGET = "public/default-deck.json";
const ORIGIN = Date.parse("2026-10-14T12:00:00Z");

const files = readdirSync(SOURCE)
  .filter((name) => name.endsWith(".json"))
  .sort();

const words = [];
files.forEach((file, index) => {
  const batchId = basename(file, ".json");
  const level = /(?:^|[-_])([abc][12])(?:[-_.]|$)/i.exec(batchId)?.[1]?.toUpperCase();
  if (level === undefined) throw new Error(`${file}: no CEFR level (A1-C2) in the file name`);
  const parsed = JSON.parse(readFileSync(join(SOURCE, file), "utf8"));
  const list = Array.isArray(parsed) ? parsed : parsed.words;
  if (!Array.isArray(list)) throw new Error(`${file}: expected an array of words`);
  const addedAt = new Date(ORIGIN - index * 60_000).toISOString();
  for (const word of list) words.push({ ...word, level, batchId, addedAt });
  console.log(`${batchId.padEnd(22)} ${level}  ${list.length} words`);
});

writeFileSync(TARGET, `${JSON.stringify(words)}\n`);
console.log(`${files.length} batches, ${words.length} words → ${TARGET}`);

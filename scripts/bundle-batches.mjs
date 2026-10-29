/**
 * Bundle every batch file in data/batches/ into public/default-deck.json, the
 * dataset the site ships with.
 *
 * Each file becomes one batch: its words are stamped with a `batchId` taken
 * from the file name, so the batch picker lists them separately. A word that
 * appears in two files stays in both batches; the app gives the second copy
 * its own id.
 *
 * WHERE THE LEVEL COMES FROM. A card written to card-prompt v3.7 carries no
 * `level` field — the prompt passes the level IN and forbids it in the output,
 * so the batch alone cannot say what it is. Two sources, in order:
 *
 *   1. A sibling manifest, `<batch>.meta.json`: one row per card, in the same
 *      order, carrying the id, the headword and the level the card was asked
 *      for. This is the better source. It gives a per-word level rather than
 *      one for the whole file, and its ids carry back to the generator's own
 *      numbering, so "A101-007" means the same thing here and there. The
 *      manifest is checked against the cards by word, position by position: a
 *      manifest that has drifted out of step would otherwise relabel cards
 *      silently, which is worse than having no manifest at all.
 *   2. Failing that, the CEFR level in the file name ("deck-v3-A1",
 *      "vocab_b2_100"), which is how the files that predate manifests work.
 *
 * `addedAt` only orders the picker: files are stamped a minute apart in name
 * order, the first file newest, so the menu reads in the same order as the
 * folder and opens on the first file.
 *
 * Run with `npm run bundle-batches` after adding or replacing a file.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const SOURCE = "data/batches";
const TARGET = "public/default-deck.json";
const ORIGIN = Date.parse("2026-10-29T12:00:00Z");

const files = readdirSync(SOURCE)
  .filter((name) => name.endsWith(".json") && !name.endsWith(".meta.json"))
  .sort();

/**
 * The manifest beside a batch, checked against it.
 *
 * @param batchId - the batch's file name without its extension
 * @param cards - the cards as read, in file order
 * @returns one row per card, or null when there is no manifest
 */
function readManifest(batchId, cards) {
  const path = join(SOURCE, `${batchId}.meta.json`);
  if (!existsSync(path)) return null;
  const rows = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(rows)) throw new Error(`${batchId}.meta.json: expected an array of rows`);
  if (rows.length !== cards.length) {
    throw new Error(
      `${batchId}: ${cards.length} cards but ${rows.length} manifest rows — one of them is stale`,
    );
  }
  rows.forEach((row, index) => {
    if (row.word !== cards[index].word) {
      throw new Error(
        `${batchId} row ${index + 1}: the manifest says "${row.word}", the card says "${cards[index].word}"`,
      );
    }
  });
  return rows;
}

const words = [];
files.forEach((file, index) => {
  const batchId = basename(file, ".json");
  const parsed = JSON.parse(readFileSync(join(SOURCE, file), "utf8"));
  const list = Array.isArray(parsed) ? parsed : parsed.words;
  if (!Array.isArray(list)) throw new Error(`${file}: expected an array of words`);

  const manifest = readManifest(batchId, list);
  const named = /(?:^|[-_])([abc][12])(?:[-_.]|$)/i.exec(batchId)?.[1]?.toUpperCase();
  if (manifest === null && named === undefined) {
    throw new Error(`${file}: no manifest beside it and no CEFR level (A1-C2) in the file name`);
  }

  const addedAt = new Date(ORIGIN - index * 60_000).toISOString();
  list.forEach((word, position) => {
    const row = manifest?.[position];
    const level = row?.level ?? named;
    if (level === undefined) throw new Error(`${file} row ${position + 1}: no level`);
    // The id is spread FIRST so a card that carries its own still wins; the
    // manifest only supplies one where the card has none.
    words.push({ ...(row?.id === undefined ? {} : { id: row.id }), ...word, level, batchId, addedAt });
  });

  const levels = [...new Set(list.map((_, position) => manifest?.[position]?.level ?? named))];
  console.log(
    `${batchId.padEnd(16)} ${levels.join("/").padEnd(6)} ${String(list.length).padStart(3)} words` +
      (manifest === null ? "  (level from the file name)" : "  (level and ids from the manifest)"),
  );
});

writeFileSync(TARGET, `${JSON.stringify(words)}\n`);
console.log(`${files.length} batches, ${words.length} words → ${TARGET}`);

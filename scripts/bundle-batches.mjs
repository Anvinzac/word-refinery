/**
 * Bundle every batch file into the dataset its workspace ships with:
 * data/batches/ -> public/default-deck.json (Vietnamese cards),
 * data/batches-ja/ -> public/default-deck-ja.json (Japanese cards).
 *
 * One deck per gloss language, because a deck of Vietnamese cards loaded into a
 * workspace started for Japanese is the loudest possible interference between
 * two workspaces. The app picks the file by the open workspace's language.
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
 * `addedAt` only orders the picker, and it runs FORWARD through the folder:
 * files are stamped a minute apart in name order, the LAST one newest. The
 * batch names carry their own order (A101, A102, ... A108, A201), so the last
 * name is the batch that arrived last, and the picker opens on it.
 *
 * It used to run the other way, which was fine when every batch landed at once
 * and wrong as soon as they arrive weekly: adding next week's batch put it at
 * the bottom of the menu and left the picker opening on a batch from months
 * ago.
 *
 * Run with `npm run bundle-batches` after adding or replacing a file.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const ORIGIN = Date.parse("2026-10-29T12:00:00Z");

/** One deck per gloss language: where its batches live and where it is written. */
const DECKS = [
  { gloss: "vi", source: "data/batches", target: "public/default-deck.json" },
  { gloss: "ja", source: "data/batches-ja", target: "public/default-deck-ja.json" },
];

/**
 * Flatten a card that carries several reader registers down to one.
 *
 * The Japanese rules (v3.9) emit a NESTED card: one English entry holding a
 * `levels` block per reader group - JPRIM 小学生, JSEC 中学生, JHIGH 高校生,
 * JCOLL 大学生 - all telling the same scene with the same definition idea, and
 * differing only in script and difficulty. The app has one card per word, so
 * the card it gets is the register the pack itself declares as its default.
 *
 * The other registers are NOT lost: they stay in data/batches-ja/, which is
 * where re-bundling reads from. They are left out of the deck because the app
 * normalises a word down to the fields it knows (see `coerceDeckWord`), so an
 * extra register carried through public/ would be weight that never arrives.
 *
 * The field names differ too - meaningJP, defJa, leadJa - but only in name:
 * they are the same card slots, and the app's slots have carried Vietnamese
 * names since before a second language existed.
 *
 * @param card - one entry as the pack delivers it
 * @returns the flat card, or the card unchanged when it has no registers
 */
function flattenRegisters(card) {
  if (card === null || typeof card !== "object" || typeof card.levels !== "object") return card;
  const code = card.defaultLevel;
  const body = card.levels?.[code];
  if (body === undefined) {
    throw new Error(`${card.word}: defaultLevel is "${code}", which is not one of its levels`);
  }
  return {
    word: card.word,
    pos: card.pos,
    ipa: card.ipa,
    meaningVi: body.meaningJP,
    defVi: body.defJa,
    leadVi: body.leadJa,
    anticipateVi: body.anticipateJa,
    usageEn: card.usageEn,
    usageVi: body.usageJa,
    topics: card.topics,
    exams: card.exams,
    emphasisVi: body.emphasisJa,
  };
}

/**
 * The manifest beside a batch, checked against it.
 *
 * @param batchId - the batch's file name without its extension
 * @param cards - the cards as read, in file order
 * @returns one row per card, or null when there is no manifest
 */
function readManifest(source, batchId, cards) {
  const path = join(source, `${batchId}.meta.json`);
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

for (const { gloss, source, target } of DECKS) {
  if (!existsSync(source)) continue;
  const files = readdirSync(source)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".meta.json"))
    .sort();
  const words = [];
  files.forEach((file, index) => {
  const batchId = basename(file, ".json");
  const parsed = JSON.parse(readFileSync(join(source, file), "utf8"));
  const raw = Array.isArray(parsed) ? parsed : parsed.words;
  if (!Array.isArray(raw)) throw new Error(`${file}: expected an array of words`);
  const list = raw.map(flattenRegisters);

  const manifest = readManifest(source, batchId, list);
  const named = /(?:^|[-_])([abc][12])(?:[-_.]|$)/i.exec(batchId)?.[1]?.toUpperCase();
  if (manifest === null && named === undefined) {
    throw new Error(`${file}: no manifest beside it and no CEFR level (A1-C2) in the file name`);
  }

  const addedAt = new Date(ORIGIN + index * 60_000).toISOString();
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

  writeFileSync(target, `${JSON.stringify(words)}\n`);
  console.log(`${gloss}: ${files.length} batches, ${words.length} words → ${target}\n`);
}

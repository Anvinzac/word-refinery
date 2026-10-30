/**
 * Tests for the KineMedia hand-off export.
 *
 * What matters is that only verified cards leave, in the shape KineMedia's
 * schema reads, with the positional highlight triple carried across and a stale
 * highlight left out rather than shipped glowing nothing. Run with `npm test`.
 *
 * Depends on: node:test, sql.js, ../src/lib/intake-db.ts, ../src/lib/kinemedia-export.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import initSqlJs from "sql.js";

import { CATALOG_SCHEMA_SQL } from "../src/lib/intake-db.ts";
import {
  KINEMEDIA_FORMAT,
  KINEMEDIA_FORMAT_VERSION,
  exportCatalogForKineMedia,
} from "../src/lib/kinemedia-export.ts";

const card = {
  word: "interested",
  pos: "adj",
  ipa: "/ˈɪn.trə.stɪd/",
  meaningVi: "quan_tâm",
  defVi: "Thấy chủ_đề hấp_dẫn | nên muốn tìm_hiểu thêm.",
  leadVi: "Nghe giảng về vũ_trụ, Minh hỏi thầy | đến hết giờ.",
  anticipateVi: "Nghe cho có, hay muốn đào sâu?",
  usageEn: "Are you _____ in music?",
  usageVi: "Bạn có quan_tâm đến âm_nhạc không?",
  emphasisVi: ["hấp dẫn", "hỏi", "đào"],
};

async function catalogue() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(CATALOG_SCHEMA_SQL);
  db.run("INSERT INTO meta VALUES ('schema_version', '1')");
  const add = (batch: string, id: string, verdict: string, raw: object, level = "A1", accepted = true) => {
    db.run("INSERT OR IGNORE INTO batches VALUES (?, ?, '2026-10-29', 'm')", [batch, batch]);
    db.run("INSERT INTO candidates VALUES (?, ?, ?, ?, 0, ?)", [
      `${batch}:${id}`, batch, (raw as { word: string }).word, verdict, JSON.stringify(raw),
    ]);
    if (!accepted) return;
    const r = raw as typeof card;
    db.run(
      `INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`${batch}-${id}`, `${batch}:${id}`, batch, r.word, r.pos, r.ipa, level, r.meaningVi,
        r.defVi, r.leadVi, r.anticipateVi, r.usageEn, r.usageVi, `2026-10-29T0${batch.at(-1)}:00:00Z`],
    );
    db.run("INSERT INTO card_topics VALUES (?, 'emotion'), (?, 'attention')", [`${batch}-${id}`, `${batch}-${id}`]);
  };
  return { db, add };
}

function queryOf(db: import("sql.js").Database) {
  return (sql: string) => {
    const results = db.exec(sql);
    if (results.length === 0) return [];
    const { columns, values } = results[0]!;
    return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
  };
}

test("exports verified cards in KineMedia's deck shape, stamped", async () => {
  const { db, add } = await catalogue();
  add("A101", "1", "accepted", card);
  add("A101", "2", "rejected", { ...card, word: "boring" }, "A1", false);
  const { deck, report } = exportCatalogForKineMedia(queryOf(db), { gloss: "vi", exportedAt: "t" });

  assert.equal(deck.meta.format, KINEMEDIA_FORMAT);
  assert.equal(deck.meta.formatVersion, KINEMEDIA_FORMAT_VERSION);
  assert.equal(deck.meta.locale, "en_vi");
  assert.deepEqual(deck.meta.batches, ["A101"]);
  assert.equal(report.exported, 1);
  const [word] = deck.words;
  assert.equal(word!.id, "vi-interested", "the id is namespaced by gloss language");
  assert.equal(word!.defVi, card.defVi, "breaking marks travel untouched; KineMedia reads them");
  // No legacy `emphasis` array: KineMedia's feed does not read it, and the
  // highlights that do reach a reader are the inline markers already in defVi
  // and leadVi.
  assert.ok(!("emphasis" in word!), "the legacy array is not sent");
  // No derived fields: KineMedia marks chars/initial [DERIVED] and normalizeDeck
  // recomputes both from the headword, so the export must not claim values the
  // importer overwrites.
  assert.ok(!("chars" in word!), "chars is derived on import, never exported");
  assert.ok(!("initial" in word!), "initial is derived on import, never exported");
  assert.deepEqual(word!.usage, [{ en: card.usageEn, vi: card.usageVi }]);
  assert.deepEqual(word!.topics, ["emotion", "attention"], "first topic stays primary");
  assert.deepEqual(word!.source, { batchId: "A101", cardId: "A101-1", acceptedAt: "2026-10-29T01:00:00Z" });
});

test("a headword verified twice exports once, the later card winning", async () => {
  const { db, add } = await catalogue();
  add("A101", "1", "accepted", card);
  add("A202", "7", "accepted", { ...card, meaningVi: "hứng_thú" }, "A2");
  const { deck, report } = exportCatalogForKineMedia(queryOf(db), { gloss: "vi" });
  assert.equal(deck.words.length, 1);
  assert.equal(deck.words[0]!.meaningVi, "hứng_thú");
  assert.deepEqual(report.superseded, [{ word: "interested", kept: "A202", dropped: "A101" }]);
});

test("a highlight not present in its sentence is reported", async () => {
  // Nothing is "left out" any more, because nothing is sent — but a card
  // verified carrying a highlight its text does not contain is still worth
  // saying out loud, since that highlight will never reach a reader.
  const { db, add } = await catalogue();
  add("A101", "1", "accepted", { ...card, emphasisVi: ["hấp dẫn", "không có", "đào"] });
  const { deck, report } = exportCatalogForKineMedia(queryOf(db), { gloss: "vi" });
  assert.equal(deck.words.length, 1);
  assert.deepEqual(report.emphasisDropped, [{ word: "interested", field: "leadVi", phrase: "không có" }]);
});

test("the same headword under two glosses gets two ids that cannot collide", async () => {
  // Both decks teach the same English headwords and reuse the same batch names,
  // so an unprefixed id would be identical in both — and KineMedia's merge
  // de-dupes by id and headword, first wins, dropping the second deck silently.
  const vi = await catalogue();
  vi.add("A101", "1", "accepted", card);
  const ja = await catalogue();
  ja.add("A101", "1", "accepted", card);
  const viDeck = exportCatalogForKineMedia(queryOf(vi.db), { gloss: "vi" }).deck;
  const jaDeck = exportCatalogForKineMedia(queryOf(ja.db), { gloss: "ja" }).deck;
  assert.equal(viDeck.words[0]!.id, "vi-interested");
  assert.equal(jaDeck.words[0]!.id, "ja-interested");
  assert.notEqual(viDeck.words[0]!.id, jaDeck.words[0]!.id, "the gloss prefix separates them");
  assert.match(viDeck.words[0]!.id, /^[a-zA-Z0-9_-]+$/, "the id stays legal in KineMedia's schema");
});

# Word Refinery → KineMedia: the hand-off contract

**Mirrored in:** `KineMedia/docs/word-refinery-import.md`. Change both or neither.

Word Refinery verifies cards (its Intake tab: schema, content, safety, repair) and keeps
the ones that pass in a SQLite catalogue, table `cards`. Those verified words belong in
KineMedia's English deck. This is how they get here.

```
word-refinery catalogue (.sqlite, in the browser or downloaded)
   │  Intake tab → "Export for KineMedia"
   │  or: npm run export:kinemedia -- word-catalog.sqlite --out export.json
   ▼
export.json   (format below)
   │  KineMedia: npm run vocab:import -- export.json
   ▼
src/features/vocabulary/data/packs/refinery-en.json   (+ older packs trimmed, codes assigned)
```

## The file

KineMedia's own deck shape (`lib/schema.ts`, validated by `normalizeDeck`) plus a stamped
header. Only verified cards are in it: rows of `cards` whose candidate's verdict is
`accepted`.

```jsonc
{
  "meta": {
    "format": "word-refinery.kinemedia-deck", // refused if different
    "formatVersion": 1, // refused if different: bump on any breaking change
    "name": "Word Refinery verified (en_vi)",
    "locale": "en_vi", // English headwords, glossed in Vietnamese
    "gloss": "vi", // KineMedia only explains words in Vietnamese; "ja" is refused
    "exportedAt": "2026-10-29T12:00:00.000Z",
    "catalogSchemaVersion": 1,
    "batches": ["A101", "A102"],
    "count": 2,
  },
  "words": [
    {
      "id": "vi-interested", // the refinery slug, namespaced by gloss; KineMedia may replace it (below)
      "word": "interested",
      "pos": "adj",
      "ipa": "/ˈɪn.trə.stɪd/",
      "level": "A1", // CEFR, from the corpus, never from the model
      "meaningVi": "quan_tâm",
      "defVi": "Thấy chủ_đề /hấp_dẫn/ | nên muốn tìm_hiểu thêm.",
      "leadVi": "Nghe giảng về vũ_trụ, Minh /hỏi/ thầy | đến hết giờ.",
      "anticipateVi": "Nghe cho có, hay muốn đào sâu?",
      "usage": [{ "en": "Are you _____ in music?", "vi": "Bạn có quan_tâm đến âm_nhạc không?" }],
      "topics": ["attention", "emotion"], // first is primary; closed list shared via taxonomy.ts
      "exams": [],
      "source": { "batchId": "A101", "cardId": "A101-001", "acceptedAt": "…" },
    },
  ],
}
```

Rules both sides hold to:

- **The header is a stamp, and KineMedia enforces it.** `meta.format` must be
  `word-refinery.kinemedia-deck` and `meta.formatVersion` must not exceed the one the
  importer knows; `scripts/import-vocabulary.ts` refuses the file otherwise. A deck with
  no `meta.format` is an ordinary hand-authored file and still imports.
- **Text travels untouched.** `_` `=` `|` stay in the text; the reader handles all three
  (`lib/word-joiner.ts`). Nothing strips them on either side.
- **Highlights are inline, not an array.** The reader glows the `/…/` markers already
  inside `defVi` and `leadVi`; KineMedia's schema marks the old `emphasis` array `[LEGACY]`
  and its feed no longer reads it, so the export does not send one. It still CHECKS the
  verified `emphasisVi` triple: an entry that no longer occurs in its sentence is reported,
  because that highlight will never reach a reader.
- **Ids are namespaced by gloss language** — `vi-…`, `ja-…`. Both decks reuse the same
  batch names and teach the same English headwords, so an unprefixed id collides the day
  they meet, and KineMedia's merge de-dupes by id and headword (first wins, second dropped
  silently). The prefix is applied even while only Vietnamese ships.
- **No derived fields.** `chars` and `initial` are `[DERIVED]`: `normalizeDeck` recomputes
  both from the headword on every import, so the export omits them rather than claim values
  the importer overwrites.
- **One card per headword.** A word verified twice exports once, the later card winning.
- **No share codes, no KineMedia ids in the export.** The refinery cannot know them;
  the importer owns both.

## Where the file lands (KineMedia's side)

KineMedia owns the import, so its behaviour is documented there, not restated here — see
`KineMedia/docs/word-refinery-import.md`. In one line: `npm run vocab:import -- <file>`
runs it through `scripts/import-vocabulary.ts`, which refuses a wrong `meta.format`,
validates via `normalizeDeck`, and writes `catalog.json` (or a `--pack`) atomically. Share
codes, `meaningVi`, and the layout guards are separate steps KineMedia runs afterwards;
that mirror doc lists them in order.


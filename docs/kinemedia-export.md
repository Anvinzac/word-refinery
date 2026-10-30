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
      "id": "interested", // the refinery's slug; KineMedia may replace it (below)
      "word": "interested",
      "pos": "adj",
      "ipa": "/ˈɪn.trə.stɪd/",
      "level": "A1", // CEFR, from the corpus, never from the model
      "meaningVi": "quan_tâm",
      "defVi": "Thấy chủ_đề hấp_dẫn | nên muốn tìm_hiểu thêm.",
      "leadVi": "Nghe giảng về vũ_trụ, Minh hỏi thầy | đến hết giờ.",
      "anticipateVi": "Nghe cho có, hay muốn đào sâu?",
      "emphasis": ["hấp dẫn", "hỏi", "đào"], // [defVi, leadVi, anticipateVi] highlights
      "usage": [{ "en": "Are you _____ in music?", "vi": "Bạn có quan_tâm đến âm_nhạc không?" }],
      "topics": ["attention", "emotion"], // first is primary; closed list shared via taxonomy.ts
      "exams": [],
      "source": { "batchId": "A101", "cardId": "A101-001", "acceptedAt": "…" },
    },
  ],
}
```

Rules both sides hold to:

- **Text travels untouched.** `_` `=` `|` stay in the text; the reader handles all three
  (`lib/word-joiner.ts`). Nothing strips them on either side.
- **Emphasis** is the card's `emphasisVi` triple, read from the verified candidate. An
  entry that no longer occurs in its sentence is left out by the export (and reported),
  never shipped glowing nothing.
- **One card per headword.** A word verified twice exports once, the later card winning.
- **No share codes, no KineMedia ids in the export.** The refinery cannot know them;
  the importer owns both.

## Where each word lands (KineMedia's importer)

`lib/refinery-import.ts`, one rule per case:

| The headword is…              | Result                                                                  |
| ----------------------------- | ----------------------------------------------------------------------- |
| in `catalog.json`             | left out: the admin-edited base wins                                    |
| already in `refinery-en.json` | updated in place, same id and share code                                |
| in another pack               | **moved**: inherits the id and share code; the old copy leaves its pack |
| only in the share-code ledger | new, and gets its old code back                                         |
| nowhere                       | new; `assign-share-codes` gives it a code                               |

A word must exist once in the deck, and so must its code (`check:share-codes` reads the
files raw), so "moved" really removes the older copy. A pack left empty is deleted.
Words already in `refinery-en.json` but missing from an export are kept, because an
export may come from a catalogue that never held them.

The import validates everything before writing anything, writes each file atomically,
assigns share codes, restamps the pack revision and refreshes `data/level-ladder.json`.
Running it again on the same file writes the same bytes. `--dry` prints the plan only.

Afterwards: `npm test`, `npm run check:share-codes`, `npm run check:meanings`, then
rebuild.

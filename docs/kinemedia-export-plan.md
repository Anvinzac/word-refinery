# Making the export land perfectly in KineMedia

Read against KineMedia as it stands: `src/features/vocabulary/lib/schema.ts`,
`lib/word-joiner.ts`, `lib/catalog-source.ts`, `lib/target-language.ts`,
`lib/stages.ts`, `scripts/import-vocabulary.ts` and
`data/catalog.schema.jsonc`.

## Already true — do not re-plan these

Four things I expected to be work and are not:

- **All three marks are understood.** `lib/word-joiner.ts` exports
  `WORD_JOINER_MARK` `_`, `CLITIC_BIND_MARK` `=` and `PHRASE_BREAK_MARK` `|`,
  turns `_`/`=` into a no-break space (or U+2060 between unspaced glyphs) and
  exposes `splitPhrases` for `|`. `data/catalog.schema.jsonc` documents only
  `_`, so **the doc is behind the code** — that is a doc fix, not a feature.
- **Multi-word and Han headwords pass.** `wordSchema.word` is
  `^(?:(?=.{2})\p{L}+(?:['’ -]\p{L}+)*|\p{Script=Han}+)$`, so `ice cream`,
  `all right`, `per cent` and `any more` all validate.
- **No word-count rule in the schema.** `defVi` is `min(2).max(400)` characters;
  the "8–11 Vietnamese words" in the `.jsonc` is an authoring convention, not
  enforced by zod. Japanese-length text therefore validates as-is.
- **`meta` is `passthrough()`**, so our stamped header rides along without
  changing the importer.

Also already correct by accident: `mask()` rewrites any occurrence of the
English headword in clue text to `_____`, so `cd`'s 「歌手の CDを 買った。」
arrives as 「歌手の _____を 買った。」 — which is what a usage clue should show.

## Gap 1 — there is nothing to export from (blocking)

> **Done** in `6fc7808`: `verify-batch.ts` reads the repository's own `A101.json` /
> `A101.meta.json` layout as well as the delivered `A1_A101_cards.json` form, so
> `--release` builds a catalogue from `data/batches` directly. The same commit fixed two
> bugs the runnable path exposed (every card stamped `B1`; the legacy `emphasis` array
> making `normalizeDeck` refuse the file).

`VERIFIED_CARDS_SQL` reads the catalogue's `cards` table
`WHERE cand.verdict = 'accepted'`. That population only exists if a batch went
through Intake and was released. **All 8,146 words arrived through
`npm run bundle-batches`, and no `.sqlite` exists anywhere in the repository.**
So the export CLI has nothing to open, and "verified" currently describes no
card in either deck.

Two ways out, and I would take the second:

1. Release all 85 batches through the Intake tab. Faithful, but it is 85 manual
   runs and the safety stage spends a model call per card.
2. **Teach `scripts/verify-batch.ts` the repository's own batch naming** so
   `--release` can build the catalogue from `data/batches` and
   `data/batches-ja` directly. It already writes a catalogue; it just cannot
   read `A101.json` / `A101.meta.json`, only `<name>_cards.json` /
   `<name>_meta.json`. One naming shim, then:

   ```bash
   npm run verify -- data/batches --release word-catalog.sqlite --words …
   npm run export:kinemedia -- word-catalog.sqlite --out vi-deck.json
   ```

   The gate runs inline, so a card in the catalogue is one that passed — the
   meaning "verified" is supposed to carry. The five local stages are free; add
   `--safety` only when a key is available.

## Gap 2 — the Japanese deck has no home in KineMedia (needs a decision)

> **Open — product decision, not a task.** `TargetLocale` is the language of the word
> being TAUGHT and the UI is Vietnamese by design, so the Japanese deck (English
> headwords, Japanese gloss, for a Japanese reader) has no home without a new
> reader-language axis. Until that is settled, export Vietnamese only. The id
> namespacing in Gap 3 is what keeps the two decks from colliding whenever this is
> resolved.

`TargetLocale` is **the language of the word being taught**, not the reader's:
`nhat.chayLá` is the site that teaches *Japanese* vocabulary, and
`target-language.ts` states the premise outright — *"Vietnamese UI never
varies; only the deck and the page title do."* Every stage label is a Vietnamese
string literal in `stages.ts`: `"Ý nghĩa"`, `"Trong câu"`, `"Bạn đoán gì?"`,
`"Đây rồi!"`, `"Gồm {chars} chữ cái, bắt đầu bằng {initial}"`.

Our Japanese deck is **English headwords, Japanese gloss, for a Japanese
reader**. That is a reader-language axis KineMedia does not have, and it is not
the same thing as a locale.

**`--locale ja` is the wrong answer** and would be a quiet mistake: it files
English-headword cards into the Japanese-vocabulary site, where every other
card teaches a Japanese word.

Three options, their call:

| option | what it costs | what it gets |
| --- | --- | --- |
| Add a reader-language axis to KineMedia | a `readerLocale` on the catalogue, the labels moved out of `stages.ts` into a per-reader table, `lang` attributes on clue stages | the Japanese deck ships, and so does any future gloss language |
| Hold the Japanese deck out of KineMedia | nothing in KineMedia | 3,823 cards stay in Word Refinery only |
| Ship it as `data/ja/` anyway | nothing | wrong: Japanese-site readers get English headwords |

Until this is settled, **export Vietnamese only**. The Japanese deck is complete
and verified; it is waiting on a product decision, not on data.

## Gap 3 — the two decks' ids and headwords collide

> **Done.** `buildKineMediaDeck` prefixes every id with the gloss language
> (`vi-…`, `ja-…`) via `glossPrefix`, so the same headword under two glosses yields two
> ids that cannot collide. `test/kinemedia-export.test.ts` asserts the two-gloss case and
> that the id stays legal in KineMedia's `^[a-zA-Z0-9_-]+$`.

Both decks use the same batch names, so both contain `A101-001`, and both teach
the same English headwords. `mergeCatalogs` de-dupes by **id and headword, first
wins**, so if the two ever meet in one catalogue the second is silently dropped
entirely.

Fix in the export, not in KineMedia: **namespace the id by gloss language** —
`vi-A101-001`, `ja-A101-001`. `wordSchema.id` is `^[a-zA-Z0-9_-]+$`, so a
hyphenated prefix is legal. Do it even while only Vietnamese ships, because the
collision is invisible until the day someone merges them, and by then the ids
are in on-device storage keys (`lib/reactions.ts` namespaces reactions by id).

## Gap 4 — the contract is written on one side only

> **Done.** `KineMedia/docs/word-refinery-import.md` now exists and owns KineMedia's side
> (what `scripts/import-vocabulary.ts` does, the `meta.format` refusal, the post-import
> guard order), pointing here for the file format so the two cannot drift. The importer
> reads `meta.format` / `meta.formatVersion` and refuses a file it was not written for;
> a deck with no `meta.format` still imports as hand-authored. This doc's stale
> "where each word lands" section (a `lib/refinery-import.ts` that does not exist in
> KineMedia) was replaced with a pointer to the mirror.

`docs/kinemedia-export.md` says the format is *"mirrored in KineMedia as
docs/word-refinery-import.md"*. **That file does not exist.** And nothing in
`import-vocabulary.ts` reads `meta.format`, so the stamp's stated purpose — *"so
KineMedia can refuse a file it was not written for"* — is unenforced: a wrong
file is accepted as long as it happens to satisfy `deckSchema`.

Two small pieces of work:

- Write `KineMedia/docs/word-refinery-import.md`, pointing at our doc rather
  than restating it, so the two cannot drift.
- Add a format check to `import-vocabulary.ts`: when `meta.format` is present
  and is not `word-refinery.kinemedia-deck`, or `meta.formatVersion` is above
  the one it knows, refuse rather than import. A file with no `meta.format` is
  an ordinary hand-authored deck and still imports.

## Gap 5 — what the import does not finish

> **Done.** `chars`/`initial` were already absent from `KineMediaWord` (never emitted);
> `test/kinemedia-export.test.ts` now asserts neither key is present so it cannot regress,
> and both contract docs state they are `[DERIVED]`. The post-import guard sequence below
> is written into `KineMedia/docs/word-refinery-import.md` in order.

Our export cannot satisfy these; they are KineMedia's to run afterwards, and the
hand-off doc should say so in order:

```bash
npm run vocab:import -- vi-deck.json       # normalizeDeck rebuilds catalog.json
npx tsx scripts/assign-share-codes.ts      # every published word needs a shareCode
npm run check:share-codes
npm run check:meanings                     # meaningVi required on published English words
npm run check:word-joiners
npm run check:emphasis-runs
npm run check:text-pagination
npm run check:deck-pages
```

Two authoring notes for the export itself:

- **`chars` and `initial` are `[DERIVED]`** — recomputed on every import. Our
  deck words carry them; drop them from the export so the file does not claim
  values the importer overwrites.
- **At most one inline marker per field.** Our positional triple puts one in
  `defVi`, one in `leadVi` and one in the third slot. For Vietnamese that third
  is `anticipateVi`, which the `.jsonc` lists as marker-bearing. For Japanese it
  is the usage sentence, and the `.jsonc` lists `usage.en` but **not**
  `usage.vi` — worth confirming a marker there renders before relying on it.

## Order I would do it in

1. **Gap 1**, the naming shim, because nothing can be exported until a
   catalogue exists. Half a day, all inside Word Refinery.
2. **Gap 3**, id namespacing, while the export is being touched anyway. An hour.
3. **Gap 4**, both sides of the contract. An hour, and it is the piece that
   stops the next drift.
4. **Gap 5**, the post-import sequence written into the doc, and `chars`/
   `initial` dropped. An hour.
5. **Gap 2** last, because it is a product decision rather than a task, and
   Vietnamese can ship perfectly without it.

Steps 1–4 make the Vietnamese deck — 4,323 words, 0 errors, 0 advisories — land
in KineMedia with every guard passing. Step 5 decides whether 3,823 Japanese
cards ever get there at all.

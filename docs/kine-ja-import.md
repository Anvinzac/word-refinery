# Word Refinery → KineThai

The Japanese deck for [KineThai](https://github.com/devhoaqtri/KineThai). Not the KineMedia
export, and not `public/default-deck-ja.json`. KineThai's importer reads the nested cards
in `exports/kine-ja/` and splits them into one pack per school level.

## The files

| File | Cards | Reader levels inside every card |
| --- | ---: | --- |
| `exports/kine-ja/a1.json` | 779 | JPRIM, JSEC, JHIGH, JCOLL |
| `exports/kine-ja/a2.json` | 747 | JPRIM, JSEC, JHIGH, JCOLL |
| `exports/kine-ja/b1.json` | 631 | JSEC, JHIGH, JCOLL |
| `exports/kine-ja/b2.json` | 1,166 | JSEC, JHIGH, JCOLL |
| `exports/kine-ja/c1.json` | 1,010 | JSEC, JHIGH, JCOLL |
| `exports/kine-ja/c2.json` | 572 | JSEC, JHIGH, JCOLL |

4,905 headwords, the same list as the Vietnamese deck. Six files because KineThai refuses
a deck whose cards do not all carry the same reader levels. A1–A2 include 小学生. From B1
up, that level was never written.

Each file is `{ "name", "words" }`. A word is one English headword plus `levels`, the
shape KineThai calls a 0B deck. `level` on the word is the CEFR band (`A1` … `C2`). The
Vietnamese companion lines are `defVi`, `leadVi`, `anticipateVi`. The marked Japanese
(`_`, `=`, `|`) is under `levels.<CODE>` as `defJa`, `leadJa`, `anticipateJa`, `usageJa`,
`meaningJP`, `emphasisJa`. KineThai moves the Japanese into `localized.ja` and turns
`level` into the school level (`JHIGH` and the rest), keeping the CEFR band as `cefr`.

Ids are left off on purpose. The importer builds `<headword>-<level>`, so `interested`
at 高校生 becomes `interested-jhigh`, matching the packs already in KineThai.

## What to run

On the machine logged in as devhoaqtri, pull this repo, then from a KineThai checkout:

```bash
REFINERY=/path/to/word-refinery
cd /path/to/KineThai
for level in a1 a2 b1 b2 c1 c2; do
  npm run vocab:import -- "$REFINERY/exports/kine-ja/$level.json" --locale ja --pack "$level"
done
```

Each command writes one file per reader level:

```
src/features/vocabulary/data/ja/a1-jprim.json
src/features/vocabulary/data/ja/a1-jsec.json
src/features/vocabulary/data/ja/a1-jhigh.json
src/features/vocabulary/data/ja/a1-jcoll.json
… and the same four names for a2, three for b1, b2, c1, c2 (no jprim)
```

A1 is new. A2, B1, B2, C1 and C2 replace the sample packs that are there now
(`a2-jhigh.json` was 100 words; after this import it is 747). The importer also
rewrites `src/features/vocabulary/data/share-codes.json`. Commit those files in
KineThai. Restart or rebuild before the feed shows them.

Do not pass `public/default-deck-ja.json` or a KineMedia export. Both are a flat
高校生-only list with the Japanese stuffed into the `*Vi` fields, and KineThai will
not split them.

## One change made so the import would pass

`probability` (B2) highlighted `10％`. KineThai requires a highlight to contain a
letter, and that one phrase does not, so it is omitted from `emphasisJa` in
`b2.json`. The sentence still says 10％. Every other card is the batch as delivered.

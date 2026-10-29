# Japanese batches (English headwords, Japanese cards)

Written to `JA_GENERATION_RULES` **v3.9**, which is the Japanese counterpart of
`card-prompt-v3.7` on the Vietnamese side. Source packs:
`engvocab_JA_A101-A105_v3.9_flat`, `engvocab_JA_A106-A108_A201-A202_v3.9_flat`
and `engvocab_JA_A203-A207_v3.9_flat`.

Each `<batch>.json` is the pack AS DELIVERED: one object per English word,
carrying four reader registers under `levels` -

| code | reader | kanjiTier |
| --- | --- | --- |
| JPRIM | 小学生 | 0 (小1-小3 kanji only) |
| JSEC | 中学生 | 1 (教育漢字) |
| JHIGH | 高校生 | 2 (the DEFAULT) |
| JCOLL | 大学生 | 3 (all 常用漢字) |

All four tell the SAME scene with the same definition idea and the same usage
sentence; they differ only in script and difficulty. `defaultLevel` is `JHIGH`
on every card, and that is the register the bundler flattens into the deck.
The other three are kept here rather than in the bundled deck because the app
normalises a deck word down to the fields it knows, so carrying them through
`public/` would be weight that never arrives. They are in git so a register
picker can be built later without re-importing anything.

Each card also carries `defVi` / `leadVi` / `anticipateVi`: plain-prose
Vietnamese translations of the Japanese, there so a Vietnamese reviewer can
check Japanese they do not read. The app has no slot for them yet.

`<batch>.meta.json` is the manifest the bundler checks the cards against,
position by position. It is derived from the pack's own
`A1_<batch>_source_words_only.json`, which is the input manifest rule 0D
names: one entry per source word, in source order.

| batch | cards | accepted | excluded | review | rules |
| --- | --- | --- | --- | --- | --- |
| A101 | 100 | 100 | 0 | 0 | v3.9 |
| A102 | 100 | 100 | 0 | 0 | v3.9 |
| A103 | 100 | 100 | 0 | 0 | v3.9 |
| A104 | 100 | 100 | 0 | 0 | v3.9 |
| A105 | 100 | 100 | 0 | 0 | v3.9 |
| A106 | 100 | 100 | 0 | 0 | v3.9 |
| A107 | 100 | 100 | 0 | 0 | v3.9 |
| A108 | 79 | 79 | 0 | 0 | v3.9 |
| A201 | 100 | 100 | 0 | 0 | v3.9 |
| A202 | 100 | 100 | 0 | 0 | v3.9 |
| A203 | 100 | 100 | 0 | 0 | v3.9 |
| A204 | 100 | 100 | 0 | 0 | v3.9 |
| A205 | 100 | 100 | 0 | 0 | v3.9 |
| A206 | 100 | 100 | 0 | 0 | v3.9 |
| A207 | 100 | 100 | 0 | 0 | v3.9 |

Run `npm run bundle-batches` after adding a batch; it writes
`public/default-deck-ja.json`, which the Japanese workspace loads.

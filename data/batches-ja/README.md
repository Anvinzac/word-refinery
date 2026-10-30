# Japanese batches (English headwords, Japanese cards)

Written to `JA_GENERATION_RULES` **v3.9**, which is the Japanese counterpart of
`card-prompt-v3.7` on the Vietnamese side. Source packs:
`engvocab_JA_A101-A105_v3.9_flat`, `engvocab_JA_A106-A108_A201-A202_v3.9_flat`,
`engvocab_JA_A203-A207_v3.9_flat`, `engvocab_JA_A208_B101-B104_v3.9_flat` and
`engvocab_JA_B105-B107_B201-B202_v3.9_flat` and
`engvocab_JA_B203-B207_v3.9_flat` and
`engvocab_JA_B208-B212_v3.9_flat` and
`engvocab_JA_C101-C105_v3.9_flat` and
`engvocab_JA_C106-C110_v3.9_flat` and
`engvocab_JA_C111_v3.9_flat` with `engvocab_JA_C201-C206_v3.9_flat`.

Each `<batch>.json` is the pack AS DELIVERED: one object per English word,
carrying one telling of the scene per reader register under `levels` -

| code | reader | kanjiTier |
| --- | --- | --- |
| JPRIM | 小学生 | 0 (小1-小3 kanji only) |
| JSEC | 中学生 | 1 (教育漢字) |
| JHIGH | 高校生 | 2 (the DEFAULT) |
| JCOLL | 大学生 | 3 (all 常用漢字) |

Not every batch carries all four. The A-level batches do; **no B batch has a
JPRIM** — B101-B107 and B201-B202 ship JSEC/JHIGH/JCOLL only, because no
小学生 is the audience for B1 or B2 vocabulary. A card is read
through its `defaultLevel`, so a register a batch omits costs nothing here - but
anything that walks `levels` has to tolerate a missing JPRIM.

The registers a card does carry all tell the SAME scene with the same definition
idea and the same usage sentence; they differ only in script and difficulty.
`defaultLevel` is `JHIGH` on every card of every batch, and that is the register
the bundler flattens into the deck. The others are kept here rather than in the
bundled deck because the app normalises a deck word down to the fields it knows,
so carrying them through `public/` would be weight that never arrives. They are
in git so a register picker can be built later without re-importing anything -
and such a picker cannot offer JPRIM for a B batch, which never had one.

Each card also carries `defVi` / `leadVi` / `anticipateVi`: plain-prose
Vietnamese translations of the Japanese, there so a Vietnamese reviewer can
check Japanese they do not read. The app has no slot for them yet.

`<batch>.meta.json` is the manifest the bundler checks the cards against,
position by position. It is derived from the pack's own `<prefix>_source.json` -
one `{id, word}` row per source word, in source order - with the CEFR level
stamped from the batch name. The pack's `<prefix>_meta.json` is NOT that
manifest: it holds batch statistics, and is what the table below is read from.

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
| A208 | 47 | 47 | 0 | 0 | v3.9 |
| B101 | 100 | 100 | 0 | 0 | v3.9 |
| B102 | 100 | 100 | 0 | 0 | v3.9 |
| B103 | 100 | 100 | 0 | 0 | v3.9 |
| B104 | 100 | 100 | 0 | 0 | v3.9 |
| B105 | 100 | 100 | 0 | 0 | v3.9 |
| B106 | 100 | 100 | 0 | 0 | v3.9 |
| B107 | 31 | 31 | 0 | 0 | v3.9 |
| B201 | 100 | 100 | 0 | 0 | v3.9 |
| B202 | 100 | 100 | 0 | 0 | v3.9 |
| B203 | 100 | 100 | 0 | 0 | v3.9 |
| B204 | 100 | 100 | 0 | 0 | v3.9 |
| B205 | 100 | 100 | 0 | 0 | v3.9 |
| B206 | 100 | 100 | 0 | 0 | v3.9 |
| B207 | 100 | 100 | 0 | 0 | v3.9 |
| B208 | 100 | 100 | 0 | 0 | v3.9 |
| B209 | 100 | 100 | 0 | 0 | v3.9 |
| B210 | 100 | 100 | 0 | 0 | v3.9 |
| B211 | 100 | 100 | 0 | 0 | v3.9 |
| B212 | 66 | 66 | 0 | 0 | v3.9 |
| C101 | 100 | 100 | 0 | 0 | v3.9 |
| C102 | 100 | 100 | 0 | 0 | v3.9 |
| C103 | 100 | 100 | 0 | 0 | v3.9 |
| C104 | 100 | 100 | 0 | 0 | v3.9 |
| C105 | 100 | 100 | 0 | 0 | v3.9 |
| C106 | 100 | 100 | 0 | 0 | v3.9 |
| C107 | 100 | 100 | 0 | 0 | v3.9 |
| C108 | 100 | 100 | 0 | 0 | v3.9 |
| C109 | 100 | 100 | 0 | 0 | v3.9 |
| C110 | 100 | 100 | 0 | 0 | v3.9 |
| C111 | 10 | 10 | 0 | 0 | v3.9 |
| C201 | 100 | 100 | 0 | 0 | v3.9 |
| C202 | 100 | 100 | 0 | 0 | v3.9 |
| C203 | 100 | 100 | 0 | 0 | v3.9 |
| C204 | 100 | 100 | 0 | 0 | v3.9 |
| C205 | 100 | 100 | 0 | 0 | v3.9 |
| C206 | 72 | 72 | 0 | 0 | v3.9 |

Check a pack before bundling it with `npm run verify -- <pack dir> --gloss ja`.
The `--gloss ja` matters: without it the Vietnamese profile is used and every
card is rejected. The gates judge the register that ships, so the pack's other
registers go unchecked. Each pack's own result is in the commit that added it,
and a pack is shipped whatever that result was, because the bundler runs no
gates. What the whole deck carries is easier to read in the app, which counts
it on every load: 4,905 words, 483 of them with something to fix and 189 with
something to look at. 482 of the 483 are one rule — see below. The other is
`dna`, whose gloss contains the English answer. Every other rule the
deck validator can decide now passes on all 4,905 cards.

A TEASER LINE MUST BE NEW IN THE WHOLE DECK, and that is the rule the deck is
now failing: 782 of 4,905 cards carry an `anticipateVi` another card
already used, over 300 repeated lines — 「かっこいい！」 on 11 cards、「大丈夫？」 on 9 cards、「いい | 香り！」 on 7 cards.
It grows with the deck rather than with any one pack, and faster than it:

| deck size | cards carrying a repeated line |
| --- | --- |
| 1,926 | 227 |
| 2,357 | 297 |
| 2,857 | 383 |
| 3,323 | 451 |
| 3,823 | 595 |
| 4,323 | 671 |
| 4,905 | 782 |

The Vietnamese series, at the same 4,905 words, carries ZERO repeats. Same rule,
one prompt honouring it — which is the evidence that this is fixable on
the generation side rather than inherent to the scale.

`needs-regeneration.json` beside this file itemises every card that breaks a
rule — 467 of them, with the rule and the register for each, one entry per card
because that is the unit a regeneration run takes. It is regenerated from
data/batches-ja and goes stale the moment a batch changes, so rebuild it rather
than trusting it.

It is the one rule a batch cannot be judged against from the inside, and v3.9
already says the generator's user message should list the lines already taken.
At this size it has to, or each new pack keeps colliding with the old ones.

Run `npm run bundle-batches` after adding a batch; it writes
`public/default-deck-ja.json`, which the Japanese workspace loads.

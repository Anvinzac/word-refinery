# NOTICE — attribution and license obligations

This package redistributes curated word-list data derived from openly licensed
lists, and generates model-annotated deck files from it. The obligations below
apply to every copy of the data — the bundled corpus
(`data/ngsl-starter-subset.json`), any corpus produced with
`npm run corpus:import`, and any deck JSON produced by `npm run crawl` that
carries `meta.corpus`.

## Bundled corpus attribution

The bundled starter corpus is derived from:

- **The New General Service List (NGSL) 1.2** — Browne, C., Culligan, B., &
  Phillips, J. (2013). *The New General Service List.* Retrieved from
  <https://www.newgeneralservicelist.com> (2809 words).
- **The New Academic Word List (NAWL) 1.2** — Browne, C., Culligan, B., &
  Phillips, J. (2013). *The New Academic Word List.* Retrieved from
  <https://www.newgeneralservicelist.com> (957 words).

Both lists are licensed under the **Creative Commons
Attribution-ShareAlike 4.0 International License (CC BY-SA 4.0)**:
<https://creativecommons.org/licenses/by-sa/4.0/>.

## Share-alike requirements

If you redistribute this package's corpus data, any derived corpus, or any deck
built from them:

1. **Keep the attribution.** Credit Browne, C., Culligan, B., & Phillips, J.
   and link <https://www.newgeneralservicelist.com> and the CC BY-SA 4.0
   license. Deck `meta.corpus` already carries the structured attribution
   (`derivedFrom`, `sources[]` with authors, URLs and license) — do not remove it.
2. **Keep the license.** Distribute the derived data under CC BY-SA 4.0 (or a
   compatible share-alike license). You may not add technological or legal
   restrictions that prevent others from exercising the license.
3. **Note the changes.** The transformation applied here is documented in the
   corpus `meta` (`disclaimer`, `bandDefinitions`) and consists of: word
   selection (a subset), curation/ordering, coarse banding, and band-to-CEFR
   level assignment.

## What the bundled file is — and is not

- It is a **starter subset of 381 words** (bands 1-4: A1/A2 core, B1, B2, C1
  academic), not the complete NGSL/NAWL lists.
- **No official frequency rank is reproduced or claimed.** NGSL/NAWL publish
  ranks only inside their official "with basic statistics" downloads; this file
  uses coarse bands and a documented heuristic instead (see the corpus `meta`).
- The 25 words already in the mock deck
  (`content-hub/data/wordcrawler-deck-mock-v0.json`) are intentionally excluded
  so merged decks cannot contain duplicates.

## Never include Oxford data

The Oxford 3000/5000 word lists are **not** present in this package and must
never be added to it, imported through `corpus:import`, or mixed into any deck
produced here: their license does not permit redistribution. Any corpus whose
`sources[]` contains an Oxford entry is out of policy; the importer already
requires explicit `--license` and `--attribution` flags to force the operator to
state the source license.

## Vietnamese annotations

The Vietnamese hints, examples and emphasis phrases in generated decks are
model output produced during a crawl. They are not part of NGSL/NAWL and are
covered by the same terms as the rest of this repository's content.

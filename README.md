# Word Refinery

A browser-only vocabulary deck studio for [KineMedia](https://github.com/Anvinzac/kinetic-canvas-19).
It generates annotations for an openly licensed CEFR word list, lets you refine them by hand, and
exports a deck that KineMedia's importer consumes. The headwords are English; the language the cards
explain them IN is a property of the workspace — Vietnamese and Japanese ship today.

There is **no backend of its own**. The app is a static bundle on GitHub Pages; the LLM is called
directly from your browser with your own key, and the working document persists to a small JSON
store you configure. Generation and refinement therefore happen on a different machine and browser
than the app, and reach it later as a file.

```
corpus (bundled, CC BY-SA)  ──▶  LLM (your key)  ──▶  review & refine  ──▶  deck JSON
                                                                              │
                                                                              ▼
                                            KineMedia:  npm run vocab:import -- <file>
```

## Why not a database

The requirement was persistence without a full cloud platform. A deck is a few hundred kilobytes of
JSON that one person edits at a time, so a document store is enough. Three backends are built in:

| Backend | Credential | Notes |
| --- | --- | --- |
| **GitHub Gist** | fine-grained PAT with the *Gists* permission | Verified reachable. The document lives in your own GitHub account as one file in a secret Gist. Most durable option. |
| **jsonbin.io** | `X-Master-Key` from your account | Simple REST bin. Free tier has a request cap. |
| **Local file** | none | Download / upload. Always works, zero infrastructure, nothing persists automatically. |

> **Backend status at build time.** `jsonblob.com` was rejected by Cloudflare (HTTP 403) and
> `api.npoint.io` returned HTTP 500 on write, so neither is wired up. `api.jsonbin.io` answered its
> root route but returned `Route not found!` for `/v3/bins` during an unauthenticated probe, so it is
> implemented against the documented v3 shape and **should be retested with a real key** before you
> rely on it. The Gist backend is the one that was confirmed alive (401 on unauthenticated POST,
> which is the correct response).

Pick a backend in **Settings → Deck storage**. The first save creates the resource and the app writes
the new id back into your settings automatically.

## Setup

### Run it locally

```bash
npm install
npm run dev          # http://localhost:5173/
```

For local dev the base path must be `/`, not the Pages subpath:

```bash
echo "VITE_BASE_PATH=/" > .env
```

### Deploy to GitHub Pages

1. Create an empty repository, e.g. `word-refinery`.
2. Push this directory to it.
3. In the repo, **Settings → Pages → Build and deployment → Source**, choose **GitHub Actions**.
4. Push to `main`. The `Deploy to GitHub Pages` workflow builds and publishes.
5. Open `https://<your-user>.github.io/word-refinery/`.

If you rename the repository, change `VITE_BASE_PATH` in `.github/workflows/deploy.yml` and the
fallback in `vite.config.ts` to match — GitHub Pages serves the app from a subpath named after the
repo, and asset URLs break otherwise.

### Configure a model

Open **Settings**, pick a provider, paste a key, choose a model, then hit **Test connection**.

| Provider | Browser call | Notes |
| --- | --- | --- |
| **OpenRouter** | works | Sends `HTTP-Referer` and `X-Title` as OpenRouter asks. Widest model choice. |
| **Together AI** | works | Same OpenAI-compatible shape. |
| **Anthropic** | needs `anthropic-dangerous-direct-browser-access: true` | The header is set for you, but it means **your key is exposed to anyone who opens the page**. Fine for a private repo you use alone; not fine for a public deployment. |

Keys are stored in `localStorage` under `word-refinery.settings` and are never written into the
repository, never committed, and never sent anywhere except the endpoint you selected. The Settings
panel prints that endpoint next to the picker so you can audit it.

## Workflow

1. **Generate** — choose CEFR bands and a word count, then run. Words already in the deck are
   excluded, so repeated runs extend rather than duplicate. Progress and every warning appear in the
   run log; a failed batch is reported and the rest still lands.
2. **Review** — each row shows the definition, teaser, guess prompt and example. The `/marked/`
   phrase is rendered highlighted so you see exactly what will glow in the feed. Edit inline, or use
   *Rewrite with AI* to regenerate one field against a complaint you type. Approve what reads well,
   reject what should never ship. Live validation flags word counts, answer leaks, reused teasers,
   unpaired markers and wrong syllable counts.
3. **Sync & export** — *Save* pushes the whole working document (deck **plus** review state) to your
   backend. *Export approved deck* downloads only the approved and edited rows as the deck file
   KineMedia imports.

### Verifying a pack from a terminal

When a batch arrives as files rather than through the browser, the Intake tab's gates run headless:

```bash
npm run verify -- ~/packs/engvocab_v3.8                 # every *_cards.json in the directory
npm run verify -- ~/packs/engvocab_v3.8 A2_A208 B1_B101 # just those two
npm run verify -- ~/packs/engvocab_v3.8 --json report.json --release catalog.sqlite
```

Each `<name>_cards.json` is read with the `<name>_meta.json` beside it; the manifest is what supplies
the CEFR level a card is held to, so without one the level ceiling and batch integrity are skipped
and the report says so. The five local stages — schema, prompt rules, content, batch rules, manifest
— are free and always run. Safety and repair cost model calls, so they are opt-in and take their key
from the environment, never from a flag or a file:

```bash
export WORD_REFINERY_API_KEY='sk-...'
npm run verify -- ~/packs/engvocab_v3.8 --check-connection   # spends nothing
npm run verify -- ~/packs/engvocab_v3.8 --safety --repair --limit 5   # trial five calls
```

Exits 1 when any card was rejected, 2 on a usage error, so a CI step fails on a pack that would not
import. Warnings are advisory and never change a verdict.

#### The example-level ceiling needs a word list you supply

U1 — an example may use no word above the card's own level — can only be decided against a list that
levels every English word, and **no such list can live in this repository**. The Oxford 3000/5000 the
prompts were written against forbids redistribution (see `NOTICE.md`); the CEFR-J Wordlist is free to
*use* with citation but does not plainly grant redistribution; the Octanove profile is CC BY-SA 4.0
but covers C1/C2 only. So the list is an **input**, pointed at a copy on your own machine:

```bash
npm run verify -- ~/packs/engvocab_v3.8   --words ~/lists/cefrj-vocabulary-profile-1.5.csv   --words ~/lists/octanove-vocabulary-profile-c1c2-1.0.csv
```

Several `--words` files merge, the lowest level for a word winning — which is how the prompts state
it, and necessary here because CEFR-J covers A1–B2 and Octanove covers C1–C2. CSV with a headword
column and a CEFR column is read, as is JSON in any of four shapes (`{"word":"A1"}`,
`[{"word","level"}]`, `{"A1":["word"]}`, or this app's own corpus file). The Intake tab takes one the
same way — choose it alongside the cards and the manifest; it is held for the session and never
stored.

**Without a list the ceiling is skipped, and every run says which happened on its first line.** It is
not softened or guessed: a wrong level would reject correct sentences and pass wrong ones, and a
reviewer could not tell which. At B2 the hand-written fallback can decide nothing at all, because the
words the prompt names by hand top out at B2 themselves.

Note that a **Coding Plan / Token Plan** key (`sk-sp-…`) will not work here. Those are bound to
`coding-intl.dashscope.aliyuncs.com` and are licensed for interactive use in a coding tool only —
bulk verification from a script is outside that licence. Use a general Model Studio key (`sk-…`)
against the workspace endpoint Settings already ships.

### Getting the deck into KineMedia

Verified words — the catalogue's `cards` — go over through one agreed file
([`docs/kinemedia-export.md`](./docs/kinemedia-export.md)). Export it from the Intake tab
(**Export for KineMedia**), or from a downloaded catalogue:

```bash
npm run export:kinemedia -- word-catalog.sqlite --out word-refinery-kinemedia.json
cd /path/to/KineMedia
npm run vocab:import-refinery -- /path/to/word-refinery-kinemedia.json --dry   # see the plan
npm run vocab:import-refinery -- /path/to/word-refinery-kinemedia.json
```

Only Vietnamese-glossed (`en_vi`) workspaces have a home there; KineMedia refuses a
Japanese-glossed export.

## Workspaces

One deck of one language per workspace, switched from the pill in the header. Switching reloads the
page: a dozen things — the deck, the corpus, the prompt overrides, the style guide, the catalogue —
are read once at startup, and carrying any one of them across would be interference between two
decks rather than a feature.

| Per workspace | Shared across the device |
| --- | --- |
| the deck and its review rows | your API keys, one per provider |
| the imported corpus | |
| prompt overrides and the style guide | |
| the SQLite catalogue | |
| the remote store id and token | |
| the model, deck name and version | |

A key belongs to the device, not to a deck: it is the same account whichever deck is open. It is
stored once, under `word-refinery.keys`, and never written into a workspace's own payload.

The original workspace keeps the unscoped storage keys it has always used, so upgrading finds the
deck exactly where it left it. Forgetting a workspace removes it from the switcher and leaves its
data in the browser — tidying the list is not a way to destroy a deck.

The **field names do not change between languages**: a Japanese card still has `defVi`, `leadVi`,
`meaningVi`. They are the wire format KineMedia's importer reads, and renaming them would be a
migration of every batch file on disk for a cosmetic gain. `meta.locale` says which language is in
them (`en_vi`, `en_ja`).

## What the app enforces

These rules come from iterating on the live KineMedia deck, and are applied to model output rather
than trusted:

Every length below is stated in the unit the workspace's language is measured in — words for
Vietnamese, which separates them with spaces, characters for Japanese, which does not. The numbers
live in `src/lib/lang.ts`, one profile per language.

- `defVi` and `leadVi` are **8–11 words** in Vietnamese, **16–34 characters** in Japanese — a
  character cap alone does not bound brevity in a syllable-spaced language.
- `anticipateVi` is 3–8 words (8–20 characters) and **must not repeat** across words; a reused
  placeholder is flagged.
- No English word may appear in any gloss field, and the answer may not leak next to the `_____`
  blank in the example sentence. In Japanese the usual leak is katakana — `チャレンジ` for
  "challenge" — and it is called out in the prompt as such.
- Emphasis phrases must occur **character-for-character** in `defVi` or `leadVi` (diacritics
  preserved, so `nền` never matches `nên`), must be **one word** — one syllable or one joined word
  of up to four, per card-prompt v3.7 — and must not be a single syllable that reads as half of a
  compound. Function words, particles and generic intensifiers are never highlighted.
- Emphasis is emitted as **inline `/phrase/` markers**, at most one per field, because the feed
  highlights exactly one word per page and `defVi` / `leadVi` render as separate stages.
  A marker can therefore never be attached to text that does not contain it.
- CEFR `level` always comes from the corpus and is never taken from the model, even if the model
  echoes one back.

## Repository layout

```
data/ngsl-starter-subset.json   bundled corpus (381 words, CC BY-SA 4.0)
data/batches/A101.json          one batch of Vietnamese cards; `npm run bundle-batches` bundles them
data/batches/A101.meta.json     its manifest: id, headword and level, one row per card
data/batches-ja/A101.json       one batch of Japanese cards, one telling per reader register (see its README)
public/default-deck.json        the dataset a Vietnamese workspace ships with (1910 words, A101-A108 + A201-A207 + B105-B107 + B201-B202)
public/default-deck-ja.json     the dataset a Japanese workspace ships with (1926 words, A101-A108 + A201-A208 + B101-B104)
src/lib/
  types.ts       deck, corpus and review document shapes
  corpus.ts      load the bundled corpus, filter by band, batch it
  contract.ts    the 10-field annotation schema + Zod validation and repairs
  prompt.ts      system prompt, batch prompt, single-field rewrite prompt
  emphasis.ts    emphasis validation + inline marker injection
  lang.ts        one profile per gloss language: lengths, marks, prompt prose
  registers.ts   the four Japanese reader registers, and which one a card ships
  workspace.ts   workspaces: what is scoped per deck and what is shared
  joiner.ts      the three breaking marks, and what counts as a stray one
  intake.ts      the four gates a batch passes before it is vocabulary
  intake-db.ts   the accepted catalogue, as a SQLite file
  deck.ts        build deck words, build the document, validate a whole deck
  pipeline.ts    one generation run: select -> annotate -> build -> review rows
  llm.ts         browser client for OpenRouter / Together / Anthropic / Alibaba
  store.ts       pluggable persistence: jsonbin, Gist, or local file
  settings.ts    localStorage settings, provider catalogue, key masking
src/components/  SettingsPanel, GeneratePanel, ReviewTable
src/App.tsx      shell: tabs, working document, save/load/export
```

The two series are sourced independently, so neither is a translation of the other past A207. Both
hold 20 batches, but not the same 20: Vietnamese has B105-B107 and B201-B202 and is missing A208 and
B101-B104, while Japanese has A208 and B101-B104 and stops there. A word count that differs between
them is expected, not a bundling failure.

`src/lib/contract.ts`, `src/lib/emphasis.ts`, `src/lib/prompt.ts` and `src/lib/deck.ts` are ports of
the Node-based `word-crawler` package in the KineMedia monorepo, with the filesystem parts removed
and the emphasis output changed to the inline-marker format. Keep the two in step if you tighten a
rule in one.

One rule has deliberately diverged: `annotationWordPattern` here accepts a space, so a multi-word
headword ("per cent", "ice cream") is a word, matching KineMedia's `wordSchema.word`. The copy in
`word-crawler/src/annotate/contract.ts` still does not. That is safe in this direction — the
narrower rule only ever refuses words the importer would have taken — but a corpus carrying
multi-word entries would need the same widening there before it could be annotated.

## Licensing

The bundled corpus is a derivative of the **New General Service List 1.2** and **New Academic Word
List 1.2** (Browne, Culligan & Phillips, 2013), both **CC BY-SA 4.0**. Share-alike applies to the
word list; the annotations you generate are your own. Read [`NOTICE.md`](./NOTICE.md)
before redistributing a deck.

Oxford 3000/5000 and any other list without a redistribution-compatible licence must never be added
to the corpus.

## Known limits

- **No offline generation.** The corpus is bundled, but annotation needs a live provider call.
- **Whole-document writes.** Saving rewrites the entire document; there is no per-word patching and
  no conflict detection. Two people editing the same bin or Gist will overwrite each other.
- **Public deployment leaks keys.** If you deploy to a public Pages URL and choose Anthropic direct,
  anyone can read your key out of the network tab. Keep such a deployment private, or use a provider
  key you are willing to rotate.

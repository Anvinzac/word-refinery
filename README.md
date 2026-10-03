# Word Refinery

A browser-only vocabulary deck studio for [KineMedia](https://github.com/Anvinzac/kinetic-canvas-19).
It generates Vietnamese annotations for an openly licensed CEFR word list, lets you refine them by
hand, and exports a deck that KineMedia's importer consumes.

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

### Getting the deck into KineMedia

```bash
cd /path/to/KineMedia
npm run vocab:import -- /path/to/word-refinery-deck.json
npm run dev   # restart: catalog.json is imported statically and cached in memory
```

## What the app enforces

These rules come from iterating on the live KineMedia deck, and are applied to model output rather
than trusted:

- `defVi` and `leadVi` are **8–11 words** — a character cap alone does not bound Vietnamese brevity.
- `anticipateVi` is 3–8 words and **must not repeat** across words; a reused placeholder is flagged.
- No English word may appear in any Vietnamese field, and the answer may not leak next to the
  `_____` blank in the example sentence.
- Emphasis phrases must occur **character-for-character** in `defVi` or `leadVi` (diacritics
  preserved, so `nền` never matches `nên`), must be exactly **two syllables**, and must not be a
  single syllable that reads as half of a compound — `sinh` inside `học sinh` is dropped, `học sinh`
  is kept. Function words are never highlighted.
- Emphasis is emitted as **inline `/phrase/` markers**, at most one per field, because the feed
  highlights exactly one Vietnamese word per page and `defVi` / `leadVi` render as separate stages.
  A marker can therefore never be attached to text that does not contain it.
- CEFR `level` always comes from the corpus and is never taken from the model, even if the model
  echoes one back.

## Repository layout

```
data/ngsl-starter-subset.json   bundled corpus (381 words, CC BY-SA 4.0)
src/lib/
  types.ts       deck, corpus and review document shapes
  corpus.ts      load the bundled corpus, filter by band, batch it
  contract.ts    the 10-field annotation schema + Zod validation and repairs
  prompt.ts      system prompt, batch prompt, single-field rewrite prompt
  emphasis.ts    Vietnamese emphasis validation + inline marker injection
  deck.ts        build deck words, build the document, validate a whole deck
  pipeline.ts    one generation run: select -> annotate -> build -> review rows
  llm.ts         browser client for OpenRouter / Together / Anthropic
  store.ts       pluggable persistence: jsonbin, Gist, or local file
  settings.ts    localStorage settings, provider catalogue, key masking
src/components/  SettingsPanel, GeneratePanel, ReviewTable
src/App.tsx      shell: tabs, working document, save/load/export
```

`src/lib/contract.ts`, `src/lib/emphasis.ts`, `src/lib/prompt.ts` and `src/lib/deck.ts` are ports of
the Node-based `word-crawler` package in the KineMedia monorepo, with the filesystem parts removed
and the emphasis output changed to the inline-marker format. Keep the two in step if you tighten a
rule in one.

## Licensing

The bundled corpus is a derivative of the **New General Service List 1.2** and **New Academic Word
List 1.2** (Browne, Culligan & Phillips, 2013), both **CC BY-SA 4.0**. Share-alike applies to the
word list; the Vietnamese annotations you generate are your own. Read [`NOTICE.md`](./NOTICE.md)
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

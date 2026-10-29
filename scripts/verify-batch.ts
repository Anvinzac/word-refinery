/**
 * Verify batches from a terminal — the Intake tab's gates, headless.
 *
 * The same checks `IntakePanel.loadBatch` runs, in the same order, over a
 * directory of `<name>_cards.json` / `<name>_meta.json` pairs. Useful when a
 * pack arrives as files rather than through the browser, and when you want the
 * answer in CI or in a shell rather than in a tab.
 *
 * Stages, cheapest first, exactly as the Intake tab orders them:
 *
 *   schema       structure, types, field order, emphasis triple    free, local
 *   prompt-rules the card-prompt's checkable rules                 free, local
 *   content      the deck validator, via the coerced card          free, local
 *   batch-rules  duplicate targets, tone-word tally                free, local
 *   manifest     the batch against what it was asked for (B1)      free, local
 *   safety       implication, framing, sense                       one call each
 *   repair       fix the failures, recheck the WHOLE card          one call each
 *
 * The five local stages always run. Safety and repair cost model calls, so they
 * are opt-in and need a key.
 *
 * TWO PACK SHAPES. A Vietnamese pack delivers one flat card per word. A
 * Japanese pack (JA_GENERATION_RULES v3.9) delivers one entry per word holding
 * four reader registers under `levels` - JPRIM/JSEC/JHIGH/JCOLL - and the gates
 * read a flat card, so each entry is flattened to its `defaultLevel` by the
 * same function the bundler uses. That means the register that SHIPS is the
 * one checked; the other three are in the pack and are not verified here.
 *
 * The manifest is read from `<name>_meta.json` when that file holds rows, and
 * from `<name>_source.json` when it does not: a Japanese pack spends the
 * `_meta` name on batch statistics and ships its targets as `_source`. See
 * manifestFor below. Without one of them the level ceiling and batch integrity
 * cannot run, and the report says so rather than passing quietly.
 *
 * A key is read ONLY from the WORD_REFINERY_API_KEY environment variable. Not
 * from a flag (it would land in shell history and in `ps`), and not from a file
 * in this repository: settings.ts states the invariant that keys are never
 * written into the repo, and this script keeps it.
 *
 * Usage:
 *   npm run verify -- <dir> [batch...] [options]
 *
 *   npm run verify -- ~/packs/engvocab_v3.8
 *       every *_cards.json in the directory, with its *_meta.json beside it
 *   npm run verify -- ~/packs/engvocab_v3.8 A2_A208 B1_B101
 *       just those two batches
 *
 * Options:
 *   --safety             run stage three (needs WORD_REFINERY_API_KEY)
 *   --repair             run stage four (needs WORD_REFINERY_API_KEY)
 *   --limit <n>          stop after n model calls, for a trial run
 *   --provider <id>      alibaba (default) | openrouter | together | anthropic
 *   --model <id>         model to call; defaults to the provider's first
 *   --gloss <vi|ja>      which language the cards are written in (default vi)
 *   --release <file>     write the run into a .sqlite catalogue, as the tab does
 *   --json <file>        also write the full report as JSON
 *   --quiet              only the summary lines
 *   --check-connection   ping the provider and exit, spending no calls
 *
 * Exits 1 when any card was rejected, 2 on a usage or configuration error, so a
 * CI step fails on a batch that would not import.
 *
 * Depends on: ../src/lib/intake.ts, ../src/lib/deck.ts, ../src/lib/lang.ts,
 *             ../src/lib/llm.ts, ../src/lib/intake-db.ts, ../src/lib/settings.ts
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// No gloss profile is read at module scope here, so this one is safe to import
// statically - unlike the libraries below.
import { flattenRegisters, isRegisterCard } from "../src/lib/registers.ts";

import type {
  IntakeFinding,
  IntakeRecord,
  ManifestRow,
} from "../src/lib/intake.ts";
import type { GlossLang } from "../src/lib/workspace.ts";
import type { LlmProvider, Settings } from "../src/lib/settings.ts";
import type { CefrLevel } from "../src/lib/types.ts";

// ── Arguments ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

/** Read and remove `--name value`, or `--name` for a boolean flag. */
function option(name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  const takesValue = value !== undefined && !value.startsWith("--");
  argv.splice(at, takesValue ? 2 : 1);
  return takesValue ? value : "";
}

const USAGE =
  "Usage: npm run verify -- <dir> [batch...] [--safety] [--repair] [--limit n]\n" +
  "                          [--provider alibaba] [--model id] [--gloss vi|ja]\n" +
  "                          [--release catalog.sqlite] [--json report.json]\n" +
  "                          [--check-connection] [--quiet]";

/** Refuse with a reason rather than running on a guess. */
function fail(message: string): never {
  console.error(`\n${message}\n\n${USAGE}\n`);
  process.exit(2);
}

// Every option() call splices its flag out of argv, so all of them must run
// before the positional arguments are read — otherwise `--limit 5` arrives as
// two batch names.
const wantSafety = option("safety") !== undefined;
const wantRepair = option("repair") !== undefined;
const quiet = option("quiet") !== undefined;
const checkConnection = option("check-connection") !== undefined;
const provider = (option("provider") ?? "alibaba") as LlmProvider;
const gloss = (option("gloss") ?? "vi") as GlossLang;
const releaseTo = option("release");
const jsonTo = option("json");
const modelFlag = option("model");
const limitText = option("limit");

const dir = argv[0];
const asked = argv.slice(1);
if (dir === undefined && !checkConnection) fail("No directory given.");
if (gloss !== "vi" && gloss !== "ja") fail(`--gloss must be "vi" or "ja", got "${gloss}".`);
// No --limit means every card, which is Infinity rather than a parsed number:
// Number.isFinite(Infinity) is false, so the two cases are told apart before
// the range check rather than by it.
const parsedLimit = limitText === undefined || limitText === "" ? null : Number(limitText);
if (parsedLimit !== null && (!Number.isFinite(parsedLimit) || parsedLimit < 0)) {
  fail(`--limit must be a non-negative number, got "${limitText}".`);
}
const limit = parsedLimit ?? Infinity;

// ── The gloss profile, before anything reads it ────────────────────────────
//
// intake.ts captures `activeGlossProfile()` into a module-level constant, and
// that call reads the workspace registry from localStorage. Node has no
// localStorage, so readWorkspaces() falls back to the original Vietnamese
// workspace — correct for `--gloss vi`, and silently wrong for a Japanese pack.
// Installing a minimal registry BEFORE the library modules are first evaluated
// is what makes `--gloss ja` mean something. Hence the dynamic imports below:
// a static import would hoist and evaluate them before this runs.

/** The narrow slice of `window` the libraries this script reaches actually read. */
interface WindowShim {
  localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  location: { origin: string };
}

function installWorkspace(glossLang: GlossLang): void {
  const held = new Map<string, string>();
  held.set(
    "word-refinery.workspaces",
    JSON.stringify({
      version: 1,
      activeId: "current",
      list: [
        {
          id: "current",
          label: glossLang === "ja" ? "English → Japanese" : "English → Vietnamese",
          gloss: glossLang,
          createdAt: "",
        },
      ],
    }),
  );
  const shim: WindowShim = {
    localStorage: {
      getItem: (key) => held.get(key) ?? null,
      setItem: (key, value) => void held.set(key, value),
      removeItem: (key) => void held.delete(key),
    },
    // llm.ts reads window.location.origin for OpenRouter's attribution headers.
    location: { origin: "https://localhost/" },
  };
  (globalThis as { window?: WindowShim }).window = shim;
}

installWorkspace(gloss);

const {
  asManifest,
  candidateId,
  checkBatchRules,
  checkContent,
  checkManifest,
  checkPromptRules,
  checkSchema,
  partitionRecords,
  summarize,
  verdictOf,
} = await import("../src/lib/intake.ts");
const { coerceDeckWord } = await import("../src/lib/deck.ts");
const { activeGlossProfile } = await import("../src/lib/lang.ts");
const { PROVIDERS } = await import("../src/lib/settings.ts");
const { CEFR_LEVELS } = await import("../src/lib/types.ts");

// ── Provider settings ──────────────────────────────────────────────────────

const profile = PROVIDERS.find((entry) => entry.id === provider);
if (profile === undefined) {
  fail(`Unknown --provider "${provider}". One of: ${PROVIDERS.map((p) => p.id).join(", ")}.`);
}
const model = modelFlag ?? profile!.suggested[0]!;
const apiKey = process.env.WORD_REFINERY_API_KEY ?? "";
const needsKey = wantSafety || wantRepair || checkConnection;
if (needsKey && apiKey.length === 0) {
  console.error(
    "\nThe safety and repair stages call a model, so they need a key.\n" +
      "Set it in the environment — this script never reads one from a file:\n\n" +
      "  export WORD_REFINERY_API_KEY='sk-...'\n" +
      `  npm run verify -- ${dir ?? "<dir>"} --safety\n`,
  );
  process.exit(2);
}

const llm: Settings["llm"] = {
  provider,
  model,
  apiKey,
  profiles: { [provider]: { apiKey, model } },
  batchSize: 5,
  maxTokens: 8192,
};

// ── A connection check spends nothing else ─────────────────────────────────
//
// Ahead of batch resolution on purpose: it is how you find out a key is bad
// without also being told a directory argument was missing.

if (checkConnection) {
  const { describeLlmError, testConnection } = await import("../src/lib/llm.ts");
  console.log(`Calling ${profile!.label} (${model}) at\n  ${profile!.endpoint}\n`);
  try {
    const reply = await testConnection(llm);
    console.log(`OK — the model answered: ${reply.trim().slice(0, 80)}`);
    process.exit(0);
  } catch (thrown) {
    console.error(`FAILED — ${describeLlmError(thrown)}`);
    process.exit(1);
  }
}

// ── Resolving batches ──────────────────────────────────────────────────────

interface BatchFiles {
  batchId: string;
  cards: string;
  /** `<name>_meta.json`: rows for a Vietnamese pack, statistics for a Japanese one. */
  manifest: string | null;
  /** `<name>_source.json`: the targets a Japanese pack was given, in order. */
  source: string | null;
}

/** The path when the directory holds it, else null. */
function ifPresent(path: string): string | null {
  return existsSync(path) ? path : null;
}

/** One batch by name, with whatever the directory holds beside it. */
function locate(from: string, name: string): BatchFiles {
  const cards = join(from, `${name}_cards.json`);
  if (!existsSync(cards)) fail(`No such batch: ${cards}`);
  return {
    batchId: name,
    cards,
    manifest: ifPresent(join(from, `${name}_meta.json`)),
    source: ifPresent(join(from, `${name}_source.json`)),
  };
}

/** Every `*_cards.json` in a directory, sorted, with its neighbours beside it. */
function discover(from: string): BatchFiles[] {
  const names = readdirSync(from)
    .filter((name) => name.endsWith("_cards.json"))
    .sort()
    .map((name) => name.replace(/_cards\.json$/, ""));
  if (names.length === 0) fail(`No *_cards.json files in ${from}.`);
  return names.map((name) => locate(from, name));
}

const root = resolve(dir!);
if (!existsSync(root)) fail(`No such directory: ${root}`);
const batches: BatchFiles[] =
  asked.length === 0
    ? discover(root)
    : asked.map((name) =>
        name.endsWith(".json")
          ? {
              batchId: basename(name).replace(/_cards\.json$/, "").replace(/\.json$/, ""),
              cards: resolve(name),
              manifest: null,
              source: null,
            }
          : locate(root, name),
      );

// ── The five local stages ──────────────────────────────────────────────────

interface Run {
  batchId: string;
  /** The rows this batch was asked for, so a repair is rechecked at its level. */
  manifest: ManifestRow[] | null;
  /** Which file the manifest came from, for the report to say so. */
  manifestOrigin: string;
  manifestFindings: IntakeFinding[];
  /** How many cards carried reader registers, and so were flattened. */
  registerCards: number;
  records: IntakeRecord[];
}

/** The CEFR level a batch name carries, read the way the bundler reads it. */
function levelInName(batchId: string): CefrLevel | undefined {
  const named = /(?:^|[-_])([abc][12])(?:[-_.]|$)/i.exec(batchId)?.[1]?.toUpperCase();
  return CEFR_LEVELS.includes(named as CefrLevel) ? (named as CefrLevel) : undefined;
}

/** The rows a batch was asked for, and the file they came out of. */
interface Manifest {
  rows: ManifestRow[];
  origin: string;
}

/**
 * The manifest a batch was asked for, from whichever file carries it.
 *
 * Two conventions meet here. A Vietnamese pack, and a batch already living in
 * data/batches*, ships `<name>_meta.json` as one row per card. A Japanese pack
 * spends that same name on batch STATISTICS - accepted and excluded counts, the
 * rules version - and ships the targets it was given as `<name>_source.json`,
 * which is the input manifest rule 0D names. data/batches-ja/README.md
 * documents deriving the row-per-card manifest from exactly that file, so this
 * does the same, stamping each row with the level from the batch name.
 *
 * Both files go through `asManifest`, which tells a target list from a card
 * list by the absence of Vietnamese prose. So a `_meta.json` holding statistics
 * is recognised as NOT a manifest and the search moves on, rather than being
 * mistaken for one.
 *
 * @returns the rows and where they came from, or null when neither file has them
 */
function manifestFor(files: BatchFiles): Manifest | null {
  const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

  if (files.manifest !== null) {
    const rows = asManifest(read(files.manifest));
    if (rows !== null) return { rows, origin: basename(files.manifest) };
  }
  if (files.source !== null) {
    const rows = asManifest(read(files.source));
    if (rows !== null) {
      const level = levelInName(files.batchId);
      return {
        // Stamped rather than read: a source list carries the targets, and the
        // whole batch was asked for at one CEFR level.
        rows: level === undefined ? rows : rows.map((row) => ({ ...row, level })),
        origin: `${basename(files.source)}${level === undefined ? "" : `, level ${level} from the batch name`}`,
      };
    }
  }
  return null;
}

/** Stages one, two and the batch-shaped rules, mirroring IntakePanel.runLocal. */
function verifyOffline(files: BatchFiles): Run {
  const batchId = files.batchId;
  const parsed = JSON.parse(readFileSync(files.cards, "utf8")) as unknown;
  const found = manifestFor(files);
  const manifest = found?.rows ?? null;

  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { words?: unknown }).words)
      ? (parsed as { words: unknown[] }).words
      : [];
  const registerCards = list.filter(isRegisterCard).length;

  // A Japanese pack delivers four reader registers per word and the gates read
  // one flat card, so each entry is flattened to its `defaultLevel` by the same
  // function the bundler flattens with on the way into a deck. Importing that
  // rather than restating it is the whole point: twelve hand-matched renames
  // kept in two places would drift, and a drift reports a pack as broken rather
  // than shipping it wrong.
  const candidates = list.map((delivered, index) => {
    let raw = delivered;
    let failed: string | null = null;
    try {
      raw = flattenRegisters(delivered);
    } catch (thrown) {
      failed = thrown instanceof Error ? thrown.message : String(thrown);
    }
    return {
      id: candidateId(batchId, String((delivered as { word?: unknown })?.word ?? ""), index),
      raw,
      failed,
    };
  });

  // One id set for the whole batch, so a repeated headword cannot be smoothed
  // into two cards with the same id.
  const used = new Set<string>();
  const local: IntakeRecord[] = candidates.map(({ id, raw, failed }, index) => {
    // A card that could not be flattened has no shape the gates can read: run
    // them on the nested original and they report fields it does have as
    // missing. Why it failed is the finding.
    const findings: IntakeFinding[] =
      failed === null
        ? [
            ...checkSchema(raw),
            // The level comes from the manifest: the card-prompt passes it in and
            // forbids it in the output, so a card alone cannot be held to its ceiling.
            ...checkPromptRules(raw, manifest?.[index]?.level),
          ]
        : [{ stage: "schema", field: "levels", severity: "blocker", message: failed }];
    const word = String((raw as { word?: unknown })?.word ?? "");
    // Coerce only when the shape is sound; a broken candidate must not be
    // smoothed into a plausible card by the importer.
    const blocked = findings.some((finding) => finding.severity === "blocker");
    const card = blocked ? null : coerceDeckWord(raw, used, { batchId, addedAt: "" });
    if (card !== null) findings.push(...checkContent(card));
    return { id, word, batchId, raw, card, findings, verdict: verdictOf(findings, ["schema", "content"]) };
  });

  // The batch-shaped rules need every record, so they run last and fold their
  // findings back in before a verdict is settled.
  const batchRules = checkBatchRules(local);
  const integrity = manifest === null ? null : checkManifest(local, manifest);

  const records = local.map((record) => {
    const extra = [
      ...(batchRules.get(record.id) ?? []),
      ...(integrity?.byRecord.get(record.id) ?? []),
    ];
    if (extra.length === 0) return record;
    const findings = [...record.findings, ...extra];
    return { ...record, findings, verdict: verdictOf(findings, ["schema", "content"]) };
  });

  return {
    batchId,
    manifest,
    manifestOrigin: found?.origin ?? "",
    manifestFindings: integrity?.batch ?? [],
    registerCards,
    records,
  };
}

// ── Stages three and four ──────────────────────────────────────────────────

/** How many model calls have been spent, against --limit. */
let spent = 0;

async function runModelStages(run: Run): Promise<void> {
  const { describeLlmError, repairCard, reviewSafety } = await import("../src/lib/llm.ts");

  if (wantSafety) {
    const targets = run.records.filter((record) => record.card !== null && record.verdict !== "rejected");
    for (const [index, record] of targets.entries()) {
      if (spent >= limit) return;
      spent += 1;
      if (!quiet) process.stdout.write(`\r  safety ${index + 1}/${targets.length}   `);
      try {
        const found = await reviewSafety(llm, record.card!);
        const findings: IntakeFinding[] = found.map((item) => ({
          stage: "safety",
          field: item.field,
          severity: item.severity,
          message: item.problem,
        }));
        record.findings.push(...findings);
        record.verdict = verdictOf(record.findings, ["schema", "content", "safety"]);
      } catch (thrown) {
        // A gate that could not be reached is not a gate that passed.
        const message = describeLlmError(thrown).split("\n")[0] ?? "the safety gate failed";
        record.findings.push({ stage: "safety", field: "card", severity: "blocker", message });
        record.verdict = "rejected";
      }
    }
    if (!quiet) process.stdout.write("\n");
  }

  if (wantRepair) {
    const failed = run.records.filter((row) => row.verdict === "rejected" && row.card !== null);
    for (const [index, record] of failed.entries()) {
      if (spent >= limit) return;
      spent += 1;
      if (!quiet) process.stdout.write(`\r  repair ${index + 1}/${failed.length}   `);
      const problems = record.findings
        .filter((finding) => finding.severity === "blocker")
        .map((finding) => `${finding.field}: ${finding.message}`);
      try {
        const raw = await repairCard(llm, record.card!, problems);
        // Revalidated from the top: a fix to one field can break another, and
        // rechecking only the trigger would ship exactly that.
        // Revalidated against the level it was ASKED for, not a fresh guess: a
        // repair that quietly raised the example's vocabulary would pass a
        // recheck that had forgotten the ceiling. Position is the mapping.
        const level = run.manifest?.[run.records.indexOf(record)]?.level;
        const used = new Set<string>();
        const fresh: IntakeFinding[] = [
          ...checkSchema(raw, record.word),
          ...checkPromptRules(raw, level),
        ];
        const blocked = fresh.some((finding) => finding.severity === "blocker");
        const card = blocked ? null : coerceDeckWord(raw, used, { batchId: run.batchId, addedAt: "" });
        if (card !== null) fresh.push(...checkContent(card));
        record.raw = raw;
        record.card = card;
        record.findings = fresh;
        record.repaired = true;
        record.verdict = verdictOf(fresh, ["schema", "content", "safety"]);
      } catch {
        // Leave the original rejection and its reasons in place.
      }
    }
    if (!quiet) process.stdout.write("\n");
  }
}

// ── Run ────────────────────────────────────────────────────────────────────

const runs: Run[] = batches.map((files) => verifyOffline(files));

// Computed from the runs rather than from the file names, because whether the
// manifest stage ran depends on a file actually PARSING as a manifest: a
// Japanese pack's `_meta.json` is statistics and its `_source.json` is the
// manifest, so the names alone cannot say which way it went.
const stages = ["schema", "prompt-rules", "content", "batch-rules"];
if (runs.some((run) => run.manifest !== null)) stages.push("manifest");
if (wantSafety) stages.push("safety");
if (wantRepair) stages.push("repair");

console.log("Word Refinery — batch verification");
console.log(
  `  gloss ${activeGlossProfile().id}   stages ${stages.join(", ")}` +
    (needsKey ? `\n  provider ${profile!.label}   model ${model}` : ""),
);
console.log("");

if (wantSafety || wantRepair) {
  for (const run of runs) {
    console.log(`${run.batchId}: ${run.records.length} card(s), calling the model…`);
    await runModelStages(run);
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

/**
 * Findings of one severity, grouped by rule and busiest first.
 *
 * The offending value is masked in the key, so a hundred cards failing the same
 * rule read as one line with examples rather than as a hundred lines.
 */
function groupByRule(
  records: readonly IntakeRecord[],
  severity: IntakeFinding["severity"],
): Array<[string, { count: number; words: string[] }]> {
  const held = new Map<string, { count: number; words: string[] }>();
  for (const record of records) {
    for (const finding of record.findings) {
      if (finding.severity !== severity) continue;
      const key = `${finding.stage}/${finding.field}: ${finding.message.replace(/"[^"]*"/g, '"…"')}`;
      const entry = held.get(key) ?? { count: 0, words: [] };
      entry.count += 1;
      if (entry.words.length < 6) entry.words.push(record.word);
      held.set(key, entry);
    }
  }
  return [...held].sort((a, b) => b[1].count - a[1].count);
}

/** Print a grouped rule table under a heading. */
function printRules(
  heading: string,
  groups: ReadonlyArray<[string, { count: number; words: string[] }]>,
): void {
  if (groups.length === 0) return;
  console.log(heading);
  for (const [rule, info] of groups) {
    console.log(`    ${String(info.count).padStart(3)}× ${rule}`);
    console.log(`         e.g. ${info.words.join(", ")}`);
  }
}

const totals = { total: 0, accepted: 0, rejected: 0, pending: 0, repaired: 0, blockers: 0, warns: 0 };

for (const run of runs) {
  const summary = summarize(run.records);
  const split = partitionRecords(run.records);
  const blockers = run.records.flatMap((r) => r.findings.filter((f) => f.severity === "blocker"));
  const warns = run.records.flatMap((r) => r.findings.filter((f) => f.severity === "warn"));
  totals.total += summary.total;
  totals.accepted += summary.accepted;
  totals.rejected += summary.rejected;
  totals.pending += summary.pending;
  totals.repaired += summary.repaired;
  totals.blockers += blockers.length;
  totals.warns += warns.length;

  console.log("─".repeat(76));
  console.log(
    `${run.batchId}   ${summary.total} card(s)` +
      (run.manifest === null
        ? "   manifest: NONE"
        : `   manifest: ${run.manifest.length} row(s) from ${run.manifestOrigin}`),
  );
  console.log("─".repeat(76));
  console.log(
    `  accepted ${summary.accepted}   rejected ${summary.rejected}   pending ${summary.pending}` +
      (summary.repaired > 0 ? `   repaired ${summary.repaired}` : ""),
  );
  console.log(`  blockers ${blockers.length}   warnings ${warns.length}`);

  if (run.registerCards > 0) {
    console.log(
      `  registers: ${run.registerCards} card(s) carried reader registers and were flattened to` +
        "\n             their defaultLevel, which is the register that ships. The other three" +
        "\n             registers are in the pack and were NOT checked.",
    );
  }

  if (run.manifest === null) {
    console.log(
      "  manifest: absent, so the level ceiling and batch integrity (B1) were skipped —\n" +
        "            a card cannot say what level it was asked for.",
    );
  } else if (run.manifestFindings.length === 0 && split.rejected.length === 0) {
    console.log("  manifest: every target has exactly one card, in order.");
  }
  for (const finding of run.manifestFindings) {
    console.log(`  manifest [${finding.severity}] ${finding.message}`);
  }

  if (quiet) continue;

  printRules("  blockers by rule:", groupByRule(run.records, "blocker"));
  printRules(
    "  warnings by rule (advisory — these do not change the verdict):",
    groupByRule(run.records, "warn"),
  );

  if (split.rejected.length > 0) {
    console.log(`  rejected (${split.rejected.length}):`);
    for (const record of split.rejected) {
      console.log(`    ${record.word}${record.repaired === true ? " (repaired, still failing)" : ""}`);
      for (const finding of record.findings.filter((f) => f.severity === "blocker").slice(0, 4)) {
        console.log(`        ${finding.stage}/${finding.field}: ${finding.message}`);
      }
    }
  }
  console.log("");
}

console.log("═".repeat(76));
console.log(
  `TOTAL  ${totals.total} card(s)   accepted ${totals.accepted}   rejected ${totals.rejected}   ` +
    `pending ${totals.pending}` +
    (totals.repaired > 0 ? `   repaired ${totals.repaired}` : ""),
);
console.log(`       blockers ${totals.blockers}   warnings ${totals.warns}` +
  (needsKey ? `   model calls ${spent}` : ""));
console.log("═".repeat(76));

// ── Outputs ────────────────────────────────────────────────────────────────

if (jsonTo !== undefined) {
  const report = {
    generatedAt: new Date().toISOString(),
    gloss: activeGlossProfile().id,
    stages,
    provider: needsKey ? provider : undefined,
    model: needsKey ? model : undefined,
    totals,
    batches: runs.map((run) => ({
      batchId: run.batchId,
      manifestRows: run.manifest?.length ?? null,
      manifestOrigin: run.manifestOrigin || null,
      registerCards: run.registerCards,
      manifestFindings: run.manifestFindings,
      ...summarize(run.records),
      records: run.records.map((record) => ({
        id: record.id,
        word: record.word,
        verdict: record.verdict,
        repaired: record.repaired === true,
        findings: record.findings,
      })),
    })),
  };
  writeFileSync(resolve(jsonTo), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report written to ${resolve(jsonTo)}`);
}

// The catalogue write is last, so a batch that was only partly checked is never
// released as though it had passed a gate that did not run.
if (releaseTo !== undefined) {
  const { openCatalog } = await import("../src/lib/intake-db.ts");
  const path = resolve(releaseTo);
  const existing = existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
  const db = await openCatalog(existing);
  for (const run of runs) {
    db.ingest({ batchId: run.batchId, source: run.batchId, model, records: run.records });
  }
  const stats = db.stats();
  writeFileSync(path, Buffer.from(db.toBytes()));
  db.close();
  console.log(
    `Released into ${path}${existing === undefined ? " (new catalogue)" : " (continued)"} — ` +
      `${stats.batches} batch(es), ${stats.cards} verified card(s), ${stats.rejected} rejection(s) kept.`,
  );
  if (!wantSafety) {
    console.log(
      "  note: the safety gate did not run, so these cards are accepted on the local\n" +
      "        stages only. Run with --safety before treating them as verified.",
    );
  }
}

process.exit(totals.rejected > 0 ? 1 : 0);

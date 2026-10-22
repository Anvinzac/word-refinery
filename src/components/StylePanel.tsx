/**
 * The style set — the thirty cards the reviewer rewrites to teach their voice.
 *
 * A workspace of its own rather than a filter on the library, because the job
 * is different. The library is for judging a deck: approve, reject, move on.
 * This is for rewriting a small set until it sounds right, and the thing worth
 * seeing is how far through that work you are and which cards still read like
 * the machine wrote them.
 *
 * Editing happens in the same table and the same refine brief as everywhere
 * else — a second editor would be a second set of bugs — so a card rewritten
 * here is marked `edited` and keeps its pre-edit snapshot like any other.
 *
 * Exports: StylePanel
 * Depends on: ./ReviewTable.tsx, ../lib/style.ts
 */
import { useMemo, useRef, useState } from "react";
import { ReviewTable } from "./ReviewTable";
import { STYLE_SET_SIZE, pickStyleSet, styleSetProgress } from "../lib/style";
import type { Settings } from "../lib/settings";
import type { ReviewEntry } from "../lib/types";
import { STYLE_FILE_NAME, applyStyleFile, buildStyleFile, parseStyleFile } from "../lib/style-file";
import { downloadJson } from "../lib/store";
import { resolvePrompt } from "../lib/prompt-store";

export function StylePanel({
  entries,
  settings,
  onChange,
}: {
  entries: readonly ReviewEntry[];
  settings: Settings;
  onChange: (next: ReviewEntry[]) => void;
}) {
  const samples = useMemo(
    () => entries.filter((entry) => entry.styleSample === true),
    [entries],
  );
  const progress = useMemo(() => styleSetProgress(entries), [entries]);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /** Write the pairs and the guide out, for committing to the repository. */
  const exportFile = () => {
    const file = buildStyleFile(entries, resolvePrompt("style"));
    downloadJson(file, STYLE_FILE_NAME);
    setNotice(
      `Downloaded ${STYLE_FILE_NAME} with ${file.samples.length} pair(s). Put it in public/ and commit it — ` +
        "then every browser that loads the site starts with this voice.",
    );
  };

  /** Read a style set back in, from a file or from another machine. */
  const importFile = async (picked: File) => {
    setNotice(null);
    const file = parseStyleFile(await picked.text());
    if (file === null) {
      setNotice(`${picked.name} is not a style-samples file.`);
      return;
    }
    const applied = applyStyleFile(entries, file);
    onChange(applied.entries);
    setNotice(
      `Restored ${file.samples.length - applied.unmatched.length} pair(s)` +
        (applied.unmatched.length > 0
          ? `; ${applied.unmatched.length} found no card here (${applied.unmatched.slice(0, 5).join(", ")})`
          : "."),
    );
  };

  /** Mark a fresh spread of cards, keeping whatever is already in the set. */
  const pick = () => {
    const chosen = new Set(pickStyleSet(entries));
    if (chosen.size === 0) return;
    onChange(
      entries.map((entry) =>
        chosen.has(entry.id) ? { ...entry, styleSample: true } : entry,
      ),
    );
  };

  /** Drop the cards not yet rewritten and draw replacements for them. */
  const reroll = () => {
    const kept = entries.map((entry) =>
      entry.styleSample === true && entry.original === undefined
        ? { ...entry, styleSample: false }
        : entry,
    );
    const chosen = new Set(pickStyleSet(kept));
    onChange(
      kept.map((entry) => (chosen.has(entry.id) ? { ...entry, styleSample: true } : entry)),
    );
  };

  const clear = () => {
    onChange(entries.map((entry) => ({ ...entry, styleSample: false })));
  };

  const done = progress.edited;
  const percent = progress.marked === 0 ? 0 : Math.round((done / progress.marked) * 100);

  return (
    <section className="panel">
      <h2>Style set</h2>
      <p className="hint">
        Rewrite these until they sound like you. The app keeps what each card said before you
        touched it — that pair is what the style guide is built from, so a card you leave alone
        teaches nothing. {STYLE_SET_SIZE} is a good target; a spread across levels matters more
        than the exact number.
      </p>

      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className="btn primary" onClick={pick} disabled={progress.marked >= STYLE_SET_SIZE}>
          {progress.marked === 0
            ? `Pick ${STYLE_SET_SIZE} for me`
            : `Top up to ${STYLE_SET_SIZE}`}
        </button>
        {progress.marked > done && (
          <button type="button" className="btn" onClick={reroll}>
            Re-roll the {progress.marked - done} untouched
          </button>
        )}
        {progress.marked > 0 && (
          <button type="button" className="btn sm" onClick={clear}>
            Clear the set
          </button>
        )}
        <div className="spacer" />
        {progress.edited > 0 && (
          <button type="button" className="btn" onClick={exportFile}>
            Download for the repo
          </button>
        )}
        <button type="button" className="btn sm" onClick={() => fileInput.current?.click()}>
          Restore from file
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={(event) => {
            const picked = event.target.files?.[0];
            if (picked !== undefined) void importFile(picked);
            event.target.value = "";
          }}
        />
      </div>

      {notice !== null && (
        <div className="banner" style={{ marginTop: 12 }}>
          {notice}
        </div>
      )}

      {progress.marked > 0 && (
        <>
          <div className="progress" aria-hidden="true" style={{ marginTop: 14 }}>
            <i style={{ width: `${percent}%` }} />
          </div>
          <p className="note" style={{ color: "var(--muted)", fontSize: 12, margin: "6px 0 0" }}>
            {done} of {progress.marked} rewritten · {progress.pairs} before/after pair(s) to learn
            from
            {done === 0 && " — nothing to distil until you change something"}
          </p>
        </>
      )}

      {samples.length === 0 ? (
        <div className="empty" style={{ marginTop: 16 }}>
          No style set yet. Picking draws a spread across every CEFR level, because a guide built
          from thirty easy nouns describes a voice that only exists in the easy half of the deck.
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          <ReviewTable
            entries={entries}
            rows={samples}
            settings={settings}
            selected={new Set()}
            onToggleSelect={() => {}}
            onChange={onChange}
          />
        </div>
      )}
    </section>
  );
}

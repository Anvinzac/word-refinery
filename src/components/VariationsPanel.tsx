/**
 * Variations — one word, four takes, choose per field.
 *
 * Regenerating a field hands back another sentence and leaves you comparing it
 * against one you can no longer see. This shows the alternatives side by side,
 * so choosing is a comparison rather than a memory test, and so a field you are
 * happy with can stay while the one beside it changes.
 *
 * The four rows differ along named axes rather than by resampling, because
 * four rolls of the same prompt cluster together and the differences between
 * them are noise. Each row is one request, so re-rolling a row costs one call
 * and leaves the others alone.
 *
 * Adopting a cell writes that field onto the word as a MODEL edit, which keeps
 * it out of the style-pair distillation: a chosen variation is still generated
 * text, however good.
 *
 * Exports: VariationsPanel
 * Depends on: ../lib/variations.ts, ../lib/llm.ts
 */
import { useMemo, useState } from "react";
import { MarkedText } from "./ReviewTable";
import { describeLlmError, generateVariation, markupField } from "../lib/llm";
import { hasAnyMark, countUnits } from "../lib/joiner";
import {
  VARIATION_FIELDS,
  VARIATION_SLANTS,
  emptyRow,
  type VariationRow,
} from "../lib/variations";
import type { MarkupField } from "../lib/prompt";
import type { Settings } from "../lib/settings";
import type { DeckWord, ReviewEntry } from "../lib/types";

/** Column headings, in the order the reader meets the card. */
const LABELS: Record<MarkupField, string> = {
  meaningVi: "meaning",
  defVi: "defVi",
  leadVi: "leadVi",
  anticipateVi: "anticipateVi",
  usageVi: "usage (vi)",
};

/** The text a field holds on a word. */
function textOf(word: DeckWord, field: MarkupField): string {
  return field === "usageVi" ? (word.usage[0]?.vi ?? "") : (word[field] ?? "");
}

export function VariationsPanel({
  entries,
  settings,
  onChange,
}: {
  entries: readonly ReviewEntry[];
  settings: Settings;
  onChange: (next: ReviewEntry[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [rows, setRows] = useState<VariationRow[]>(() =>
    VARIATION_SLANTS.map((slant) => emptyRow(slant.id)),
  );
  const [adopting, setAdopting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [];
    return entries
      .filter((entry) => entry.deckWord.word.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [entries, query]);

  const entry = useMemo(
    () => entries.find((row) => row.id === chosenId) ?? null,
    [entries, chosenId],
  );

  /** Start again on a different word: the old takes do not belong to it. */
  const choose = (id: string) => {
    setChosenId(id);
    setQuery("");
    setNotice(null);
    setRows(VARIATION_SLANTS.map((slant) => emptyRow(slant.id)));
  };

  /** Write one row, replacing whatever it held. */
  const runRow = async (slantId: string) => {
    const slant = VARIATION_SLANTS.find((item) => item.id === slantId);
    if (slant === undefined || entry === null) return;
    if (settings.llm.apiKey.length === 0) {
      setNotice("Add an API key in Settings before generating variations.");
      return;
    }
    setRows((previous) =>
      previous.map((row) =>
        row.slant === slantId ? { ...row, busy: true, error: null } : row,
      ),
    );
    try {
      const fields = await generateVariation(
        settings.llm,
        entry.deckWord,
        slant.instruction,
        slant.label,
      );
      setRows((previous) =>
        previous.map((row) =>
          row.slant === slantId ? { slant: slantId, fields, error: null, busy: false } : row,
        ),
      );
    } catch (thrown) {
      const message = describeLlmError(thrown);
      setRows((previous) =>
        previous.map((row) =>
          row.slant === slantId ? { ...row, busy: false, error: message } : row,
        ),
      );
    }
  };

  /** Write every row, one after another so a failure is legible. */
  const runAll = async () => {
    for (const slant of VARIATION_SLANTS) await runRow(slant.id);
  };

  /**
   * Take one cell as the card's new text.
   *
   * Marked on the way in when the take came back bare, for the same reason a
   * rewrite is: a variation request carries the whole quality bar at once and
   * the marks are what slips.
   */
  const adopt = async (field: MarkupField, text: string) => {
    if (entry === null) return;
    const key = `${field}:${text}`;
    setAdopting(key);
    setNotice(null);
    let written = text;
    try {
      if (!hasAnyMark(text) && countUnits(text) > 2) {
        const marked = await markupField(settings.llm, entry.deckWord, field, text);
        written = marked.text;
      }
    } catch {
      // Marking is a courtesy; the reviewer's choice stands either way.
    }
    onChange(
      entries.map((row) => {
        if (row.id !== entry.id) return row;
        const deckWord =
          field === "usageVi"
            ? {
                ...row.deckWord,
                usage: row.deckWord.usage.map((item, index) =>
                  index === 0 ? { ...item, vi: written } : item,
                ),
              }
            : ({ ...row.deckWord, [field]: written } as DeckWord);
        // A chosen variation is still generated text, so it must not become
        // half of a style pair.
        return { ...row, deckWord, machineEdited: true, status: "edited" as const };
      }),
    );
    setAdopting(null);
    setNotice(`Took the ${LABELS[field]} from this row.`);
  };

  return (
    <section className="panel">
      <h2>Variations</h2>
      <p className="hint">
        One word, four takes on it, side by side. Tap any cell to make it the card's text; use a
        row's Generate to roll that row again. The four differ along fixed axes rather than by
        chance, so a row that never suits you is telling you something.
      </p>

      <div className="field" style={{ marginTop: 12, maxWidth: 420 }}>
        <label htmlFor="variation-word">Word</label>
        <input
          id="variation-word"
          type="search"
          placeholder="Search the deck…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {matches.length > 0 && (
          <div className="chips" style={{ marginTop: 8 }}>
            {matches.map((row) => (
              <button
                key={row.id}
                type="button"
                className="chip"
                onClick={() => choose(row.id)}
              >
                {row.deckWord.word}
                <span style={{ opacity: 0.7, marginLeft: 5 }}>{row.deckWord.level}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {entry === null ? (
        <div className="empty" style={{ marginTop: 16 }}>
          Search for a word to see four takes on it.
        </div>
      ) : (
        <>
          <div className="row" style={{ marginTop: 14 }}>
            <strong style={{ fontSize: 15 }}>{entry.deckWord.word}</strong>
            <span className="note" style={{ color: "var(--muted)", fontSize: 12 }}>
              {entry.deckWord.level} · {entry.deckWord.pos || "—"} ·{" "}
              {entry.deckWord.topics.join(", ")}
            </span>
            <div className="spacer" />
            <button
              type="button"
              className="btn primary"
              disabled={rows.some((row) => row.busy)}
              onClick={() => void runAll()}
            >
              {rows.some((row) => row.busy) ? "Writing…" : "Generate all four"}
            </button>
          </div>

          {notice !== null && (
            <div className="banner" style={{ marginTop: 12 }}>
              {notice}
            </div>
          )}

          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table className="review-table variations">
              <thead>
                <tr>
                  <th>Take</th>
                  {VARIATION_FIELDS.map((field) => (
                    <th key={field}>{LABELS[field]}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                <tr data-current="true">
                  <th scope="row" className="variation-label">
                    Current
                    <span className="variation-note">what the card says now</span>
                  </th>
                  {VARIATION_FIELDS.map((field) => (
                    <td key={field} className="vi-cell" lang="vi">
                      {textOf(entry.deckWord, field).length > 0 ? (
                        <MarkedText value={textOf(entry.deckWord, field)} />
                      ) : (
                        <span style={{ color: "var(--muted)" }}>—</span>
                      )}
                    </td>
                  ))}
                  <td />
                </tr>

                {VARIATION_SLANTS.map((slant) => {
                  const row = rows.find((item) => item.slant === slant.id) ?? emptyRow(slant.id);
                  return (
                    <tr key={slant.id}>
                      <th scope="row" className="variation-label">
                        {slant.label}
                        <span className="variation-note">{slant.note}</span>
                      </th>
                      {row.error !== null ? (
                        <td colSpan={VARIATION_FIELDS.length} className="variation-error">
                          {row.error}
                        </td>
                      ) : (
                        VARIATION_FIELDS.map((field) => {
                          const text = row.fields[field];
                          const same = text !== undefined && text === textOf(entry.deckWord, field);
                          return (
                            <td
                              key={field}
                              className={text === undefined ? "vi-cell" : "vi-cell clickable"}
                              lang="vi"
                              role={text === undefined ? undefined : "button"}
                              tabIndex={text === undefined ? undefined : 0}
                              data-same={same || undefined}
                              title={text === undefined ? undefined : "Use this one"}
                              onClick={() => {
                                if (text !== undefined) void adopt(field, text);
                              }}
                              onKeyDown={(event) => {
                                if (text === undefined) return;
                                if (event.key !== "Enter" && event.key !== " ") return;
                                event.preventDefault();
                                void adopt(field, text);
                              }}
                            >
                              {row.busy ? (
                                <span style={{ color: "var(--muted)" }}>…</span>
                              ) : text === undefined ? (
                                <span style={{ color: "var(--muted)" }}>—</span>
                              ) : (
                                <>
                                  <MarkedText value={text} />
                                  {adopting === `${field}:${text}` && (
                                    <div className="variation-note">taking…</div>
                                  )}
                                </>
                              )}
                            </td>
                          );
                        })
                      )}
                      <td className="actions-cell">
                        <button
                          type="button"
                          className="btn sm"
                          disabled={row.busy}
                          onClick={() => void runRow(slant.id)}
                        >
                          {row.busy ? "…" : Object.keys(row.fields).length > 0 ? "Again" : "Generate"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

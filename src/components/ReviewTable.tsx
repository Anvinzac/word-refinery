/**
 * Review workspace — a compact table where each Vietnamese field sits in its
 * own column, making it easy to scan and judge many words at once.
 *
 * Each row renders the deck word with its `/…/` markers highlighted. Quick
 * approve/reject controls let the reviewer sign off on rows without expanding
 * them.
 *
 * Refining happens in place: tapping a Vietnamese cell unfolds a brief directly
 * beneath that row — the table stays on screen, so neighbouring words remain
 * available for comparison while the complaint is written. The brief gathers
 * three things and sends them as one instruction: complaint chips tapped for
 * that field, a free-text note, and whatever the validator already flagged
 * there. The exact prompt is inspectable before it is sent.
 *
 * Exports: ReviewTable, MarkedText
 * Depends on: ../lib/deck.ts, ../lib/emphasis.ts, ../lib/llm.ts, ../lib/prompt.ts, ../lib/types.ts
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { validateDeck, type DeckIssue } from "../lib/deck";
import { stripEmphasisMarkers } from "../lib/emphasis";
import { regenerateField } from "../lib/llm";
import { buildRegeneratePrompt, chipsForField, type RefineField, type RefineRequest } from "../lib/prompt";
import type { Settings } from "../lib/settings";
import type { DeckWord, ReviewEntry, ReviewStatus } from "../lib/types";

/** Render a marked field, visually distinguishing the `/highlighted/` span. */
export function MarkedText({ value }: { value: string }) {
  const parts = value.split(/(\/[^/]+\/)/g);
  return (
    <>
      {parts.map((part, index) => {
        const isMarker = part.startsWith("/") && part.endsWith("/") && part.length > 2;
        return isMarker ? (
          <span key={index} className="marked">
            {part.slice(1, -1)}
          </span>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        );
      })}
    </>
  );
}

/** Statuses a reviewer can move a row to. */
const STATUSES: readonly ReviewStatus[] = ["pending", "approved", "edited", "rejected"];

/** Column header per refinable field, reused by the inline brief's title. */
const FIELD_LABELS: Record<RefineField, string> = {
  defVi: "defVi",
  leadVi: "leadVi",
  anticipateVi: "anticipateVi",
  usageVi: "usage (vi)",
};

/**
 * Which validator findings belong to a field. The validator reports usage
 * problems positionally (`usage[0].vi`), so the usage column matches on a
 * pattern rather than on an exact name.
 */
function issuesForField(issues: readonly DeckIssue[], field: RefineField): string[] {
  const match = (issue: DeckIssue) =>
    field === "usageVi" ? /^usage\[\d+]\./.test(issue.field) : issue.field === field;
  return issues.filter(match).map((issue) => `${issue.field} ${issue.message}`);
}

/** The cell currently unfolded for refinement. */
interface ActiveCell {
  entryId: string;
  field: RefineField;
}

export function ReviewTable({
  entries,
  settings,
  onChange,
}: {
  entries: readonly ReviewEntry[];
  settings: Settings;
  onChange: (next: ReviewEntry[]) => void;
}) {
  const [filter, setFilter] = useState<ReviewStatus | "all">("all");
  const [active, setActive] = useState<ActiveCell | null>(null);
  const [chips, setChips] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set after a successful rewrite so the still-open brief confirms it landed. */
  const [rewrote, setRewrote] = useState<string | null>(null);

  /** Issues per word id, recomputed whenever the deck content changes. */
  const issuesById = useMemo(() => {
    const map = new Map<string, DeckIssue[]>();
    const issues = validateDeck({
      meta: {
        name: "",
        version: "",
        locale: "en_vi",
        generatedAt: "",
        generator: "",
        model: "",
        corpus: "",
        corpusLicense: "",
        wordCount: entries.length,
        notes: "",
      },
      words: entries.map((entry) => entry.deckWord),
    });
    for (const issue of issues) {
      const list = map.get(issue.wordId) ?? [];
      list.push(issue);
      map.set(issue.wordId, list);
    }
    return map;
  }, [entries]);

  const counts = useMemo(() => {
    const tally: Record<ReviewStatus, number> = { pending: 0, approved: 0, edited: 0, rejected: 0 };
    for (const entry of entries) tally[entry.status] += 1;
    return tally;
  }, [entries]);

  const visible = useMemo(
    () => (filter === "all" ? entries : entries.filter((entry) => entry.status === filter)),
    [entries, filter],
  );

  const patchWord = (id: string, patch: Partial<DeckWord>) => {
    onChange(
      entries.map((entry) =>
        entry.id === id
          ? { ...entry, deckWord: { ...entry.deckWord, ...patch }, status: "edited" as const }
          : entry,
      ),
    );
  };

  const setStatus = (id: string, status: ReviewStatus) => {
    onChange(entries.map((entry) => (entry.id === id ? { ...entry, status } : entry)));
  };

  const approveAll = () => {
    onChange(
      entries.map((entry) =>
        entry.status === "pending" ? { ...entry, status: "approved" as const } : entry,
      ),
    );
  };

  const closeBrief = () => {
    setActive(null);
    setChips([]);
    setNote("");
    setRewrote(null);
    setError(null);
  };

  // Escape folds the brief away from anywhere inside it — the cell that opened it
  // has long lost focus by the time the note is being typed. A request in flight
  // keeps it open, so the reply still has somewhere to land.
  useEffect(() => {
    if (active === null || busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeBrief();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, busy]);

  /** Tapping the open cell folds the brief away; any other cell moves it there. */
  const toggleCell = (entryId: string, field: RefineField) => {
    if (busy) return;
    if (active !== null && active.entryId === entryId && active.field === field) {
      closeBrief();
      return;
    }
    setActive({ entryId, field });
    setChips([]);
    setNote("");
    setRewrote(null);
    setError(null);
  };

  const toggleChip = (id: string) => {
    setChips((prev) => (prev.includes(id) ? prev.filter((chip) => chip !== id) : [...prev, id]));
  };

  /** The request as it will be sent, so the preview and the call cannot diverge. */
  const buildRequest = (entryId: string, field: RefineField): RefineRequest => ({
    field,
    chips,
    note,
    issues: issuesForField(issuesById.get(entryId) ?? [], field),
  });

  const regenerate = async (entry: ReviewEntry, field: RefineField) => {
    setError(null);
    setRewrote(null);
    if (settings.llm.apiKey.length === 0) {
      setError("Add an API key in Settings before regenerating a field.");
      return;
    }

    setBusy(true);
    try {
      const value = await regenerateField(
        settings.llm,
        entry.deckWord,
        buildRequest(entry.id, field),
      );
      if (field === "usageVi") {
        const usage = entry.deckWord.usage.map((item, index) =>
          index === 0 ? { ...item, vi: value } : item,
        );
        patchWord(entry.id, { usage });
      } else {
        patchWord(entry.id, { [field]: stripEmphasisMarkers(value) } as Partial<DeckWord>);
      }
      // The brief stays open: a rewrite often needs a second pass, and the chips
      // that described the problem are still the right ones to send again.
      setRewrote(value);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setBusy(false);
    }
  };

  /** Props shared by every refinable cell: click, keyboard and open-state. */
  const cellProps = (entryId: string, field: RefineField) => ({
    className: "vi-cell clickable",
    role: "button",
    tabIndex: 0,
    "aria-expanded":
      active !== null && active.entryId === entryId && active.field === field,
    "data-refining":
      active !== null && active.entryId === entryId && active.field === field ? true : undefined,
    onClick: () => toggleCell(entryId, field),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleCell(entryId, field);
    },
  });

  /** The brief itself, rendered as a full-width row beneath the word it edits. */
  const renderBrief = (entry: ReviewEntry, field: RefineField) => {
    const fieldIssues = issuesForField(issuesById.get(entry.id) ?? [], field);
    const offered = chipsForField(field);
    const preview = buildRegeneratePrompt(entry.deckWord, buildRequest(entry.id, field));

    return (
      <tr className="refine-row" data-status={entry.status}>
        <td colSpan={6}>
          <div className="refine">
            <div className="refine-head">
              <strong>
                Rewrite <code>{FIELD_LABELS[field]}</code> for “{entry.deckWord.word}”
              </strong>
              <button type="button" className="btn sm" onClick={closeBrief} disabled={busy}>
                Close
              </button>
            </div>

            {fieldIssues.length > 0 && (
              <div className="refine-section">
                <div className="refine-label">
                  Validator already flagged — sent with the request
                </div>
                <ul className="refine-issues">
                  {fieldIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="refine-section">
              <div className="refine-label">What's wrong?</div>
              <div className="chips">
                {offered.map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    className="chip"
                    data-active={chips.includes(chip.id)}
                    title={chip.instruction}
                    aria-pressed={chips.includes(chip.id)}
                    disabled={busy}
                    onClick={() => toggleChip(chip.id)}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="refine-section">
              <div className="refine-label">Anything else to tell the model?</div>
              <textarea
                className="refine-note"
                rows={2}
                placeholder="e.g. compare it to something a child would recognise, keep the rhythm of the old line…"
                value={note}
                disabled={busy}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>

            <details className="refine-preview">
              <summary>
                Prompt being sent
                <span className="refine-tally">
                  {chips.length} chip{chips.length === 1 ? "" : "s"}
                  {note.trim().length > 0 ? " + note" : ""}
                  {fieldIssues.length > 0
                    ? ` + ${fieldIssues.length} validator finding${fieldIssues.length === 1 ? "" : "s"}`
                    : ""}
                </span>
              </summary>
              <pre>{preview}</pre>
            </details>

            {error !== null && <div className="banner error">{error}</div>}
            {rewrote !== null && (
              <div className="refine-result">
                <div className="refine-label">Rewritten — the row above now reads</div>
                <div lang="vi">{stripEmphasisMarkers(rewrote)}</div>
              </div>
            )}

            <div className="refine-foot">
              <button
                type="button"
                className="btn primary"
                onClick={() => void regenerate(entry, field)}
                disabled={busy}
              >
                {busy ? "Regenerating…" : rewrote !== null ? "Regenerate again" : "Regenerate"}
              </button>
            </div>
          </div>
        </td>
      </tr>
    );
  };

  return (
    <section className="panel">
      <h2>Review</h2>
      <p className="hint">
        Each Vietnamese field sits in its own column. Tap a cell to refine it in place, approve what
        reads well, reject what should never ship. Only approved and edited rows are included in the
        exported deck.
      </p>

      <div className="review-toolbar">
        <button type="button" className="chip" data-active={filter === "all"} onClick={() => setFilter("all")}>
          All <span style={{ opacity: 0.7 }}>{entries.length}</span>
        </button>
        {STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            className="chip"
            data-active={filter === status}
            onClick={() => setFilter(status)}
          >
            {status} <span style={{ opacity: 0.7 }}>{counts[status]}</span>
          </button>
        ))}
        <div className="spacer" />
        <button type="button" className="btn sm" onClick={approveAll} disabled={counts.pending === 0}>
          Approve all pending
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="empty">
          {entries.length === 0
            ? "Nothing generated yet. Use the Generate tab to annotate your first batch."
            : "No rows match this filter."}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="review-table">
            <thead>
              <tr>
                <th>Word</th>
                <th>defVi</th>
                <th>leadVi</th>
                <th>anticipateVi</th>
                <th>usage</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => {
                const usage = entry.deckWord.usage[0];
                const openHere = active !== null && active.entryId === entry.id;
                const issueCount = (issuesById.get(entry.id) ?? []).length;
                return (
                  <Fragment key={entry.id}>
                    <tr data-status={entry.status} data-refining={openHere || undefined}>
                      <td className="word-cell">
                        <div>{entry.deckWord.word}</div>
                        <div className="meta-cell">
                          {entry.deckWord.level} · {entry.deckWord.pos || "—"} · {entry.deckWord.topic}
                        </div>
                        {issueCount > 0 && (
                          <div className="word-issues" title={`${issueCount} validation issue(s)`}>
                            ⚠ {issueCount}
                          </div>
                        )}
                      </td>
                      <td {...cellProps(entry.id, "defVi")} lang="vi">
                        <MarkedText value={entry.deckWord.defVi} />
                      </td>
                      <td {...cellProps(entry.id, "leadVi")} lang="vi">
                        {entry.deckWord.leadVi.length > 0 ? (
                          <MarkedText value={entry.deckWord.leadVi} />
                        ) : (
                          <span style={{ color: "var(--muted)" }}>—</span>
                        )}
                      </td>
                      <td {...cellProps(entry.id, "anticipateVi")} lang="vi">
                        {entry.deckWord.anticipateVi.length > 0 ? (
                          stripEmphasisMarkers(entry.deckWord.anticipateVi)
                        ) : (
                          <span style={{ color: "var(--muted)" }}>—</span>
                        )}
                      </td>
                      <td {...cellProps(entry.id, "usageVi")}>
                        {usage !== undefined ? (
                          <>
                            <div lang="en">{usage.en}</div>
                            <div lang="vi" style={{ color: "var(--muted)", fontSize: 12 }}>
                              {usage.vi}
                            </div>
                          </>
                        ) : (
                          <span style={{ color: "var(--muted)" }}>—</span>
                        )}
                      </td>
                      <td className="actions-cell">
                        <span className="pill" data-status={entry.status}>
                          {entry.status}
                        </span>
                        <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => setStatus(entry.id, "approved")}
                            disabled={entry.status === "approved"}
                          >
                            ✓
                          </button>
                          <button
                            type="button"
                            className="btn sm danger"
                            onClick={() =>
                              setStatus(entry.id, entry.status === "rejected" ? "pending" : "rejected")
                            }
                          >
                            {entry.status === "rejected" ? "↺" : "✗"}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {openHere && active !== null && renderBrief(entry, active.field)}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

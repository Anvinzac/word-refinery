/**
 * Review workspace — a compact table where each Vietnamese field sits in its
 * own column, making it easy to scan and judge many words at once.
 *
 * Each row renders the deck word with its `/…/` markers highlighted. Quick
 * approve/reject controls let the reviewer sign off on rows without expanding
 * them.
 *
 * Exports: ReviewTable, MarkedText
 * Depends on: ../lib/emphasis.ts, ../lib/types.ts
 */
import { Fragment, useMemo, useState } from "react";
import { validateDeck } from "../lib/deck";
import { stripEmphasisMarkers } from "../lib/emphasis";
import { regenerateField } from "../lib/llm";
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

/** Common complaint chips for quick feedback. */
const COMPLAINT_CHIPS = [
  "too long",
  "too short",
  "contains answer",
  "awkward phrasing",
  "unnatural",
  "wrong meaning",
];

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
  const [openCell, setOpenCell] = useState<{ entryId: string; field: "defVi" | "leadVi" | "anticipateVi" | "usageVi" } | null>(null);
  const [selectedChips, setSelectedChips] = useState<string[]>([]);
  const [customFeedback, setCustomFeedback] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Issues per word id, recomputed whenever the deck content changes. */
  const issuesById = useMemo(() => {
    const map = new Map<string, string[]>();
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
      list.push(`${issue.field}: ${issue.message}`);
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

  const openPopover = (entryId: string, field: "defVi" | "leadVi" | "anticipateVi" | "usageVi") => {
    setOpenCell({ entryId, field });
    setSelectedChips([]);
    setCustomFeedback("");
    setError(null);
  };

  const closePopover = () => {
    setOpenCell(null);
    setSelectedChips([]);
    setCustomFeedback("");
  };

  const toggleChip = (chip: string) => {
    setSelectedChips((prev) =>
      prev.includes(chip) ? prev.filter((c) => c !== chip) : [...prev, chip],
    );
  };

  const regenerate = async () => {
    if (openCell === null) return;
    const entry = entries.find((e) => e.id === openCell.entryId);
    if (entry === undefined) return;

    setError(null);
    if (settings.llm.apiKey.length === 0) {
      setError("Add an API key in Settings before regenerating a field.");
      return;
    }

    const feedback = [...selectedChips, customFeedback].filter(Boolean).join(", ");
    const complaint = feedback.length > 0 ? feedback : "improve naturally";

    setBusyId(entry.id);
    try {
      const value = await regenerateField(settings.llm, entry.deckWord, openCell.field, complaint);
      if (openCell.field === "usageVi") {
        const usage = entry.deckWord.usage.map((item, index) =>
          index === 0 ? { ...item, vi: value } : item,
        );
        patchWord(entry.id, { usage });
      } else {
        patchWord(entry.id, { [openCell.field]: stripEmphasisMarkers(value) } as Partial<DeckWord>);
      }
      closePopover();
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="panel">
      <h2>Review</h2>
      <p className="hint">
        Each Vietnamese field sits in its own column. Approve what reads well, reject what should
        never ship. Only approved and edited rows are included in the exported deck.
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

      {error !== null && <div className="banner error">{error}</div>}

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
                return (
                  <tr key={entry.id} data-status={entry.status}>
                    <td className="word-cell">
                      <div>{entry.deckWord.word}</div>
                      <div className="meta-cell">
                        {entry.deckWord.level} · {entry.deckWord.pos || "—"} · {entry.deckWord.topic}
                      </div>
                    </td>
                    <td
                      className="vi-cell clickable"
                      lang="vi"
                      onClick={() => openPopover(entry.id, "defVi")}
                    >
                      <MarkedText value={entry.deckWord.defVi} />
                    </td>
                    <td
                      className="vi-cell clickable"
                      lang="vi"
                      onClick={() => openPopover(entry.id, "leadVi")}
                    >
                      {entry.deckWord.leadVi.length > 0 ? (
                        <MarkedText value={entry.deckWord.leadVi} />
                      ) : (
                        <span style={{ color: "var(--muted)" }}>—</span>
                      )}
                    </td>
                    <td
                      className="vi-cell clickable"
                      lang="vi"
                      onClick={() => openPopover(entry.id, "anticipateVi")}
                    >
                      {entry.deckWord.anticipateVi.length > 0 ? (
                        stripEmphasisMarkers(entry.deckWord.anticipateVi)
                      ) : (
                        <span style={{ color: "var(--muted)" }}>—</span>
                      )}
                    </td>
                    <td
                      className="vi-cell clickable"
                      onClick={() => openPopover(entry.id, "usageVi")}
                    >
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {openCell !== null && (
        <div className="popover-overlay" onClick={closePopover}>
          <div className="popover" onClick={(e) => e.stopPropagation()}>
            <div className="popover-header">
              <strong>Regenerate {openCell.field}</strong>
              <button type="button" className="btn sm" onClick={closePopover}>
                ✕
              </button>
            </div>
            <div className="popover-body">
              {(() => {
                const entry = entries.find((e) => e.id === openCell.entryId);
                if (entry === undefined) return null;
                const issues = issuesById.get(entry.id) ?? [];
                const fieldIssues = issues.filter((i) => i.startsWith(`${openCell.field}:`));
                return (
                  <>
                    {fieldIssues.length > 0 && (
                      <div className="popover-section">
                        <div className="popover-label">Validation issues:</div>
                        <ul className="popover-issues">
                          {fieldIssues.map((issue, index) => (
                            <li key={index}>{issue}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="popover-section">
                      <div className="popover-label">What's wrong?</div>
                      <div className="chips">
                        {COMPLAINT_CHIPS.map((chip) => (
                          <button
                            key={chip}
                            type="button"
                            className="chip"
                            data-active={selectedChips.includes(chip)}
                            onClick={() => toggleChip(chip)}
                          >
                            {chip}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="popover-section">
                      <div className="popover-label">Additional feedback:</div>
                      <input
                        type="text"
                        className="popover-input"
                        placeholder="e.g., make it more casual, use a different metaphor…"
                        value={customFeedback}
                        onChange={(e) => setCustomFeedback(e.target.value)}
                      />
                    </div>
                  </>
                );
              })()}
            </div>
            <div className="popover-footer">
              <button
                type="button"
                className="btn primary"
                onClick={() => void regenerate()}
                disabled={busyId !== null}
              >
                {busyId !== null ? "Regenerating…" : "Regenerate"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

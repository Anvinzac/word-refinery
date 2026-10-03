/**
 * Review workspace — read, edit, approve or reject every generated word.
 *
 * Each row renders the deck word with its `/…/` markers highlighted so the
 * reviewer sees exactly what will glow in the feed. Editing a field marks the
 * row "edited" and re-validates the whole deck, so the issue list always
 * reflects current content rather than the last generation run.
 *
 * Exports: ReviewTable, MarkedText
 * Depends on: ../lib/deck.ts, ../lib/emphasis.ts, ../lib/llm.ts, ../lib/types.ts
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
  const [expanded, setExpanded] = useState<string | null>(null);
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

  const remove = (id: string) => {
    onChange(entries.filter((entry) => entry.id !== id));
  };

  const approveAll = () => {
    onChange(
      entries.map((entry) =>
        entry.status === "pending" ? { ...entry, status: "approved" as const } : entry,
      ),
    );
  };

  const rewrite = async (entry: ReviewEntry, field: "defVi" | "leadVi" | "anticipateVi" | "usageVi") => {
    setError(null);
    if (settings.llm.apiKey.length === 0) {
      setError("Add an API key in Settings before regenerating a field.");
      return;
    }
    const complaint = globalThis.prompt(
      `What is wrong with ${field} for "${entry.deckWord.word}"?`,
      field === "anticipateVi" ? "too generic, make it specific to this word" : "too robotic, rewrite naturally",
    );
    if (complaint === null) return;

    setBusyId(entry.id);
    try {
      const value = await regenerateField(settings.llm, entry.deckWord, field, complaint);
      if (field === "usageVi") {
        const usage = entry.deckWord.usage.map((item, index) =>
          index === 0 ? { ...item, vi: value } : item,
        );
        patchWord(entry.id, { usage });
      } else {
        // A rewritten field loses its marker, so strip any stale one from the
        // sibling field's perspective and re-mark only if a phrase still fits.
        patchWord(entry.id, { [field]: stripEmphasisMarkers(value) } as Partial<DeckWord>);
      }
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
        Approve what reads well, edit what does not, reject what should never ship. Only approved
        and edited rows are included in the exported deck.
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
        <div className="entries">
          {visible.map((entry) => {
            const issues = issuesById.get(entry.id) ?? [];
            const open = expanded === entry.id;
            const busy = busyId === entry.id;
            return (
              <article key={entry.id} className="entry" data-status={entry.status}>
                <header className="entry-head">
                  <span className="word">{entry.deckWord.word}</span>
                  <span className="pill" data-status={entry.status}>
                    {entry.status}
                  </span>
                  <span className="meta">
                    {entry.deckWord.level} · {entry.deckWord.pos || "—"} · {entry.deckWord.topic} ·{" "}
                    {entry.deckWord.chars} letters
                  </span>
                  {entry.deckWord.ipa.length > 0 && (
                    <span className="meta">{entry.deckWord.ipa}</span>
                  )}
                  <div className="spacer" />
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => setExpanded(open ? null : entry.id)}
                    aria-expanded={open}
                  >
                    {open ? "Close" : "Edit"}
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => setStatus(entry.id, "approved")}
                    disabled={entry.status === "approved"}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn sm danger"
                    onClick={() =>
                      setStatus(entry.id, entry.status === "rejected" ? "pending" : "rejected")
                    }
                  >
                    {entry.status === "rejected" ? "Unreject" : "Reject"}
                  </button>
                </header>

                <div className="entry-body">
                  <div className="field">
                    <label>defVi — definition stage</label>
                    {open ? (
                      <textarea
                        value={entry.deckWord.defVi}
                        onChange={(event) => patchWord(entry.id, { defVi: event.target.value })}
                      />
                    ) : (
                      <span lang="vi">
                        <MarkedText value={entry.deckWord.defVi} />
                      </span>
                    )}
                  </div>

                  {entry.deckWord.leadVi.length > 0 && (
                    <div className="field">
                      <label>leadVi — teaser stage</label>
                      {open ? (
                        <textarea
                          value={entry.deckWord.leadVi}
                          onChange={(event) => patchWord(entry.id, { leadVi: event.target.value })}
                        />
                      ) : (
                        <span lang="vi">
                          <MarkedText value={entry.deckWord.leadVi} />
                        </span>
                      )}
                    </div>
                  )}

                  {entry.deckWord.anticipateVi.length > 0 && (
                    <div className="field">
                      <label>anticipateVi — guess prompt</label>
                      {open ? (
                        <input
                          type="text"
                          value={entry.deckWord.anticipateVi}
                          onChange={(event) => patchWord(entry.id, { anticipateVi: event.target.value })}
                        />
                      ) : (
                        <span lang="vi">{stripEmphasisMarkers(entry.deckWord.anticipateVi)}</span>
                      )}
                    </div>
                  )}

                  {entry.deckWord.usage.map((usage, index) => (
                    <div className="field" key={index}>
                      <label>usage — example sentence</label>
                      {open ? (
                        <>
                          <input
                            type="text"
                            value={usage.en}
                            onChange={(event) => {
                              const next = entry.deckWord.usage.map((item, position) =>
                                position === index ? { ...item, en: event.target.value } : item,
                              );
                              patchWord(entry.id, { usage: next });
                            }}
                          />
                          <input
                            type="text"
                            value={usage.vi}
                            onChange={(event) => {
                              const next = entry.deckWord.usage.map((item, position) =>
                                position === index ? { ...item, vi: event.target.value } : item,
                              );
                              patchWord(entry.id, { usage: next });
                            }}
                          />
                        </>
                      ) : (
                        <>
                          <span lang="en">{usage.en}</span>
                          <span lang="vi" style={{ color: "var(--muted)" }}>
                            {usage.vi}
                          </span>
                        </>
                      )}
                    </div>
                  ))}
                </div>

                {open && (
                  <div className="row" style={{ marginTop: 10 }}>
                    <span style={{ color: "var(--muted)", fontSize: 12 }}>Rewrite with AI:</span>
                    {(["defVi", "leadVi", "anticipateVi", "usageVi"] as const).map((field) => (
                      <button
                        key={field}
                        type="button"
                        className="btn sm"
                        disabled={busy}
                        onClick={() => void rewrite(entry, field)}
                      >
                        {field}
                      </button>
                    ))}
                    <div className="spacer" />
                    <button
                      type="button"
                      className="btn sm danger"
                      onClick={() => remove(entry.id)}
                      disabled={busy}
                    >
                      Delete row
                    </button>
                  </div>
                )}

                {issues.length > 0 && (
                  <div className="issues">
                    <strong>{issues.length} issue(s)</strong>
                    <ul>
                      {issues.map((issue, index) => (
                        <li key={index}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

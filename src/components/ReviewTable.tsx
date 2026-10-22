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
 * there. The exact prompt is inspectable before it is sent. The brief also lays
 * the field out as chips so the reviewer can fix it by hand — move a phrase
 * break, toggle the highlight, delete or insert a word — and save it without
 * calling the model.
 *
 * Exports: ReviewTable, MarkedText
 * Depends on: ./SentenceEditor.tsx, ../lib/deck.ts, ../lib/emphasis.ts, ../lib/llm.ts, ../lib/prompt.ts, ../lib/types.ts
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { validateDeck, type DeckIssue } from "../lib/deck";
import { injectEmphasisMarkers, stripEmphasisMarkers, validateEmphasis } from "../lib/emphasis";
import { regenerateField, verifyWord, describeLlmError } from "../lib/llm";
import { renderExemplars, styleExemplars } from "../lib/style";
import { buildRegeneratePrompt, chipsForField, type RefineField, type RefineRequest } from "../lib/prompt";
import { collectUniqueness, renderAvoidSection } from "../lib/uniqueness";
import type { Settings } from "../lib/settings";
import type { VerifyReport } from "../lib/prompt";
import type { DeckWord, ReviewEntry, ReviewStatus } from "../lib/types";
import { SentenceEditor } from "./SentenceEditor";

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

/** Column header per refinable field, reused by the inline brief's title. */
const FIELD_LABELS: Record<RefineField, string> = {
  meaningVi: "meaningVi",
  defVi: "defVi",
  leadVi: "leadVi",
  anticipateVi: "anticipateVi",
  usageVi: "usage (vi)",
};

/** Fields whose `/…/` highlight is rendered, and therefore worth editing by hand. */
const HIGHLIGHTABLE: ReadonlySet<RefineField> = new Set<RefineField>(["defVi", "leadVi"]);

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

/** The teaser lines taken elsewhere in the deck, rendered for an anticipateVi rewrite. */
function avoidFor(entries: readonly ReviewEntry[], entryId: string, field: RefineField): string {
  if (field !== "anticipateVi") return "";
  const taken = entries.filter((entry) => entry.id !== entryId).map((entry) => entry.deckWord.anticipateVi);
  return renderAvoidSection(collectUniqueness(taken));
}

/**
 * A rewritten defVi/leadVi with the model's highlight placed, when that phrase
 * passes the same checks a generated one does; otherwise the plain text.
 */
function withHighlight(value: string, emphasis: string | null): string {
  const plain = stripEmphasisMarkers(value);
  if (emphasis === null) return plain;
  const { emphasis: kept } = validateEmphasis({ defVi: plain, emphasisVi: [emphasis] });
  return kept.length > 0 ? injectEmphasisMarkers(plain, "", kept).defVi : plain;
}

/** The text a field holds, as the hand editor reads and writes it. */
function storedText(word: DeckWord, field: RefineField): string {
  return field === "usageVi" ? (word.usage[0]?.vi ?? "") : word[field];
}

/** The cell currently unfolded for refinement. */
interface ActiveCell {
  entryId: string;
  field: RefineField;
}

export function ReviewTable({
  entries,
  rows,
  settings,
  selected,
  onToggleSelect,
  onChange,
}: {
  /** Every row in the deck. Edits map over this, so ids outside `rows` survive. */
  entries: readonly ReviewEntry[];
  /** The slice to render — already filtered and capped by the library. */
  rows: readonly ReviewEntry[];
  settings: Settings;
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onChange: (next: ReviewEntry[]) => void;
}) {
  const [active, setActive] = useState<ActiveCell | null>(null);
  const [chips, setChips] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set after a successful rewrite so the still-open brief confirms it landed. */
  const [rewrote, setRewrote] = useState<string | null>(null);
  /** Unsaved hand edits to the open field; null means the stored text is shown. */
  const [draft, setDraft] = useState<string | null>(null);
  /** The second-pass review for one word, kept until the row is checked again. */
  const [reports, setReports] = useState<Record<string, VerifyReport>>({});
  const [verifying, setVerifying] = useState<string | null>(null);

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

  const patchWord = (id: string, patch: Partial<DeckWord>) => {
    onChange(
      entries.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              // Snapshot the word as it stood BEFORE the first edit and never
              // again. The pair — what the model wrote against what the
              // reviewer changed it to — is what the style guide is distilled
              // from, and it only exists if it is captured here.
              original: entry.original ?? entry.deckWord,
              deckWord: { ...entry.deckWord, ...patch },
              status: "edited" as const,
            }
          : entry,
      ),
    );
  };

  /** Mark or unmark a card as an example of how the deck should sound. */
  const toggleStyleSample = (id: string) => {
    onChange(
      entries.map((entry) =>
        entry.id === id ? { ...entry, styleSample: entry.styleSample !== true } : entry,
      ),
    );
  };

  /** Ask the model to review one finished card. */
  const verify = async (entry: ReviewEntry) => {
    setError(null);
    if (settings.llm.apiKey.length === 0) {
      setError("Add an API key in Settings before checking a card.");
      return;
    }
    setVerifying(entry.id);
    try {
      const report = await verifyWord(settings.llm, entry.deckWord);
      setReports((previous) => ({ ...previous, [entry.id]: report }));
    } catch (thrown) {
      setError(describeLlmError(thrown));
    } finally {
      setVerifying(null);
    }
  };

  const setStatus = (id: string, status: ReviewStatus) => {
    onChange(entries.map((entry) => (entry.id === id ? { ...entry, status } : entry)));
  };

  const closeBrief = () => {
    setActive(null);
    setChips([]);
    setNote("");
    setRewrote(null);
    setError(null);
    setDraft(null);
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
    setDraft(null);
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
      const { value, emphasis } = await regenerateField(
        settings.llm,
        entry.deckWord,
        buildRequest(entry.id, field),
        {
          avoid: avoidFor(entries, entry.id, field),
          // Examples from the same field, nearest this word's level and topics.
          exemplars: renderExemplars(
            styleExemplars(entries, field, {
              level: entry.deckWord.level,
              topics: entry.deckWord.topics,
            }),
          ),
        },
      );
      let written = value;
      if (field === "usageVi") {
        const usage = entry.deckWord.usage.map((item, index) =>
          index === 0 ? { ...item, vi: value } : item,
        );
        patchWord(entry.id, { usage });
      } else {
        written = HIGHLIGHTABLE.has(field) ? withHighlight(value, emphasis) : stripEmphasisMarkers(value);
        patchWord(entry.id, { [field]: written } as Partial<DeckWord>);
      }
      // The brief stays open: a rewrite often needs a second pass, and the chips
      // that described the problem are still the right ones to send again.
      setRewrote(written);
      setDraft(null);
    } catch (thrown) {
      setError(describeLlmError(thrown));
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
    const preview = buildRegeneratePrompt(
      entry.deckWord,
      buildRequest(entry.id, field),
      avoidFor(entries, entry.id, field),
    );
    const highlightable = HIGHLIGHTABLE.has(field);
    const stored = storedText(entry.deckWord, field);
    const dirty = draft !== null && draft !== stored;

    const saveDraft = () => {
      if (draft === null) return;
      if (field === "usageVi") {
        const usage = entry.deckWord.usage.map((item, index) => (index === 0 ? { ...item, vi: draft } : item));
        patchWord(entry.id, { usage });
      } else {
        patchWord(entry.id, { [field]: draft } as Partial<DeckWord>);
      }
      closeBrief();
    };

    return (
      <tr className="refine-row" data-status={entry.status}>
        <td colSpan={8}>
          <div className="refine">
            <div className="refine-head">
              <strong>
                Rewrite <code>{FIELD_LABELS[field]}</code> for “{entry.deckWord.word}”
              </strong>
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

            {stored.length > 0 && (
              <div className="refine-section">
                <div className="refine-label">Edit by hand</div>
                <SentenceEditor
                  value={draft ?? stored}
                  highlightable={highlightable}
                  disabled={busy}
                  onChange={setDraft}
                />
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
              <div className="refine-note-box">
                <textarea
                  className="refine-note"
                  rows={2}
                  placeholder="e.g. compare it to something a child would recognise, keep the rhythm of the old line…"
                  value={note}
                  disabled={busy}
                  onChange={(event) => setNote(event.target.value)}
                />
                {note.length > 0 && (
                  <button
                    type="button"
                    className="refine-note-clear"
                    aria-label="Clear note"
                    title="Clear note"
                    onClick={() => setNote("")}
                    disabled={busy}
                  >
                    ×
                  </button>
                )}
                <button
                  type="button"
                  className="btn sm primary refine-note-send"
                  onClick={() => void regenerate(entry, field)}
                  disabled={busy}
                >
                  {busy ? "Regenerating…" : rewrote !== null ? "Regenerate again" : "Regenerate"}
                </button>
              </div>
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

            {(reports[entry.id]?.findings ?? []).filter(
              (finding) => finding.field === field || finding.field.startsWith(field),
            ).length > 0 && (
              <div className="refine-section">
                <div className="refine-label">The review pass flagged this field</div>
                <ul className="refine-findings">
                  {(reports[entry.id]?.findings ?? [])
                    .filter((finding) => finding.field === field || finding.field.startsWith(field))
                    .map((finding, index) => (
                      <li key={index} data-severity={finding.severity}>
                        <strong>{finding.severity}</strong> {finding.problem}
                        {finding.suggestion.length > 0 && (
                          <div className="refine-suggestion" lang="vi">
                            Suggested: {finding.suggestion}
                          </div>
                        )}
                      </li>
                    ))}
                </ul>
              </div>
            )}

            {error !== null && <div className="banner error">{error}</div>}
            {rewrote !== null && (
              <div className="refine-result">
                <div className="refine-label">Rewritten — the row above now reads</div>
                <div lang="vi">{stripEmphasisMarkers(rewrote)}</div>
              </div>
            )}

            <div className="refine-foot">
              <button type="button" className="btn" onClick={closeBrief} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={saveDraft}
                disabled={busy || !dirty}
              >
                Save
              </button>
            </div>
          </div>
        </td>
      </tr>
    );
  };

  return (
    <>
      {rows.length === 0 ? (
        <div className="empty">
          {entries.length === 0
            ? "Nothing here yet. Open Generate below to annotate your first batch."
            : "No words match these filters."}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="review-table">
            <thead>
              <tr>
                <th className="pick-cell" aria-label="Select" />
                <th>Word</th>
                <th>meaning</th>
                <th>defVi</th>
                <th>leadVi</th>
                <th>anticipateVi</th>
                <th>usage</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => {
                const usage = entry.deckWord.usage[0];
                const openHere = active !== null && active.entryId === entry.id;
                const issueCount = (issuesById.get(entry.id) ?? []).length;
                return (
                  <Fragment key={entry.id}>
                    <tr
                      data-status={entry.status}
                      data-refining={openHere || undefined}
                      data-selected={selected.has(entry.id) || undefined}
                    >
                      <td className="pick-cell">
                        <input
                          type="checkbox"
                          checked={selected.has(entry.id)}
                          aria-label={`Select ${entry.deckWord.word}`}
                          onChange={() => onToggleSelect(entry.id)}
                        />
                      </td>
                      <td className="word-cell">
                        <div>{entry.deckWord.word}</div>
                        <div className="meta-cell">
                          {entry.deckWord.level} · {entry.deckWord.pos || "—"}
                        </div>
                        <div className="word-tags">
                          {entry.deckWord.topics.map((topic) => (
                            <span key={topic} className="tag-pill" data-kind="topic">
                              {topic}
                            </span>
                          ))}
                          {entry.deckWord.exams.map((exam) => (
                            <span key={exam} className="tag-pill" data-kind="exam">
                              {exam}
                            </span>
                          ))}
                        </div>
                        {issueCount > 0 && (
                          <div className="word-issues" title={`${issueCount} validation issue(s)`}>
                            ⚠ {issueCount}
                          </div>
                        )}
                      </td>
                      <td {...cellProps(entry.id, "meaningVi")} lang="vi">
                        {entry.deckWord.meaningVi.length > 0 ? (
                          <MarkedText value={entry.deckWord.meaningVi} />
                        ) : (
                          <span style={{ color: "var(--muted)" }}>—</span>
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
                          <button
                            type="button"
                            className="btn sm star"
                            data-active={entry.styleSample === true}
                            aria-pressed={entry.styleSample === true}
                            title={
                              entry.original === undefined
                                ? "Edit this card first — a style sample teaches from what you changed"
                                : entry.styleSample === true
                                  ? "A style sample: the generator learns this card's voice"
                                  : "Mark as a style sample"
                            }
                            onClick={() => toggleStyleSample(entry.id)}
                          >
                            {entry.styleSample === true ? "★" : "☆"}
                          </button>
                          <button
                            type="button"
                            className="btn sm"
                            title="Ask the model to review this card"
                            disabled={verifying !== null}
                            onClick={() => void verify(entry)}
                          >
                            {verifying === entry.id ? "…" : "⌕"}
                          </button>
                        </div>
                        {reports[entry.id] !== undefined && (
                          <div
                            className="verdict"
                            data-verdict={reports[entry.id].verdict}
                            title={
                              reports[entry.id].findings.length === 0
                                ? "No problems reported"
                                : reports[entry.id].findings
                                    .map((finding) => `${finding.field}: ${finding.problem}`)
                                    .join("\n")
                            }
                          >
                            {reports[entry.id].verdict === "pass"
                              ? "reviewed ✓"
                              : `${reports[entry.id].findings.length} to fix`}
                          </div>
                        )}
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
    </>
  );
}

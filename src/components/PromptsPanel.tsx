/**
 * Prompts — read and edit the instructions the model is given.
 *
 * The prompts carry the whole quality bar, so tuning them is the fastest lever
 * on output quality. Editing them here means a rule can be tried on tonight's
 * batch and kept or dropped on the evidence, instead of being a source change.
 *
 * The two system prompts are editable because they are static prose. The user
 * messages are assembled per request, so they are shown live — built from a
 * real example — rather than made editable: a placeholder language would let a
 * typo drop the word list out of a request, which is a worse failure than a
 * badly worded rule.
 *
 * Exports: PromptsPanel
 * Depends on: ../lib/prompt-store.ts, ../lib/prompt.ts, ../lib/uniqueness.ts
 */
import { useMemo, useState } from "react";
import {
  PROMPT_DEFINITIONS,
  promptFallback,
  readPromptOverrides,
  resetPromptOverride,
  resolvePrompt,
  writePromptOverride,
  type PromptId,
} from "../lib/prompt-store";
import { buildBatchPrompt, buildRegeneratePrompt, buildVerifyPrompt } from "../lib/prompt";
import { collectUniqueness, renderAvoidSection } from "../lib/uniqueness";
import type { CorpusWord, ReviewEntry } from "../lib/types";
import type { Settings } from "../lib/settings";
import { distilStyle, describeLlmError } from "../lib/llm";
import { renderPairs, stylePairs } from "../lib/style";

/** A representative request, so the live previews show real structure. */
const SAMPLE_WORDS: CorpusWord[] = [
  { word: "harvest", pos: "noun", level: "B1", band: 2, source: "ngsl" },
  { word: "whisper", pos: "verb", level: "A2", band: 1, source: "ngsl" },
];

const SAMPLE_CARD = {
  word: "harvest",
  pos: "noun",
  level: "B1",
  meaningVi: "vụ_mùa",
  defVi: "Việc thu_gom cây trái sau một /mùa_màng/ dài.",
  leadVi: "Nông_dân chờ cả năm mới tới lúc này.",
  anticipateVi: "Mùa gì vui nhất nhỉ?",
  usage: [{ en: "The _____ was poor this year.", vi: "Vụ mùa năm nay kém." }],
};

/** One read-only preview of a message built at request time. */
function Preview({ title, note, body }: { title: string; note: string; body: string }) {
  return (
    <details className="prompt-preview">
      <summary>
        {title}
        <span className="prompt-preview-note">{note}</span>
      </summary>
      <pre>{body}</pre>
    </details>
  );
}

export function PromptsPanel({
  entries,
  settings,
}: {
  entries: readonly ReviewEntry[];
  settings: Settings;
}) {
  const [overrides, setOverrides] = useState(() => readPromptOverrides());
  // The textarea each prompt is being edited in, before Save.
  const [drafts, setDrafts] = useState<Partial<Record<PromptId, string>>>({});
  const [saved, setSaved] = useState<PromptId | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  const pairs = useMemo(() => stylePairs(entries), [entries]);
  const sampleCount = useMemo(
    () => entries.filter((entry) => entry.styleSample === true).length,
    [entries],
  );

  /** Read the reviewer's edits and write the guide from them. */
  const rebuildStyle = async () => {
    setBuildError(null);
    if (settings.llm.apiKey.length === 0) {
      setBuildError("Add an API key in Settings before distilling a style guide.");
      return;
    }
    if (pairs.length === 0) {
      setBuildError(
        "No before/after pairs yet. Mark cards you have EDITED with the ★ in the review table — an untouched card teaches nothing about what you would change.",
      );
      return;
    }
    setBuilding(true);
    try {
      const guide = await distilStyle(settings.llm, renderPairs(pairs), sampleCount);
      setOverrides(writePromptOverride("style", guide));
      setDrafts((previous) => ({ ...previous, style: undefined }));
      setSaved("style");
    } catch (thrown) {
      setBuildError(describeLlmError(thrown));
    } finally {
      setBuilding(false);
    }
  };

  const previews = useMemo(
    () => ({
      batch: buildBatchPrompt(
        SAMPLE_WORDS,
        renderAvoidSection(collectUniqueness(["Đoán xem nào?", "Đoán xem thử?", "Mùa gì vui nhất?"])),
      ),
      regenerate: buildRegeneratePrompt(SAMPLE_CARD, {
        field: "defVi",
        chips: ["too-long", "generic"],
        note: "compare it to something a child would recognise",
        issues: ["defVi 13 words; expected 8-11"],
      }),
      verify: buildVerifyPrompt(SAMPLE_CARD),
    }),
    [],
  );

  const save = (id: PromptId) => {
    const draft = drafts[id];
    if (draft === undefined) return;
    setOverrides(writePromptOverride(id, draft));
    setDrafts((previous) => ({ ...previous, [id]: undefined }));
    setSaved(id);
  };

  const reset = (id: PromptId) => {
    setOverrides(resetPromptOverride(id));
    setDrafts((previous) => ({ ...previous, [id]: undefined }));
    setSaved(null);
  };

  return (
    <>
      <section className="panel">
        <h2>Prompts</h2>
        <p className="hint">
          Every rule the model follows lives here as prose. Edits are kept in this browser and take
          effect on the next request — they are not shared, and they are not exported with a deck.
        </p>
      </section>

      {PROMPT_DEFINITIONS.map((definition) => {
        const live = resolvePrompt(definition.id);
        const draft = drafts[definition.id];
        const text = draft ?? live;
        const overridden = overrides[definition.id] !== undefined;
        const dirty = draft !== undefined && draft !== live;

        return (
          <section className="panel" key={definition.id}>
            <div className="prompt-head">
              <h2>
                {definition.title}
                {overridden && <span className="prompt-badge">edited</span>}
              </h2>
              <div className="row">
                {definition.id === "style" && (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={building}
                    onClick={() => void rebuildStyle()}
                  >
                    {building
                      ? "Reading your edits…"
                      : `Rebuild from ${sampleCount} sample${sampleCount === 1 ? "" : "s"}`}
                  </button>
                )}
                {dirty && (
                  <button type="button" className="btn primary sm" onClick={() => save(definition.id)}>
                    Save
                  </button>
                )}
                {dirty && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() =>
                      setDrafts((previous) => ({ ...previous, [definition.id]: undefined }))
                    }
                  >
                    Discard
                  </button>
                )}
                {overridden && !dirty && (
                  <button type="button" className="btn sm" onClick={() => reset(definition.id)}>
                    Reset to shipped
                  </button>
                )}
              </div>
            </div>
            <p className="hint">{definition.purpose}</p>
            {definition.id === "style" && (
              <p className="hint">
                {sampleCount === 0
                  ? "No cards marked yet. Edit a card so it sounds the way you want, then press its ★ in the review table."
                  : `${sampleCount} card(s) marked, yielding ${pairs.length} before/after pair(s). ` +
                    (pairs.length === 0
                      ? "None of them were edited, so there is nothing to learn from yet."
                      : "The distillation reads what you changed, not just what you wrote.")}
              </p>
            )}
            {definition.id === "style" && buildError !== null && (
              <div className="banner error" style={{ marginBottom: 10 }}>
                {buildError}
              </div>
            )}

            <textarea
              className="prompt-editor"
              spellCheck={false}
              value={text}
              aria-label={definition.title}
              onChange={(event) =>
                setDrafts((previous) => ({ ...previous, [definition.id]: event.target.value }))
              }
            />
            <div className="prompt-foot">
              <span className="note">
                {text.length} characters
                {overridden
                  ? ` · ${Math.abs(text.length - promptFallback(definition.id).length)} from the shipped version`
                  : " · unchanged from the shipped version"}
              </span>
              {saved === definition.id && !dirty && (
                <span className="note" style={{ color: "var(--ok)" }}>
                  Saved — the next request uses it.
                </span>
              )}
            </div>
          </section>
        );
      })}

      <section className="panel">
        <h2>What gets sent with it</h2>
        <p className="hint">
          These are built fresh for each request from the corpus words, your refine chips and the
          teaser lines already in use, so they are shown here rather than edited. The examples below
          use sample data.
        </p>
        <Preview
          title="Generation request"
          note="one per batch, with the avoid list"
          body={previews.batch}
        />
        <Preview
          title="Single-field rewrite"
          note="when you regenerate one cell"
          body={previews.regenerate}
        />
        <Preview title="Verification request" note="when you check a card" body={previews.verify} />
      </section>
    </>
  );
}

/**
 * The workspace switcher, in the header.
 *
 * Switching is a page reload, not a state swap, and the control says so. The
 * alternative - swapping twelve pieces of state in place - is how one deck's
 * style guide ends up generating the other deck's words, which is the exact
 * interference workspaces exist to prevent.
 *
 * Exports: WorkspaceSwitcher
 * Depends on: ../lib/workspace.ts
 */
import { useEffect, useRef, useState } from "react";
import { GLOSS_LANGS, glossProfile } from "../lib/lang";
import { ORIGINAL_WORKSPACE_ID, type GlossLang, type Workspace } from "../lib/workspace";

export function WorkspaceSwitcher({
  workspaces,
  activeId,
  onSwitch,
  onCreate,
  onForget,
}: {
  workspaces: readonly Workspace[];
  activeId: string;
  onSwitch: (id: string) => void;
  onCreate: (label: string, gloss: GlossLang) => void;
  onForget: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [gloss, setGloss] = useState<GlossLang>("ja");
  const [confirmForget, setConfirmForget] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const active = workspaces.find((workspace) => workspace.id === activeId) ?? workspaces[0];

  /** Close on a click anywhere else, the way a menu is expected to behave. */
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) {
        setOpen(false);
        setCreating(false);
        setConfirmForget(null);
      }
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  if (active === undefined) return null;

  const submit = () => {
    const trimmed = label.trim();
    if (trimmed.length === 0) return;
    onCreate(trimmed, gloss);
  };

  return (
    <div className="workspace-switch" ref={root}>
      <button
        type="button"
        className="workspace-pill"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="workspace-pill-label">{active.label}</span>
        <span className="workspace-pill-lang">{glossProfile(active.gloss).nativeLabel}</span>
        <span className="workspace-pill-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="workspace-menu" role="menu">
          <p className="workspace-menu-head">
            Each deck keeps its own words, prompts, style guide, catalogue and remote store. Only
            your API keys are shared.
          </p>
          {workspaces.map((workspace) => (
            <div key={workspace.id} className="workspace-row" data-active={workspace.id === activeId}>
              <button
                type="button"
                className="workspace-row-main"
                onClick={() => {
                  if (workspace.id === activeId) {
                    setOpen(false);
                    return;
                  }
                  onSwitch(workspace.id);
                }}
              >
                <span>{workspace.label}</span>
                <span className="workspace-row-lang">{glossProfile(workspace.gloss).nativeLabel}</span>
              </button>
              {workspace.id !== ORIGINAL_WORKSPACE_ID &&
                (confirmForget === workspace.id ? (
                  <button
                    type="button"
                    className="workspace-row-forget danger"
                    onClick={() => {
                      onForget(workspace.id);
                      setConfirmForget(null);
                    }}
                  >
                    forget it?
                  </button>
                ) : (
                  <button
                    type="button"
                    className="workspace-row-forget"
                    title="Remove it from this list. The deck itself stays in this browser."
                    onClick={() => setConfirmForget(workspace.id)}
                  >
                    ×
                  </button>
                ))}
            </div>
          ))}

          {creating ? (
            <form
              className="workspace-new"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <label className="field">
                <span>Name</span>
                <input
                  autoFocus
                  value={label}
                  placeholder="English → Japanese"
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Explanations written in</span>
                <select
                  value={gloss}
                  onChange={(event) => setGloss(event.target.value as GlossLang)}
                >
                  {GLOSS_LANGS.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label} — {profile.nativeLabel}
                    </option>
                  ))}
                </select>
              </label>
              <p className="workspace-new-note">
                The words themselves stay English; this is the language the card explains them in.
              </p>
              <div className="row">
                <button type="submit" className="btn primary sm" disabled={label.trim().length === 0}>
                  Create and open
                </button>
                <button type="button" className="btn sm" onClick={() => setCreating(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="workspace-row-main workspace-add"
              onClick={() => setCreating(true)}
            >
              + New deck…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

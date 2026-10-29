/**
 * Workspaces — one deck, one catalogue, one voice, kept apart from the next.
 *
 * The refinery held exactly one of everything: one mirrored document, one
 * imported corpus, one catalogue, one set of prompt overrides, one style guide.
 * That is right while there is one deck. A second deck written in another
 * language shares none of it — not the words, not the house voice, not the
 * remote store it is pushed to — and letting them share the same keys would not
 * merge them, it would overwrite them.
 *
 * So every per-deck key is SCOPED by the active workspace, and switching
 * workspaces reloads the page rather than swapping state in place: a stale
 * value left in memory is exactly the interference this exists to prevent.
 *
 * The original workspace keeps the unscoped keys. A reviewer who has been using
 * this app since before workspaces existed has their deck under "working-doc /
 * current"; renaming that on upgrade would be a migration whose only possible
 * outcomes are "no change" and "lost everything".
 *
 * API keys are deliberately NOT scoped - see settings.ts. A key belongs to the
 * device, not to a deck.
 *
 * Exports: GlossLang, Workspace, WorkspaceRegistry, ORIGINAL_WORKSPACE_ID,
 *          readWorkspaces, writeWorkspaces, activeWorkspace, activeScope,
 *          setActiveWorkspace, addWorkspace, removeWorkspace, scopedKey,
 *          workspaceSlug
 * Depends on: none
 */

/** The language a deck's explanations are written in. */
export type GlossLang = "vi" | "ja";

/** One deck's worth of everything. */
export interface Workspace {
  /**
   * Also the storage scope. The original workspace's id is "current", which is
   * the key its data has always been under.
   */
  id: string;
  /** What the switcher shows. The reviewer's words, not a slug. */
  label: string;
  /** The language its explanations are written in. */
  gloss: GlossLang;
  /** When it was created, ISO 8601. Empty for the original. */
  createdAt: string;
}

/** Every workspace on this device, and which one is open. */
export interface WorkspaceRegistry {
  version: 1;
  activeId: string;
  list: Workspace[];
}

/** The id of the workspace whose data predates workspaces. */
export const ORIGINAL_WORKSPACE_ID = "current";

/** localStorage key for the registry itself. Never scoped - it holds the scopes. */
const REGISTRY_KEY = "word-refinery.workspaces";

/** The workspace every existing install already has, whether it knows it or not. */
function originalWorkspace(): Workspace {
  return {
    id: ORIGINAL_WORKSPACE_ID,
    label: "English → Vietnamese",
    gloss: "vi",
    createdAt: "",
  };
}

/** A registry holding only the original workspace. */
function defaultRegistry(): WorkspaceRegistry {
  return { version: 1, activeId: ORIGINAL_WORKSPACE_ID, list: [originalWorkspace()] };
}

/** True when `value` is a usable workspace record. */
function isWorkspace(value: unknown): value is Workspace {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<Workspace>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.label === "string" &&
    (record.gloss === "vi" || record.gloss === "ja")
  );
}

/**
 * Read the registry, repairing anything unusable.
 *
 * A registry that cannot be read must not strand the decks it names, so the
 * original workspace is always present and the active id always points at a
 * workspace that exists.
 */
export function readWorkspaces(): WorkspaceRegistry {
  if (typeof window === "undefined") return defaultRegistry();
  try {
    const stored = window.localStorage.getItem(REGISTRY_KEY);
    if (stored === null) return defaultRegistry();
    const parsed = JSON.parse(stored) as Partial<WorkspaceRegistry>;
    const list = Array.isArray(parsed.list) ? parsed.list.filter(isWorkspace) : [];
    if (!list.some((workspace) => workspace.id === ORIGINAL_WORKSPACE_ID)) {
      list.unshift(originalWorkspace());
    }
    const activeId =
      typeof parsed.activeId === "string" && list.some((entry) => entry.id === parsed.activeId)
        ? parsed.activeId
        : ORIGINAL_WORKSPACE_ID;
    return { version: 1, activeId, list };
  } catch {
    return defaultRegistry();
  }
}

/** Persist the registry. Swallows quota and private-mode failures. */
export function writeWorkspaces(registry: WorkspaceRegistry): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry));
  } catch {
    // The in-memory registry still works for this session.
  }
}

/** The open workspace. */
export function activeWorkspace(): Workspace {
  const registry = readWorkspaces();
  return (
    registry.list.find((workspace) => workspace.id === registry.activeId) ?? originalWorkspace()
  );
}

/** The storage scope of the open workspace. */
export function activeScope(): string {
  return activeWorkspace().id;
}

/**
 * Scope a storage key to a workspace.
 *
 * @param base - the key as it was before workspaces existed
 * @param scope - the workspace id, defaulting to the open one
 * @returns `base` for the original workspace, `base:scope` for any other
 */
export function scopedKey(base: string, scope: string = activeScope()): string {
  return scope === ORIGINAL_WORKSPACE_ID ? base : `${base}:${scope}`;
}

/** Switch workspaces. The caller is responsible for reloading the page. */
export function setActiveWorkspace(id: string): WorkspaceRegistry {
  const registry = readWorkspaces();
  if (!registry.list.some((workspace) => workspace.id === id)) return registry;
  const next: WorkspaceRegistry = { ...registry, activeId: id };
  writeWorkspaces(next);
  return next;
}

/**
 * Turn a label into an id that is safe as a storage-key suffix and has never
 * been used on this device.
 *
 * @param label - what the reviewer typed
 * @param taken - ids already in use
 */
export function workspaceSlug(label: string, taken: readonly string[]): string {
  const base =
    label
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "deck";
  // Never the original's id: that id names the pre-workspace data, and handing
  // it to a new workspace would open the old deck under a new name.
  if (base !== ORIGINAL_WORKSPACE_ID && !taken.includes(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Add a workspace and make it the open one. */
export function addWorkspace(input: { label: string; gloss: GlossLang }): {
  registry: WorkspaceRegistry;
  workspace: Workspace;
} {
  const registry = readWorkspaces();
  const label = input.label.trim().length > 0 ? input.label.trim() : "New deck";
  const workspace: Workspace = {
    id: workspaceSlug(label, registry.list.map((entry) => entry.id)),
    label,
    gloss: input.gloss,
    createdAt: new Date().toISOString(),
  };
  const next: WorkspaceRegistry = {
    version: 1,
    activeId: workspace.id,
    list: [...registry.list, workspace],
  };
  writeWorkspaces(next);
  return { registry: next, workspace };
}

/**
 * Forget a workspace.
 *
 * Only the registry entry goes: the deck, catalogue and corpus stay in this
 * browser under their scoped keys. Removing a workspace is how a reviewer
 * tidies the switcher, and tidying must not be a way to destroy a deck by
 * accident. The original workspace cannot be removed.
 */
export function removeWorkspace(id: string): WorkspaceRegistry {
  const registry = readWorkspaces();
  if (id === ORIGINAL_WORKSPACE_ID) return registry;
  const list = registry.list.filter((workspace) => workspace.id !== id);
  if (list.length === registry.list.length) return registry;
  const next: WorkspaceRegistry = {
    version: 1,
    activeId: registry.activeId === id ? ORIGINAL_WORKSPACE_ID : registry.activeId,
    list,
  };
  writeWorkspaces(next);
  return next;
}

/**
 * Settings panel — provider picker, model, keys, store backend, deck identity.
 *
 * Keys are written to localStorage only. The panel shows the provider endpoint
 * next to each choice so the user can audit exactly where a key is sent.
 *
 * Exports: SettingsPanel
 * Depends on: ../lib/settings.ts, ../lib/llm.ts, ../lib/models.ts
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { PROVIDERS, maskKey, type Settings, type StoreKind } from "../lib/settings";
import { listModels, testConnection, type ListedModel } from "../lib/llm";
import { estimateParamsB, formatParamsB, groupModels, type ModelFamily } from "../lib/models";

export function SettingsPanel({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
}) {
  const [testState, setTestState] = useState<{ kind: "idle" | "busy" | "ok" | "error"; text: string }>({
    kind: "idle",
    text: "",
  });
  const [listState, setListState] = useState<{ kind: "idle" | "busy" | "ok" | "error"; text: string }>({
    kind: "idle",
    text: "",
  });
  const [models, setModels] = useState<ListedModel[]>([]);
  const [openFamily, setOpenFamily] = useState<string | null>(null);
  const listAbort = useRef<AbortController | null>(null);

  const provider = PROVIDERS.find((entry) => entry.id === settings.llm.provider) ?? PROVIDERS[0];
  const { provider: providerId, apiKey } = settings.llm;

  /** Fetch the provider's catalogue; stale requests are aborted. */
  const runFetch = async (signal?: AbortSignal) => {
    setListState({ kind: "busy", text: "Fetching the model list…" });
    try {
      const rows = await listModels(settings.llm, signal);
      setModels(rows);
      setListState({ kind: "ok", text: `${rows.length} models fetched — tap a family to browse.` });
    } catch (error) {
      if (signal?.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      setListState({ kind: "error", text: message });
    }
  };

  /**
   * Once a key and provider are settled, pull the catalogue automatically so
   * the picker is populated without the user having to ask. Debounced so
   * pasting a key doesn't fire on every keystroke.
   */
  useEffect(() => {
    if (apiKey.trim().length === 0) {
      listAbort.current?.abort();
      setModels([]);
      setListState({ kind: "idle", text: "" });
      return;
    }
    const controller = new AbortController();
    listAbort.current?.abort();
    listAbort.current = controller;
    const timer = window.setTimeout(() => void runFetch(controller.signal), 700);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-pull when the identity of the credential changes
  }, [providerId, apiKey]);

  /**
   * Fetched catalogue rows first, then the static suggestions, so the picker
   * is usable even when the catalogue call fails. groupModels filters out
   * media generators, sub-20B models and everything outside the curated
   * families, then hands back the seven groups in display order.
   */
  const families = useMemo(() => {
    const byId = new Map<string, ListedModel>();
    for (const row of models) if (!byId.has(row.id)) byId.set(row.id, row);
    for (const id of provider.suggested) {
      if (!byId.has(id)) byId.set(id, { id, name: id, contextLength: null });
    }
    return groupModels([...byId.values()]);
  }, [models, provider]);

  /** The curated families stay on top; the Other card sits alongside them. */
  const mainFamilies = families.filter((family) => family.id !== "other");
  const otherFamily = families.find((family) => family.id === "other");

  const patchLlm = (patch: Partial<Settings["llm"]>) =>
    onChange({ ...settings, llm: { ...settings.llm, ...patch } });
  const patchStore = (patch: Partial<Settings["store"]>) =>
    onChange({ ...settings, store: { ...settings.store, ...patch } });
  const patchGeneration = (patch: Partial<Settings["generation"]>) =>
    onChange({ ...settings, generation: { ...settings.generation, ...patch } });

  /** Pick from a family list; collapse it so the chosen row is what's left visible. */
  const pickModel = (id: string) => {
    patchLlm({ model: id });
    setOpenFamily(null);
  };

  /** Human-readable context window: 131072 → "131K". */
  const formatContext = (tokens: number | null): string | null => {
    if (tokens === null) return null;
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
    return `${tokens}`;
  };

  /**
   * One family: its folder-style toggle (same shape whether open or not),
   * and — when opened — a full-width plain-text listing inserted right below
   * it, laid out by the stylesheet in two or three columns.
   */
  const renderFamily = (family: ModelFamily) => {
    const open = openFamily === family.id;
    const holdsSelection = family.models.some((model) => model.id === settings.llm.model);
    return (
      <Fragment key={family.id}>
        <button
          type="button"
          className="model-family-toggle"
          data-open={open ? "true" : "false"}
          data-active={holdsSelection ? "true" : "false"}
          aria-expanded={open}
          onClick={() => setOpenFamily(open ? null : family.id)}
        >
          <span>{family.label}</span>
          <span className="count">{family.models.length}</span>
        </button>
        {open && (
          <div className="family-pills" role="group" aria-label={`${family.label} models`}>
            {family.models.map((model) => {
              const params = estimateParamsB(`${model.id} ${model.name}`);
              const context = formatContext(model.contextLength);
              return (
                <button
                  key={model.id}
                  type="button"
                  className="model-entry"
                  data-active={model.id === settings.llm.model ? "true" : "false"}
                  title={model.id + (context === null ? "" : ` — ${context} ctx`)}
                  onClick={() => pickModel(model.id)}
                >
                  {displayModelName(model)}
                  {params !== null && <span className="sub">{formatParamsB(params)}</span>}
                </button>
              );
            })}
          </div>
        )}
      </Fragment>
    );
  };

  /** Short pill label: keep real display names, or the tail of an id. */
  const displayModelName = (model: ListedModel): string => {
    if (model.name !== model.id && model.name.trim().length > 0) return model.name;
    const slash = model.id.lastIndexOf("/");
    return slash === -1 ? model.id : model.id.slice(slash + 1);
  };

  const runTest = async () => {
    setTestState({ kind: "busy", text: "Contacting provider…" });
    try {
      const reply = await testConnection(settings.llm);
      setTestState({ kind: "ok", text: `Provider replied: ${reply.trim().slice(0, 120)}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTestState({ kind: "error", text: message });
    }
  };

  return (
    <>
      <section className="panel">
        <h2>Language model</h2>
        <p className="hint">
          Your key stays in this browser's localStorage and is sent only to the endpoint shown below.
        </p>

        <div className="grid cols-2">
          <div className="field">
            <label htmlFor="provider">Provider</label>
            <select
              id="provider"
              value={settings.llm.provider}
              onChange={(event) => {
                const next = event.target.value as Settings["llm"]["provider"];
                const info = PROVIDERS.find((entry) => entry.id === next);
                // Drop the previous provider's catalogue right away: its ids
                // are unusable here, and the fresh list arrives moments later.
                listAbort.current?.abort();
                setModels([]);
                setListState({ kind: "idle", text: "" });
                patchLlm({ provider: next, model: info?.suggested[0] ?? "" });
              }}
            >
              {PROVIDERS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
            <span className="note">Endpoint: {provider.endpoint}</span>
          </div>

          <div className="field">
            <label htmlFor="apikey">API key</label>
            <input
              id="apikey"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="paste your key"
              value={settings.llm.apiKey}
              onChange={(event) => patchLlm({ apiKey: event.target.value })}
            />
            <span className="note">
              {settings.llm.apiKey.length > 0
                ? `stored locally as ${maskKey(settings.llm.apiKey)}`
                : "not set — generation is disabled until you add one"}
            </span>
          </div>

          <div className="field">
            <label htmlFor="batch">Words per request</label>
            <input
              id="batch"
              type="number"
              min={1}
              max={20}
              value={settings.llm.batchSize}
              onChange={(event) => patchLlm({ batchSize: Number(event.target.value) || 1 })}
            />
            <span className="note">Smaller batches are more reliable; larger ones are cheaper.</span>
          </div>
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <label>Model</label>
          <span className="picked">
            Selected: <code className="k">{settings.llm.model.length > 0 ? settings.llm.model : "none yet"}</code>
          </span>

          <div className="model-families">
            {mainFamilies.map(renderFamily)}
            {otherFamily !== undefined && renderFamily(otherFamily)}
            {/* The catalogue holds no families beyond the curated ones, so
                More… stays grayed out; the leftovers live in the Other card. */}
            <button
              type="button"
              className="model-family-toggle"
              disabled
              title="Every family in the catalogue is already listed — the rest lives in Other."
            >
              <span>More…</span>
            </button>
          </div>

          <span
            className="note"
            style={listState.kind === "error" ? { color: "var(--error)" } : undefined}
          >
            {listState.kind === "idle"
              ? "Tap a family to browse. Media and tiny models are hidden; less-known ones sit in Other."
              : listState.text}
            {listState.kind !== "idle" && (
              <>
                {" "}
                <button
                  type="button"
                  className="btn link"
                  disabled={listState.kind === "busy"}
                  onClick={() => void runFetch(listAbort.current?.signal)}
                >
                  {listState.kind === "busy" ? "Fetching…" : "Refresh"}
                </button>
              </>
            )}
          </span>
        </div>

        {provider.browserWarning !== undefined && (
          <div className="banner warn" style={{ marginTop: 12 }}>
            {provider.browserWarning}
          </div>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn"
            onClick={() => void runTest()}
            disabled={testState.kind === "busy" || settings.llm.apiKey.length === 0}
          >
            {testState.kind === "busy" ? "Testing…" : "Test connection"}
          </button>
          {testState.text.length > 0 && (
            <span
              className={`banner ${testState.kind === "ok" ? "ok" : testState.kind === "error" ? "error" : ""}`}
              style={{ margin: 0, flex: 1 }}
            >
              {testState.text}
            </span>
          )}
        </div>
      </section>

      <section className="panel">
        <h2>Deck storage</h2>
        <p className="hint">
          Where the working document is persisted between visits. The first save creates the
          resource and reports its id back — copy it here so later saves update the same place.
        </p>

        <div className="grid cols-3">
          <div className="field">
            <label htmlFor="storekind">Backend</label>
            <select
              id="storekind"
              value={settings.store.kind}
              onChange={(event) => patchStore({ kind: event.target.value as StoreKind })}
            >
              <option value="none">Local file only</option>
              <option value="jsonbin">jsonbin.io</option>
              <option value="gist">GitHub Gist</option>
            </select>
          </div>

          {settings.store.kind !== "none" && (
            <>
              <div className="field">
                <label htmlFor="storeid">
                  {settings.store.kind === "gist" ? "Gist id" : "Bin id"}
                </label>
                <input
                  id="storeid"
                  type="text"
                  spellCheck={false}
                  placeholder="leave blank to create on first save"
                  value={settings.store.id}
                  onChange={(event) => patchStore({ id: event.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="storetoken">
                  {settings.store.kind === "gist" ? "GitHub token (gists scope)" : "jsonbin API key"}
                </label>
                <input
                  id="storetoken"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={settings.store.token}
                  onChange={(event) => patchStore({ token: event.target.value })}
                />
                <span className="note">
                  {settings.store.kind === "gist"
                    ? "A fine-grained PAT with only the Gists permission is enough."
                    : "Found under your jsonbin.io account → API Keys."}
                </span>
              </div>
            </>
          )}
        </div>

        {settings.store.kind === "none" && (
          <div className="banner warn" style={{ marginTop: 12 }}>
            No remote backend. Use Download after each session, and Upload to continue one — nothing
            is saved automatically.
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Deck identity</h2>
        <p className="hint">Written into the deck header, and shown by KineMedia's importer.</p>
        <div className="grid cols-2">
          <div className="field">
            <label htmlFor="deckname">Deck name</label>
            <input
              id="deckname"
              type="text"
              value={settings.generation.deckName}
              onChange={(event) => patchGeneration({ deckName: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="deckversion">Version</label>
            <input
              id="deckversion"
              type="text"
              spellCheck={false}
              value={settings.generation.deckVersion}
              onChange={(event) => patchGeneration({ deckVersion: event.target.value })}
            />
          </div>
        </div>
      </section>
    </>
  );
}

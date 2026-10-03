/**
 * Settings panel — provider picker, model, keys, store backend, deck identity.
 *
 * Keys are written to localStorage only. The panel shows the provider endpoint
 * next to each choice so the user can audit exactly where a key is sent.
 *
 * Exports: SettingsPanel
 * Depends on: ../lib/settings.ts, ../lib/llm.ts
 */
import { useState } from "react";
import { PROVIDERS, maskKey, type Settings, type StoreKind } from "../lib/settings";
import { testConnection } from "../lib/llm";

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

  const provider = PROVIDERS.find((entry) => entry.id === settings.llm.provider) ?? PROVIDERS[0];

  const patchLlm = (patch: Partial<Settings["llm"]>) =>
    onChange({ ...settings, llm: { ...settings.llm, ...patch } });
  const patchStore = (patch: Partial<Settings["store"]>) =>
    onChange({ ...settings, store: { ...settings.store, ...patch } });
  const patchGeneration = (patch: Partial<Settings["generation"]>) =>
    onChange({ ...settings, generation: { ...settings.generation, ...patch } });

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
            <label htmlFor="model">Model</label>
            <input
              id="model"
              type="text"
              spellCheck={false}
              list="model-suggestions"
              value={settings.llm.model}
              onChange={(event) => patchLlm({ model: event.target.value })}
            />
            <datalist id="model-suggestions">
              {provider.suggested.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            <span className="note">Suggestions for {provider.label} appear as you type.</span>
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

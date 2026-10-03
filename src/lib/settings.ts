/**
 * Browser-local settings store.
 *
 * API keys and store credentials live ONLY in this browser's localStorage -
 * they are never written into the repository, never sent anywhere except the
 * provider the user selected, and never leave the device. Because GitHub Pages
 * is a public static host, anyone who opens the deployed URL uses their own
 * keys on their own machine.
 *
 * Exports: LlmProvider, Settings, readSettings, writeSettings, patchSettings,
 *          SETTINGS_KEY, maskKey, PROVIDERS
 * Depends on: none
 */

/** The three LLM providers the refinery can call from the browser. */
export type LlmProvider = "openrouter" | "together" | "anthropic";

/** The pluggable JSON backends the deck can be persisted to. */
export type StoreKind = "none" | "jsonbin" | "gist";

/** Provider metadata used to render the picker. */
export interface ProviderInfo {
  id: LlmProvider;
  label: string;
  /** Where the key is sent. Shown in the UI so the user can audit it. */
  endpoint: string;
  /** Whether a direct browser call needs a special CORS escape hatch. */
  browserWarning?: string;
  /** A few known-good text models so the picker is usable before any key. */
  suggested: string[];
}

/** Provider catalogue. Endpoints are public and safe to display. */
export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    suggested: [
      "meta-llama/llama-3.3-70b-instruct",
      "anthropic/claude-3.5-haiku",
      "google/gemini-2.0-flash-001",
    ],
  },
  {
    id: "together",
    label: "Together AI",
    endpoint: "https://api.together.xyz/v1/chat/completions",
    suggested: [
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "Qwen/Qwen2.5-72B-Instruct-Turbo",
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic (direct)",
    endpoint: "https://api.anthropic.com/v1/messages",
    browserWarning:
      "Needs the anthropic-dangerous-direct-browser-access header, which exposes your key to anyone using this page. Prefer OpenRouter or Together.",
    suggested: ["claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"],
  },
];

/** Persisted settings document. */
export interface Settings {
  /** Schema marker so older localStorage payloads can be migrated. */
  version: 1;
  llm: {
    provider: LlmProvider;
    model: string;
    apiKey: string;
    /** Words per LLM call. Smaller batches are more reliable, slower overall. */
    batchSize: number;
    maxTokens: number;
  };
  store: {
    kind: StoreKind;
    /** jsonbin.io bin id, or the GitHub Gist id. */
    id: string;
    /** jsonbin X-Master-Key / X-Access-Key, or a GitHub fine-grained PAT. */
    token: string;
  };
  generation: {
    /** CEFR bands to draw from; empty means all. */
    levels: string[];
    deckName: string;
    deckVersion: string;
  };
}

/** localStorage key. */
export const SETTINGS_KEY = "word-refinery.settings";

/** Defaults: nothing is pre-filled, so no key can ever be committed by accident. */
export function defaultSettings(): Settings {
  return {
    version: 1,
    llm: {
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct",
      apiKey: "",
      batchSize: 5,
      maxTokens: 4096,
    },
    store: { kind: "none", id: "", token: "" },
    generation: { levels: [], deckName: "WordCrawler deck", deckVersion: "0.1.0" },
  };
}

/** Read settings, filling any missing branch with defaults. */
export function readSettings(): Settings {
  const base = defaultSettings();
  if (typeof window === "undefined") return base;
  try {
    const stored = window.localStorage.getItem(SETTINGS_KEY);
    if (stored === null) return base;
    const parsed = JSON.parse(stored) as Partial<Settings>;
    return {
      version: 1,
      llm: { ...base.llm, ...(parsed.llm ?? {}) },
      store: { ...base.store, ...(parsed.store ?? {}) },
      generation: { ...base.generation, ...(parsed.generation ?? {}) },
    };
  } catch {
    return base;
  }
}

/** Persist settings. Swallow quota/privacy-mode failures. */
export function writeSettings(settings: Settings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or quota exceeded - the in-memory copy still works.
  }
}

/** Shallow-merge one branch of settings and persist the result. */
export function patchSettings<K extends keyof Settings>(
  current: Settings,
  branch: K,
  patch: Partial<Settings[K]>,
): Settings {
  const next: Settings = {
    ...current,
    [branch]: { ...(current[branch] as object), ...(patch as object) },
  } as Settings;
  writeSettings(next);
  return next;
}

/** Show only the tail of a key so the UI can confirm identity without leaking it. */
export function maskKey(key: string): string {
  if (key.length === 0) return "";
  if (key.length <= 4) return "•".repeat(key.length);
  return `••••${key.slice(-4)}`;
}

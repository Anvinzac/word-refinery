/**
 * Browser-local settings store.
 *
 * API keys and store credentials live ONLY in this browser's localStorage -
 * they are never written into the repository, never sent anywhere except the
 * provider the user selected, and never leave the device. Because GitHub Pages
 * is a public static host, anyone who opens the deployed URL uses their own
 * keys on their own machine.
 *
 * Each provider keeps its own key and model, so pasting one service's key
 * never overwrites another's.
 *
 * Exports: LlmProvider, Settings, ProviderProfile, readSettings, writeSettings,
 *          patchSettings, patchLlmSettings, switchProvider, SETTINGS_KEY,
 *          maskKey, PROVIDERS
 * Depends on: none
 */

/** The LLM providers the refinery can call from the browser. */
export type LlmProvider = "openrouter" | "together" | "anthropic" | "alibaba";

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
  {
    id: "alibaba",
    label: "Alibaba (Bailian)",
    // Workspace-scoped MaaS host: the ws-* subdomain is tied to one Bailian
    // workspace, so this entry serves that workspace's deployed models.
    endpoint:
      "https://ws-qc87cpgqq7pnch88.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    suggested: ["qwen3-max", "qwen3-235b-a22b", "deepseek-v4-pro"],
  },
];

/** What is remembered per provider, so switching services never loses a key. */
export interface ProviderProfile {
  apiKey: string;
  model: string;
}

/** Persisted settings document. */
export interface Settings {
  /** Schema marker so older localStorage payloads can be migrated. */
  version: 1;
  llm: {
    provider: LlmProvider;
    /** The active provider's model; mirrored into `profiles[provider]`. */
    model: string;
    /** The active provider's key; mirrored into `profiles[provider]`. */
    apiKey: string;
    /** Every provider's key and model as last entered on this device. */
    profiles: Partial<Record<LlmProvider, ProviderProfile>>;
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
      model: "openai/gpt-oss-120b",
      apiKey: "",
      profiles: {},
      batchSize: 5,
      // Raised for a reasoning default: gpt-oss thinks before it answers, and
      // those tokens come out of the same budget. At 4096 a five-word batch can
      // spend the lot reasoning and return no text at all.
      maxTokens: 8192,
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
    // Older payloads had one shared key and no profiles; adopting it as the
    // active provider's profile is the migration.
    const llm = { ...base.llm, ...(parsed.llm ?? {}) };
    return {
      version: 1,
      llm: {
        ...llm,
        profiles: {
          ...(llm.profiles ?? {}),
          [llm.provider]: { apiKey: llm.apiKey, model: llm.model },
        },
      },
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

/** Patch the active LLM settings, keeping the active provider's profile in step. */
export function patchLlmSettings(
  llm: Settings["llm"],
  patch: Partial<Pick<Settings["llm"], "apiKey" | "model" | "batchSize" | "maxTokens">>,
): Settings["llm"] {
  const next = { ...llm, ...patch };
  return {
    ...next,
    profiles: { ...next.profiles, [next.provider]: { apiKey: next.apiKey, model: next.model } },
  };
}

/**
 * Switch provider: the outgoing key and model are kept in its profile, and the
 * incoming provider's own key and model come back. A provider never used here
 * starts with no key and its first suggested model.
 */
export function switchProvider(llm: Settings["llm"], provider: LlmProvider): Settings["llm"] {
  const profiles = { ...llm.profiles, [llm.provider]: { apiKey: llm.apiKey, model: llm.model } };
  const saved = profiles[provider];
  const fallbackModel = PROVIDERS.find((entry) => entry.id === provider)?.suggested[0] ?? "";
  return {
    ...llm,
    provider,
    apiKey: saved?.apiKey ?? "",
    model: saved?.model || fallbackModel,
    profiles,
  };
}

/** Show only the tail of a key so the UI can confirm identity without leaking it. */
export function maskKey(key: string): string {
  if (key.length === 0) return "";
  if (key.length <= 4) return "•".repeat(key.length);
  return `••••${key.slice(-4)}`;
}

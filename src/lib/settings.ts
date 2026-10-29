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
 *          SHARED_KEYS_KEY, maskKey, PROVIDERS
 * Depends on: ./lang.ts, ./workspace.ts
 */
import { activeGlossProfile } from "./lang.ts";
import { scopedKey } from "./workspace.ts";

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

/** localStorage key, before the workspace scope is applied. */
export const SETTINGS_KEY = "word-refinery.settings";

/**
 * Where API keys live, for every workspace at once.
 *
 * A key belongs to the DEVICE, not to a deck: it is the same account whichever
 * deck is open, and a reviewer who pasted it once should not have to paste it
 * again because they switched language. Everything else in Settings - the
 * model, the remote store, the deck name - is per workspace, because those
 * genuinely differ between decks, and a shared store id would mean two decks
 * saving over each other.
 *
 * Keys are kept out of the per-workspace payload entirely rather than copied
 * into each, so there is one place to clear and one place to leak.
 */
export const SHARED_KEYS_KEY = "word-refinery.keys";

/** Per-provider API keys, shared across every workspace on this device. */
type SharedKeys = Partial<Record<LlmProvider, string>>;

/** Read the device-wide keys. */
function readSharedKeys(): SharedKeys {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(SHARED_KEYS_KEY);
    if (stored === null) return {};
    const parsed = JSON.parse(stored) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([, value]) => typeof value === "string" && value.length > 0,
      ),
    ) as SharedKeys;
  } catch {
    return {};
  }
}

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
    generation: { levels: [], deckName: activeGlossProfile().deckName, deckVersion: "0.1.0" },
  };
}

/**
 * Drop OpenRouter's `:batch` suffix from a model id.
 *
 * `openai/gpt-oss-120b:batch` and `openai/gpt-oss-120b` are the same model
 * behind two endpoints, and only the second answers a chat request, so the
 * suffix is always a mistake rather than a preference.
 *
 * @param model - a stored model id
 * @returns the id without the suffix
 */
export function stripBatchVariant(model: string): string {
  return typeof model === "string" ? model.replace(/:batch$/i, "") : model;
}

/** Read settings, filling any missing branch with defaults. */
export function readSettings(): Settings {
  const base = defaultSettings();
  if (typeof window === "undefined") return base;
  try {
    const stored = window.localStorage.getItem(scopedKey(SETTINGS_KEY));
    const shared = readSharedKeys();
    if (stored === null) {
      // A workspace opened for the first time still knows the device's keys.
      const provider = base.llm.provider;
      const apiKey = shared[provider] ?? "";
      return {
        ...base,
        llm: {
          ...base.llm,
          apiKey,
          profiles: Object.fromEntries(
            Object.entries(shared).map(([id, key]) => [id, { apiKey: key, model: "" }]),
          ) as Settings["llm"]["profiles"],
        },
      };
    }
    const parsed = JSON.parse(stored) as Partial<Settings>;
    // Older payloads had one shared key and no profiles; adopting it as the
    // active provider's profile is the migration.
    const llm = { ...base.llm, ...(parsed.llm ?? {}) };
    // A ":batch" model is OpenRouter's asynchronous Batch API, which the chat
    // endpoint refuses with a 404 on every request. The picker used to offer
    // them, so an install can be holding one; dropping the suffix lands on the
    // ordinary model of the same name, which is what was meant.
    const model = stripBatchVariant(llm.model);
    const profiles = Object.fromEntries(
      Object.entries(llm.profiles ?? {}).map(([provider, profile]) => [
        provider,
        profile === undefined ? profile : { ...profile, model: stripBatchVariant(profile.model) },
      ]),
    ) as Settings["llm"]["profiles"];
    // The shared key wins over whatever an older payload inlined: it is the one
    // the reviewer last entered, in whichever workspace they entered it.
    const withShared = Object.fromEntries(
      Object.entries(profiles).map(([id, profile]) => [
        id,
        { model: profile?.model ?? "", apiKey: shared[id as LlmProvider] ?? profile?.apiKey ?? "" },
      ]),
    ) as Settings["llm"]["profiles"];
    for (const [id, key] of Object.entries(shared)) {
      const provider = id as LlmProvider;
      if (withShared[provider] === undefined) withShared[provider] = { apiKey: key, model: "" };
    }
    const apiKey = shared[llm.provider] ?? llm.apiKey;
    return {
      version: 1,
      llm: {
        ...llm,
        model,
        apiKey,
        profiles: {
          ...withShared,
          [llm.provider]: { apiKey, model },
        },
      },
      store: { ...base.store, ...(parsed.store ?? {}) },
      generation: { ...base.generation, ...(parsed.generation ?? {}) },
    };
  } catch {
    return base;
  }
}

/**
 * Persist settings: the keys device-wide, everything else to this workspace.
 *
 * The per-workspace payload is written with every apiKey blanked, so switching
 * workspace cannot carry one deck's credentials into another's storage and a
 * key exists in exactly one place on disk.
 */
export function writeSettings(settings: Settings): void {
  if (typeof window === "undefined") return;
  const keys: SharedKeys = { ...readSharedKeys() };
  for (const [id, profile] of Object.entries(settings.llm.profiles)) {
    if (profile !== undefined && profile.apiKey.length > 0) keys[id as LlmProvider] = profile.apiKey;
  }
  if (settings.llm.apiKey.length > 0) keys[settings.llm.provider] = settings.llm.apiKey;
  // An emptied field is a deliberate clearing, not an absence of news.
  if (settings.llm.apiKey.length === 0) delete keys[settings.llm.provider];
  const withoutKeys: Settings = {
    ...settings,
    llm: {
      ...settings.llm,
      apiKey: "",
      profiles: Object.fromEntries(
        Object.entries(settings.llm.profiles).map(([id, profile]) => [
          id,
          { apiKey: "", model: profile?.model ?? "" },
        ]),
      ) as Settings["llm"]["profiles"],
    },
  };
  try {
    window.localStorage.setItem(scopedKey(SETTINGS_KEY), JSON.stringify(withoutKeys));
    window.localStorage.setItem(SHARED_KEYS_KEY, JSON.stringify(keys));
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

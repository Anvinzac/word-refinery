/**
 * PIN-locked API keys that can be published with the site.
 *
 * A key is sealed with AES-GCM under a key derived from the PIN by PBKDF2, so
 * the published file holds only salt, nonce and ciphertext — never the PIN.
 * The wrong PIN fails the GCM authentication check, which is how unlocking
 * knows the PIN was right.
 *
 * The file is public, so its strength is the PIN's: a 4-digit PIN is 10,000
 * guesses, which an offline attacker exhausts quickly no matter how slow the
 * derivation is. Pair it with a spending cap on the provider key.
 *
 * Exports: SealedSecret, LockedKeyFile, LOCKED_KEY_FILE, sealSecret,
 *          openSecret, loadLockedKeys, addLockedKey
 * Depends on: ./settings.ts
 */
import type { LlmProvider } from "./settings.ts";

/** One sealed secret, every binary field base64-encoded. */
export interface SealedSecret {
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

/** The published file: at most one sealed key per provider. */
export interface LockedKeyFile {
  version: 1;
  keys: Partial<Record<LlmProvider, SealedSecret>>;
}

/** Path of the published file, relative to the site root. */
export const LOCKED_KEY_FILE = "locked-key.json";

/** Slow enough that each guess costs real time in a browser. */
const DEFAULT_ITERATIONS = 600_000;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function deriveKey(
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin.normalize("NFC")),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seal a secret under a PIN. A fresh salt and nonce make every seal unique. */
export async function sealSecret(
  secret: string,
  pin: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<SealedSecret> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt, iterations);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(secret),
  );
  return {
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

/** Open a sealed secret; null means the PIN is wrong or the blob is damaged. */
export async function openSecret(sealed: SealedSecret, pin: string): Promise<string | null> {
  try {
    const key = await deriveKey(pin, fromBase64(sealed.salt), sealed.iterations);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(sealed.iv) },
      key,
      fromBase64(sealed.ciphertext),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** Fetch the published file; null when the site has none. */
export async function loadLockedKeys(baseUrl: string): Promise<LockedKeyFile | null> {
  try {
    const response = await fetch(`${baseUrl}${LOCKED_KEY_FILE}`, { cache: "no-store" });
    if (!response.ok) return null;
    const parsed = (await response.json()) as Partial<LockedKeyFile>;
    if (parsed.version !== 1 || typeof parsed.keys !== "object" || parsed.keys === null) return null;
    return { version: 1, keys: parsed.keys };
  } catch {
    return null;
  }
}

/** Return a copy of the file with one provider's sealed key added or replaced. */
export function addLockedKey(
  file: LockedKeyFile | null,
  provider: LlmProvider,
  sealed: SealedSecret,
): LockedKeyFile {
  return { version: 1, keys: { ...(file?.keys ?? {}), [provider]: sealed } };
}

// app-key.ts — the app's auth key for --expose. Persisted by default so it
// survives restarts ("one key, use forever"); overridable with a fixed key,
// or disabled explicitly. This is the sugar over the `users` map for the
// common "one shared key" case.
import { appDirs } from "./app-dirs.ts";
import { dirname } from "@std/path";

/** Outcome of resolving the app key. */
export interface KeyResolution {
  /** The auth token — `undefined` means no framework auth (open / app-level). */
  key: string | undefined;
  /** True when the key was read from / written to the data dir (default mode). */
  persisted: boolean;
  /** True when the user set `key` explicitly (a string, or `false` for open). */
  explicit: boolean;
}

/**
 * Resolve the app's auth key:
 * - `key: "secret"` → that fixed key (auth on).
 * - `key: false` / omitted → **no framework auth** (the default — the app
 *   does its own user auth, or is deliberately open on a trusted LAN).
 * - `key: true` → a stable key generated once and persisted in the data dir,
 *   the same across restarts (opt in to framework auth).
 */
export function resolveAppKey(
  appId: string,
  configKey: string | boolean | undefined,
): KeyResolution {
  const path = appDirs(appId).appKey;
  // A direct caller (a test, `am`) may reach this before aio.run() created the
  // tree — the key is tier ① data, so make its home rather than fail.
  try {
    Deno.mkdirSync(dirname(path), { recursive: true });
  } catch { /* exists, or unwritable — the write below reports it */ }
  // Default (undefined) and explicit `false` → no framework auth (open).
  if (configKey === undefined || configKey === false) {
    // Clear any stale key file so tooling reports "open".
    try {
      Deno.removeSync(path);
    } catch { /* not present */ }
    return { key: undefined, persisted: false, explicit: configKey === false };
  }
  if (typeof configKey === "string" && configKey.length > 0) {
    // Mirror the fixed key to disk too, so `am profile` and other local
    // tooling read the ACTIVE key regardless of where it was set.
    try {
      Deno.writeTextFileSync(path, configKey);
      Deno.chmodSync(path, 0o600);
    } catch { /* data dir not writable — fixed key still works in-process */ }
    return { key: configKey, persisted: false, explicit: true };
  }
  // `key: true` → a persisted, stable auto-generated key.
  try {
    try {
      const existing = Deno.readTextFileSync(path).trim();
      if (existing) return { key: existing, persisted: true, explicit: true };
    } catch { /* not created yet */ }
    const key = crypto.randomUUID();
    Deno.writeTextFileSync(path, key);
    try {
      Deno.chmodSync(path, 0o600); // owner-only (best-effort; no-op on Windows)
    } catch { /* chmod unsupported */ }
    return { key, persisted: true, explicit: true };
  } catch {
    // Data dir not writable — fall back to an ephemeral key (still auth-on).
    return { key: crypto.randomUUID(), persisted: false, explicit: true };
  }
}

/** Path to the persisted key file (for tooling like `am profile`). */
export function appKeyPath(appId: string): string {
  return appDirs(appId).appKey;
}

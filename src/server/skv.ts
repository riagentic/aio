// skv.ts — the simple key-value persistence interface (string keys, JSON
// values). Since perfect-aio D4 the ONE implementation is SQLite
// (skv-sqlite.ts sqliteKv) — Deno.Kv was retired (its local backend was
// SQLite anyway, minus a 64KiB value limit we hit in the field). Legacy KV
// stores auto-migrate at boot (skv-sqlite.ts migrateLegacyKv).

/** Commit-style result kept for interface compatibility. */
export type SkvCommit = { ok: true; versionstamp: string };

/** Simple string-keyed get/set/del persistence interface. */
export type SkvInstance = {
  /** Persist a value under a key (upsert). */
  set: (key: string, val: unknown) => Promise<SkvCommit>;
  /** Retrieve a value or null. */
  get: <T>(key: string) => Promise<T | null>;
  /** Remove a key. */
  del: (key: string) => Promise<void>;
  /** Release resources (no-op when the store is app-owned). */
  close: () => Promise<void> | void;
  /** Store each top-level property under its own row (atomic) — deletes any
   *  `prevKeys` no longer present. Per-cell snapshot writes use this. */
  setMulti: (
    prefix: string,
    obj: Record<string, unknown>,
    prevKeys?: string[],
  ) => Promise<SkvCommit>;
  /** Reconstruct an object from all rows under a prefix — null if none. */
  getMulti: <T>(prefix: string) => Promise<T | null>;
};

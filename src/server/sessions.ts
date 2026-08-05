// sessions.ts — SQLite-backed session tokens (AUTH-1).
//
// The missing lifecycle for per-user auth: `users:` and `resolveUser` are
// static — nothing expires, nothing revokes. A SessionStore issues opaque
// bearer tokens with a TTL, resolvable by the server's normal auth path, and
// revocable at any time (logout, kick, breach response).
//
//   await aio.run({ sessions: true, cells: [...] })       // enables the store
//   const token = app.sessions.issue({ id: "u1", role: "user" });  // login
//   app.sessions.revoke(token);                                    // logout
//
// Tokens are 256-bit random, stored HASHED (SHA-256) — a stolen sessions.db
// yields no usable tokens. Expired rows are deleted on read and swept lazily.
// AUTH-2 builds the password login flow on top of exactly this store.

// @ts-ignore node:sqlite types unavailable when an old @types/node shadows
// them (same workaround as db-worker.ts B-1) — the specifier resolves fine.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { AioUser } from "./aio-types.ts";

const DEFAULT_TTL_MS = 30 * 24 * 3_600_000; // 30 days

/** A live session's user plus when its token expires (epoch ms). */
export interface SessionInfo extends AioUser {
  expiresAt: number;
}

/** Server-side session storage — issue, resolve, refresh and revoke bearer
 *  tokens. Only token hashes are kept, so a leaked store can't be replayed. */
export interface SessionStore {
  /** Create a session for `user`; returns the bearer token (shown ONCE —
   *  only its hash is stored). */
  issue(user: AioUser, opts?: { ttlMs?: number }): string;
  /** Resolve a token → user, or null (unknown / expired / revoked). */
  get(token: string): SessionInfo | null;
  /** Extend a live session's expiry. False when the token isn't live. */
  refresh(token: string, ttlMs?: number): boolean;
  /** Revoke one session (logout). */
  revoke(token: string): boolean;
  /** Revoke every session of a user (kick / breach response). Returns count. */
  revokeUser(userId: string): number;
  /** Live session count (sweeps expired first). */
  count(): number;
  /** Observe revocations. A revoked token must stop working EVERYWHERE, and
   *  an already-open WebSocket is not reachable by a token check that only
   *  ever ran at upgrade — the WS manager subscribes here so "logout" /
   *  "kick" disarms live sockets the moment it happens rather than at their
   *  next poll. Observe-only: a throwing listener never breaks a revocation.
   *  Returns an unsubscribe function. */
  onRevoked(listener: () => void): () => void;
  close(): void;
}

/** SHA-256 hex of a token — the at-rest key (node:crypto: sync in Deno,
 *  unlike WebCrypto's async digest, and the resolver path must stay sync). */
const hash = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/** 256-bit URL-safe random token with a recognizable prefix. */
const newToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return `aios_${s}`;
};

/** Open (or create) a session store at `path` (":memory:" for tests). */
export function openSessionStore(
  path: string,
  defaultTtlMs = DEFAULT_TTL_MS,
): SessionStore {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  const ins = db.prepare(
    "INSERT INTO sessions (token_hash, user_id, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  );
  const sel = db.prepare(
    "SELECT user_id, role, expires_at FROM sessions WHERE token_hash = ?",
  );
  const upd = db.prepare(
    "UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND expires_at > ?",
  );
  const del = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
  const delUser = db.prepare("DELETE FROM sessions WHERE user_id = ?");
  const sweep = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");
  const cnt = db.prepare("SELECT COUNT(*) AS n FROM sessions");
  // Hygiene: expired sessions that are never read again would otherwise
  // accumulate forever — one sweep per open keeps auth.db lean.
  sweep.run(Date.now());

  const listeners = new Set<() => void>();
  const emitRevoked = (): void => {
    for (const l of listeners) {
      try {
        l();
      } catch (e) {
        console.warn(`[aio] auth: session revocation listener failed — ${e}`);
      }
    }
  };

  return {
    issue(user, opts) {
      const token = newToken();
      const now = Date.now();
      ins.run(
        hash(token),
        user.id,
        user.role,
        now,
        now + (opts?.ttlMs ?? defaultTtlMs),
      );
      return token;
    },
    get(token) {
      const row = sel.get(hash(token)) as
        | { user_id: string; role: string; expires_at: number }
        | undefined;
      if (!row) return null;
      if (row.expires_at <= Date.now()) {
        del.run(hash(token)); // expired — remove on read
        return null;
      }
      return { id: row.user_id, role: row.role, expiresAt: row.expires_at };
    },
    refresh(token, ttlMs) {
      const now = Date.now();
      const r = upd.run(now + (ttlMs ?? defaultTtlMs), hash(token), now);
      return r.changes > 0;
    },
    revoke(token) {
      const r = del.run(hash(token));
      if (r.changes > 0) {
        console.warn(`[aio] auth: session revoked`);
        emitRevoked();
        return true;
      }
      return false;
    },
    revokeUser(userId) {
      const r = delUser.run(userId);
      if (r.changes > 0) {
        console.warn(
          `[aio] auth: all sessions revoked for user=${userId} (${r.changes})`,
        );
        emitRevoked();
      }
      return Number(r.changes);
    },
    count() {
      sweep.run(Date.now());
      return Number((cnt.get() as { n: number }).n);
    },
    onRevoked(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      db.close();
    },
  };
}

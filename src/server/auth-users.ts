// auth-users.ts — password identity store (AUTH-2/3).
//
// The framework-owned users table behind `aio.run({ auth: true })`: signup,
// login verification, password change, email verification state, TOTP secret
// storage, per-account lockout, and a generic one-shot token store (email
// verify, password reset, TOTP pending-login, OIDC state). Passwords are
// PBKDF2-HMAC-SHA-256 (WebCrypto — zero deps), per-user random salt, OWASP
// iteration count, timing-safe verify. SQLite lives in the app's data dir
// (`auth.db`, same file as the session store).
//
// Login flow endpoints (/__aio/auth/*) live in auth-flows.ts; this module is
// pure storage + crypto — no HTTP, no framework state.

// @ts-ignore node:sqlite types unavailable when an old @types/node shadows
// them (same workaround as db-worker.ts B-1) — the specifier resolves fine.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { _timingSafeEqual } from "./server-auth.ts";
import type { AioUser } from "./aio-types.ts";

/** OWASP 2023 recommendation for PBKDF2-HMAC-SHA-256. */
const PBKDF2_ITERS = 600_000;
const HASH_BITS = 256;

/** Per-account lockout: LOCK_AFTER consecutive failures → locked LOCK_MS. */
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;

const hex = (buf: ArrayBuffer | Uint8Array): string => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
};

const fromHex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    HASH_BITS,
  );
  return hex(bits);
}

/** `pbkdf2$sha256$<iters>$<salt-hex>$<hash-hex>` — self-describing, so the
 *  iteration count can be raised later without invalidating old rows. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await pbkdf2(password, salt, PBKDF2_ITERS);
  return `pbkdf2$sha256$${PBKDF2_ITERS}$${hex(salt)}$${h}`;
}

/** Timing-safe verify against a stored hash string. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, alg, iters, saltHex, hashHex] = stored.split("$");
  if (
    scheme !== "pbkdf2" || alg !== "sha256" || !iters || !saltHex || !hashHex
  ) {
    return false;
  }
  const n = parseInt(iters, 10);
  if (!Number.isFinite(n) || n < 1) return false;
  const h = await pbkdf2(password, fromHex(saltHex), n);
  return _timingSafeEqual(h, hashHex);
}

export interface AuthUserRecord extends AioUser {
  createdAt: number;
  email: string | null;
  verified: boolean;
  totpEnabled: boolean;
}

/** One-shot token kinds — each namespace is independent. */
export type TokenKind = "verify" | "reset" | "totp" | "oidc";

// Convention for this interface: methods THROW only on invalid INPUT a
// programmer must fix (a policy violation — "user_exists", "invalid_id",
// "password_too_short"), and RETURN a boolean/null for the normal "not found"
// outcome. So `create`/`setPassword` can throw a policy error; every mutator
// returns `false` when the id simply doesn't exist. Thrown codes are
// snake_case (they double as the HTTP wire error); catch and map for
// programmatic callers (`app.auth.create`).
export interface UserStore {
  /** Create a user. THROWS "user_exists" / "invalid_id" /
   *  "password_too_short" (policy). Role defaults to "user". */
  create(
    id: string,
    password: string,
    opts?: { role?: string; email?: string },
  ): Promise<AuthUserRecord>;
  /** Verify credentials → user, `"locked"` (account lockout active), or null.
   *  Unknown ids burn a real PBKDF2 so timing doesn't reveal existence.
   *  LOCK_AFTER consecutive failures lock the account for 15 minutes. */
  verify(id: string, password: string): Promise<AioUser | "locked" | null>;
  /** Change password. THROWS "password_too_short" (policy); returns false
   *  when the user doesn't exist. */
  setPassword(id: string, newPassword: string): Promise<boolean>;
  setRole(id: string, role: string): boolean;
  setEmail(id: string, email: string): boolean;
  /** Mark the account's email as verified. */
  markVerified(id: string): boolean;
  /** Clear a lockout + fail counter (operator rescue — `am auth unlock`). */
  unlock(id: string): boolean;
  /** All users, newest first (admin/CLI listing). */
  list(): AuthUserRecord[];
  get(id: string): AuthUserRecord | null;
  remove(id: string): boolean;
  count(): number;
  /** Stage a TOTP secret (base32) — not active until enableTotp. */
  setTotpSecret(id: string, secretB32: string): boolean;
  enableTotp(id: string): boolean;
  disableTotp(id: string): boolean;
  totpSecret(id: string): { secret: string; enabled: boolean } | null;
  /** Issue a one-shot token (returned raw, stored hashed) with a TTL. */
  issueToken(
    kind: TokenKind,
    subject: string,
    ttlMs: number,
    payload?: string,
  ): string;
  /** Consume a one-shot token — deletes it; null when unknown/expired. */
  consumeToken(
    kind: TokenKind,
    token: string,
  ): { subject: string; payload: string | null } | null;
  close(): void;
}

/** Open (or create) the user store at `path` (":memory:" for tests). */
export function openUserStore(path: string): UserStore {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    pw TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    email TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    totp TEXT,
    totp_on INTEGER NOT NULL DEFAULT 0,
    fails INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS one_shot_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    payload TEXT,
    expires_at INTEGER NOT NULL
  )`);
  const ins = db.prepare(
    "INSERT INTO users (id, pw, role, created_at, email) VALUES (?, ?, ?, ?, ?)",
  );
  const sel = db.prepare("SELECT * FROM users WHERE id = ?");
  const updPw = db.prepare("UPDATE users SET pw = ? WHERE id = ?");
  const updRole = db.prepare("UPDATE users SET role = ? WHERE id = ?");
  const updEmail = db.prepare("UPDATE users SET email = ? WHERE id = ?");
  const updVerified = db.prepare("UPDATE users SET verified = 1 WHERE id = ?");
  const updFails = db.prepare(
    "UPDATE users SET fails = ?, locked_until = ? WHERE id = ?",
  );
  const updTotp = db.prepare("UPDATE users SET totp = ? WHERE id = ?");
  const updTotpOn = db.prepare(
    "UPDATE users SET totp_on = ? WHERE id = ? AND totp IS NOT NULL",
  );
  const totpOff = db.prepare(
    "UPDATE users SET totp_on = 0, totp = NULL WHERE id = ?",
  );
  const del = db.prepare("DELETE FROM users WHERE id = ?");
  const cnt = db.prepare("SELECT COUNT(*) AS n FROM users");
  const tokIns = db.prepare(
    "INSERT INTO one_shot_tokens (token_hash, kind, subject, payload, expires_at) VALUES (?, ?, ?, ?, ?)",
  );
  const tokSel = db.prepare(
    "SELECT subject, payload, expires_at FROM one_shot_tokens WHERE token_hash = ? AND kind = ?",
  );
  const tokDel = db.prepare("DELETE FROM one_shot_tokens WHERE token_hash = ?");
  const tokSweep = db.prepare(
    "DELETE FROM one_shot_tokens WHERE expires_at <= ?",
  );

  // A real hash to verify against when the id is unknown — keeps login timing
  // identical for existing and non-existing users (no account enumeration).
  const DECOY = `pbkdf2$sha256$${PBKDF2_ITERS}$${"00".repeat(16)}$${
    "00".repeat(32)
  }`;

  type Row = {
    id: string;
    pw: string;
    role: string;
    created_at: number;
    email: string | null;
    verified: number;
    totp: string | null;
    totp_on: number;
    fails: number;
    locked_until: number;
  };

  const toRecord = (row: Row): AuthUserRecord => ({
    id: row.id,
    role: row.role,
    createdAt: row.created_at,
    email: row.email,
    verified: row.verified === 1,
    totpEnabled: row.totp_on === 1,
  });

  return {
    async create(id, password, opts) {
      if (typeof id !== "string" || id.length < 1 || id.length > 256) {
        throw new Error("invalid_id");
      }
      if (typeof password !== "string" || password.length < 8) {
        throw new Error("password_too_short"); // NIST floor — 8 chars minimum
      }
      const pw = await hashPassword(password);
      const createdAt = Date.now();
      try {
        ins.run(id, pw, opts?.role ?? "user", createdAt, opts?.email ?? null);
      } catch (e) {
        if (String(e).includes("UNIQUE")) throw new Error("user_exists");
        throw e;
      }
      return {
        id,
        role: opts?.role ?? "user",
        createdAt,
        email: opts?.email ?? null,
        verified: false,
        totpEnabled: false,
      };
    },
    async verify(id, password) {
      const row = sel.get(id) as Row | undefined;
      const now = Date.now();
      // Hash FIRST, unconditionally — locked, unknown, and wrong-password
      // paths all cost one PBKDF2, so timing reveals nothing.
      const ok = await verifyPassword(password, row?.pw ?? DECOY);
      if (!row) return null;
      // Wrong password (or unknown user) ALWAYS returns a generic null — the
      // "locked" signal is never handed to a caller who can't prove they know
      // the password, so a wrong-guessing attacker can't distinguish
      // exists/locked/absent by the response (no account enumeration, no
      // lock-state oracle). Only the correct-password branch below can reveal
      // a lock — to the legitimate account owner.
      if (!ok) {
        if (row.locked_until > now) return null; // already locked — don't extend
        const fails = row.fails + 1;
        if (fails >= LOCK_AFTER) {
          updFails.run(0, now + LOCK_MS, id);
          console.warn(
            `[aio] auth: account "${id}" locked for ${
              LOCK_MS / 60_000
            }m after ${LOCK_AFTER} failed logins`,
          );
        } else {
          updFails.run(fails, 0, id);
        }
        return null;
      }
      // Password is correct. If the account is under an active lockout, tell
      // the owner (they can wait it out) — but only now, past the password gate.
      if (row.locked_until > now) return "locked";
      if (row.fails > 0 || row.locked_until > 0) updFails.run(0, 0, id);
      return { id: row.id, role: row.role };
    },
    async setPassword(id, newPassword) {
      if (typeof newPassword !== "string" || newPassword.length < 8) {
        throw new Error("password_too_short");
      }
      const r = updPw.run(await hashPassword(newPassword), id);
      return r.changes > 0;
    },
    setRole(id, role) {
      return updRole.run(role, id).changes > 0;
    },
    setEmail(id, email) {
      return updEmail.run(email, id).changes > 0;
    },
    markVerified(id) {
      return updVerified.run(id).changes > 0;
    },
    unlock(id) {
      return updFails.run(0, 0, id).changes > 0;
    },
    list() {
      const rows = db.prepare(
        "SELECT * FROM users ORDER BY created_at DESC",
      ).all() as Row[];
      return rows.map(toRecord);
    },
    get(id) {
      const row = sel.get(id) as Row | undefined;
      return row ? toRecord(row) : null;
    },
    remove(id) {
      return del.run(id).changes > 0;
    },
    count() {
      return Number((cnt.get() as { n: number }).n);
    },
    setTotpSecret(id, secretB32) {
      return updTotp.run(secretB32, id).changes > 0;
    },
    enableTotp(id) {
      return updTotpOn.run(1, id).changes > 0;
    },
    disableTotp(id) {
      return totpOff.run(id).changes > 0;
    },
    totpSecret(id) {
      const row = sel.get(id) as Row | undefined;
      return row?.totp
        ? { secret: row.totp, enabled: row.totp_on === 1 }
        : null;
    },
    issueToken(kind, subject, ttlMs, payload) {
      tokSweep.run(Date.now()); // lazy sweep keeps the table tiny
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const token = `aiot_${hex(bytes)}`;
      tokIns.run(
        sha256(token),
        kind,
        subject,
        payload ?? null,
        Date.now() + ttlMs,
      );
      return token;
    },
    consumeToken(kind, token) {
      const h = sha256(token);
      const row = tokSel.get(h, kind) as
        | { subject: string; payload: string | null; expires_at: number }
        | undefined;
      if (!row) return null;
      tokDel.run(h); // one-shot — gone regardless of expiry outcome
      if (row.expires_at <= Date.now()) return null;
      return { subject: row.subject, payload: row.payload };
    },
    close() {
      db.close();
    },
  };
}

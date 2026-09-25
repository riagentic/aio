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
import type { SessionStore } from "./sessions.ts";
import type { AioUser } from "./aio-types.ts";
import { log } from "../diagnostics/logger-api.ts";
import { count } from "../diagnostics/fmt.ts";
import { _onTotpReplayReset } from "./auth-totp.ts";

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

/** THE id key — one normalization, applied at every entry point of the store.
 *
 *  `Neighbour`, `neighbour `, and the NFD spelling of `neighbour` are three
 *  strings a human reads as ONE account. Left raw they created three rows an
 *  operator cannot tell apart in `am auth users` (and a whitespace-only id was
 *  accepted outright). Two rules, both applied HERE so a lookup can never
 *  disagree with a write:
 *
 *   - Unicode NFC + trim: the same visible id is the same key, and " " is
 *     empty (→ `invalid_id`).
 *   - Case-insensitive UNIQUENESS at create time (see `selCi`), while lookups
 *     stay EXACT — an account is created once, so that is where confusables
 *     must be refused; making every lookup case-folding would silently widen
 *     what a stored id matches. */
const normId = (id: unknown): string =>
  typeof id === "string" ? id.normalize("NFC").trim() : "";

/** Control + format characters (zero-width joiners, RTL overrides, NULs) have
 *  no place in an id: they are invisible in every console and every UI, so two
 *  ids that differ only by one are indistinguishable to the operator. */
const HAS_INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/u;

/** Prefix that marks an account id as EXTERNAL — owned by an identity
 *  provider, never password-verifiable. `auth-oidc.ts` builds those ids
 *  (`oidc:<issuer>:<sub>`) and re-exports this as `OIDC_ID_PREFIX`; it lives
 *  HERE because the store is what has to refuse the namespace, and a second
 *  spelling of the prefix is how the two would drift.
 *
 *  A RESERVED NAMESPACE IS RESERVED FROM BOTH SIDES. `externalId` exists so
 *  that "no OIDC login can ever land on a local account"; nothing stopped the
 *  other direction, and `POST /__aio/auth/signup` is open by default. An
 *  anonymous caller could sign up as `oidc:<issuer>:<victim-sub>` with a
 *  password of their choosing; the real SSO user then signed in, the callback
 *  found that row (`existing`), issued a session for it and never consulted
 *  `role(claims)` — and the attacker's password went on opening the SSO
 *  identity indefinitely, with no access to the provider at all. Classic
 *  account pre-hijacking, measured end to end against a mock IdP.
 *
 *  So the store refuses it, for every door at once (`/auth/signup`,
 *  `am auth add`, `app.auth.create`), and the one caller that legitimately
 *  owns the namespace comes through `externalCreatorOf` — a separate door,
 *  not a flag on `UserStore.create`, because that interface is frozen public
 *  surface (the same reason `AccountLockout` and `TotpReplay` live beside it
 *  rather than on it). */
export const EXTERNAL_ID_PREFIX = "oidc:";

/** True when an account id belongs to an external identity provider — it has
 *  no usable password, so password-shaped flows (reset) must refuse it. THE
 *  predicate; `auth-oidc.ts` re-exports it. EXACT, because it answers "what
 *  IS this row": only the callback mints these ids, and it mints them
 *  lowercase. For "may this id be claimed", see {@linkcode claimsExternalNamespace}. */
export const isExternalId = (id: string): boolean =>
  id.startsWith(EXTERNAL_ID_PREFIX);

/** True when an id CLAIMS the external namespace — the reservation predicate.
 *
 *  A RESERVATION IS ONLY AS STRONG AS THE FOLDING UNIQUENESS USES. Account
 *  ids are unique case-INSENSITIVELY (`selCi`, `COLLATE NOCASE`: `Neighbour`
 *  cannot join `neighbour`) while lookups stay exact. Reserving the namespace
 *  with a case-SENSITIVE `startsWith` therefore let the land-grab back in one
 *  shift key later: `OIDC:<issuer>:<sub>` passed the reservation, and then
 *  collided with the real SSO id at the uniqueness check, where nothing can be
 *  done about it any more. The victim's first SSO login looked the account up
 *  EXACTLY (a miss), tried to create it, was refused as a duplicate — and
 *  answered 401. On every login after that too: an anonymous signup took an
 *  SSO identity out of service permanently, and left a row that reads like the
 *  real one in `am auth users`.
 *
 *  So the reservation folds exactly as far as uniqueness does, and a little
 *  further (JS case folding covers more than SQLite's ASCII `NOCASE`) —
 *  refusing more ids than collide is safe; refusing fewer is the bug above. */
const claimsExternalNamespace = (id: string): boolean =>
  id.slice(0, EXTERNAL_ID_PREFIX.length).toLowerCase() === EXTERNAL_ID_PREFIX;

/** The id/password policy `create` enforces, asked as a pure QUESTION.
 *
 *  Same rule, one decider: `createRow` throws exactly what this returns, and
 *  the signup route asks it BEFORE it spends a budget. These three refusals
 *  are decided from the request alone — no hash, no row, no lookup — so a
 *  request they refuse costs the server nothing and reveals nothing. Charging
 *  it was the same outage the account budget had already been fixed for once:
 *  `{"id":"a","password":"1"}` is 25 bytes, and ten of them left signup
 *  `429 too_many_accounts` for an HOUR for everyone sharing the bucket — and
 *  thirty-one of them answered `429 too_many_attempts` to a correct password,
 *  because the per-minute work meter is LOGIN's too.
 *
 *  `user_exists` is deliberately NOT here: a collision needs the store, and it
 *  is the id-enumeration channel the account budget exists to bound. */
export function signupPolicyRefusal(
  rawId: unknown,
  password: unknown,
): "invalid_id" | "reserved_id" | "password_too_short" | null {
  const id = normId(rawId);
  if (id.length < 1 || id.length > 256 || HAS_INVISIBLE.test(id)) {
    return "invalid_id";
  }
  if (claimsExternalNamespace(id)) return "reserved_id";
  // NIST floor — 8 chars minimum.
  if (typeof password !== "string" || password.length < 8) {
    return "password_too_short";
  }
  return null;
}

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

/** A stored user as the auth subsystem sees it — identity plus the flags that
 *  gate a login (verified, TOTP). Never carries the password hash. */
export interface AuthUserRecord extends AioUser {
  createdAt: number;
  email: string | null;
  verified: boolean;
  totpEnabled: boolean;
}

/** One-shot token kinds — each namespace is independent. */
export type TokenKind = "verify" | "reset" | "totp" | "oidc";

/** Password + TOTP user storage behind `auth: true` — create/verify users,
 *  rotate passwords, and mint one-shot verify/reset/totp tokens. Usable
 *  headless (`app.auth`) when an app brings its own login UI.
 *
 *  Convention: policy errors THROW, "not found" RETURNS false/null (below). */
// Convention for this interface: methods THROW only on invalid INPUT a
// programmer must fix (a policy violation — "user_exists", "invalid_id",
// "password_too_short"), and RETURN a boolean/null for the normal "not found"
// outcome. So `create`/`setPassword` can throw a policy error; every mutator
// returns `false` when the id simply doesn't exist. Thrown codes are
// snake_case (they double as the HTTP wire error); catch and map for
// programmatic callers (`app.auth.create`).
export interface UserStore {
  /** Create a user. THROWS "user_exists" / "invalid_id" / "reserved_id" /
   *  "password_too_short" (policy). Role defaults to "user".
   *
   *  "reserved_id": the id is in the IdP-owned namespace (see
   *  {@linkcode EXTERNAL_ID_PREFIX}). The OIDC callback, which owns it, goes
   *  through `externalCreatorOf` instead. */
  create(
    id: string,
    password: string,
    opts?: { role?: string; email?: string },
  ): Promise<AuthUserRecord>;
  /** Verify credentials → user, `"locked"` (account lockout active), or null.
   *  Unknown ids burn a real PBKDF2 so timing doesn't reveal existence.
   *  LOCK_AFTER consecutive failures lock the account for 15 minutes. */
  verify(id: string, password: string): Promise<AioUser | "locked" | null>;
  /** Change password — the ONE decider for "this account was rescued".
   *
   *  A new password is never JUST a new hash. Every caller (HTTP
   *  `/auth/password`, `/auth/reset`, `am auth passwd`, `app.auth.setPassword`)
   *  needs the same four effects, and each caller that had to remember them
   *  forgot a different one:
   *
   *   1. the hash is replaced,
   *   2. any LOCKOUT and fail counter are cleared — a completed reset used to
   *      leave the victim `423 account_locked` for another 15 minutes, an
   *      attacker-renewable lockout that survived the rescue,
   *   3. outstanding one-shot tokens (reset / verify / TOTP pending) are
   *      burned — a pending captured before the reset used to complete
   *      afterwards and mint a fresh session,
   *   4. every session is revoked — `am auth passwd`, the breach-response
   *      command, used to leave the attacker's session alive.
   *
   *  THROWS "password_too_short" (policy); returns false when the user
   *  doesn't exist. */
  setPassword(id: string, newPassword: string): Promise<boolean>;
  /** Burn every outstanding one-shot token of a subject (reset, email verify,
   *  TOTP pending). Breach response: `revokeUser` kills sessions, this kills
   *  the things that MINT sessions. Returns the number deleted. */
  purgeTokens(subject: string): number;
  setRole(id: string, role: string): boolean;
  setEmail(id: string, email: string): boolean;
  /** Mark the account's email as verified. */
  markVerified(id: string): boolean;
  /** Clear a lockout + fail counter (operator rescue — `am auth unlock`). */
  unlock(id: string): boolean;
  /** All users, newest first (admin/CLI listing). */
  list(): AuthUserRecord[];
  get(id: string): AuthUserRecord | null;
  /** Delete a user — and END the account: every session revoked (through the
   *  store instance, so live sockets are disarmed) and every outstanding
   *  one-shot token burned. Returns false when the id doesn't exist. */
  remove(id: string): boolean;
  count(): number;
  /** Stage a TOTP secret (base32) — not active until enableTotp. */
  setTotpSecret(id: string, secretB32: string): boolean;
  enableTotp(id: string): boolean;
  /** Clear a second factor. True when one was actually enrolled — NOT whether
   *  the user exists (`get` answers that). The recovery path for a lost
   *  authenticator; there are no user-held recovery codes. */
  disableTotp(id: string): boolean;
  totpSecret(id: string): { secret: string; enabled: boolean } | null;
  /** Subscribe to CHANGES to a user's identity row — role, email, lock state,
   *  verification, second factor, deletion.
   *
   *  The session store has had `onRevoked` since the WS manager needed to
   *  disarm live sockets the moment a token dies. Nothing said the same thing
   *  about the row those sockets resolve their user FROM, so a demotion was
   *  honoured by the very next HTTP request and ignored by an already-open
   *  socket until the 5-second sweep found it — ten more frames of admin-only
   *  state to someone who is no longer an admin, and nothing ever closes that
   *  socket. Three docstrings and `docs/auth/auth.md` all said a role change
   *  "lands here too"; this is what makes that true.
   *
   *  OPTIONAL because `UserStore` is public surface and a required member
   *  would break anyone who implements it. A store without it degrades to the
   *  sweep, which is exactly where things stood.
   *
   *  @returns unsubscribe */
  onUserChanged?(listener: (id: string) => void): () => void;
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

/** The per-account lockout, for the one caller that verifies a credential
 *  OTHER than the password: the TOTP step of `/__aio/auth/totp`.
 *
 *  Wrong passwords always fed the lockout (5 → 15 minutes); wrong second-factor
 *  codes fed only the per-IP budget, which a botnet behind the documented proxy
 *  rotates past. Measured: 40 wrong TOTP codes for one account from 40
 *  addresses, then the right one → a session. The lockout is "the only defence
 *  a botnet's rotating IPs don't sidestep" (see `bumpFail`), and the factor
 *  that exists for the case where the password has LEAKED was outside it.
 *
 *  Internal — reached through `accountLockoutOf`, not a `UserStore` member,
 *  because `UserStore` is public surface. */
export interface AccountLockout {
  /** Count one failed second factor. True when the account is locked after it
   *  (this failure locked it, or it already was) — and a lock burns the
   *  subject's outstanding TOTP pending tokens, so guesses already in flight
   *  cannot keep trying the codes a lock is meant to stop. */
  fail(id: string): boolean;
  /** Is a lockout active right now? */
  locked(id: string): boolean;
  /** A completed login: the counter starts over. */
  clear(id: string): void;
}

const _lockouts = new WeakMap<UserStore, AccountLockout>();

/** The lockout behind a store opened by `openUserStore`; null for any other
 *  implementation of the interface (which then has no per-account lockout for
 *  second factors — the caller says so out loud). */
export function accountLockoutOf(store: UserStore): AccountLockout | null {
  return _lockouts.get(store) ?? null;
}

/** The TOTP step an account last had ACCEPTED, kept in auth.db so a code used
 *  just before a restart is still spent after it. `verifyTotp`'s own record is
 *  in memory and died with the process — within the 90-second window, the
 *  same code logged in again. Internal, like `AccountLockout`, because
 *  `UserStore` is public surface. */
export interface TotpReplay {
  /** Consume `step` for this account: true when it is newer than every step
   *  accepted before (and is now recorded), false for a replay. One atomic
   *  compare-and-set, so two concurrent checks cannot both win. */
  accept(id: string, step: number): boolean;
}

const _totpReplays = new WeakMap<UserStore, TotpReplay>();

/** The persisted replay record behind a store opened by `openUserStore`; null
 *  for any other implementation (which keeps only the in-memory guard). */
export function totpReplayOf(store: UserStore): TotpReplay | null {
  return _totpReplays.get(store) ?? null;
}

/** Create an account in the IdP-owned namespace `create` refuses — the ONE
 *  door into it. Same arguments as `create`; same throws. Internal, like
 *  `AccountLockout` and `TotpReplay`, because `UserStore` is frozen public
 *  surface and this must not become a flag anyone can pass. */
export type ExternalCreate = (
  id: string,
  password: string,
  opts?: { role?: string; email?: string },
) => Promise<AuthUserRecord>;

const _externalCreators = new WeakMap<UserStore, ExternalCreate>();

/** The external-identity door of a store opened by `openUserStore`; null for
 *  any other implementation — which has no reserved namespace of ours to get
 *  past, so its plain `create` is the right call. */
export function externalCreatorOf(store: UserStore): ExternalCreate | null {
  return _externalCreators.get(store) ?? null;
}

/** Options for `openUserStore`.
 *
 *  `sessions` is a GETTER, not a store: the session store and the user store
 *  are opened on the same `auth.db` and each needs the other (sessions resolve
 *  a live role from the users row; a password change revokes sessions), so one
 *  of the two edges has to be late-bound. Revocation must go through the store
 *  INSTANCE rather than a `DELETE` on the shared table — the WS manager
 *  subscribes to `onRevoked` to disarm live sockets, and a direct delete would
 *  leave those sockets open. */
export interface UserStoreOptions {
  sessions?: () => SessionStore | null | undefined;
}

/** Open (or create) the user store at `path` (":memory:" for tests). */
export function openUserStore(
  path: string,
  opts?: UserStoreOptions,
): UserStore {
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
  // Additive migration: the last accepted TOTP step (see `TotpReplay`). A
  // column with a default, so an older build opening this file reads and
  // writes it exactly as before.
  let totpStepColumn = true;
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all() as Array<
      { name: string }
    >;
    if (!cols.some((c) => c.name === "totp_step")) {
      db.exec(
        "ALTER TABLE users ADD COLUMN totp_step INTEGER NOT NULL DEFAULT 0",
      );
    }
  } catch (e) {
    totpStepColumn = false;
    log.warn(
      `[aio] auth: could not add the TOTP replay column to ${path} (${e}) — ` +
        `a second-factor code used just before a restart can be used once ` +
        `more after it, inside its 90-second window.`,
    );
  }
  const ins = db.prepare(
    "INSERT INTO users (id, pw, role, created_at, email) VALUES (?, ?, ?, ?, ?)",
  );
  const sel = db.prepare("SELECT * FROM users WHERE id = ?");
  // Case-insensitive existence probe — create-time confusable refusal.
  const selCi = db.prepare(
    "SELECT id FROM users WHERE id = ? COLLATE NOCASE LIMIT 1",
  );
  // ONE statement for a password change: new hash, lockout cleared, and any
  // STAGED-but-never-enabled TOTP secret dropped (an attacker who staged one
  // from a stolen session must not keep it across the owner's rescue). An
  // ENABLED factor is deliberately untouched — see the note on `setPassword`.
  const updPw = db.prepare(
    `UPDATE users
        SET pw = ?, fails = 0, locked_until = 0,
            totp = CASE WHEN totp_on = 1 THEN totp ELSE NULL END
      WHERE id = ?`,
  );
  // Identity-change listeners — see `onUserChanged` on the interface. Fired
  // for every write that changes what a live socket would resolve this user
  // to, so the WS manager can re-resolve now rather than at its next sweep.
  const _userListeners = new Set<(id: string) => void>();
  const _changed = (id: string): void => {
    for (const l of _userListeners) {
      try {
        l(id);
      } catch {
        // aio-ok: a listener is an observer — one that throws must not undo a
        // write that already landed, nor stop the others hearing it
      }
    }
  };

  const updRole = db.prepare("UPDATE users SET role = ? WHERE id = ?");
  const updEmail = db.prepare("UPDATE users SET email = ? WHERE id = ?");
  const updVerified = db.prepare("UPDATE users SET verified = 1 WHERE id = ?");
  const updFails = db.prepare(
    "UPDATE users SET fails = ?, locked_until = ? WHERE id = ?",
  );
  // Failure counting must happen IN THE DATABASE, not around it.
  //
  // The old path read `fails`, awaited PBKDF2 (~100ms of yielded event loop),
  // then wrote `fails + 1` as an absolute value. N concurrent wrong-password
  // requests all read the same stale count and all wrote the same number, so a
  // burst of 20 guesses advanced the counter by ONE — verified: twenty
  // concurrent wrong passwords left the account unlocked and still accepting
  // logins. The per-account lockout, the only defence a botnet's
  // rotating IPs don't sidestep, was bypassable by simply not waiting.
  //
  // One statement, evaluated atomically: increment, and lock at the threshold.
  // `locked_until <= ?` makes it a no-op for an already-locked account (never
  // extend a lockout) AND means exactly one racer can perform the locking
  // transition — so the warning below is logged once, not once per request.
  const bumpFail = db.prepare(
    `UPDATE users
        SET fails        = CASE WHEN fails + 1 >= ? THEN 0 ELSE fails + 1 END,
            locked_until = CASE WHEN fails + 1 >= ? THEN ? ELSE 0 END
      WHERE id = ? AND locked_until <= ?`,
  );
  const selLock = db.prepare("SELECT locked_until FROM users WHERE id = ?");
  // A NEW secret starts a new replay record: `totp_step` is the step the OLD
  // secret last spent, and left in place it refused the new authenticator's
  // first valid code as a "replay" when enrolment followed a 2FA login inside
  // the same 30 s step. Re-staging the SAME secret keeps the record, so this
  // never reopens a spent code.
  const updTotp = db.prepare(
    totpStepColumn
      ? "UPDATE users SET totp_step = CASE WHEN totp IS ?1 THEN totp_step " +
        "ELSE 0 END, totp = ?1 WHERE id = ?2"
      : "UPDATE users SET totp = ?1 WHERE id = ?2",
  );
  const updTotpOn = db.prepare(
    "UPDATE users SET totp_on = ? WHERE id = ? AND totp IS NOT NULL",
  );
  // Scoped to rows that actually CARRY a factor, so `changes` answers "was one
  // cleared" rather than "does this user exist" — which is what the one caller
  // reading the result asks. `am auth totp <id> off` told an operator "second
  // factor cleared" for an account that never had one, in the middle of a
  // lost-device recovery, which is the worst moment to imply an account was
  // protected. Existence is already answered separately, by `get`.
  const totpOff = db.prepare(
    "UPDATE users SET totp_on = 0, totp = NULL " +
      "WHERE id = ? AND (totp IS NOT NULL OR totp_on = 1)",
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
  // Burn a subject's outstanding one-shot tokens. `kind != 'oidc'` because
  // OIDC state tokens are subject-less ("state") and belong to a browser
  // mid-redirect, not to an account.
  const tokPurge = db.prepare(
    "DELETE FROM one_shot_tokens WHERE subject = ? AND kind != 'oidc'",
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

  const purgeTokens = (subject: string): number =>
    Number(tokPurge.run(normId(subject)).changes);
  const tokPurgeTotp = db.prepare(
    "DELETE FROM one_shot_tokens WHERE subject = ? AND kind = 'totp'",
  );

  /** Count a failure atomically, and warn exactly once when it locks. Shared
   *  by the password and the second factor, so both feed ONE counter. */
  const recordFailure = (id: string, what: string): void => {
    const now = Date.now();
    const r = bumpFail.run(LOCK_AFTER, LOCK_AFTER, now + LOCK_MS, id, now);
    if (Number(r.changes) === 1) {
      const after = selLock.get(id) as { locked_until: number } | undefined;
      if ((after?.locked_until ?? 0) > now) {
        log.warn(
          `[aio] auth: account "${id}" locked for ${
            LOCK_MS / 60_000
          }m after ${LOCK_AFTER} failed ${what}`,
        );
      }
    }
  };
  const lockedNow = (id: string): boolean =>
    ((selLock.get(id) as { locked_until: number } | undefined)
      ?.locked_until ?? 0) > Date.now();

  /** The tail of each account's verify queue — see `verify`. Keyed by the
   *  normalized id, so two spellings of one account cannot open two parallel
   *  lanes; per store (it lives in this closure), so two apps in one process
   *  never delay each other. An entry is dropped once its queue drains: no
   *  per-account residue, however many ids a guesser invents. */
  const _verifyQueues = new Map<string, Promise<void>>();
  const oneVerifyAtATime = <T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const run = (_verifyQueues.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.then(() => {}, () => {});
    _verifyQueues.set(key, tail);
    void tail.then(() => {
      if (_verifyQueues.get(key) === tail) _verifyQueues.delete(key);
    });
    return run;
  };

  /** How many session rows this same auth.db holds for a user. Only used to
   *  make an UNBOUND store's password change loud (see setPassword) — the
   *  table belongs to sessions.ts and may not exist at all. */
  const _liveSessionsFor = (id: string): number => {
    try {
      const row = db.prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?",
      ).get(id, Date.now()) as { n: number } | undefined;
      return Number(row?.n ?? 0);
    } catch {
      return 0; // no sessions table in this file — nothing to survive
    }
  };

  /** The one row-creating body, with WHO is asking as a parameter — so the
   *  public `create` and the external-identity door cannot grow two different
   *  ideas of what a valid account is. */
  const createRow = async (
    rawId: string,
    password: string,
    opts: { role?: string; email?: string } | undefined,
    external: boolean,
  ): Promise<AuthUserRecord> => {
    {
      const id = normId(rawId);
      // The whole policy, in one place — see `signupPolicyRefusal`, which the
      // signup route asks BEFORE it spends a budget on a request that cannot
      // create anything. This is still where it is ENFORCED; the route asking
      // first is an optimization of who pays, never a second rule.
      const refusal = signupPolicyRefusal(rawId, password);
      if (refusal !== null && !(refusal === "reserved_id" && external)) {
        throw new Error(refusal);
      }
      const pw = await hashPassword(password);
      const createdAt = Date.now();
      // Confusable refusal, immediately before the insert (no `await` between,
      // so nothing can slip in): `Neighbour` cannot join `neighbour`. The
      // PRIMARY KEY still catches the exact-duplicate race either way.
      if (selCi.get(id)) throw new Error("user_exists");
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
    }
  };

  const store: UserStore = {
    create(rawId, password, opts) {
      return createRow(rawId, password, opts, false);
    },
    verify(rawId, password) {
      const id = normId(rawId);
      // ONE VERIFY AT A TIME PER ACCOUNT: lock check → PBKDF2 → count is a
      // read-then-await-then-write, and `bumpFail` being atomic only fixed
      // the COUNT. Every guess that started before the fifth failure was
      // counted still had its password checked, and a right one read the
      // pre-lock row. Measured: 29 wrong passwords and the right one in one
      // `Promise.all` → `{ id, role }`, a session thirty guesses into a
      // lockout that allows five. Serialized, a burst is exactly the
      // sequential case (five nulls, a lock, `"locked"`). Not a reservation
      // (count first, refund on success): the fifth reservation would lock
      // the account before a CORRECT fifth password was even hashed. Mirrors
      // the TOTP route's queue in auth-flows.ts. Unknown ids queue too, so a
      // burst costs the same whether or not the account exists.
      return oneVerifyAtATime(id, async () => {
        const row = sel.get(id) as Row | undefined;
        // Hash FIRST, unconditionally — locked, unknown, and wrong-password
        // paths all cost one PBKDF2, so timing reveals nothing.
        const ok = await verifyPassword(password, row?.pw ?? DECOY);
        // AN EXTERNAL IDENTITY IS NEVER PASSWORD-VERIFIABLE — here, not just
        // in the comments. It was true only because one caller happens to
        // mint an unusable random password, and that is a convention, not a
        // property. Two things it now holds for:
        //
        //  · the UPGRADE. The reservation that refuses `oidc:<issuer>:<sub>`
        //    at signup is new, so an app that ran the version before it can
        //    hold a row an anonymous caller created under the victim's SSO id
        //    with a password of their choosing — the pre-hijack that fix was
        //    written for, still opening with a 200 on every login. `reset`
        //    already refuses "a token that predates that rule"; login did not.
        //  · one caller mistake — an `externalCreatorOf` handed a known
        //    password — no longer turns an IdP-owned identity into a password
        //    account.
        //
        // After the hash, so it costs exactly what every other path costs;
        // and the same generic `null`. No oracle is lost either way — the
        // namespace is a PREFIX of the id the caller just supplied.
        if (!row || isExternalId(id)) return null;
        // Wrong password (or unknown user) ALWAYS returns a generic null — the
        // "locked" signal is never handed to a caller who can't prove they
        // know the password, so a wrong-guessing attacker can't distinguish
        // exists/locked/absent by the response (no account enumeration, no
        // lock-state oracle). Only the correct-password branch below can
        // reveal a lock — to the legitimate account owner.
        if (!ok) {
          // Atomic increment-and-maybe-lock; the WHERE clause covers the
          // "already locked — don't extend" case that used to be a stale read.
          recordFailure(id, "logins");
          return null;
        }
        // RE-READ after the await. The queue serializes verifies, not the
        // store's other writers: during the hash the account can be removed,
        // its password rotated, or locked by the TOTP step. A verdict about a
        // row that no longer exists is not a login — the route mints a session
        // from whatever this returns, for a deleted account included.
        const now = sel.get(id) as Row | undefined;
        if (!now || now.pw !== row.pw) return null;
        // Password is correct. If the account is under an active lockout, tell
        // the owner (they can wait it out) — but only now, past the password
        // gate.
        if (now.locked_until > Date.now()) return "locked";
        // With a second factor enrolled, a right password is HALF a login, and
        // it must not wipe the counter the other half feeds: otherwise every
        // guess cycle (password → pending → wrong code) resets to zero before
        // the next wrong code, and the TOTP lockout never arrives. The TOTP
        // step clears the counter when the login actually completes.
        if (now.totp_on === 1) return { id: now.id, role: now.role };
        if (now.fails > 0 || now.locked_until > 0) updFails.run(0, 0, id);
        return { id: now.id, role: now.role };
      });
    },
    async setPassword(rawId, newPassword) {
      const id = normId(rawId);
      if (typeof newPassword !== "string" || newPassword.length < 8) {
        throw new Error("password_too_short");
      }
      // (1) new hash + (2) lockout cleared + staged-TOTP dropped — one
      // statement, so a rescued account is never half-rescued.
      const r = updPw.run(await hashPassword(newPassword), id);
      if (r.changes === 0) return false;
      // (3) every outstanding one-shot token dies with the old password: a
      // reset token mailed earlier, and — the one that mattered — a TOTP
      // `pending` an attacker captured before the reset, which used to
      // complete afterwards and hand them a brand-new session.
      purgeTokens(id);
      // (4) and every session. In-process this goes through the store
      // instance, so the WS manager's revocation listener disarms live
      // sockets too; `am auth passwd` (a separate process, no sockets) gets
      // the same guarantee for free.
      const sess = opts?.sessions?.();
      if (sess) sess.revokeUser(id);
      else if (_liveSessionsFor(id) > 0) {
        // The binding is what makes this the ONE decider. A caller that opens
        // a user store without it silently rotates a password while the old
        // sessions keep working — the exact bug this consolidation fixed — so
        // say so at the moment it happens rather than leaving it to a report.
        log.warn(
          `[aio] auth: password changed for id=${id} but this user store has ` +
            `no session store bound — ${
              count(_liveSessionsFor(id), "session")
            } ` +
            `SURVIVE the change. Open it as ` +
            `openUserStore(path, { sessions: () => sessionStore }).`,
        );
      }
      return true;
    },
    purgeTokens,
    setRole(rawId, role) {
      const id = normId(rawId);
      const ok = updRole.run(role, id).changes > 0;
      if (ok) _changed(id);
      return ok;
    },
    setEmail(rawId, email) {
      const id = normId(rawId);
      const ok = updEmail.run(email, id).changes > 0;
      if (ok) _changed(id);
      return ok;
    },
    markVerified(rawId) {
      const id = normId(rawId);
      const ok = updVerified.run(id).changes > 0;
      if (ok) _changed(id);
      return ok;
    },
    unlock(rawId) {
      const id = normId(rawId);
      const ok = updFails.run(0, 0, id).changes > 0;
      if (ok) _changed(id);
      return ok;
    },
    onUserChanged(listener) {
      _userListeners.add(listener);
      return () => _userListeners.delete(listener);
    },
    list() {
      const rows = db.prepare(
        "SELECT * FROM users ORDER BY created_at DESC",
      ).all() as Row[];
      return rows.map(toRecord);
    },
    get(rawId) {
      const row = sel.get(normId(rawId)) as Row | undefined;
      return row ? toRecord(row) : null;
    },
    remove(rawId) {
      const id = normId(rawId);
      if (del.run(id).changes === 0) return false;
      // DELETING AN ACCOUNT MUST END IT — same "one decider" rule as
      // `setPassword`, for the same reason it was needed there.
      //
      // A session row survives its users row: `sessions.get` re-reads the live
      // role, but a MISSING users row is indistinguishable from `sessions: true`
      // without `auth: true` (no user table at all), so it falls back to the
      // role cached at login. So `app.auth.remove("carol")` — offboarding, a
      // ban, breach response — deleted the account while carol's existing
      // token kept authenticating her, with her old role (admin included),
      // over HTTP and on already-open sockets, for up to the 30-day TTL.
      // `am auth rm` had always remembered to revoke; the programmatic door
      // had not, which is exactly how `am auth passwd` lost its revocation.
      // And one-shot tokens are burned too: a reset token or a TOTP `pending`
      // captured before the deletion would MINT a fresh session for an account
      // that no longer exists.
      purgeTokens(id);
      const sess = opts?.sessions?.();
      if (sess) sess.revokeUser(id);
      else if (_liveSessionsFor(id) > 0) {
        log.warn(
          `[aio] auth: user id=${id} removed but this user store has no ` +
            `session store bound — ${
              count(
                _liveSessionsFor(id),
                "session",
              )
            } SURVIVE ` +
            `the deletion. Open it as ` +
            `openUserStore(path, { sessions: () => sessionStore }).`,
        );
      }
      return true;
    },
    count() {
      return Number((cnt.get() as { n: number }).n);
    },
    setTotpSecret(rawId, secretB32) {
      // REFUSED at the write. Every TOTP code is derived by base32-decoding
      // this string, and the decoder throws `invalid_base32` — uncaught, deep
      // inside the login flow, as a bare `500 Internal Server Error`. So a hex
      // secret (the shape a migration off another system hands you) was
      // accepted with `true`, reported success, and then every login attempt
      // for that account answered 500 with no explanation, burning a `pending`
      // token each time. The write site is the one place that can say what is
      // wrong while the caller still knows what it passed.
      const clean = String(secretB32 ?? "").replace(/=+$/, "").toUpperCase();
      if (!clean || /[^A-Z2-7]/.test(clean)) {
        // The SHAPE, never the characters: the secret is a credential, and an
        // app's catch that logs e.message would write it into a log file.
        const bad = clean.search(/[^A-Z2-7]/);
        throw new Error(
          `setTotpSecret: the secret must be base32 (A-Z and 2-7). Got ` +
            `${clean.length} characters` +
            (bad >= 0 ? `, the first invalid one at position ${bad + 1}` : "") +
            ` (not shown: it is a credential) — every TOTP ` +
            `code is derived by decoding it, so this would be accepted here ` +
            `and then fail every login for this account.`,
        );
      }
      return updTotp.run(secretB32, normId(rawId)).changes > 0;
    },
    enableTotp(rawId) {
      return updTotpOn.run(1, normId(rawId)).changes > 0;
    },
    disableTotp(rawId) {
      return totpOff.run(normId(rawId)).changes > 0;
    },
    totpSecret(rawId) {
      const row = sel.get(normId(rawId)) as Row | undefined;
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
        // Same key as every other id column, so `purgeTokens` cannot miss a
        // token issued under a differently-spelled spelling of the same id.
        normId(subject) || subject,
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
      _unhookTotpReset?.();
      db.close();
    },
  };
  let _unhookTotpReset: (() => void) | undefined;
  if (totpStepColumn) {
    const updTotpStep = db.prepare(
      "UPDATE users SET totp_step = ? WHERE id = ? AND totp_step < ?",
    );
    _totpReplays.set(store, {
      accept: (rawId, step) =>
        updTotpStep.run(step, normId(rawId), step).changes > 0,
    });
    // Test seam only (see `_resetTotpReplay`).
    const resetSteps = db.prepare("UPDATE users SET totp_step = 0");
    _unhookTotpReset = _onTotpReplayReset(() => {
      try {
        resetSteps.run();
      } catch {
        // aio-ok: a store dropped without close() — its database is gone, so
        // there is nothing left to reset; stop asking.
        _unhookTotpReset?.();
      }
    });
  }
  // The one door into the reserved `oidc:` namespace — see
  // `EXTERNAL_ID_PREFIX` and `externalCreatorOf`.
  _externalCreators.set(
    store,
    (id, password, opts) => createRow(id, password, opts, true),
  );
  _lockouts.set(store, {
    fail(rawId) {
      const id = normId(rawId);
      recordFailure(id, "logins (second factor)");
      if (!lockedNow(id)) return false;
      tokPurgeTotp.run(id);
      return true;
    },
    locked: (rawId) => lockedNow(normId(rawId)),
    clear(rawId) {
      const id = normId(rawId);
      const row = sel.get(id) as Row | undefined;
      if (row && (row.fails > 0 || row.locked_until > 0)) {
        updFails.run(0, 0, id);
      }
    },
  });
  return store;
}

const _encoder = new TextEncoder();

// Authentication helpers — timing-safe comparison, token extraction, user resolution.
// Extracted from server.ts — no side effects, pure functions.
import type { AioUser } from "./aio.ts";

// Constant-time string comparison — prevents timing attacks on token auth
// Compares full length even on mismatch to avoid leaking token length
export function _timingSafeEqual(a: string, b: string): boolean {
  const ab = _encoder.encode(a);
  const bb = _encoder.encode(b);
  const len = Math.max(ab.length, bb.length);
  let result = ab.length ^ bb.length; // length difference contributes to result
  for (let i = 0; i < len; i++) result |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return result === 0;
}

/** Session cookie name (AUTH-2 browser flow). */
export const SESSION_COOKIE = "aio_session";

/** Read the session token from the Cookie header (browser flow). */
export function sessionTokenFromCookie(req: Request): string | null {
  const cookies = req.headers.get("cookie");
  if (!cookies) return null;
  for (const part of cookies.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v.join("=") || null;
  }
  return null;
}

/** Extract token from query param, Authorization header, or session cookie.
 *  Cookie last: it only exists when the AUTH-2 login flow set it, and an
 *  explicit token always wins over ambient cookie state. */
export function _extractToken(url: URL, req: Request): string | null {
  return _extractTokenWithSource(url, req).token;
}

/** Where a presented token came from. A URL-borne credential is visible in
 *  browser history, proxy logs and the `Referer` header, so the SOURCE decides
 *  what it is allowed to authenticate (see `sessionResolver` in server.ts). */
export function _extractTokenWithSource(
  url: URL,
  req: Request,
): { token: string | null; fromUrl: boolean } {
  const qToken = url.searchParams.get("token");
  if (qToken) return { token: qToken, fromUrl: true };
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return { token: auth.slice(7), fromUrl: false };
  }
  return { token: sessionTokenFromCookie(req), fromUrl: false };
}

/** User resolver function — built once from resolveUser hook or static users map */
export type UserResolverFn = (
  token: string,
) => AioUser | null | Promise<AioUser | null>;

/** Build a unified user resolver from config (AIO-171).
 *  resolveUser hook takes precedence over static users map. */
export function _buildUserResolver(config: {
  resolveUser?: UserResolverFn;
  users?: Record<string, AioUser>;
}): UserResolverFn | null {
  if (config.resolveUser) return config.resolveUser;
  if (config.users) {
    const users = config.users;
    return (token: string) => {
      for (const [t, user] of Object.entries(users)) {
        if (_timingSafeEqual(token, t)) return user;
      }
      return null;
    };
  }
  return null;
}

// ── Cell access evaluation (AUTH-1) ──────────────────────────────────────────

import type { CellAccess } from "../state/cell-types.ts";

/** Evaluate a cell's declarative access rule for a network caller.
 *  Same vocabulary as ServerFnAccess: true = any authenticated user,
 *  string = exact role, predicate = custom (also sees the method name).
 *  `false` = server-side only. */
export function cellAccessAllowed(
  rule: CellAccess,
  user: AioUser | undefined,
  method: string,
  args: unknown[] = [],
): boolean {
  if (rule === true) return user !== undefined;
  if (typeof rule === "string") return user?.role === rule;
  if (typeof rule === "function") return rule(user, method, ...args);
  return false; // rule === false
}

// ── Failed-auth budget (AUTH-1) ──────────────────────────────────────────────
// Brute-forcing tokens must get expensive: after MAX failed auths inside the
// sliding window, that client key (IP) gets 429 until the window drains. Same
// per-key philosophy as pairing — an attacker locks only themselves. Success
// never counts, so a legitimate browser is unaffected. Keyless callers (no
// remoteAddr) share one bucket.

const AUTH_FAIL_MAX = 10;
const AUTH_FAIL_WINDOW_MS = 5 * 60_000;
const _authFails = new Map<string, number[]>();

/** True when this client key has exhausted its failed-auth budget. */
export function authFailBudgetExceeded(
  clientKey: string | undefined,
  now = Date.now(),
): boolean {
  const key = clientKey ?? "*";
  const fails = _authFails.get(key);
  if (!fails) return false;
  const fresh = fails.filter((t) => now - t < AUTH_FAIL_WINDOW_MS);
  if (fresh.length === 0) _authFails.delete(key);
  else _authFails.set(key, fresh);
  return fresh.length >= AUTH_FAIL_MAX;
}

// The budget map is fed by REMOTE input — one entry per source that ever failed
// auth — and entries were only ever removed when that same key came back and
// found its window expired. An attacker rotating addresses (or a botnet) never
// comes back, so every address left a permanent entry: unbounded growth on a
// long-running `--expose` server, driven entirely from outside.
//
// Two bounds, both cheap: each key keeps at most the newest AUTH_FAIL_MAX
// timestamps (that is all the threshold test can need), and every so often a
// sweep drops keys whose whole window has passed.
const SWEEP_EVERY = 256;
let _sinceSweep = 0;
function _sweepExpired(now: number): void {
  for (const [key, ts] of _authFails) {
    const newest = ts[ts.length - 1];
    if (newest === undefined || now - newest >= AUTH_FAIL_WINDOW_MS) {
      _authFails.delete(key);
    }
  }
}

/** Record one failed auth for this client key + audit line. */
export function recordAuthFail(
  clientKey: string | undefined,
  detail: string,
  now = Date.now(),
): void {
  const key = clientKey ?? "*";
  const prior = _authFails.get(key) ?? [];
  const fails = prior.filter((t) => now - t < AUTH_FAIL_WINDOW_MS);
  fails.push(now);
  if (fails.length > AUTH_FAIL_MAX) {
    fails.splice(0, fails.length - AUTH_FAIL_MAX);
  }
  _authFails.set(key, fails);
  if (++_sinceSweep >= SWEEP_EVERY) {
    _sinceSweep = 0;
    _sweepExpired(now);
  }
  console.warn(
    `[aio] auth: failed auth from ${key} (${detail}) — ${fails.length}/${AUTH_FAIL_MAX} in window`,
  );
}

/** Test isolation. */
export function _resetAuthFails(): void {
  _authFails.clear();
}

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
 *  what it is allowed to authenticate (see `sessionResolver` in server.ts).
 *
 *  `"cookie"` is the AMBIENT source: the browser attaches it to every
 *  subresource of every page load without anyone deciding to. That makes it
 *  categorically different from `?token=` / `Authorization:` — see
 *  `_isPresented` below. */
export type TokenSource = "url" | "header" | "cookie";

export function _extractTokenWithSource(
  url: URL,
  req: Request,
): { token: string | null; fromUrl: boolean; source: TokenSource | null } {
  const qToken = url.searchParams.get("token");
  if (qToken) return { token: qToken, fromUrl: true, source: "url" };
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return { token: auth.slice(7), fromUrl: false, source: "header" };
  }
  const cookie = sessionTokenFromCookie(req);
  return {
    token: cookie,
    fromUrl: false,
    source: cookie === null ? null : "cookie",
  };
}

/** True when the caller DELIBERATELY presented this credential.
 *
 *  Only a presented-and-wrong credential is an attack signal worth spending
 *  the per-IP failure budget on (the shared-key path has always drawn this
 *  line — a token-less probe is a plain 401, not a strike). A session cookie
 *  is attached by the browser to every request for every subresource, so ONE
 *  page reload after a session expires used to burn the whole budget and
 *  429 the user's own next login attempt: the normal end of every session
 *  self-inflicted a 5-minute lockout.
 *
 *  Exempting the cookie is only safe because a cookie may authenticate a
 *  SESSION and nothing else (see the cookie clamp in server.ts) — session
 *  tokens are 256-bit random, so an unmetered guessing channel is worth
 *  nothing, while a short static `users:` token would have been. */
export const _isPresented = (source: TokenSource | null): boolean =>
  source === "url" || source === "header";

/** Header that tells a browser to drop a dead session cookie. Sent with the
 *  refusal, so the stale value stops riding along on every later request
 *  instead of failing silently forever. */
export const clearSessionCookie = (secure: boolean): string =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` +
  (secure ? "; Secure" : "");

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

// ── Control-plane gate (/__aio/trojan/*) ─────────────────────────────────────

import { mintControlKey, removeControlKey } from "./app-key.ts";

/** URL prefix of the trojan control plane. */
export const TROJAN_PREFIX = "/__aio/trojan/";

/** Header carrying the local operator's control credential.
 *
 *  A HEADER, deliberately, and never a query parameter: a URL-borne credential
 *  lands in browser history, proxy logs and the `Referer` of every outbound
 *  link (the same reasoning as `_warnTokenInUrl`), and a custom header is one a
 *  cross-origin page cannot attach to a forged request without a CORS preflight
 *  the trojan never answers — so a malicious page in the operator's own browser
 *  cannot ride this credential even though it sits on localhost.
 *
 *  Not `Authorization:` either: that channel feeds `resolveUser`/`users`, so a
 *  control key presented there would be counted as a failed LOGIN and burn the
 *  operator's own per-IP auth budget (an `am` loop could lock its own author out
 *  of the app for five minutes). It authenticates a different thing, so it
 *  travels on a different header. */
export const LOCAL_CONTROL_HEADER = "x-aio-control";

/** The credentials this process has armed, by appId. One process serves one app
 *  (the single-instance lock guarantees it); a TEST process that boots several
 *  servers arms several, and any of them authorizes — they are all the same
 *  operator's, on the same machine, in the same dev process. */
const _armed = new Map<string, { key: string; path: string }>();

/** Mint this app's local control credential and hold it in memory. Call once,
 *  at server construction. Idempotent per boot in effect: each call replaces
 *  the file and the value, so a restart invalidates every earlier copy.
 *
 *  WIRING — live, in two places in server.ts:
 *
 *    1. `armLocalControl(config)` at server construction (server.ts:169).
 *    2. the `localControlAuthorized(req)` branch in `handleRequest`
 *       (server.ts:568), immediately after the same-machine 404 for
 *       `/__aio/trojan/*`, so a remote caller is already gone before it runs.
 *
 *  (This paragraph described the wiring as NOT DONE long after it landed,
 *  listing the two edits as future work. A stale comment is bad everywhere and
 *  worse here: it told the reader that per-user apps refuse `am`/amui, which is
 *  the opposite of what the code does, and invited someone to "finish" wiring
 *  that already exists.)
 *
 *  It goes THERE, not at the `trojanDenialForUserMode` call sites, because in
 *  `users:` mode (no login flows) a credential-less request is refused by
 *  "no token, no bytes" long before any trojan gate runs — three edits deep in
 *  the per-user branch would have to cooperate, and a security rule spread over
 *  three conditionals is one refactor away from a hole. One branch, before the
 *  app's own auth, for one path prefix, in every mode.
 *  `trojanDenialForUserMode`'s `req` stays useful either way: it is what lets a
 *  WRONG credential be diagnosed instead of 401'd anonymously.
 *  Shutdown needs no edit — `resetTrojanRateLimit()` already disarms.
 *
 *  NEVER in prod: the trojan does not exist there (`server-static` refuses to
 *  mount it, `handleTrojan` refuses again), so a production app writes no
 *  control secret at all — nothing to steal, nothing to protect.
 *
 *  A failure is LOUD and leaves the app UNARMED. It never degrades into "allow
 *  anyway": the whole point is that this credential is as trustworthy as the
 *  directory it lives in. */
export function armLocalControl(
  cfg: { appId?: string; prod?: boolean },
): void {
  if (cfg.prod) return;
  if (!cfg.appId) {
    console.warn(
      "[aio] control plane: no appId — `am`/amui cannot authenticate to " +
        "/__aio/trojan/* on an auth-enabled app. Set appId in aio.run().",
    );
    return;
  }
  const r = mintControlKey(cfg.appId);
  if (r.error !== undefined) {
    console.warn(
      `[aio] control plane: no local control credential — ${r.error}. ` +
        `\`am\`/amui will need an authenticated admin on this app.`,
    );
    _armed.delete(cfg.appId);
    return;
  }
  _armed.set(cfg.appId, { key: r.key, path: r.path });
}

/** Drop the credential (and its file) — shutdown, or one app in a test process.
 *  With no appId, every armed credential in this process. */
export function disarmLocalControl(appId?: string): void {
  if (appId !== undefined) {
    _armed.delete(appId);
    removeControlKey(appId);
    return;
  }
  for (const id of [..._armed.keys()]) {
    _armed.delete(id);
    removeControlKey(id);
  }
}

/** Did the caller present a control credential at all? (Used to tell "you have
 *  no credential" apart from "yours is stale" in the refusal.) */
function _controlPresented(req: Request | undefined): string | null {
  return req?.headers.get(LOCAL_CONTROL_HEADER) ?? null;
}

/** True when the presented credential matches one this process armed.
 *  Timing-safe, and false whenever nothing is armed (prod, an unwritable or
 *  non-owner-only data dir) — an unarmed app cannot be talked into accepting
 *  an empty or absent key. */
export function localControlAuthorized(req: Request | undefined): boolean {
  const presented = _controlPresented(req);
  if (!presented || _armed.size === 0) return false;
  let ok = false;
  // No early exit: compare against every armed key so the work (and therefore
  // the timing) does not depend on which one matched.
  for (const { key } of _armed.values()) {
    if (_timingSafeEqual(presented, key)) ok = true;
  }
  return ok;
}

/** The path of an armed credential, for a refusal that can be acted on. */
function _armedPath(): string | null {
  for (const { path } of _armed.values()) return path;
  return null;
}

/** ONE decider for "may this identity touch the raw-state control plane?".
 *
 *  `/__aio/trojan/*` reads UNFILTERED state (no `ui.exclude`, no `forUser`),
 *  dispatches arbitrary actions, runs SQL against the app DB and REPLACES the
 *  whole state. That is `/__aio/snapshot`'s power and more, so it is gated
 *  identically — and the rule is written once, here, because it must hold on
 *  BOTH the main listener and the plain-HTTP control listener that TLS spins
 *  up (two copies of a security rule is how one of them rots).
 *
 *  The complete rule, by auth mode:
 *   - per-user mode (`users` / `resolveUser` / `sessions` / `auth: true`):
 *     an authenticated user with role "admin" — CALL THIS FUNCTION. Before the
 *     fix this path fell through to static serving whenever the login flows
 *     made the shell public, leaving the entire control plane anonymous.
 *   - shared-key mode: the key already gates every route ahead of this.
 *   - public mode: no identity exists to check; the trojan's gate is that it
 *     is dev-only (server-static) and same-machine-only (handleRequest).
 *
 *  THE LOCAL OPERATOR is the third way in, and the only one that is not an app
 *  identity: a request carrying `X-Aio-Control` with this boot's credential from
 *  `<data>/control.key` (0600 in a 0700 dir — see app-key.ts). "Can read that
 *  file" means "is the OS user who owns this app's data", which is strictly
 *  stronger than any account inside the app and is the same boundary the
 *  same-machine rule already relies on. Without it `am`/amui — which have no app
 *  account to log in as — could not inspect a locally running `auth: true` app
 *  at all, and the answer to that is a credential, not a hole: this authorizes
 *  the TROJAN and nothing else. `/ws`, `/__aio/snapshot`, the login flows and
 *  every app route are gated by their own checks in server.ts, which never
 *  consult this function and never see this header as an identity.
 *
 *  Nothing here weakens the refusals that matter: a remote caller is 404'd
 *  before this (same-machine only), a production build has no trojan and mints
 *  no credential, and a local user who is NOT the owner cannot read the file
 *  (0600) — for them this path is exactly as closed as it was.
 *
 *  Returns the refusal, or null when the caller may proceed. */
/** ONE bar for every surface that REWRITES OR REWINDS RAW STATE, whatever the
 *  transport: `/__aio/snapshot`, `/__aio/trojan/*` — and the `tt-cmd` frame on
 *  a live WebSocket, which was the door nobody guarded.
 *
 *  A time-travel command is not a debug read. `handleTTCommand` assigns
 *  `state` directly (`goto:0` rewinds the WHOLE app to its first action, for
 *  every connected client) and `pause` makes `dispatch` REJECT every action
 *  from every user until someone resumes — writes stop and persistence stops
 *  with them. That is `/__aio/snapshot`'s power, reachable from one frame on
 *  a socket any authenticated account can open, so it answers to the same
 *  rule the other two doors answer to instead of to none.
 *
 *  Only meaningful in per-user mode: public mode has no identity to check (the
 *  dev panel is the whole point) and shared-key mode already gated the socket
 *  on the key. Callers pass that context; this decides the ROLE question. */
export const rawStateControlAllowed = (user: AioUser | undefined): boolean =>
  user?.role === "admin";

export function trojanDenialForUserMode(
  pathname: string,
  user: AioUser | undefined,
  req?: Request,
): Response | null {
  if (!pathname.startsWith(TROJAN_PREFIX)) return null;
  // ① the machine owner, proved by a file only they can read
  if (localControlAuthorized(req)) return null;
  const presented = _controlPresented(req);
  // ② an app account: admin only
  if (!user) {
    return new Response(_noCredentialMessage(presented !== null), {
      status: 401,
    });
  }
  if (!rawStateControlAllowed(user)) {
    return new Response(
      'Forbidden — /__aio/trojan/* is the raw-state control plane and requires role "admin"' +
        (presented !== null ? `\n\n${_staleCredentialHint()}` : ""),
      { status: 403 },
    );
  }
  return null;
}

/** Why the caller was refused, and what to do about it — a 401 with no path
 *  forward is what makes people turn auth off in dev. */
function _noCredentialMessage(presentedOne: boolean): string {
  const head =
    "Unauthorized — /__aio/trojan/* is the raw-state control plane (unfiltered " +
    "state, arbitrary dispatch, SQL, whole-state overwrite).\n";
  if (presentedOne) return head + "\n" + _staleCredentialHint();
  const path = _armedPath();
  return head +
    "\nReach it as an authenticated admin, or — from this machine — with this " +
    "app's local control credential in the " + LOCAL_CONTROL_HEADER +
    " header (that is what `am` and amui do).\n" +
    (path
      ? `This boot's credential: ${path} (owner-only).`
      : "This app armed NO local control credential: it is a production build, " +
        "or its data dir is not owner-only / not writable — the boot log says " +
        "which. Start it in dev, or use an admin account.");
}

function _staleCredentialHint(): string {
  const path = _armedPath();
  return "The " + LOCAL_CONTROL_HEADER +
    " credential presented does not match this app. It is minted fresh at every " +
    "boot, so a copy from an earlier run is dead" +
    (path ? ` — the live one is ${path}.` : ".") +
    " Re-run the command (it reads the file each time); if it still fails, the " +
    "app's data dir is not where your tooling is looking (AIO_APPS_DIR / appDir).";
}

// ── Cell access evaluation (AUTH-1) ──────────────────────────────────────────

import type { Access } from "../state/cell-types.ts";

/** Evaluate a cell's declarative access rule for a network caller.
 *  Same vocabulary as serverFns' access (one `Access` type, alpha52): true = any authenticated user,
 *  string = exact role, predicate = custom (also sees the method name).
 *  `false` = server-side only. */
export function cellAccessAllowed(
  rule: Access,
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

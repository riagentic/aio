const _encoder = new TextEncoder();

// Authentication helpers — timing-safe comparison, token extraction, user resolution.
// Extracted from server.ts — no side effects, pure functions.
import type { AioUser } from "./aio.ts";
import { parseCookies } from "./route.ts";
import { slugify } from "./single-instance-lock.ts";
import { certSubjectAltNames } from "./x509.ts";

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

/** The token from an `Authorization: Bearer` header, or null.
 *
 *  THE reader. Three call sites spelled `auth?.startsWith("Bearer ")` for
 *  themselves — the general extractor, the auth-flow resolver and the
 *  shared-key path — which is three chances for the credential rule to drift,
 *  on the one header where drifting means "authenticated here, anonymous
 *  there".
 *
 *  The scheme is matched case-INSENSITIVELY, which is what RFC 7235 says it is
 *  (`auth-scheme` is a token, and tokens are case-insensitive). Every spelling
 *  here was exact-match, so a client sending `bearer <token>` — which some HTTP
 *  libraries do — presented a perfectly good credential and was treated as
 *  anonymous. Accepting the other casings loosens nothing: the token still has
 *  to match. */
export function bearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = /^bearer[ \t]+(.+)$/i.exec(auth.trim());
  return m ? m[1]!.trim() || null : null;
}

/** The LEGACY session cookie name (AUTH-2 browser flow) — one name for every
 *  app. Still READ, as a fallback, so sessions issued before the per-app name
 *  survive an upgrade; never WRITTEN. See `sessionCookieNameFor`. */
export const SESSION_COOKIE = "aio_session";

/** The session cookie's name, scoped to the app.
 *
 *  Cookies ignore the PORT (RFC 6265 §8.5), so every aio app on one host shared
 *  one `aio_session`: signing in to app B on :8081 overwrote app A's cookie on
 *  :8080 — A logged out, and B's server received A's HttpOnly session token on
 *  every request. The shared-key cookie was already per app
 *  (`keyCookieNameFor` in server.ts); the session cookie, the one carrying a
 *  per-USER credential, was the one that was not. Same slug rule as the key
 *  cookie and the instance lock, so one appId is one name everywhere. */
export function sessionCookieNameFor(appId: string | undefined): string {
  return `${SESSION_COOKIE}_${slugify(appId ?? "app", "app")}`;
}

/** The session token a request's cookies carry for THIS app, and whether it
 *  came from the legacy shared name.
 *
 *  The app's own name wins outright. The legacy name is consulted only when
 *  the app's own is absent — a session issued before the upgrade — and the
 *  caller is told, because a legacy value may belong to ANOTHER app on the
 *  host: it may authenticate here only if this app's store knows it, and it
 *  must never be cleared on a mere mismatch (that would log the other app
 *  out, which is the bug the per-app name exists to end). */
export function sessionCookieFrom(
  req: Request,
  name: string = SESSION_COOKIE,
): { token: string; legacy: boolean } | null {
  const jar = parseCookies(req.headers.get("cookie"));
  const own = jar[name];
  if (own) return { token: own, legacy: name === SESSION_COOKIE };
  if (name === SESSION_COOKIE) return null;
  const old = jar[SESSION_COOKIE];
  return old ? { token: old, legacy: true } : null;
}

/** Read the session token from the Cookie header (browser flow).
 *
 *  Through `parseCookies`, not a second hand-rolled parse. There were two
 *  readers of the same header with two different answers: this one returned
 *  the FIRST duplicate and did not percent-decode; `parseCookies` (route.ts,
 *  what an app's own handler sees) returns the LAST and decodes. Same header,
 *  two answers — and a browser sending two `aio_session` cookies (one set on
 *  the host, one on a parent domain) is ordinary, not exotic. Last-wins is the
 *  rule that survives, because it is the one an app's handler already gets. */
export function sessionTokenFromCookie(
  req: Request,
  name: string = SESSION_COOKIE,
): string | null {
  return sessionCookieFrom(req, name)?.token ?? null;
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
  cookieName: string = SESSION_COOKIE,
): {
  token: string | null;
  fromUrl: boolean;
  source: TokenSource | null;
  /** The cookie was the legacy shared name — see `sessionCookieFrom`. */
  legacyCookie?: boolean;
} {
  const qToken = url.searchParams.get("token");
  if (qToken) return { token: qToken, fromUrl: true, source: "url" };
  const bearer = bearerToken(req);
  if (bearer) return { token: bearer, fromUrl: false, source: "header" };
  const cookie = sessionCookieFrom(req, cookieName);
  return cookie === null ? { token: null, fromUrl: false, source: null } : {
    token: cookie.token,
    fromUrl: false,
    source: "cookie",
    legacyCookie: cookie.legacy,
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
export const clearSessionCookie = (
  secure: boolean,
  name: string = SESSION_COOKIE,
): string =>
  `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` +
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
    log.warn(
      "[aio] control plane: no appId — `am`/amui cannot authenticate to " +
        "/__aio/trojan/* on an auth-enabled app. Set appId in aio.run().",
      { detail: String() },
    );
    return;
  }
  const r = mintControlKey(cfg.appId);
  if (r.error !== undefined) {
    log.warn(
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
import { log } from "../diagnostics/logger-api.ts";
import { _diagScopeNow } from "../diagnostics/diagnostic-bus.ts";

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
  if (typeof rule === "function") {
    let answer: unknown;
    try {
      answer = rule(user, method, ...args);
    } catch (e) {
      // A guard that cannot answer is not a yes — the same rule the update
      // applier's `canApply` follows. The alternative is a 500 whose cause is
      // three layers away from the sentence that would have explained it.
      log.error(
        "auth",
        `access predicate for "${method}" threw (${e}) — DENIED. A rule that ` +
          `cannot answer is a refusal, never permission.`,
      );
      return false;
    }
    if (typeof answer === "boolean") return answer;
    // NOT a boolean. This used to be returned as-is into `if (!allowed)`, so
    // any truthy non-boolean granted access — and the one an app reaches for
    // by accident is a PROMISE: `access: async (u) => await check(u)` is a
    // pending promise, which is truthy, which is "yes" to everybody. The
    // `Access` type says `=> boolean` and TypeScript catches the direct form,
    // but not one returned through an `any`, and this gate is the last place
    // that mistake can still be caught. Denied and said out loud, because a
    // silent grant is the one outcome an access rule must never produce.
    log.error(
      "auth",
      `access predicate for "${method}" returned ${
        isThenable(answer)
          ? "a PROMISE — the dispatch gate is synchronous and cannot await it"
          : `a ${typeof answer}, not a boolean`
      } — DENIED. Return true or false; do the async work before the call ` +
        `(resolveUser, a serverFn) and decide on its result here.`,
    );
    return false;
  }
  return false; // rule === false
}

/** Promise-shaped, without assuming it is a real `Promise`. */
function isThenable(v: unknown): boolean {
  return typeof v === "object" && v !== null &&
    typeof (v as { then?: unknown }).then === "function";
}

// ── Failed-auth budget (AUTH-1) ──────────────────────────────────────────────
// Brute-forcing tokens must get expensive: after MAX failed auths inside the
// sliding window, that client key (IP) gets 429 until the window drains. Same
// per-key philosophy as pairing — an attacker locks only themselves. Success
// never counts, so a legitimate browser is unaffected. Keyless callers (no
// remoteAddr) share one bucket.

const AUTH_FAIL_MAX = 10;
const AUTH_FAIL_WINDOW_MS = 5 * 60_000;

// ONE LEDGER PER APP. The failure, work and signup budgets below are keyed by
// client address — and one process can host several apps (library mode,
// `testApps`), each running in its own app scope (`_diagScopeNow()`). As
// module-level maps they were one ledger for the whole process: 11 signups on
// app B answered app A's FIRST signup with a 429, and failed logins on B
// locked the same address out of A. Each app now draws on its own; code
// outside any app (a bare `createServer`, a unit test) keeps the process one.
type AuthLedger = {
  fails: Map<string, number[]>;
  work: Map<string, number[]>;
  signups: Map<string, number[]>;
};
const _newLedger = (): AuthLedger => ({
  fails: new Map(),
  work: new Map(),
  signups: new Map(),
});
let _processLedger = _newLedger();
let _ledgerOf = new WeakMap<object, AuthLedger>();
/** The ledger of the app running this code — or the process's, outside any. */
function _ledger(): AuthLedger {
  const scope = _diagScopeNow();
  if (scope === undefined) return _processLedger;
  let l = _ledgerOf.get(scope);
  if (!l) _ledgerOf.set(scope, l = _newLedger());
  return l;
}

/** True when this client key has exhausted its failed-auth budget. */
export function authFailBudgetExceeded(
  clientKey: string | undefined,
  now = Date.now(),
): boolean {
  const key = clientKey ?? "*";
  const failMap = _ledger().fails;
  const fails = failMap.get(key);
  if (!fails) return false;
  const fresh = fails.filter((t) => now - t < AUTH_FAIL_WINDOW_MS);
  if (fresh.length === 0) failMap.delete(key);
  else failMap.set(key, fresh);
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
/** Hard ceiling on distinct keys. The opportunistic sweep only runs every
 *  SWEEP_EVERY records and only drops keys whose window has already passed —
 *  so a client rotating its address faster than the window drains (trivial
 *  behind a forwarding header, and merely cheap from a botnet) grew this map
 *  without bound between sweeps. A bound that holds under ADVERSARIAL input
 *  cannot be "we tidy up now and then": at the ceiling, sweep first, and if
 *  that frees nothing, drop the oldest keys. Losing the oldest strikes is the
 *  correct failure — they are the ones closest to expiring anyway. */
const AUTH_FAIL_MAX_KEYS = 10_000;
let _sinceSweep = 0;
function _sweepExpired(failMap: Map<string, number[]>, now: number): void {
  for (const [key, ts] of failMap) {
    const newest = ts[ts.length - 1];
    if (newest === undefined || now - newest >= AUTH_FAIL_WINDOW_MS) {
      failMap.delete(key);
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
  const failMap = _ledger().fails;
  if (failMap.size >= AUTH_FAIL_MAX_KEYS && !failMap.has(key)) {
    _sweepExpired(failMap, now);
    // Map iteration is insertion-ordered, so the front IS the oldest. Drop
    // back to 90% rather than exactly one, so a saturated map does not pay an
    // eviction on every single request.
    const target = Math.floor(AUTH_FAIL_MAX_KEYS * 0.9);
    for (const k of failMap.keys()) {
      if (failMap.size <= target) break;
      failMap.delete(k);
    }
  }
  const prior = failMap.get(key) ?? [];
  const fails = prior.filter((t) => now - t < AUTH_FAIL_WINDOW_MS);
  fails.push(now);
  if (fails.length > AUTH_FAIL_MAX) {
    fails.splice(0, fails.length - AUTH_FAIL_MAX);
  }
  failMap.set(key, fails);
  if (++_sinceSweep >= SWEEP_EVERY) {
    _sinceSweep = 0;
    _sweepExpired(failMap, now);
  }
  log.warn(
    `[aio] auth: failed auth from ${key} (${detail}) — ${fails.length}/${AUTH_FAIL_MAX} in window`,
  );
}

// ── Expensive-work budget: the OTHER thing a credential route must bound ────
//
// The failure budget answers "is this client guessing". It cannot answer "is
// this client making me do work", and the two are not the same question:
//
//   * a SUCCESSFUL signup records no failure, so nothing ever throttled it.
//     60 anonymous signups landed in 665 ms — 60 PBKDF2-600k runs (~51 ms of
//     CPU each), 60 permanent `users` rows, and 60 real sessions, i.e.
//     anonymous → `role:"user"` at will, reaching every `access: true` cell.
//     `signup: true` is the default. Every OTHER verifying route carries a
//     budget explicitly "so it is not an unthrottled PBKDF2 pump"; the one
//     route reachable with no credential at all did not.
//
//   * and the failure budget was being used as a stand-in for this one, at the
//     cost of the invariant `docs/auth/auth.md` states: "The budget throttles
//     failed authentication, never service. A request that presents a VALID
//     credential is served regardless of the budget." True at the HTTP gate,
//     false at `/__aio/auth/*`, which checked the budget BEFORE verifying
//     anything — so 12 failed logins for a nonexistent id took the whole app's
//     login and signup offline for five minutes. Behind the reverse proxy the
//     docs prescribe WITHOUT `trustProxyHeader`, every client shares one
//     bucket, so those 12 requests are an outage for everyone, renewably.
//
// So: work is metered on its own, valid or not, and the failure budget goes
// back to deciding only what a FAILED verification is answered with.
const AUTH_WORK_MAX = 30;
const AUTH_WORK_WINDOW_MS = 60_000;
/** Accounts one client key may create in a window. A person signs up once. */
const SIGNUP_MAX = 10;
const SIGNUP_WINDOW_MS = 60 * 60_000;

/** Charge one unit against `map` and report whether it stayed within `max`.
 *  Bounded the same way `_authFails` is: newest `max` stamps per key, and the
 *  oldest keys evicted at the ceiling — the map is fed by remote input. */
function _charge(
  map: Map<string, number[]>,
  key: string,
  max: number,
  windowMs: number,
  now: number,
): boolean {
  if (map.size >= AUTH_FAIL_MAX_KEYS && !map.has(key)) {
    for (const [k, ts] of map) {
      const newest = ts[ts.length - 1];
      if (newest === undefined || now - newest >= windowMs) map.delete(k);
    }
    const target = Math.floor(AUTH_FAIL_MAX_KEYS * 0.9);
    for (const k of map.keys()) {
      if (map.size <= target) break;
      map.delete(k);
    }
  }
  const fresh = (map.get(key) ?? []).filter((t) => now - t < windowMs);
  fresh.push(now);
  if (fresh.length > max + 1) fresh.splice(0, fresh.length - (max + 1));
  map.set(key, fresh);
  return fresh.length <= max;
}

/** Charge one EXPENSIVE verification (PBKDF2-class) to this client key.
 *  `false` ⇒ over budget: answer 429 without doing the work. */
/** Give back a unit charged by {@linkcode chargeAuthWork} — the work is done,
 *  and the credential turned out to be VALID.
 *
 *  `docs/auth/auth.md` states the contract: "Successful requests never consume
 *  budget. The budget throttles failed authentication, never service. A
 *  request that presents a valid credential is served regardless of the
 *  budget." The work meter charged every attempt and never gave any back, so
 *  it was 30 CORRECT logins per minute and then `429` for everyone. Measured:
 *  40 consecutive logins with the right password, all for an unlocked account
 *  — the first 29 answered 200, the last 11 answered 429. And the same page
 *  notes that behind a reverse proxy without `trustProxyHeader` every client
 *  shares ONE bucket, so a team of more than 30 people signing in within a
 *  minute takes the whole app's login offline from purely legitimate traffic
 *  — which is precisely the outage `chargeAuthWork` was introduced to fix,
 *  arriving from the other direction.
 *
 *  Refunding a SUCCESS costs an attacker nothing: they do not have the valid
 *  credential that earns the refund. What the meter still caps is exactly what
 *  it was built to cap — PBKDF2 work spent on attempts that turn out wrong. */
export function refundAuthWork(
  clientKey: string | undefined,
  now = Date.now(),
): void {
  const key = clientKey ?? "*";
  const work = _ledger().work;
  const stamps = work.get(key);
  if (!stamps || stamps.length === 0) return;
  // Drop the most recent stamp — the one this request just charged.
  stamps.pop();
  if (stamps.length === 0) work.delete(key);
  void now;
}

export function chargeAuthWork(
  clientKey: string | undefined,
  now = Date.now(),
): boolean {
  return _charge(
    _ledger().work,
    clientKey ?? "*",
    AUTH_WORK_MAX,
    AUTH_WORK_WINDOW_MS,
    now,
  );
}

/** Charge one ACCOUNT CREATION to this client key. `false` ⇒ over budget. */
export function chargeSignup(
  clientKey: string | undefined,
  now = Date.now(),
): boolean {
  return _charge(
    _ledger().signups,
    clientKey ?? "*",
    SIGNUP_MAX,
    SIGNUP_WINDOW_MS,
    now,
  );
}

/** Test isolation. */
export function _resetAuthFails(): void {
  _processLedger = _newLedger();
  _ledgerOf = new WeakMap(); // every app's too — a test resets from outside
}

// ── Host gate — DNS-rebinding defense (ONE decider) ──────────────────────────
//
// A page on evil.com whose DNS record flips to 127.0.0.1 becomes SAME-ORIGIN
// with an app served on loopback: the browser attaches the app's cookies, the
// WS `isOwnHost` check (Origin vs the request's own Host) passes because both
// say `evil.com`, and in public mode there is no credential to miss. The
// attacker then reads `/__aio/trojan/state` (raw, unfiltered, secrets and all),
// dispatches, runs SQL and replaces the whole state.
//
// The only header that carries the NAME the browser used is `Host`, so that is
// what has to be checked, and it has to be checked in ONE place that the HTTP
// path, the trojan and the WS upgrade all pass through (`handleRequest`) —
// three copies of a rebinding gate is how one of them rots.
//
// The rule is "is this a name this server is actually reachable as?", and the
// load-bearing half of it is that an IP LITERAL cannot be rebound: a browser
// only sends `Host: 10.0.0.5` for a page whose origin IS `http://10.0.0.5`,
// which means it connected to that address with no DNS in the loop. That is
// what keeps `--expose` (LAN IPs, and the share link) working untouched while
// every attacker-controlled DOMAIN is refused.

/** A single trailing dot is the ROOT LABEL, not part of the name: `localhost.`
 *  and `localhost` are the same host, and a browser sends the dotted form when
 *  the user types one. Without this, `http://localhost.:3000` was refused with
 *  a DNS-rebinding message — a security control turning away the developer who
 *  owns the machine. */
function _dropRootDot(name: string): string {
  return name.length > 1 && name.endsWith(".") ? name.slice(0, -1) : name;
}

/** Bare hostname of a `Host` header value: port stripped, IPv6 brackets
 *  removed, root dot dropped, lowercased. `""` when there is nothing to check.
 *
 *  Parses rather than slices. Taking everything before the LAST colon meant a
 *  `Host` with two of them (`evil.com:80:80`) yielded `evil.com:80`, which the
 *  old "contains a colon ⇒ IP literal" rule then read as an IPv6 address — so
 *  an attacker-controlled domain walked straight through the allowlist with a
 *  header a proxy or a non-browser client can send at will. A port is digits;
 *  anything else is not a `host:port`, and a fragment of a malformed header is
 *  never a name this server answers to. */
export function _hostnameOfHeader(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    return _dropRootDot(close === -1 ? h.slice(1) : h.slice(1, close));
  }
  // A bare IPv6 is not legal in `Host` (RFC 7230 wants brackets), but one that
  // really IS an address is recognised rather than mangled into a fragment.
  if (_isIpv6(h)) return h;
  const i = h.lastIndexOf(":");
  if (i === -1) return _dropRootDot(h);
  if (!/^\d+$/.test(h.slice(i + 1))) return h; // not host:port — matches nothing
  return _dropRootDot(h.slice(0, i));
}

const _IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** A real IPv6 literal, judged by the platform's own URL parser rather than by
 *  a second spelling of the rule here. `evil.com:80` contains a colon and is
 *  not an address; that difference is the whole point. */
function _isIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  try {
    new URL(`http://[${hostname}]/`);
    return true;
  } catch {
    return false;
  }
}

/** An IP literal — v4 dotted quad or v6. Cannot be the product of DNS, which
 *  is what makes it safe to allow: a browser only sends `Host: 10.0.0.5` for a
 *  page whose origin IS that address, so no name was ever resolved. */
function _isIpLiteral(hostname: string): boolean {
  if (_IPV4_RE.test(hostname)) {
    return hostname.split(".").every((o) => Number(o) <= 255);
  }
  return _isIpv6(hostname);
}

/** This machine's own name, once. `Deno.hostname()` needs `--allow-sys`; an app
 *  running without it simply has no hostname to allow (loopback + IP literals +
 *  `allowedOrigins` still work), so a denial is not an error. */
let _machineHost: string | null | undefined;
function _machineHostname(): string | null {
  if (_machineHost !== undefined) return _machineHost;
  try {
    _machineHost = Deno.hostname().toLowerCase() || null;
  } catch {
    _machineHost = null;
  }
  return _machineHost;
}

/** Test isolation — re-read `Deno.hostname()`. @internal */
export function _resetMachineHostname(): void {
  _machineHost = undefined;
}

/** The name the client says it reached this server as — THE input to
 *  {@link hostAllowed} and to the same-origin half of `originVerdict`.
 *
 *  HTTP/1.1 carries it in `Host`. HTTP/2 does NOT: the name travels in the
 *  `:authority` pseudo-header, which Deno does not surface as a header at all
 *  but builds `req.url` from. Reading `Host` alone (remote-desktop field report §3)
 *  handed the gate `null` — "a non-browser client, allow" — for EVERY h2
 *  request, so the DNS-rebinding gate was off for any TLS client that
 *  negotiated h2, i.e. every browser; and a same-origin POST over h2 was
 *  judged cross-origin ("no Host header"). Measured on Deno 2.9: an h2
 *  request has no `host` key and `req.url` = `https://<:authority>/…`; an
 *  HTTP/1.0 request with no Host gets a synthesised `localhost` URL, which
 *  the gate allows exactly as it allowed the missing header before.
 *
 *  `Host` wins when present: on HTTP/1.1 Deno derives the URL from it anyway,
 *  so the two only differ when the header is absent. */
export function requestHost(req: Request): string | null {
  const h = req.headers.get("host");
  if (h !== null) return h;
  try {
    return new URL(req.url).host || null;
  } catch {
    return null;
  }
}

/** The DNS names the TLS certificate this app SERVES vouches for — read once,
 *  at server setup, and handed to {@link hostAllowed} as `certNames`.
 *
 *  Why the gate trusts them: until the Host gate learned to read HTTP/2's
 *  `:authority` (v1.0.11), every h2 request — every browser on TLS — skipped
 *  it, so an exposed TLS app reached by its own name (`nas.local`,
 *  `myapp.example.com`) worked with no `allowedOrigins`. A name in the
 *  certificate is one the operator already declared as this app's name, and
 *  an attacker's rebinding domain cannot be in it (they would need our key or
 *  our CA to put it there). So those apps keep working, and a foreign name is
 *  still refused.
 *
 *  Lower-cased, trailing dot dropped. A certificate the reader cannot parse
 *  is said out loud, never read as "no names": the operator learns that their
 *  own name now needs `allowedOrigins`. Reuses THE SAN reader (`x509.ts`). */
export function certHostNames(certPem: string | undefined): string[] {
  if (!certPem) return [];
  try {
    return (certSubjectAltNames(certPem)?.dns ?? [])
      .map((d) => d.trim().toLowerCase().replace(/\.$/, ""))
      .filter((d) => d !== "");
  } catch (e) {
    log.warn(
      "auth",
      `could not read the DNS names in this app's TLS certificate ` +
        `(${
          e instanceof Error ? e.message : String(e)
        }) — the Host gate will ` +
        `not admit them by themselves. If this app is reached by a domain ` +
        `name, name it: aio.run({ allowedOrigins: ["<that name>"] }).`,
    );
    return [];
  }
}

/** Does a certificate DNS name cover `name`? Exact, or an RFC 6125 wildcard:
 *  `*.example.com` covers exactly ONE extra left-most label (`a.example.com`,
 *  never `example.com` nor `a.b.example.com`). A wildcard over a bare
 *  top-level label (`*.com`, `*`) covers nothing — no real CA issues one, and
 *  it would turn the gate off. */
export function certNameCovers(pattern: string, name: string): boolean {
  if (!pattern.startsWith("*.")) return pattern === name;
  const base = pattern.slice(2);
  if (!base.includes(".") || base.includes("*")) return false;
  const dot = name.indexOf(".");
  return dot > 0 && name.slice(dot + 1) === base;
}

/** May this server answer a request that says it was reached as `hostHeader`?
 *
 *  Allowed: no Host at all (a non-browser client — there is no name to rebind),
 *  any IP literal, `localhost` and `*.localhost`, the address this app is bound
 *  to, this machine's own hostname, any DNS name in the TLS certificate this
 *  app serves (`certNames`, see {@link certHostNames}), and anything the app
 *  listed in `allowedOrigins` (hostname, `host:port`, full origin, or `"*"`).
 *  Everything else is a foreign domain pointed at this server. */
export function hostAllowed(
  hostHeader: string | null,
  opts: {
    bindHost?: string;
    allowedOrigins?: string[];
    certNames?: readonly string[];
  },
): boolean {
  if (hostHeader === null || hostHeader.trim() === "") return true;
  const raw = hostHeader.trim().toLowerCase();
  const name = _hostnameOfHeader(hostHeader);
  if (name === "") return true;
  if (_isIpLiteral(name)) return true;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  const bind = opts.bindHost?.trim().toLowerCase();
  if (bind && bind !== "0.0.0.0" && bind !== "::" && bind === name) return true;
  if (name === _machineHostname()) return true;
  if (opts.certNames?.some((p) => certNameCovers(p, name))) return true;
  return allowlistAdmits(opts.allowedOrigins, {
    hostname: name,
    hostPort: raw,
  });
}

/** Entries of `allowedOrigins` that NO request can ever match.
 *
 *  The matcher below accepts four spellings — `"*"`, a bare hostname, a
 *  `host:port`, or a full origin — and anything else simply never compares
 *  equal to anything. So a typo'd entry is inert: the operator believes they
 *  widened access, the app refuses their client anyway, and the refusal points
 *  at "the same list the WebSocket origin check reads" — a list whose entry
 *  does nothing. Fail-closed, and silent, which is the half that costs an
 *  afternoon.
 *
 *  It lives HERE, beside `allowlistAdmits`, because a second copy of that
 *  grammar somewhere else is how the two would come to disagree — which is the
 *  drift that function's own header records between the Host and WS checks.
 *  Reported as a boot warning (`configConflicts`), never a refusal: an app
 *  with a stale junk entry boots today and must keep booting. */
export function inertAllowlistEntries(
  entries: readonly string[] | undefined,
): string[] {
  const HOSTISH =
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
  const out: string[] = [];
  for (const raw of entries ?? []) {
    const e = raw.trim().toLowerCase();
    if (e === "*") continue;
    if (e === "") {
      out.push(raw);
      continue;
    }
    if (e.includes("://")) {
      try {
        if (new URL(e).hostname !== "") continue;
      } catch {
        // aio-ok: an entry that does not parse as a URL IS the finding — it
        // is reported two lines down, which is the opposite of swallowed.
      }
      out.push(raw);
      continue;
    }
    if (!HOSTISH.test(e)) out.push(raw);
  }
  return out;
}

/** Does `allowedOrigins` admit this caller? THE reader of that config key.
 *
 *  One decider because the key has two consumers — the `Host` check above and
 *  the WebSocket `Origin` check (`server-ws.ts`) — and they had drifted. The
 *  WS side did exact `Array.includes()` on the raw entries, so an entry with a
 *  capital letter, a stray space, a `host:port` spelling, or a full origin
 *  matched over HTTP and not over the socket. The app loaded and then could
 *  not connect, which reads as a network fault rather than a config one — and
 *  the Host refusal tells operators this is "the same list the WebSocket
 *  origin check reads", which has to be true.
 *
 *  Every documented spelling, in one place: `"*"`, a bare hostname, a
 *  `host:port`, or a full origin.
 *
 *  @decider */
export function allowlistAdmits(
  entries: readonly string[] | undefined,
  what: { hostname: string; hostPort?: string; origin?: string },
): boolean {
  for (const entry of entries ?? []) {
    if (entry.trim() === "*") return true;
    const e = entry.trim().toLowerCase();
    if (e === "") continue;
    if (e === what.hostname) return true;
    if (what.hostPort && e === what.hostPort) return true;
    if (what.origin && e === what.origin.trim().toLowerCase()) return true;
    // A full origin entry is matched by what it MEANS, not by its text.
    //
    // Against an ORIGIN (the WebSocket and HTTP Origin checks) it means that
    // origin: scheme, host AND port, an omitted port being the scheme's
    // default (`new URL` elides it on both sides, so `https://x` and
    // `https://x:443` are one origin). It used to be compared by hostname
    // alone, so `https://dash.corp:8443` also admitted `http://dash.corp` and
    // every other port on that host — and a cookie ignores ports, so any other
    // service on that machine could open an authenticated socket as the
    // victim. A BARE hostname entry keeps its meaning: any port, any scheme.
    //
    // Against a Host header (the DNS-rebinding gate) there is no scheme to
    // compare, and the question is only "is this app served as that name", so
    // the hostname — or the exact host:port — answers it, as before.
    if (e.includes("://")) {
      try {
        const u = new URL(e);
        if (what.origin !== undefined) {
          const o = new URL(what.origin.trim());
          if (u.protocol === o.protocol && u.host === o.host) return true;
          continue;
        }
        if (u.hostname === what.hostname) return true;
        if (what.hostPort && u.host === what.hostPort) return true;
      } catch { /* not a URL — the literal compares above already ran */ }
    }
  }
  return false;
}

/** Why an `Origin` is NOT admitted, or null when it is. THE Origin decider.
 *
 *  Admitted: the server's own origin (same host as the `Host` header AND the
 *  scheme this server speaks — an https app is not same-origin with an http
 *  page of the same name), anything `allowedOrigins` admits, and `aio://app`
 *  — the privileged scheme only aio's own Electron shell registers, which no
 *  web page can put in an Origin header (its forced-protocol dev window
 *  proxies the app's page to this TCP listener; the packaged window reaches
 *  the app over its Unix socket, which never meets this check).
 *
 *  A SUBMITTED origin cannot certify itself: no loopback exemption. A port is
 *  not part of a "site", so `SameSite=Strict` sends the session cookie to
 *  every loopback port, and any other local dev server or tool UI would
 *  otherwise act as the victim.
 *
 *  `status` 400 is an Origin that does not even parse (`null` from a sandboxed
 *  frame or a cross-site redirect chain included); 403 is a foreign one. */
export function originVerdict(
  origin: string,
  opts: {
    hostHeader: string | null;
    secure: boolean;
    allowedOrigins?: readonly string[];
  },
): { status: 400 | 403; reason: string } | null {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return {
      status: 400,
      reason: `Origin "${origin}" is not an origin this server can admit ` +
        `(an opaque "null" origin comes from a sandboxed frame, a file: page ` +
        `or a cross-site redirect)`,
    };
  }
  if (u.protocol === "aio:" && u.host === "app") return null;
  if (
    allowlistAdmits(opts.allowedOrigins, {
      hostname: u.hostname,
      hostPort: u.host,
      origin,
    })
  ) return null;
  const scheme = opts.secure ? "https" : "http";
  const schemeOk = u.protocol === `${scheme}:`;
  const sameHost = opts.hostHeader !== null && u.host === opts.hostHeader;
  if (sameHost && schemeOk) return null;
  return {
    status: 403,
    reason: `Origin ${origin} is not this server's own origin (${scheme}://${
      opts.hostHeader ?? "no Host header"
    })${
      sameHost
        ? ` — the host matches but the SCHEME does not; this server speaks ${scheme}`
        : ""
    } and is not listed in allowedOrigins`,
  };
}

/** Methods that change nothing by HTTP's own contract — never Origin-gated. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Origins already reported (attacker-chosen, so bounded like `_hostWarned`). */
const _originWarned = new Set<string>();

/** Refuse a STATE-CHANGING request that a browser sent from another origin,
 *  where that request could borrow authority. `null` when the caller may
 *  proceed.
 *
 *  The WebSocket upgrade has always checked `Origin`; plain HTTP never did. So
 *  an app ROUTE took a cross-origin POST — a form or a `text/plain` fetch,
 *  which need no CORS preflight — from any page the user visited: anonymously
 *  on an open loopback app, and AS the signed-in user on an `auth: true` or
 *  shared-key app, whose cookie the browser attaches (SameSite does not stop a
 *  sibling loopback port, which is the same site).
 *
 *  Refused only where the cross-site request GRANTS something:
 *   (a) it carries a Cookie. aio's cookies are SameSite=Strict, so a cookie on
 *       a foreign-Origin request is a same-site sibling (another localhost
 *       port) or an app cookie with SameSite=None — the CSRF cases exactly;
 *   (b) its authority is NETWORK POSITION: the app is not exposed (nothing but
 *       this machine reaches it, so a page in this machine's browser is the
 *       only way in), or the peer is this machine (no proxy relayed it) and
 *       the app has no auth at all.
 *  Everything else passes as before — above all an EXPOSED app's route
 *  receiving a cookieless cross-site form POST (a payment return URL, a SAML
 *  or OIDC `form_post`): a public endpoint, and the page gains nothing `curl`
 *  could not do. A header credential (`Authorization`) is not ambient, and a
 *  page cannot attach one cross-site without a preflight aio never grants.
 *
 *  Only a PRESENT Origin is judged. A request with none is not a browser
 *  acting for someone else's page — a webhook sender, `curl`, `am`, the aio
 *  client's pairing call — so it passes exactly as before. A Unix-socket peer
 *  is same-machine and same-user by construction (the same exemption the Host
 *  gate makes). */
export function crossOriginRefusal(
  req: Request,
  addr: Deno.Addr | undefined,
  opts: {
    secure: boolean;
    allowedOrigins?: readonly string[];
    /** `expose` is on — the app is meant to be reached over the network. */
    exposed: boolean;
    /** A shared key or per-user auth is configured. */
    authConfigured: boolean;
    /** The peer is this machine and no proxy relayed it (`_isLocalRequest`). */
    peerLocal: boolean;
  },
): Response | null {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null;
  if (addr?.transport === "unix") return null;
  const origin = req.headers.get("origin");
  if (origin === null) return null;
  const ambientCookie = (req.headers.get("cookie") ?? "").trim() !== "";
  const byPosition = !opts.exposed || (opts.peerLocal && !opts.authConfigured);
  if (!ambientCookie && !byPosition) return null;
  const verdict = originVerdict(origin, {
    hostHeader: requestHost(req),
    secure: opts.secure,
    allowedOrigins: opts.allowedOrigins,
  });
  if (!verdict) return null;
  const path = (() => {
    try {
      return new URL(req.url).pathname;
    } catch {
      return "?";
    }
  })();
  const hint =
    (verdict.status === 400
      ? `An opaque origin cannot be allowlisted — send the request from a page ` +
        `this app served, or from a page on an origin named in allowedOrigins.`
      : `If that page is meant to call this app, name it once: ` +
        `aio.run({ allowedOrigins: ["${origin}"] }).`) +
    ` Requests that carry no Origin (webhooks, curl, native clients) are not ` +
    `affected.`;
  if (!_originWarned.has(origin) && _originWarned.size < HOST_WARN_MAX) {
    _originWarned.add(origin);
    log.warn(
      "auth",
      `refused a cross-origin ${req.method} ${path} — ${verdict.reason}. A ` +
        `page on another origin must not change this app's state ${
          ambientCookie
            ? "with the visitor's cookie"
            : "on the strength of where the request comes from (this machine)"
        } (CSRF). ${hint} Said once per Origin.`,
    );
  }
  return new Response(
    `Forbidden — ${verdict.reason}.\n\nA ${req.method} from another origin ` +
      `is refused: a page elsewhere must not drive this app ${
        ambientCookie
          ? "with the visitor's cookie"
          : "from inside this machine's network position"
      }.\n\n${hint}`,
    { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}

/** Hosts already reported, so a rebinding attempt cannot flood the log. Bounded:
 *  the set is the attacker's input, and an unbounded one is a memory leak they
 *  control. */
const _hostWarned = new Set<string>();
const HOST_WARN_MAX = 32;

/** The refusal, naming the Host we got, what this app answers to, and the one
 *  config key that widens it. `null` when the caller may proceed. */
export function hostRefusal(
  req: Request,
  addr: Deno.Addr | undefined,
  opts: {
    bindHost?: string;
    allowedOrigins?: string[];
    certNames?: readonly string[];
  },
): Response | null {
  // A Unix socket / named pipe carries no meaningful authority in `Host` (the
  // URL is synthesised as `http://app<target>`), and it is same-machine,
  // same-user by construction — there is no DNS to rebind.
  if (addr?.transport === "unix") return null;
  const hostHeader = requestHost(req);
  if (hostAllowed(hostHeader, opts)) return null;
  _reportHostRefusal(hostHeader);
  const bind = opts.bindHost && opts.bindHost !== "0.0.0.0" &&
      opts.bindHost !== "::"
    ? `, ${opts.bindHost}`
    : "";
  return new Response(
    `Forbidden — Host "${hostHeader}" is not a name this app is served as.\n\n` +
      `This app answers to localhost, to any IP address it is bound on${bind}` +
      `${
        opts.certNames?.length ? ", to the names in its TLS certificate" : ""
      }, and to whatever is listed in allowedOrigins. A request whose Host is ` +
      `some other domain is the shape of a DNS-rebinding attack: a page on ` +
      `that domain would become same-origin with this app and could read raw ` +
      `state and dispatch actions with no credential.\n\n` +
      `Fix: if this app really is reached as "${hostHeader}" (a reverse proxy, ` +
      `a custom domain), name it — aio.run({ allowedOrigins: ["${
        _hostnameOfHeader(hostHeader ?? "")
      }"] }) — which is the same list the WebSocket origin check reads.`,
    { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}

/** Say it on the SERVER too, once per Host.
 *
 *  The refusal reaches whoever made the request; the person who has to act on
 *  it is the operator, and they were reading a log that said nothing. A
 *  reverse-proxied deployment therefore failed as "users report Forbidden,
 *  nothing in the log" — the shape that turns a one-line config fix into an
 *  afternoon. Once per Host, and bounded, because the value is attacker-chosen. */
function _reportHostRefusal(hostHeader: string | null): void {
  const name = _hostnameOfHeader(hostHeader ?? "");
  if (name === "" || _hostWarned.has(name)) return;
  if (_hostWarned.size >= HOST_WARN_MAX) return;
  _hostWarned.add(name);
  log.warn(
    "auth",
    `refused a request whose Host is "${name}" — this app is not served as ` +
      `that name, and a page on it would otherwise become same-origin with ` +
      `this app (DNS rebinding). If this app really IS reached as "${name}" ` +
      `— a reverse proxy, a custom domain — name it once: ` +
      `aio.run({ allowedOrigins: ["${name}"] }). Said once per Host.`,
  );
}

/** Test seam: forget which Hosts have been reported. Production never wants it —
 *  forgetting is exactly what would make this log floodable. */
// aio-ok: a test-only reset for once-per-process state; forgetting in production is what would make this log floodable.
export function _resetHostWarnings(): void {
  _hostWarned.clear();
  _originWarned.clear();
}

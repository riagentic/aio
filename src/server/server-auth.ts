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
  const bearer = bearerToken(req);
  if (bearer) return { token: bearer, fromUrl: false, source: "header" };
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
  if (_authFails.size >= AUTH_FAIL_MAX_KEYS && !_authFails.has(key)) {
    _sweepExpired(now);
    // Map iteration is insertion-ordered, so the front IS the oldest. Drop
    // back to 90% rather than exactly one, so a saturated map does not pay an
    // eviction on every single request.
    const target = Math.floor(AUTH_FAIL_MAX_KEYS * 0.9);
    for (const k of _authFails.keys()) {
      if (_authFails.size <= target) break;
      _authFails.delete(k);
    }
  }
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
  log.warn(
    `[aio] auth: failed auth from ${key} (${detail}) — ${fails.length}/${AUTH_FAIL_MAX} in window`,
  );
}

/** Test isolation. */
export function _resetAuthFails(): void {
  _authFails.clear();
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

/** May this server answer a request that says it was reached as `hostHeader`?
 *
 *  Allowed: no Host at all (a non-browser client — there is no name to rebind),
 *  any IP literal, `localhost` and `*.localhost`, the address this app is bound
 *  to, this machine's own hostname, and anything the app listed in
 *  `allowedOrigins` (hostname, `host:port`, full origin, or `"*"`).
 *  Everything else is a foreign domain pointed at this server. */
export function hostAllowed(
  hostHeader: string | null,
  opts: { bindHost?: string; allowedOrigins?: string[] },
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
  return allowlistAdmits(opts.allowedOrigins, {
    hostname: name,
    hostPort: raw,
  });
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
 *  `host:port`, or a full origin. */
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
    // A full origin entry is matched by what it MEANS, not by its text: an
    // `https://app.example.com` entry admits that host whether the request
    // carried a port or not.
    if (e.includes("://")) {
      try {
        const u = new URL(e);
        if (u.hostname === what.hostname) return true;
        if (what.hostPort && u.host === what.hostPort) return true;
      } catch { /* not a URL — the literal compares above already ran */ }
    }
  }
  return false;
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
  opts: { bindHost?: string; allowedOrigins?: string[] },
): Response | null {
  // A Unix socket / named pipe carries no meaningful authority in `Host` (the
  // URL is synthesised as `http://app<target>`), and it is same-machine,
  // same-user by construction — there is no DNS to rebind.
  if (addr?.transport === "unix") return null;
  const hostHeader = req.headers.get("host");
  if (hostAllowed(hostHeader, opts)) return null;
  _reportHostRefusal(hostHeader);
  const bind = opts.bindHost && opts.bindHost !== "0.0.0.0" &&
      opts.bindHost !== "::"
    ? `, ${opts.bindHost}`
    : "";
  return new Response(
    `Forbidden — Host "${hostHeader}" is not a name this app is served as.\n\n` +
      `This app answers to localhost, to any IP address it is bound on${bind}` +
      `, and to whatever is listed in allowedOrigins. A request whose Host is ` +
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
}

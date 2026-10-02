// auth-context.ts — ONE ambient context for everything server-side: WHO is
// calling (`serverUser`), WHERE FROM (`serverRequest`), and the running app's
// own user store (`serverAuth`, at the bottom of this file).
// The server resolves a connection's user once (server-auth.ts); dispatch and
// serverFn invocation run inside `runWithUser`, so `serverUser()` answers
// "who is calling?" anywhere downstream — cell methods, serverFns, effects —
// without threading a parameter through every signature. `serverRequest()` is
// the same trick for the transport facts a caller can't spoof: client IP,
// request headers, cookies.
//
// serverRequest() is deliberately READ-ONLY. Writing to the response (cookies
// out, status, headers) is HTTP, and `route()` already owns that — a second
// write path through the ambient would be two models for one job.
//
// AsyncLocalStorage survives `await`, so async methods/fns keep their caller.
//
// This module is SERVER-ONLY and reaches NO client bundle. `aio` never
// resolves to mod.ts in a bundle: it is aliased to src/browser-air.ts
// (browser/electron) or src/standalone-air.ts (android/standalone) —
// bundleFrameworkEntries() — and both import these names as TYPES ONLY and
// export facades of their own that THROW when called, naming the runtime the
// call landed on.
//
// The note that used to stand here said the opposite: that node:async_hooks is
// stubbed for the browser bundle and "the guards below make
// serverUser()/serverRequest() a harmless `undefined` there". Both halves were
// untrue — nothing of this file is in a client bundle at all (the metafile
// check in tests/android-server-only-stubs.test.ts) — and the second half was
// the dangerous one: a client reading `serverUser()` as `undefined` is an
// authorization check that passed because there was nobody to check. A
// server-only name in a client fails loud; it never answers "anonymous".
//
// The `_als`/`_reqAls` guards below are therefore only about a host whose
// `node:async_hooks` exposes no AsyncLocalStorage; on Deno it always does.

import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import type { AioUser } from "./aio-types.ts";
import type { UserStore } from "./auth-users.ts";
import { parseCookies } from "./route.ts";
import { _installCallerScope } from "../state/method-policy.ts";

const NO_KEY = new Error("no key");

/** One value of a user record as key text. Throws {@linkcode NO_KEY} for a
 *  value with no faithful key.
 *
 *  NOT `JSON.stringify` plus a replacer, which is what stood here: JSON has
 *  one spelling for several values, and every tag a replacer can emit is
 *  itself a value some other record may hold —
 *
 *    `{x: undefined}`  and  `{x: {__aioUndefined: true}}`   one key
 *    `{d: new Date(0)}`  and  `{d: "1970-01-01T00:00:00.000Z"}`   one key
 *    `{d: new Date(NaN)}`  and  `{d: null}`   one key
 *    a class whose `toJSON` leaves `role` out, as admin and as viewer   one key
 *
 *  — and a record holding a `bigint` (an ORM row's `int8` id) had no key at
 *  all. Here every STRING is quoted, so the bare tokens (`u`, `12n`, `D0`,
 *  `NaN`, `N{`) are spellings no field value can produce: two records share a
 *  key only when a view cannot tell them apart. */
function keyPart(v: unknown, stack: Set<object>): string {
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "number":
      return Object.is(v, -0) ? "-0" : String(v);
    case "boolean":
      return String(v);
    case "undefined":
      return "u";
    case "bigint":
      return `${v}n`;
    case "object":
      break;
    default:
      throw NO_KEY; // function, symbol: nothing to compare two of by
  }
  if (v === null) return "null";
  // A cycle has no finite key (a value reached twice WITHOUT one is fine, so
  // this is a stack). A Proxy answers reads its own keys do not announce.
  if (stack.has(v) || types.isProxy(v)) throw NO_KEY;
  const proto = Object.getPrototypeOf(v);
  const own = Reflect.ownKeys(v);
  // The ONE object keyed by its own conversion. A `toJSON` on anything else
  // is that class's choice of what to PRINT, not a statement of everything a
  // view can read off it.
  if (proto === Date.prototype && own.length === 0) {
    return `D${Date.prototype.getTime.call(v)}`;
  }
  stack.add(v);
  try {
    if (Array.isArray(v)) {
      // Exactly its indices and `length`: a hole, a named property or a
      // symbol on an array is a different array with the same elements. The
      // count alone does not say so — one hole plus one named property has as
      // many own keys as a dense array — hence every index is checked too.
      if (proto !== Array.prototype || own.length !== v.length + 1) {
        throw NO_KEY;
      }
      const items: string[] = [];
      for (let i = 0; i < v.length; i++) {
        if (!Object.hasOwn(v, i)) throw NO_KEY;
        items.push(keyPart(v[i], stack));
      }
      return `[${items.join(",")}]`;
    }
    // Set, Map, RegExp, a typed array, a class instance: none is described by
    // its own properties (private state, prototype getters).
    if (proto !== Object.prototype && proto !== null) throw NO_KEY;
    if (own.some((k) => typeof k !== "string")) throw NO_KEY;
    const parts: string[] = [];
    // Non-enumerable ones too — a view reads `user.role` however it was
    // defined. Sorted, so two structurally-equal users share a slot.
    for (const k of (own as string[]).sort()) {
      parts.push(
        `${JSON.stringify(k)}:${
          keyPart((v as Record<string, unknown>)[k], stack)
        }`,
      );
    }
    return `${proto === null ? "N" : ""}{${parts.join(",")}}`;
  } finally {
    stack.delete(v);
  }
}

/** Cache key for a user — a STABLE serialization of everything `ui.forUser`
 *  can observe, not just the id.
 *
 *  Keying on `user.id` alone was a cross-user leak: `resolveUser` may return
 *  `{id:"alice", role:"admin"}` for one token and `{id:"alice", role:"viewer"}`
 *  for another (impersonation, a role switch, a re-issued session, two devices
 *  with different scopes). `forUser` receives the WHOLE user object, so two
 *  users that differ anywhere are two different views — and the admin's view
 *  was being served to the viewer whenever no dispatch happened in between.
 *  The `""` bucket was worse still: every user-less caller (UDS, trojan,
 *  anonymous WS) shared one slot with any user whose id was empty.
 *
 *  Object keys are sorted so two structurally-equal users still share a slot,
 *  and the key is recomputed per call so an IN-PLACE mutation of a
 *  connection's user object (a role change on a live socket) invalidates it.
 *
 *  Cost: one pass over a user record (a handful of small fields) per
 *  client per broadcast, against a `forUser` call that structuredClones and
 *  rewrites the whole cell slice — two to three orders of magnitude apart on
 *  any state worth memoizing. The memo keeps its purpose; it just can no
 *  longer answer a question it was not asked.
 *
 *  The keyed domain is plain data: primitives (`bigint` and `undefined`
 *  included), arrays, plain objects and `Date` — see {@linkcode keyPart}.
 *  Returns null for anything else (a `Map`, `Set`, class instance, function,
 *  Proxy, cycle, a getter that throws) — the caller then SKIPS the cache
 *  entirely and recomputes. A cache miss costs time; a wrong cache hit costs
 *  someone else's data. */
export function userMemoKey(user?: AioUser): string | null {
  // "no user" is its OWN bucket, and cannot be spelled by any serialized user:
  // a string user is quoted, and `keyPart` has no such bare token.
  if (user === undefined || user === null) return "no-user";
  // The walk reads the user's own values, so a getter that throws must land
  // on "no key", not escape into the broadcast.
  try {
    return keyPart(user, new Set());
  } catch {
    return null; // aio-ok: unkeyable → no caching, ever
  }
}

const _als = typeof AsyncLocalStorage === "function"
  ? new AsyncLocalStorage<AioUser | undefined>()
  : null;

/** Framework-internal: run `fn` with `user` as the ambient caller identity.
 *  Wraps network dispatch + serverFn invocation; server-origin work (effects
 *  of server dispatches, schedules) runs outside → serverUser() = undefined. */
export const runWithUser = <T>(user: AioUser | undefined, fn: () => T): T =>
  _als ? _als.run(user, fn) : fn();

/** The `ttl`/`"first"` calls running here, innermost first: a read of a
 *  caller fact marks every one of them, since an outer call's result may be
 *  built from an inner one's. */
type ReadScope = { reads: Set<string>; up: ReadScope | undefined };
const _readAls = typeof AsyncLocalStorage === "function"
  ? new AsyncLocalStorage<ReadScope>()
  : null;

/** Record that the running `ttl`/`"first"` calls read caller fact `fact`. */
function noteRead(fact: string): void {
  for (let r = _readAls?.getStore(); r; r = r.up) r.reads.add(fact);
}

/** The authenticated caller of the current server-side execution — usable in
 *  cell methods, serverFns, and effects. `undefined` = anonymous client
 *  (public/shared-key mode) or server-origin execution. */
export const serverUser = (): AioUser | undefined => {
  noteRead("user");
  return _als?.getStore();
};

/** The transport facts of the call in flight — what a caller can't forge.
 *  Read-only by design: to SET a cookie/status/header, use `route()`. */
export interface ServerRequest {
  /** Remote IP as the server sees it, when the transport exposes one. */
  readonly ip?: string;
  /** Request headers. For a WS call these are the upgrade request's headers —
   *  the connection's, not the individual frame's. */
  readonly headers: Headers;
  /** Cookies parsed from those headers. */
  readonly cookies: Readonly<Record<string, string>>;
  /** Full request URL. */
  readonly url: string;
  /** HTTP method (`"GET"` for a WS upgrade). */
  readonly method: string;
  /** How the call arrived: an HTTP route, or a frame on a live socket. */
  readonly via: "http" | "ws";
}

const _reqAls = typeof AsyncLocalStorage === "function"
  ? new AsyncLocalStorage<ServerRequest | undefined>()
  : null;

/** Framework-internal: snapshot a `Request` into the ambient shape. Headers are
 *  copied so a later mutation of the original can't rewrite history. */
export function makeServerRequest(
  req: Request,
  ip: string | undefined,
  via: "http" | "ws",
): ServerRequest {
  const headers = new Headers(req.headers);
  return {
    ip,
    headers,
    cookies: Object.freeze(parseCookies(headers.get("cookie"))),
    url: req.url,
    method: req.method,
    via,
  };
}

/** Framework-internal: run `fn` with `req` as the ambient request context.
 *  Wraps HTTP route handlers, WS action dispatch, and serverFn invocation. */
export const runWithRequest = <T>(
  req: ServerRequest | undefined,
  fn: () => T,
): T => _reqAls ? _reqAls.run(req, fn) : fn();

/** The request behind the current server-side execution — client IP, headers
 *  and cookies — usable in cell methods, serverFns, and effects. `undefined`
 *  when nothing requested this: schedules, boot, server-origin dispatches.
 *
 *  ```ts
 *  methods: {
 *    async login(s, id: string, pw: string) {
 *      const ip = serverRequest()?.ip ?? "unknown"; // rate-limit key
 *      if (tooManyFrom(ip)) throw new Error("slow_down");
 *    },
 *  }
 *  ``` */
export const serverRequest = (): ServerRequest | undefined => {
  const req = _reqAls?.getStore();
  return req && tracked(req);
};

/** The ambient request WITHOUT recording a read — for the framework's own
 *  plumbing (forwarding it to a worker), which is not the method reading it.
 *  @internal */
export const _ambientRequest = (): ServerRequest | undefined =>
  _reqAls?.getStore();

// `ttl`/`"first"` answer per CALLER when the run read something of the
// caller: a shared answer from a run that read `serverUser()` or a cookie is
// another caller's data. Keyed on exactly the facts the run read, each by its
// value: the WHOLE user (`userMemoKey`), not its id — one id may carry a
// different role or tenant per token; a header or cookie by its value, so a
// method reading the `session` cookie is shared by that session's requests
// and no other's, and one reading `accept-language` by every caller of that
// language. Keying on the whole request instead would make every call miss
// (a request id, a timestamp, a changing `referer`), and on the user alone
// would still hand Alice's cookie-derived answer to an anonymous Bob. A miss
// costs a run; a wrong hit costs that caller's data.
_installCallerScope({
  snapshot: () => {
    const user = _als?.getStore();
    const req = _reqAls?.getStore();
    return (fact) => factKey(fact, user, req);
  },
  track: (reads, fn) => _trackReads(reads, fn),
  capture: () => {
    const als = _readAls;
    const at = als?.getStore();
    return als && at ? (<T>(fn: () => T): T => als.run(at, fn)) : undefined;
  },
});

/** Run `fn` recording every caller fact it reads into `reads` (and into the
 *  running calls around it). @internal also the worker host's root scope. */
export const _trackReads = <T>(reads: Set<string>, fn: () => T): T =>
  _readAls ? _readAls.run({ reads, up: _readAls.getStore() }, fn) : fn();

/** The running `ttl`/`"first"` calls, to hand facts read ELSEWHERE to — a
 *  worker cell's method runs in another isolate, where no scope of the
 *  caller's reaches. Undefined when none is running. @internal */
export function _readsSink():
  | ((facts: readonly string[]) => void)
  | undefined {
  const at = _readAls?.getStore();
  if (!at) return undefined;
  return (facts) => {
    for (let r: ReadScope | undefined = at; r; r = r.up) {
      for (const f of facts) r.reads.add(f);
    }
  };
}

/** One caller fact's value as a key. A user key is `userMemoKey`'s; every
 *  other value is JSON, so "none" — no request at all — is its own. */
function factKey(
  fact: string,
  user: AioUser | undefined,
  req: ServerRequest | undefined,
): string | null {
  if (fact === "user") return userMemoKey(user);
  if (!req) return "none";
  try {
    const name = fact.slice(2);
    switch (fact.slice(0, 2)) {
      case "h:":
        return JSON.stringify(
          name === "*" ? [...req.headers] : req.headers.get(name),
        );
      case "c:":
        return JSON.stringify(
          name === "*"
            ? Object.entries(req.cookies).sort(([a], [b]) => a < b ? -1 : 1)
            : Object.hasOwn(req.cookies, name)
            ? req.cookies[name]
            : null,
        );
    }
    const v = req[fact as "ip" | "url" | "method" | "via"];
    return JSON.stringify(v ?? null);
  } catch {
    return null; // aio-ok: an unkeyable fact means "share nothing"
  }
}

/** The request as a method sees it: every field read is recorded, per header
 *  and per cookie by name, and a whole-set read (iterating, spreading) as
 *  `*`. One view per request, so `serverRequest() === serverRequest()`. */
const _views = new WeakMap<ServerRequest, ServerRequest>();
function tracked(req: ServerRequest): ServerRequest {
  let view = _views.get(req);
  if (view) return view;
  const headers = new Proxy(req.headers, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        noteRead(
          (p === "get" || p === "has") && typeof a[0] === "string"
            ? `h:${a[0].toLowerCase()}`
            : p === "getSetCookie"
            ? "h:set-cookie"
            : "h:*",
        );
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    },
  });
  const cookies = new Proxy(req.cookies, {
    get(t, p) {
      if (typeof p === "string") noteRead(`c:${p}`);
      return Reflect.get(t, p);
    },
    has(t, p) {
      if (typeof p === "string") noteRead(`c:${p}`);
      return Reflect.has(t, p);
    },
    ownKeys(t) {
      noteRead("c:*");
      return Reflect.ownKeys(t);
    },
    getOwnPropertyDescriptor(t, p) {
      if (typeof p === "string") noteRead(`c:${p}`);
      return Reflect.getOwnPropertyDescriptor(t, p);
    },
  });
  const field = <K extends "ip" | "url" | "method" | "via">(k: K) => ({
    enumerable: true,
    get: () => {
      noteRead(k);
      return req[k];
    },
  });
  view = Object.defineProperties({} as ServerRequest, {
    ip: field("ip"),
    url: field("url"),
    method: field("method"),
    via: field("via"),
    headers: { enumerable: true, value: headers },
    cookies: { enumerable: true, value: cookies },
  });
  _views.set(req, view);
  return view;
}

// ── serverAuth(): the running app's user store, ambient ─────────────────────
// `app.auth` was reachable only from `onStart(app)`, so every app with an
// admin screen carried the same snippet: a mutable module-global set at boot,
// read per call, with a "not ready" throw for a race that cannot happen (a
// field report — the one impure module-scoped mutable in an otherwise pure
// codebase). Registered at boot, released on shutdown.
const _authStores: UserStore[] = [];

/** Framework-internal: announce a booted app's user store. Returns the
 *  disposer the shutdown path calls. */
export function _registerAuthStore(store: UserStore): () => void {
  _authStores.push(store);
  return () => {
    const i = _authStores.indexOf(store);
    if (i >= 0) _authStores.splice(i, 1);
  };
}

/** The running app's user store — list/create/remove accounts, set roles —
 *  usable in cell methods, serverFns and effects, like `serverUser()` /
 *  `serverRequest()`. Throws (never a silent null) when this app runs
 *  without per-user auth, or when several authed apps share one process —
 *  there `app.auth` (from `aio.run()` / `onStart`) is the unambiguous
 *  handle. */
export function serverAuth(): UserStore {
  const first = _authStores[0];
  if (first === undefined) {
    throw new Error(
      "[aio] serverAuth(): no user store — this app runs without per-user " +
        "auth (`auth: true` / `users:` / `resolveUser`), or it has not booted yet",
    );
  }
  if (_authStores.length > 1) {
    throw new Error(
      "[aio] serverAuth(): ambiguous — several authed apps share this " +
        "process; use `app.auth` from `aio.run()`/`onStart(app)` instead",
    );
  }
  return first;
}

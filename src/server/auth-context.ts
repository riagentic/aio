// auth-context.ts — ONE ambient caller context for everything server-side:
// WHO is calling (`serverUser`) and WHERE FROM (`serverRequest`).
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
// In the browser bundle node:async_hooks is stubbed (esbuild-plugin) — the
// guards below make serverUser()/serverRequest() a harmless `undefined` there.

import { AsyncLocalStorage } from "node:async_hooks";
import type { AioUser } from "./aio-types.ts";
import { parseCookies } from "./route.ts";

const _als = typeof AsyncLocalStorage === "function"
  ? new AsyncLocalStorage<AioUser | undefined>()
  : null;

/** Framework-internal: run `fn` with `user` as the ambient caller identity.
 *  Wraps network dispatch + serverFn invocation; server-origin work (effects
 *  of server dispatches, schedules) runs outside → serverUser() = undefined. */
export const runWithUser = <T>(user: AioUser | undefined, fn: () => T): T =>
  _als ? _als.run(user, fn) : fn();

/** The authenticated caller of the current server-side execution — usable in
 *  cell methods, serverFns, and effects. `undefined` = anonymous client
 *  (public/shared-key mode) or server-origin execution. */
export const serverUser = (): AioUser | undefined => _als?.getStore();

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
export const serverRequest = (): ServerRequest | undefined =>
  _reqAls?.getStore();

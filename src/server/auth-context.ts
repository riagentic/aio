// auth-context.ts — ONE ambient caller identity for everything server-side.
// The server resolves a connection's user once (server-auth.ts); dispatch and
// serverFn invocation run inside `runWithUser`, so `serverUser()` answers
// "who is calling?" anywhere downstream — cell methods, serverFns, effects —
// without threading a parameter through every signature.
//
// AsyncLocalStorage survives `await`, so async methods/fns keep their caller.
// In the browser bundle node:async_hooks is stubbed (esbuild-plugin) — the
// guards below make serverUser() a harmless `undefined` there.

import { AsyncLocalStorage } from "node:async_hooks";
import type { AioUser } from "./aio-types.ts";

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

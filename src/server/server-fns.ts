// server-fns.ts — the explicit server/client seam (perfect-aio D3/B3).
//
// Define real server functions in a *.server.ts file:
//
//   export const api = serverFns("api", {
//     chargeCard: async (amount: number) => await stripe.charge(amount),
//   });
//
// Use them ANYWHERE (cell methods, components) via the typed resolver:
//
//   import type { api } from "./api.server.ts";   // type-only — erased
//   const fns = serverFn<typeof api>("api");
//   const r = await fns.chargeCard(s.total);       // explicit server hop
//
// On the server, serverFn() resolves the registered real functions; in the
// browser it resolves a WS proxy (cid-correlated request/response, 30s
// fail-loud timeout). The hop is VISIBLE in code — the one seam.

import { cellAccessAllowed } from "./server-auth.ts";
import type { AioUser } from "./aio-types.ts";
import type { Access } from "../state/cell-types.ts";
import { serializeReturn } from "../protocol/return-value.ts";
import { log } from "../diagnostics/logger-api.ts";
import { _diagScopeNow } from "../diagnostics/diagnostic-bus.ts";
import type { AioErrorCode } from "../diagnostics/error.ts";
import type { Remote } from "../protocol/protocol-types.ts";

// deno-lint-ignore no-explicit-any
type FnMap = Record<string, (...args: any[]) => any>;

const _registry = new Map<string, FnMap>();
const _access = new Map<string, Access>();
/** The app each namespace was registered AS (`_diagScopeNow()` — the scope
 *  every `aio.run()` runs in). One process can host several apps, and the
 *  registry is one map: app B — open, no auth — served a namespace app A had
 *  registered behind its user auth, to an anonymous client of B's. A
 *  namespace registered inside an app is served over the network by that app
 *  only; one registered outside any app (a module's top level) has no app to
 *  belong to and is served by every app, as before.
 *
 *  Ownership PASSES ON when the owner closes (`_serverFnsAppLive`): the
 *  module that registered it is cached, so the next app to import it — a
 *  restart, the next `testServer()` in a file — never registers it again. A
 *  closed owner kept refusing it forever ("not registered"), and held its
 *  scope alive. But it passes only to an app that BOOTS AFTER the close (the
 *  first one, which adopts it): an app already live beside the owner never
 *  takes it over — else A's `vault`, behind A's auth, was served anonymously
 *  by an open sibling B the moment A closed. */
const _owner = new Map<string, object>();
/** Namespaces whose owner closed, waiting for the next app to boot → the
 *  closed owner's app id. Strings only — a closed app's scope is never held. */
const _orphaned = new Map<string, string>();
/** Each live app's id, by its scope — to name it in a refusal. */
const _appIdOf = new WeakMap<object, string>();
/** Refusals already warned — once per namespace and app. */
const _refusedWarned = new WeakMap<object, Set<string>>();

/** Whether the app serving this call may serve `ns` — its own, or unowned.
 *  A caller outside any app cannot be placed, and is answered as before. */
function servedHere(ns: string): boolean {
  const owner = _owner.get(ns);
  if (owner === undefined && !_orphaned.has(ns)) return true;
  const here = _diagScopeNow();
  if (here === undefined || here === owner) return true;
  // Refused — said on THIS side (never to the caller, see `callServerFn`).
  const seen = _refusedWarned.get(here) ?? new Set<string>();
  _refusedWarned.set(here, seen);
  if (!seen.has(ns)) {
    seen.add(ns);
    log.warn(
      "sfn",
      `serverFns(${JSON.stringify(ns)}) is not served by app ` +
        `${JSON.stringify(_appIdOf.get(here) ?? "?")}: ` +
        (owner === undefined
          ? `the app that registered it has closed, and it passes only to ` +
            `an app booted AFTER that close — this one was already running. `
          : `another app in this process registered it (${
            JSON.stringify(_appIdOf.get(owner) ?? "?")
          }). `) +
        `Its clients get "not registered". To serve it here, register it ` +
        `outside any app (a module's top level — every app serves it) or ` +
        `from this app's own onStart.`,
    );
  }
  return false;
}

// ── Shared namespaces are said out loud ─────────────────────────────────────
//
// A namespace registered outside any app — `export const api = serverFns(…)`
// at a module's top level, the documented pattern — cannot be placed, so every
// app in the process serves it. In a one-app process that is exactly right.
// With a second app it means app B (open, no auth) answers app A's `vault`:
// the silent kind of wrong. So once two apps are live, each such namespace is
// named ONCE, with the apps serving it and the two ways to make it one app's.

/** The apps serving in this process, in boot order. */
const _liveApps: string[] = [];
/** Namespaces already announced — once each, for the process's life. */
const _announced = new Set<string>();

function announceShared(ns: string): void {
  if (
    _owner.has(ns) || _orphaned.has(ns) || _announced.has(ns) ||
    _liveApps.length < 2
  ) return;
  _announced.add(ns);
  const apps = _liveApps.map((a) => JSON.stringify(a)).join(", ");
  log.warn(
    "sfn",
    `serverFns(${JSON.stringify(ns)}) was registered outside any app, so ` +
      `EVERY app in this process serves it over the wire — now ${apps}. ` +
      `A client of one app reaches functions another app may keep behind its ` +
      `auth. Register it inside the app that owns it (from onStart, or a ` +
      `module imported there — then only that app serves it), or gate it ` +
      `with an access: rule (access rules fail closed).`,
  );
}

/** An app starts serving (its boot — called in its scope). Adopts the
 *  namespaces a closed owner left (see `_owner`), announces the shared ones
 *  once a second app is live, and returns the "it stopped" call, which hands
 *  what the app owned on to the NEXT app to boot. @internal */
export function _serverFnsAppLive(appId: string): () => void {
  const scope = _diagScopeNow();
  _liveApps.push(appId);
  if (scope !== undefined) {
    _appIdOf.set(scope, appId);
    for (const [ns, prev] of _orphaned) {
      _owner.set(ns, scope);
      // A restart of the owner is the point of the hand-off; any OTHER app
      // taking it over now serves functions it never registered — say so.
      if (prev !== appId) {
        log.warn(
          "sfn",
          `serverFns(${JSON.stringify(ns)}) was registered by app ` +
            `${JSON.stringify(prev)}, which closed; ${JSON.stringify(appId)} ` +
            `booted next and now serves it over the wire (its module was ` +
            `already loaded, so no app can register it again). If ` +
            `${JSON.stringify(appId)} must not expose it, gate it with an ` +
            `access: rule (access rules fail closed).`,
        );
      }
    }
    _orphaned.clear();
  }
  for (const ns of _registry.keys()) announceShared(ns);
  let gone = false;
  return () => {
    if (gone) return;
    gone = true;
    const i = _liveApps.indexOf(appId);
    if (i >= 0) _liveApps.splice(i, 1);
    if (scope === undefined) return;
    for (const [ns, owner] of [..._owner]) {
      if (owner !== scope) continue;
      _owner.delete(ns);
      _orphaned.set(ns, appId); // the next app to BOOT adopts it; no live one does
    }
  };
}

/** Register a namespace of server functions (call in a *.server.ts file —
 *  the browser bundle must never contain the bodies). Returns the map for
 *  direct server-side use. Duplicate namespaces fail loudly.
 *  `opts.access` (an `Access` rule — true / role / predicate) gates network
 *  calls; inside a fn, `serverUser()` (from "aio") answers who is calling. */
export function serverFns<T extends FnMap>(
  ns: string,
  fns: T,
  opts?: { access?: Access },
): T {
  if (_registry.has(ns)) {
    throw new Error(
      `serverFns("${ns}") already registered — namespaces are unique per ` +
        `process. Pick a different name or register once and share the ref.`,
    );
  }
  _registry.set(ns, fns);
  const owner = _diagScopeNow();
  if (owner !== undefined) _owner.set(ns, owner);
  if (opts?.access !== undefined) _access.set(ns, opts.access);
  announceShared(ns);
  return fns;
}

/** Evaluate a namespace's access rule for a network caller. The predicate form
 *  also receives the invoked `fn` name and its `args`, so a namespace can do
 *  per-function or row-level authz; existing `(user)` predicates
 *  ignore the extra params, so this is backwards-compatible. */
export function serverFnAllowed(
  ns: string,
  user?: AioUser,
  fn = "",
  args: unknown[] = [],
): boolean {
  const rule = _access.get(ns);
  if (rule === undefined) return true; // no rule — connection auth only
  // The RULE itself is evaluated by the one decider `cellAccessAllowed`. This
  // spelled the same four branches for itself, which made it a second reader
  // of a vocabulary the docs call unified — and it inherited the same
  // fail-OPEN: a predicate returning a promise (or anything else truthy that
  // is not a boolean) granted access to a whole serverFn namespace. Only the
  // "no rule at all" case above is specific to serverFns.
  return cellAccessAllowed(rule, user, fn, args);
}

/** Resolve a namespace to its typed callable map. Server-side impl: returns
 *  the REAL functions (lazy proxy, so import order never matters); the
 *  browser build swaps in the WS proxy with the same signature. */
export function serverFn<T extends FnMap>(ns: string): Remote<T> {
  return new Proxy({} as Remote<T>, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      // NOT a thenable. The trap returns a callable for ANY string prop, so
      // `await getApi()` (a normal shape — resolving the proxy inside an async
      // function, or during boot) invoked `then(resolve, reject)`, which
      // returned a rejected promise and called NEITHER callback: the await
      // never settled AND an unhandled rejection was raised naming a
      // namespace that is registered perfectly well. Boot-time rejections are
      // fatal, so the hang came with a crash and a misleading message.
      if (prop === "then" || prop === "catch" || prop === "finally") {
        return undefined;
      }
      return (...args: unknown[]) => {
        const fns = _registry.get(ns);
        // Own-property only — never resolve inherited Object.prototype members
        // (constructor, valueOf, hasOwnProperty…) as if they were registered fns.
        if (
          !fns || !Object.hasOwn(fns, prop) || typeof fns[prop] !== "function"
        ) {
          return Promise.reject(
            new Error(
              `serverFn("${ns}").${prop} — namespace or function not ` +
                `registered. Did the *.server.ts module with serverFns("${ns}", …) ` +
                `get imported by the server entry?`,
            ),
          );
        }
        try {
          return Promise.resolve(fns[prop]!(...args));
        } catch (e) {
          return Promise.reject(e);
        }
      };
    },
  });
}

/** Server WS route: run a client-requested fn, reply with the outcome.
 *  Errors carry the server's message — fail loud on the client, never hang.
 *  `user` is the connection's resolved identity — checked against the
 *  namespace's access rule; the caller wraps this in runWithUser so
 *  serverUser() works inside the fn body. */
export async function invokeServerFn(
  ns: string,
  name: string,
  args: unknown[],
  user?: AioUser,
): Promise<
  { ok: true; value: unknown } | {
    ok: false;
    error: string;
    /** {@linkcode AioErrorCode} when this failure has a classification — it
     *  is spread straight into the `sfnr` frame, so the caller reads it with
     *  `errorCode(err)`. Absent when the fn's own body threw: that error is
     *  the APP's, and inventing a code for it would be a guess. */
    code?: string;
  }
> {
  // Another app's namespace is answered exactly like one that does not
  // exist: this app has no such function, and saying more would tell an
  // anonymous caller what a sibling app keeps behind its auth.
  if (!servedHere(ns)) return notRegistered(ns, name);
  if (!serverFnAllowed(ns, user, name, args)) {
    log.warn(
      `[aio] auth: serverFn "${ns}.${name}" denied for ${
        user ? `user=${user.id} role=${user.role}` : "anonymous client"
      }`,
    );
    // A DENIAL is not an app error. Without the code the caller had to match
    // the wording "— access denied" to tell "sign in" from "your code threw",
    // and the semver policy explicitly does not freeze wording.
    return {
      ok: false,
      error: `serverFn "${ns}.${name}" — access denied`,
      code: "ACCESS_DENIED" satisfies AioErrorCode,
    };
  }
  const fns = _registry.get(ns);
  // Own-property only — a client-supplied `name` must not reach inherited
  // Object.prototype builtins (constructor, valueOf, …); those are not
  // registered server functions and must fail loud like any unknown name.
  const fn = fns && Object.hasOwn(fns, name) ? fns[name] : undefined;
  if (typeof fn !== "function") return notRegistered(ns, name);
  let value: unknown;
  try {
    value = await fn(...args);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  // THE RESULT MUST BE WIRE-SAFE *HERE*, not at the two send sites.
  //
  // Both callers do `socket.send(enc("sfnr", { cid, ...result }))` inside a
  // `try { … } catch { /* client disconnected */ }`. `enc` THROWS on a BigInt
  // or a circular structure — so a serverFn returning one sent nothing at all,
  // the throw was swallowed as a disconnect, and the caller sat for 30s before
  // rejecting with "server unreachable or the function hung": the wrong
  // diagnosis for a value the server could have named. Everything else JSON
  // silently rewrote (Date → string, Map → {}, NaN/undefined → null) with no
  // warning, while the identical value returned from a CELL METHOD warned
  // loudly — the same fact, guarded on one path and not the other.
  //
  // serializeReturn is that one guard. Vetting inside invokeServerFn covers
  // every transport (WS + UDS) at their single shared entry; a DIRECT
  // server-side call never comes through here, so in-process fidelity is
  // untouched.
  //
  // `dropped` REJECTS rather than resolving undefined (the ack path's choice):
  // an RPC's product is its return value, so handing back `undefined` as if it
  // were the answer is the silent corruption this guard exists to remove. The
  // message states plainly that the function did run.
  const { value: safe, dropped } = serializeReturn(value, `${ns}.${name}`);
  if (dropped) {
    const error = `serverFn "${ns}.${name}" returned a value JSON cannot ` +
      `carry (BigInt, a circular structure, or a bare function), so it ` +
      `cannot cross the wire. The function DID run — only its result was ` +
      `undeliverable. Return JSON-safe data (plain objects/arrays/primitives).`;
    log.warn("sfn", error);
    return { ok: false, error };
  }
  return { ok: true, value: safe };
}

function notRegistered(ns: string, name: string): {
  ok: false;
  error: string;
} {
  return {
    ok: false,
    error:
      `serverFn "${ns}.${name}" is not registered on the server (check the *.server.ts module is imported by the entry)`,
  };
}

/** Test isolation. */
export function _resetServerFns(): void {
  _registry.clear();
  _access.clear();
  _owner.clear();
  _orphaned.clear();
  _announced.clear();
}

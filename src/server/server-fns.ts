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

import type { AioUser } from "./aio-types.ts";
import type { Access } from "../state/cell-types.ts";
import { serializeReturn } from "../protocol/return-value.ts";
import { log } from "../diagnostics/logger.ts";

// deno-lint-ignore no-explicit-any
type FnMap = Record<string, (...args: any[]) => any>;

/** @deprecated alpha52 — unified as {@linkcode Access} (one network-access
 *  vocabulary for cells and serverFns: true / role-string / predicate).
 *  Alias through beta. Direct server-side calls (via serverFn()/the returned
 *  map) never pass through this gate — the server trusts its own code. */
export type ServerFnAccess = Access;

const _registry = new Map<string, FnMap>();
const _access = new Map<string, Access>();

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
  if (opts?.access !== undefined) _access.set(ns, opts.access);
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
  if (rule === true) return user !== undefined;
  if (typeof rule === "string") return user?.role === rule;
  if (typeof rule === "function") return rule(user, fn, ...args);
  return false; // rule === false: namespace is server-side only
}

/** Resolve a namespace to its typed callable map. Server-side impl: returns
 *  the REAL functions (lazy proxy, so import order never matters); the
 *  browser build swaps in the WS proxy with the same signature. */
export function serverFn<T extends FnMap>(ns: string): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
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
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  if (!serverFnAllowed(ns, user, name, args)) {
    console.warn(
      `[aio] auth: serverFn "${ns}.${name}" denied for ${
        user ? `user=${user.id} role=${user.role}` : "anonymous client"
      }`,
    );
    return {
      ok: false,
      error: `serverFn "${ns}.${name}" — access denied`,
    };
  }
  const fns = _registry.get(ns);
  // Own-property only — a client-supplied `name` must not reach inherited
  // Object.prototype builtins (constructor, valueOf, …); those are not
  // registered server functions and must fail loud like any unknown name.
  const fn = fns && Object.hasOwn(fns, name) ? fns[name] : undefined;
  if (typeof fn !== "function") {
    return {
      ok: false,
      error:
        `serverFn "${ns}.${name}" is not registered on the server (check the *.server.ts module is imported by the entry)`,
    };
  }
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

/** Test isolation. */
export function _resetServerFns(): void {
  _registry.clear();
  _access.clear();
}

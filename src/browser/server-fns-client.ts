// server-fns-client.ts — browser side of the serverFns seam (perfect-aio B3).
// `serverFn<T>(ns)` returns a typed proxy that calls the server over the live
// transport: an "sfn" envelope out, an "sfnr" envelope back (B4b v2).
// Fail-loud: server errors reject with the server's message; 30s timeout.

import { enc, type SfnrPayload } from "../protocol/envelope.ts";
import { serializeArgs } from "../protocol/wire-value.ts";

const SFN_TIMEOUT_MS = 30_000;

const _pending = new Map<string, {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

let _send: ((raw: string) => void) | null = null;
let _cid = 0;

/** Wire the transport's raw send (called by browser-air-transport at boot). */
export function _registerSfnTransport(send: (raw: string) => void): void {
  _send = send;
}

/** Route a decoded "sfnr" payload. Returns true when consumed. */
export function handleSfnResult(data: unknown): boolean {
  const r = data as SfnrPayload | undefined;
  if (!r || typeof r.cid !== "string") return false;
  const p = _pending.get(r.cid);
  if (!p) return true; // late/duplicate — already settled
  _pending.delete(r.cid);
  clearTimeout(p.timer);
  if (r.ok) p.resolve(r.value);
  else p.reject(new Error(`[server] ${r.error ?? "serverFn failed"}`));
  return true;
}

// deno-lint-ignore no-explicit-any
type FnMap = Record<string, (...args: any[]) => any>;

/** Typed access to a serverFns namespace — the explicit server hop.
 *  `const api = serverFn<typeof apiDef>("api"); await api.chargeCard(9)` */
export function serverFn<T extends FnMap>(ns: string): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          if (!_send) {
            return reject(
              new Error(
                `serverFn("${ns}").${prop} — no transport yet (call after the app connected)`,
              ),
            );
          }
          // ARGUMENTS ARE VETTED BEFORE ANYTHING IS REGISTERED.
          //
          // They cross the same JSON wire as the result and had no guard at
          // all: a Date arrived as a string, a Map as `{}`, NaN/undefined as
          // null — silently, and only on the network path, so the same call
          // behaved differently server-side. A BigInt was worse: `enc` threw
          // from inside the executor AFTER the pending entry and its 30s timer
          // were registered, so the call rejected with a bare
          // "Do not know how to serialize a BigInt" (naming no function) and
          // leaked the timer. Vet first: name the call, send nothing, register
          // nothing.
          const what = `serverFn("${ns}").${prop}`;
          const { args: safeArgs, dropped } = serializeArgs(args, what);
          if (dropped) {
            return reject(
              new Error(
                `${what} was called with an argument JSON cannot carry ` +
                  `(BigInt or a circular structure) — nothing was sent. Pass ` +
                  `JSON-safe data across the wire.`,
              ),
            );
          }
          const cid = `sfn-${++_cid}-${Date.now()}`;
          const timer = setTimeout(() => {
            _pending.delete(cid);
            reject(
              new Error(
                `serverFn("${ns}").${prop} timed out after ${
                  SFN_TIMEOUT_MS / 1000
                }s — server unreachable or the function hung`,
              ),
            );
          }, SFN_TIMEOUT_MS);
          _pending.set(cid, { resolve, reject, timer });
          _send(enc("sfn", { cid, ns, name: prop, args: safeArgs }));
        });
    },
  });
}

/** Browser build must never HOST server functions — defining them here is
 *  the server-only-code-in-browser seam violation, caught loudly. */
export function serverFns(ns: string, _fns: FnMap): never {
  throw new Error(
    `serverFns("${ns}") called in the BROWSER — server function bodies ` +
      `belong in a *.server.ts module imported by the server entry. In the ` +
      `browser, resolve the typed proxy with serverFn<typeof def>("${ns}").`,
  );
}

/** Test isolation. */
export function _resetSfnClient(): void {
  for (const p of _pending.values()) clearTimeout(p.timer);
  _pending.clear();
  _send = null;
  _cid = 0;
}

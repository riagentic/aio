// server-fns-client.ts — browser side of the serverFns seam (perfect-aio B3).
// `serverFn<T>(ns)` returns a typed proxy that calls the server over the live
// transport: an "sfn" envelope out, an "sfnr" envelope back (B4b v2).
// Fail-loud: server errors reject with the server's message; 30s timeout.

import { enc, type SfnrPayload, wireError } from "../protocol/envelope.ts";
import { serializeArgs } from "../protocol/wire-value.ts";
import type { Remote } from "../protocol/protocol-types.ts";
import { getConnectedSignal } from "../state-core.ts";

const SFN_TIMEOUT_MS = 30_000;

const _pending = new Map<string, {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  what: string;
}>();

// Returns whether the frame actually LEFT. `_sendRaw` has answered that
// question since it stopped swallowing a refused write, and this module threw
// the answer away: a dropped `sfn` frame then waited the full 30 s to be told
// "the server never replied (the function may still be running)" — a wrong
// diagnosis, in the module whose own comment says OFFLINE IS AN ANSWER, NOT A
// WAIT.
let _send: ((raw: string) => boolean) | null = null;
let _cid = 0;

/** Settle every in-flight call as failed. A serverFn call is NOT queued —
 *  `_send` writes it straight to the socket or drops it — so once the
 *  connection is gone the request is definitively lost and its caller can be
 *  told immediately.
 *
 *  Without this, a disconnect (or a teardown, or a protocol mismatch — all of
 *  which close the socket) left the caller waiting out the full 30s and then
 *  blamed the wrong thing: "server unreachable or the function hung", for a
 *  call the client itself had already given up on. */
function _failAll(reason: string): number {
  if (_pending.size === 0) return 0;
  const entries = [..._pending.entries()];
  _pending.clear();
  for (const [, p] of entries) {
    clearTimeout(p.timer);
    p.reject(new Error(`${p.what} — ${reason}`));
  }
  return entries.length;
}

/** True when the transport reports a live connection. */
function _connected(): boolean {
  return getConnectedSignal().peek() === true;
}

let _watchingConnection = false;
/** One subscription, installed with the transport: the connection dropping is
 *  the event that kills every in-flight call. */
function _watchConnection(): void {
  if (_watchingConnection) return;
  _watchingConnection = true;
  const sig = getConnectedSignal();
  sig.subscribe(() => {
    if (sig.peek() !== true) {
      _failAll("the connection to the server was lost before it replied");
    }
  });
}

/** Wire the transport's raw send (called by browser-air-transport at boot). */
export function _registerSfnTransport(
  send: (raw: string) => boolean,
): void {
  _send = send;
  _watchConnection();
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
  else {
    // `[server] ` says WHERE it failed, which a bare message cannot — but it
    // is the only prefix now (the send side stopped stringifying with
    // `String(e)`, which prepended a second "Error: " that the client then
    // wrapped into a third). The classification travels beside the text, not
    // inside it: `wireError` puts the server's `code` on the rejection.
    const e = wireError(r, "serverFn failed");
    e.message = `[server] ${e.message}`;
    p.reject(e);
  }
  return true;
}

// deno-lint-ignore no-explicit-any
type FnMap = Record<string, (...args: any[]) => any>;

/** Typed access to a serverFns namespace — the explicit server hop.
 *  `const api = serverFn<typeof apiDef>("api"); await api.chargeCard(9)` */
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
          // OFFLINE IS AN ANSWER, NOT A WAIT. There is no offline queue for
          // serverFn calls: the transport's raw send drops the frame when the
          // socket is not open, so a call made while disconnected used to sit
          // silently for 30s and then report "server unreachable". Say it now,
          // and say which call it was.
          if (!_connected()) {
            return reject(
              new Error(
                `${what} — not connected to the server, so nothing was sent ` +
                  `(serverFn calls are never queued). Wait for the connection ` +
                  `(useAio().ready / client.subscribe) before calling.`,
              ),
            );
          }
          const cid = `sfn-${++_cid}-${Date.now()}`;
          const timer = setTimeout(() => {
            _pending.delete(cid);
            reject(
              new Error(
                `${what} timed out after ${
                  SFN_TIMEOUT_MS / 1000
                }s — the server never replied (the function may still be running)`,
              ),
            );
          }, SFN_TIMEOUT_MS);
          _pending.set(cid, { resolve, reject, timer, what });
          if (!_send(enc("sfn", { cid, ns, name: prop, args: safeArgs }))) {
            _pending.delete(cid);
            clearTimeout(timer);
            reject(
              new Error(
                `${what} was never sent — the transport refused the write. ` +
                  `The call did not reach the server, so nothing is running: ` +
                  `retry once the connection is back (useAio().ready).`,
              ),
            );
          }
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
  // Settle rather than abandon: a cleared entry whose promise is never settled
  // is the same hang this module exists to prevent.
  _failAll("the client was reset");
  _send = null;
  _cid = 0;
}

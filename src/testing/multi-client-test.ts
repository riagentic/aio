/**
 * @module
 * `testMultiClient()` — aio's central claim, made testable.
 *
 * The promise that sells the framework is that an Electron window, a browser tab
 * and `am` all read the same state with no transport code written by you. A real
 * app shipped two of those clients and reported: *"I have never tested two of
 * them at once, because there is nothing to test them with… so the claim I lean
 * on hardest is the one my 281-test suite says nothing about."* A framework that cannot let you verify its own headline is missing
 * something more important than a convenience.
 *
 * This mounts N INDEPENDENT clients over one server: a real `aio.run()`, real
 * WebSocket connections, real broadcast. Nothing is simulated, because a harness
 * that faked the transport would be worse than none — it would report success
 * for the one thing it was built to check.
 *
 * ```ts
 * await using m = await testMultiClient({ cells: [counter] }, 2);
 * await m.clients[0].dispatch(counter.increment.action(1));
 * await m.converged();                       // every client saw it
 * assertEquals(m.clients[1].state("counter").count, 1);
 *
 * // The case you cannot reason about from the outside:
 * await m.dispatchAll(counter.increment.action(1));   // same action, same tick
 * await m.converged();
 * assertEquals(m.serverState("counter").count, 3);    // no lost update
 * ```
 */

import { dec } from "../protocol/envelope.ts";
import { connectCli } from "../server/cli-client.ts";
import type { CliApp } from "../server/cli-client.ts";
import type { CellsConfig } from "../server/aio-types.ts";
import { _armTestStrict } from "./test-strict.ts";
import { testServer } from "./server-test.ts";

/** One connected surface. */
export interface TestClient {
  /** 0-based index, matching `clients[]` and `am`'s client indices. */
  readonly index: number;
  /** This client's view of a cell's slice — what IT received, not the server's. */
  state<T = Record<string, unknown>>(cell: string): T;
  /** Whole state as this client sees it. */
  fullState(): Record<string, unknown>;
  /** Dispatch over this client's socket, resolving when the server acks. */
  dispatch(action: { type: string; payload?: unknown }): Promise<void>;
  /** Every patch this client RECEIVED over its socket, in arrival order — the
   *  immer-style `{ op, path, value }` objects the server broadcast, exactly as
   *  a browser tab would apply them. State is the sum; this is the stream, so
   *  "the field was filtered out of the delta" or "the whole state was resent"
   *  (an entry with `op: "replace"` and an empty `path`) is assertable. */
  readonly patches: readonly Patch[];
  /** Observe patches as they arrive; returns an unsubscribe. */
  onPatch(cb: (batch: readonly Patch[]) => void): () => void;
  /** Resolve with the first patch (already received or still to come) that
   *  satisfies `pred`; rejects after `timeoutMs` (default 2000) naming the
   *  patches that DID arrive. */
  waitForPatch(
    pred: (p: Patch) => boolean,
    opts?: { timeoutMs?: number },
  ): Promise<Patch>;
  /** Underlying connection, for anything this surface doesn't cover. */
  readonly cli: CliApp<Record<string, unknown>>;
}

/** One received patch — immer's shape on the wire. A full-state resend is
 *  recorded as a single `replace` at the empty path. */
export type Patch = {
  op: "add" | "replace" | "remove";
  path: (string | number)[];
  value?: unknown;
};

// ── Patch capture ─────────────────────────────────────────────────────────
// `connectCli` owns its WebSocket and exposes state, not frames. The frames
// are what a browser tab sees, so the harness listens on the SAME socket: the
// global `WebSocket` is wrapped for the harness's lifetime, and every socket
// created while a client is being connected is attributed to that client (a
// reconnect goes to the client whose previous socket closed). Refcounted so
// two harnesses in one process share one wrapper and restore the original
// once the last one closes.
type Sink = { push(batch: Patch[]): void; socket: WebSocket | null };
const _sinks = new Set<Sink>();
let _constructing: Sink | null = null;
let _wrapDepth = 0;
let _origWebSocket: typeof WebSocket | null = null;

function _installSocketCapture(): void {
  if (_wrapDepth++ > 0) return;
  const Orig = globalThis.WebSocket;
  _origWebSocket = Orig;
  const Wrapped = function (
    this: unknown,
    url: string | URL,
    protocols?: string | string[],
  ) {
    const ws = new Orig(url, protocols);
    const owner = _constructing ??
      [..._sinks].find((s) =>
        s.socket === null || s.socket.readyState === WebSocket.CLOSED
      ) ?? null;
    if (owner) {
      owner.socket = ws;
      ws.addEventListener("message", (e: MessageEvent) => {
        if (typeof e.data !== "string") return;
        const frame = dec(e.data);
        if (!frame) return;
        if (frame.t === "patches" && Array.isArray(frame.d)) {
          owner.push(frame.d as Patch[]);
        } else if (frame.t === "state") {
          owner.push([{ op: "replace", path: [], value: frame.d }]);
        }
      });
    }
    return ws;
  } as unknown as typeof WebSocket;
  Wrapped.prototype = Orig.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
    Object.defineProperty(Wrapped, k, { value: Orig[k] });
  }
  globalThis.WebSocket = Wrapped;
}

function _uninstallSocketCapture(): void {
  if (--_wrapDepth > 0) return;
  if (_origWebSocket) globalThis.WebSocket = _origWebSocket;
  _origWebSocket = null;
}

/** Handle for a multi-client test: several independent clients on one app, so
 *  broadcast, per-user filtering and convergence can be asserted for real. */
export interface TestMultiClient {
  clients: TestClient[];
  /** Server-authoritative state — the truth every client should converge on. */
  serverState<T = Record<string, unknown>>(cell?: string): T;
  /** Wait until every client's state deep-equals the server's.
   *  Throws naming the first divergent client and cell, so a failure says which
   *  surface fell behind rather than "timeout". */
  converged(opts?: { timeoutMs?: number }): Promise<void>;
  /** Dispatch the SAME action from every client at once — the concurrency case
   *  an app author cannot reason about from the outside. */
  dispatchAll(action: { type: string; payload?: unknown }): Promise<void>;
  url: string;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long the server must be quiet (and how long since the last send) before
 *  convergence is believed. Local WebSocket round trips are single-digit ms; the
 *  margin is for a loaded machine, and `converged({ settleMs })` raises it. */
const DEFAULT_SETTLE_MS = 80;

/** Stable JSON for comparing two views of the same state. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0
        ),
      );
    }
    return val;
  });
}

/**
 * Boot one app and connect `count` independent clients to it.
 *
 * `config` is a normal `aio.run()` config (it goes through `testServer`, so a
 * free port and a throwaway data dir are handled). Clients are real WS peers:
 * they receive the same broadcasts a browser would, in the same order.
 */
export async function testMultiClient(
  config: CellsConfig,
  count = 2,
): Promise<TestMultiClient> {
  _armTestStrict(); // tests are the strictest environment, never the most permissive
  if (count < 1) throw new Error("testMultiClient: count must be >= 1");
  const srv = await testServer(config);
  const clients: TestClient[] = [];
  const conns: CliApp<Record<string, unknown>>[] = [];
  // When the most recent action left a socket — `converged()` refuses to answer
  // before the server has had a chance to see it.
  let lastSendAt = 0;
  // How long to keep watching for a change before concluding the action was a
  // NO-OP. An action that legitimately changes nothing (a guard returned early,
  // or the only changed cell is `ui.exclude`d from this client's view) produces
  // no patch ever, so the watch loops used to burn their entire 2s deadline —
  // silently, once per call. Over a loopback socket a real dispatch lands
  // in single-digit milliseconds, so this grace is ~50× the expected latency
  // while cutting the no-op cost by an order of magnitude. The 2s deadline
  // stays as the ceiling for a genuinely slow round trip.
  const NOOP_GRACE_MS = 250;

  const sinks: Sink[] = [];
  _installSocketCapture();
  try {
    for (let i = 0; i < count; i++) {
      const patches: Patch[] = [];
      const patchListeners = new Set<(b: readonly Patch[]) => void>();
      const sink: Sink = {
        socket: null,
        push: (batch) => {
          patches.push(...batch);
          for (const fn of patchListeners) fn(batch);
        },
      };
      _sinks.add(sink);
      sinks.push(sink);
      _constructing = sink;
      let cli: CliApp<Record<string, unknown>>;
      try {
        cli = connectCli<Record<string, unknown>>(srv.url);
      } finally {
        _constructing = null;
      }
      if (sink.socket === null) {
        throw new Error(
          "testMultiClient: the client's WebSocket was not observed — patch " +
            "capture wraps globalThis.WebSocket during connectCli(), which " +
            "must construct its socket synchronously",
        );
      }
      await cli.ready; // first full state — the client is a real peer now
      // Observe EVERY send, including raw `client.cli.send(...)`. `converged()`
      // must not answer in the window between an action leaving a socket and the
      // server seeing it — and it can only know about sends it was told about.
      const rawSend = cli.send.bind(cli);
      (cli as { send: (a: { type: string; payload?: unknown }) => void }).send =
        (action) => {
          lastSendAt = Date.now();
          rawSend(action);
        };
      conns.push(cli);
      const waitForPatch = (
        pred: (p: Patch) => boolean,
        opts?: { timeoutMs?: number },
      ): Promise<Patch> => {
        const hit = patches.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise<Patch>((resolve, reject) => {
          const timer = setTimeout(() => {
            off();
            reject(
              new Error(
                `testMultiClient: client ${i} received no matching patch within ${
                  opts?.timeoutMs ?? 2000
                }ms.\n  received: ${
                  JSON.stringify(patches).slice(0, 600) || "(none)"
                }`,
              ),
            );
          }, opts?.timeoutMs ?? 2000);
          const off = onPatch((batch) => {
            const p = batch.find(pred);
            if (!p) return;
            clearTimeout(timer);
            off();
            resolve(p);
          });
        });
      };
      const onPatch = (cb: (b: readonly Patch[]) => void) => {
        patchListeners.add(cb);
        return () => {
          patchListeners.delete(cb);
        };
      };
      clients.push({
        index: i,
        cli,
        patches,
        onPatch,
        waitForPatch,
        state: <T>(cell: string) =>
          ((cli.state ?? {}) as Record<string, unknown>)[cell] as T,
        fullState: () => (cli.state ?? {}) as Record<string, unknown>,
        dispatch: async (action) => {
          // Wait for the WORK, not for a fixed delay. `send` is
          // fire-and-forget, so a naive sleep either flakes on a slow round
          // trip or wastes time on a fast one — and, worse, `converged()`
          // would then pass TRIVIALLY, comparing two states that are equal
          // only because the action hasn't reached the server yet.
          const before = canon(cli.state ?? {});
          lastSendAt = Date.now();
          cli.send(action);
          const startedAt = Date.now();
          const deadline = startedAt + 2000;
          while (Date.now() < deadline) {
            if (canon(cli.state ?? {}) !== before) return; // the patch came back
            // Nothing after the grace period ⇒ this action changes nothing
            // visible to this client. Return instead of waiting out the
            // deadline; `converged()` still enforces the quiet period.
            if (Date.now() - startedAt > NOOP_GRACE_MS) break;
            await sleep(5);
          }
        },
      });
    }
  } catch (e) {
    for (const c of conns) c.close();
    for (const s of sinks) _sinks.delete(s);
    _uninstallSocketCapture();
    await srv.close();
    throw e;
  }

  const serverState = <T>(cell?: string): T => {
    const s = srv.app.getState() as Record<string, unknown>;
    return (cell === undefined ? s : s[cell]) as T;
  };

  const converged = async (
    opts?: { timeoutMs?: number; settleMs?: number },
  ): Promise<void> => {
    const settleMs = opts?.settleMs ?? DEFAULT_SETTLE_MS;
    const deadline = Date.now() + (opts?.timeoutMs ?? 3000);
    let lastDiff = "";
    // "Everyone agrees" is not the same as "the work landed and everyone
    // agrees". Right after a send, every client still matches the server —
    // because the action is still in flight — and a naive comparison would
    // report success at exactly the moment it knows least.
    //
    // There is no exact external signal for "the server has seen it" (acks are
    // internal to the connection), so the harness requires a quiet period: no
    // answer before `settleMs` has passed since the last send, AND the server's
    // own state must then hold still for `settleMs`. Raise it via `settleMs` on
    // a loaded CI box; the 3s deadline still bounds the whole thing.
    let serverSeen = canon(srv.app.getState());
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const nowServer = canon(srv.app.getState());
      if (nowServer !== serverSeen) {
        serverSeen = nowServer;
        stableSince = Date.now();
      }
      const settled = Date.now() - lastSendAt >= settleMs &&
        Date.now() - stableSince >= settleMs;
      if (!settled) {
        await sleep(5);
        continue;
      }
      const server = srv.app.getState() as Record<string, unknown>;
      let allMatch = true;
      for (const c of clients) {
        const mine = c.fullState();
        // A client legitimately holds a SUBSET (ui.exclude, per-user filtering),
        // so compare the cells it actually has rather than the whole object.
        for (const cell of Object.keys(mine)) {
          if (canon(mine[cell]) !== canon(server[cell])) {
            allMatch = false;
            lastDiff = `client ${c.index}, cell "${cell}":\n` +
              `  client: ${canon(mine[cell]).slice(0, 300)}\n` +
              `  server: ${canon(server[cell]).slice(0, 300)}`;
            break;
          }
        }
        if (!allMatch) break;
      }
      if (allMatch) return;
      await sleep(10);
    }
    throw new Error(
      `testMultiClient: clients did not converge on the server's state.\n${
        lastDiff || "  (no client received any state)"
      }`,
    );
  };

  const dispatchAll = async (action: { type: string; payload?: unknown }) => {
    // Fire from every socket before awaiting any of them: the point is to put
    // N copies of the same action in flight simultaneously.
    const before = canon(srv.app.getState());
    lastSendAt = Date.now();
    for (const c of clients) c.cli.send(action);
    // Then wait for the SERVER to finish absorbing them — changed, and then
    // quiet. A fixed sleep here is what made this look like a lost update at
    // 20ms and correct at 60ms: the harness, not the framework.
    const startedAt = Date.now();
    const deadline = startedAt + 2000;
    let changedAt = 0;
    let lastSeen = before;
    while (Date.now() < deadline) {
      const now = canon(srv.app.getState());
      if (now !== before) {
        if (changedAt === 0 || now !== lastSeen) changedAt = Date.now();
        lastSeen = now;
        // Quiet for 40ms after the last observed change ⇒ all N have landed.
        if (Date.now() - changedAt > 40) return;
      } else if (Date.now() - startedAt > NOOP_GRACE_MS) {
        return; // no server-visible change: a no-op action, not a slow one
      }
      await sleep(5);
    }
  };

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const c of conns) c.close();
    for (const s of sinks) _sinks.delete(s);
    _uninstallSocketCapture();
    await sleep(5); // let the sockets unwind before the server goes down
    await srv.close();
  };

  return {
    clients,
    serverState,
    converged,
    dispatchAll,
    url: srv.url,
    close,
    [Symbol.asyncDispose]: close,
  };
}

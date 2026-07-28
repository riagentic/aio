/**
 * @module
 * `testMultiClient()` — aio's central claim, made testable.
 *
 * The promise that sells the framework is that an Electron window, a browser tab
 * and `am` all read the same state with no transport code written by you. A real
 * app shipped two of those clients and reported: *"I have never tested two of
 * them at once, because there is nothing to test them with… so the claim I lean
 * on hardest is the one my 281-test suite says nothing about."* (llama-master
 * #16.) A framework that cannot let you verify its own headline is missing
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

import { connectCli } from "../server/cli-client.ts";
import type { CliApp } from "../server/cli-client.ts";
import type { CellsConfig } from "../server/aio-types.ts";
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
  /** Underlying connection, for anything this surface doesn't cover. */
  readonly cli: CliApp<Record<string, unknown>>;
}

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
  if (count < 1) throw new Error("testMultiClient: count must be >= 1");
  const srv = await testServer(config);
  const clients: TestClient[] = [];
  const conns: CliApp<Record<string, unknown>>[] = [];
  // When the most recent action left a socket — `converged()` refuses to answer
  // before the server has had a chance to see it.
  let lastSendAt = 0;

  try {
    for (let i = 0; i < count; i++) {
      const cli = connectCli<Record<string, unknown>>(srv.url);
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
      clients.push({
        index: i,
        cli,
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
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            if (canon(cli.state ?? {}) !== before) return; // the patch came back
            await sleep(5);
          }
          // An action that legitimately changes nothing (a guard returned
          // early) never produces a patch. Fall through — `converged()` still
          // enforces the quiet period.
        },
      });
    }
  } catch (e) {
    for (const c of conns) c.close();
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
    const deadline = Date.now() + 2000;
    let changedAt = 0;
    let lastSeen = before;
    while (Date.now() < deadline) {
      const now = canon(srv.app.getState());
      if (now !== before) {
        if (changedAt === 0 || now !== lastSeen) changedAt = Date.now();
        lastSeen = now;
        // Quiet for 40ms after the last observed change ⇒ all N have landed.
        if (Date.now() - changedAt > 40) return;
      }
      await sleep(5);
    }
  };

  const close = async () => {
    for (const c of conns) c.close();
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

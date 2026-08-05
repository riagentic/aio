// Bound remote cells — connectCli().bind(cell) replaces raw wire actions:
// `await counter.increment(1)` dispatches over the socket (resolving on the
// server's per-action ack) and `counter.count` reads live server state.
import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { connectCli } from "../src/server/cli-client.ts";
import type { CellDef } from "../src/state/cell-types.ts";

// Coverage profiles from spawned deno processes go to a throwaway temp dir —
// never into the repo (an empty DENO_COVERAGE_DIR means "cwd"), never into
// the parent's coverage profile.
const _childCovDir = Deno.env.get("DENO_COVERAGE_DIR") ??
  Deno.makeTempDirSync({ prefix: "aio-child-cov-" });

function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

async function waitFor<T>(
  fn: () => T | null,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== null && v !== undefined) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timeout");
}

Deno.test({
  name: "connectCli.bind: cell methods + state work over the socket",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const port = freePort();
    const proc = new Deno.Command(Deno.execPath(), {
      env: { DENO_COVERAGE_DIR: _childCovDir },
      args: [
        "run",
        "-A",
        "--unstable-kv",
        "app.ts",
        "--client=server-only",
        `--port=${port}`,
      ],
      cwd: new URL("../examples/counter", import.meta.url).pathname,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();

    // The client's own cell definition — in a real remote-cli app this is
    // the shared cell.ts import; methods/state shape must match the server.
    const counter = cell("counter", {
      state: { count: 0 },
      methods: {
        increment(s, by = 1) {
          s.count += by;
        },
        reset(s) {
          s.count = 0;
        },
      },
    });

    const cli = connectCli<{ counter: { count: number } }>(
      `http://localhost:${port}`,
    );
    try {
      await waitFor(() => cli.connected ? true : null);
      await cli.ready;
      cli.bind(counter as unknown as CellDef);

      await counter.reset(); //        ← bound method, resolves on server ack
      await waitFor(() => cli.state?.counter.count === 0 ? true : null);
      assertEquals(counter.count, 0); // ← bound state getter reads live state

      await counter.increment(5);
      await waitFor(() => cli.state?.counter.count === 5 ? true : null);
      assertEquals(counter.count, 5);
    } finally {
      cli.close();
      try {
        proc.kill();
      } catch { /* exited */ }
      await proc.status;
    }
  },
});

Deno.test({
  name:
    "connectCli.bind: a call made while offline waits for the queue, then settles on close",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const port = freePort();
    const proc = new Deno.Command(Deno.execPath(), {
      env: { DENO_COVERAGE_DIR: _childCovDir },
      args: [
        "run",
        "-A",
        "--unstable-kv",
        "app.ts",
        "--client=server-only",
        `--port=${port}`,
      ],
      cwd: new URL("../examples/counter", import.meta.url).pathname,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();

    const c2 = cell("counter2-hang", {
      state: { count: 0 },
      methods: {
        increment(s, by = 1) {
          s.count += by;
        },
      },
    });
    // A short ceiling so the contract is observable in a test; production
    // apps get ACK_TIMEOUT_MS.
    const cli = connectCli<{ counter: { count: number } }>(
      `http://localhost:${port}`,
      { ackTimeoutMs: 1_000 },
    );
    let hold: Deno.Listener | undefined;
    try {
      await waitFor(() => cli.connected ? true : null);
      cli.bind(c2 as unknown as CellDef);

      // Kill the server mid-session, then call a bound method. The action is
      // QUEUED — no socket carried it — and the client is still retrying, so
      // it will be sent the moment the server returns.
      //
      // The contract has three parts, and each of the other two answers used
      // to be shipped and wrong:
      //   • it must NOT resolve — nothing was written, so "success" would be
      //     a report about work that never happened;
      //   • it must NOT reject while the frame is still queued — that was the
      //     shipped defect: the caller was told the action failed (and the
      //     message promised "the action is not resent automatically") while
      //     the very same queue went on to deliver it on reconnect. One user
      //     intent, one rejection AND one application;
      //   • it must settle the moment the frame's fate IS known. close()
      //     discards the queue, so there it becomes a truthful rejection.
      proc.kill();
      await proc.status;
      // HOLD the port. Killing the server frees it, and the client retries
      // forever — so under a loaded suite another test's server can bind this
      // port, the client connects to IT, the frame is written and the call
      // settles early. That is a property of the harness, not of the contract
      // under test. A listener that accepts nothing keeps the port ours and
      // the handshake incomplete, which is exactly the state being asserted.
      hold = Deno.listen({ port });
      await waitFor(() => !cli.connected ? true : null);

      const call = c2.increment(1).then(() => "resolved", () => "rejected");
      const early = await Promise.race([
        call,
        new Promise((r) => setTimeout(() => r("pending"), 3000)),
      ]);
      assertEquals(
        early,
        "pending",
        "a queued action must not be settled by a disconnect that never " +
          "carried it — the queue survives and flushes on reconnect",
      );
      cli.close(); // discards the queue → now the rejection is the truth
      assertEquals(
        await call,
        "rejected",
        "close() throws the queued frame away, so its caller must be told",
      );
    } finally {
      try {
        hold?.close();
      } catch { /* already closed */ }
      cli.close();
      try {
        proc.kill();
      } catch { /* already dead */ }
    }
  },
});

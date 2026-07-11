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
const _childCovDir = Deno.makeTempDirSync({ prefix: "aio-child-cov-" });

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

// A burst of bound calls from ONE `connectCli` client must land, every one of
// them, on a socket that stays open — the terminal twin of
// tests/ws-burst-no-lost-writes.test.ts.
//
// MEASURED before the fix (the shape below: a real server in a subprocess, the
// default 100 msg/sec per-connection budget): `Promise.allSettled` over 150
// bound `inc()` calls gave ok 99 / rejected 51 — 50 "this frame was dropped:
// this connection is over its budget", 1 "connection lost" — and the server
// closed the socket with 1008 and denylisted the address, so the 1000-call
// burst after it lost 901 more to a full offline queue. The client read the
// server's hello, which advertises `rate`, and paced nothing: every call wrote
// its frame the instant it was made.
//
// Driven through the REAL `connectCli` over Deno's WebSocket against a REAL
// server process: the budget, the drop, the close and the denylist are all
// production code, and the server's event loop is not the client's.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { connectCli } from "../src/server/cli-client.ts";
import type { CellDef } from "../src/state/cell-types.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { freePort } from "../src/testing/server-test.ts";
import { childCoverageDir, tempDir } from "../src/testing/temp-dir.ts";
import { stopChild } from "./stop-child.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const clientCell = (name: string) =>
  cell(name, {
    state: { n: 0 },
    methods: {
      inc(s: Inc) {
        s.n++;
      },
    },
  });

const SIZES = [150, 1000] as const;
type Inc = { n: number };

/** The same definitions on both sides — in a real remote CLI app this is the
 *  shared cell.ts import. */
const DEF_SRC = (name: string) =>
  `cell(${
    JSON.stringify(name)
  }, { state: { n: 0 }, methods: { inc(s) { s.n++; } } })`;

function serverChild(
  port: number,
  dir: string,
  names: readonly string[],
  extra = "",
): Deno.ChildProcess {
  const mod = new URL("../mod.ts", import.meta.url).href;
  const code = `
    import { aio, cell } from ${JSON.stringify(mod)};
    await aio.run({
      cells: [${names.map(DEF_SRC).join(", ")}],
      appId: "cliburst-${Deno.pid}-${port}",${extra}
      client: "server-only",
      persist: false,
      singleton: false,
      port: ${port},
      baseDir: ${JSON.stringify(dir)},
      dbPath: ":memory:",
    });`;
  return new Deno.Command(Deno.execPath(), {
    args: ["eval", "--ext=ts", code],
    cwd: new URL("..", import.meta.url).pathname,
    env: { DENO_COVERAGE_DIR: childCoverageDir() },
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
}

async function connectedClients(base: string): Promise<number> {
  const body = await (await fetch(`${base}/__aio/vitals`)).json() as {
    clients?: unknown[];
  };
  return body.clients?.length ?? 0;
}

Deno.test({
  name:
    "connectCli burst: 150 then 1000 parallel bound calls all resolve, count exact, socket stays up",
  async fn(t) {
    const port = freePort();
    const base = `http://127.0.0.1:${port}`;
    const dir = await tempDir("aio-cliburst-");
    const proc = serverChild(port, dir, SIZES.map((N) => `cliburst${N}`));
    const remote = SIZES.map((N) => clientCell(`cliburst${N}`));
    const cli = connectCli<Record<string, Inc>>(base, {
      readyTimeoutMs: 30_000,
    });
    try {
      await cli.ready;
      cli.bind(...(remote as unknown as CellDef[]));
      for (let i = 0; i < 100; i++) {
        if (await connectedClients(base)) break;
        await sleep(30);
      }
      assertEquals(await connectedClients(base), 1, "client connected");

      for (const [i, N] of SIZES.entries()) {
        await t.step(`${N} parallel calls`, async () => {
          const c = remote[i] as unknown as { inc(): Promise<unknown> };
          const t0 = Date.now();
          const settled = await Promise.allSettled(
            Array.from({ length: N }, () => c.inc()),
          );
          const rejected = settled.filter((r) => r.status === "rejected");
          assertEquals(
            rejected.length,
            0,
            `${rejected.length} of ${N} calls were refused — first: ${
              String(
                (rejected[0] as PromiseRejectedResult | undefined)?.reason,
              )
            }`,
          );
          // The count as THIS client sees it — so it also proves state kept
          // arriving through the burst.
          const key = `cliburst${N}`;
          for (let k = 0; k < 100 && cli.state?.[key]?.n !== N; k++) {
            await sleep(30);
          }
          assertEquals(
            cli.state?.[key]?.n,
            N,
            "every call applied exactly once — the count is exact",
          );
          assert(cli.connected, "the client's socket is still open");
          assertEquals(
            await connectedClients(base),
            1,
            "the socket was never closed for the burst (1008 + denylist)",
          );
          // Paced, not stalled.
          const took = Date.now() - t0;
          assert(took < 1000 + N * 25, `burst of ${N} took ${took} ms`);
        });
      }
    } finally {
      cli.close();
      await stopChild(proc, { label: "cliburst server", quiet: true });
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// The calls are made before the socket opens, so they replay in the
// connection's first burst — paced to the DEFAULT budget, because the server's
// hello (5/sec here) has not arrived yet. The server drops most of that burst
// with a retry hint; every one of those calls must be re-sent and land, once.
Deno.test({
  name:
    "connectCli: calls the server drops over its budget are re-sent and resolve — none rejected, none doubled",
  async fn() {
    const port = freePort();
    const base = `http://127.0.0.1:${port}`;
    const dir = await tempDir("aio-cliretry-");
    const proc = serverChild(
      port,
      dir,
      ["cliretry"],
      `\n      wsLimits: { messagesPerSec: 5 },`,
    );
    const counter = clientCell("cliretry");
    const retryNotes: string[] = [];
    const prev = getLogger();
    setLogger({
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn" && msg.includes("asked for a re-send")) {
          retryNotes.push(msg);
        }
      },
      perf: () => {},
      flush: () => Promise.resolve(),
    } as unknown as LogSink);
    // Up before the client dials, so the calls below queue offline and flush
    // as one burst on the first open (not across failed dials).
    for (let i = 0; i < 300; i++) {
      const up = await fetch(`${base}/__aio/health`).then(
        (r) => r.body?.cancel().then(() => true),
        () => false,
      );
      if (up) break;
      await sleep(50);
    }
    const cli = connectCli<Record<string, Inc>>(base, {
      readyTimeoutMs: 30_000,
    });
    try {
      cli.bind(counter as unknown as CellDef);
      const N = 20;
      const c = counter as unknown as { inc(): Promise<unknown> };
      const settled = await Promise.allSettled(
        Array.from({ length: N }, () => c.inc()),
      );
      const rejected = settled.filter((r) => r.status === "rejected");
      assertEquals(
        rejected.length,
        0,
        `${rejected.length} of ${N} rejected — first: ${
          String((rejected[0] as PromiseRejectedResult | undefined)?.reason)
        }`,
      );
      for (let k = 0; k < 100 && cli.state?.cliretry?.n !== N; k++) {
        await sleep(30);
      }
      assertEquals(
        cli.state?.cliretry?.n,
        N,
        "each call applied exactly once — a re-send is not a duplicate",
      );
      assert(
        retryNotes.length > 0,
        "the drops this test exists for must have happened (else it proves " +
          "nothing)",
      );
      assert(cli.connected, "and the socket is still up");
    } finally {
      setLogger(prev);
      cli.close();
      await stopChild(proc, { label: "cliretry server", quiet: true });
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// A call still waiting on the pacer when the socket dies was never written, so
// it is not "lost" — it goes back to the offline queue and replays on the next
// connection. Only the calls actually written are rejected as connection lost.
Deno.test({
  name:
    "connectCli: calls still paced when the server goes away replay on reconnect — only written ones are rejected",
  async fn() {
    const port = freePort();
    const base = `http://127.0.0.1:${port}`;
    const dir = await tempDir("aio-clirequeue-");
    const limits = `\n      wsLimits: { messagesPerSec: 5 },`;
    const waitUp = async () => {
      for (let i = 0; i < 300; i++) {
        const up = await fetch(`${base}/__aio/health`).then(
          (r) => r.body?.cancel().then(() => true),
          () => false,
        );
        if (up) return;
        await sleep(50);
      }
      throw new Error("server did not come up");
    };
    let proc = serverChild(port, dir, ["clirequeue"], limits);
    const counter = clientCell("clirequeue");
    const cli = connectCli<Record<string, Inc>>(base, {
      readyTimeoutMs: 30_000,
    });
    try {
      await cli.ready;
      cli.bind(counter as unknown as CellDef);
      // The hello (5/sec → 3/sec paced) is in: one call leaves now, the rest
      // wait on the pacer.
      const N = 20;
      const c = counter as unknown as { inc(): Promise<unknown> };
      let doneOnA = 0;
      let stopped = false;
      const calls = Array.from({ length: N }, () =>
        c.inc().then((v) => {
          if (!stopped) doneOnA++;
          return v;
        }));
      // Observed NOW, not after the restart: a call that was on the wire when
      // server A went away rejects ("connection lost") during stopChild, and
      // with no handler attached yet that was an unhandled rejection — an
      // "Uncaught error" that only a loaded machine (one call caught mid-flight)
      // ever produced.
      const allSettled = Promise.allSettled(calls);
      await sleep(1_200);
      await stopChild(proc, { label: "clirequeue server A" });
      stopped = true;
      proc = serverChild(port, dir, ["clirequeue"], limits);
      await waitUp();
      // The guard timer is cleared once the race is decided: left armed, it
      // outlives the test by ~40s and the resource sanitizer (test:core)
      // reports it as a leaked timer.
      let guard: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        allSettled,
        new Promise<null>((r) => {
          guard = setTimeout(() => r(null), 40_000);
        }),
      ]).finally(() => clearTimeout(guard));
      assert(settled, "every call settles — none is stranded by the close");
      const rejected = settled.filter((r) => r.status === "rejected");
      const lost = rejected.filter((r) =>
        /connection lost/.test(String((r as PromiseRejectedResult).reason))
      );
      assertEquals(
        rejected.length,
        lost.length,
        `only "connection lost" is an honest rejection here: ${
          String(
            (rejected.find((r) => !lost.includes(r)) as
              | PromiseRejectedResult
              | undefined)?.reason,
          )
        }`,
      );
      // Server B started from zero: whatever it counts arrived AFTER the
      // close, i.e. was still waiting when server A went away.
      const replayed = N - rejected.length - doneOnA;
      assert(
        replayed >= 5,
        `the close must catch most calls still paced (else this proves ` +
          `nothing): ${doneOnA} settled on A, ${lost.length} lost`,
      );
      for (let k = 0; k < 100 && cli.state?.clirequeue?.n !== replayed; k++) {
        await sleep(30);
      }
      assertEquals(
        cli.state?.clirequeue?.n,
        replayed,
        "every paced call replayed onto the new server, exactly once",
      );
    } finally {
      cli.close();
      await stopChild(proc, { label: "clirequeue server B", quiet: true });
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// A connection blip must not turn a paced burst into rejections for calls that
// were never sent.
//
// MEASURED before the fix (the chaos run: 300 bound calls, the server killed
// at 1 s and back 0.5 s later): ok 178, 121 rejected "action dropped — offline
// queue full (100)", 1 connection lost — and the same burst with no blip fully
// succeeds. Frames still waiting on the socket's pacer went back into the
// 100-cap offline queue on close, and the cap's drop-oldest policy evicted the
// EARLIEST of them: the first calls the app made were rejected while later
// ones applied. Those calls had already been accepted — the pacer holds any
// number of them while online — so the blip, not the app, decided their fate.
//
// The cap is for calls made WHILE offline; a call already accepted is never
// evicted to make room.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { connectCli } from "../src/server/cli-client.ts";
import type { CellDef } from "../src/state/cell-types.ts";
import { WS_MAX_QUEUE } from "../src/protocol/protocol-types.ts";
import { freePort } from "../src/testing/server-test.ts";
import { childCoverageDir, tempDir } from "../src/testing/temp-dir.ts";
import { stopChild } from "./stop-child.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Inc = { n: number };

function serverChild(port: number, dir: string): Deno.ChildProcess {
  const mod = new URL("../mod.ts", import.meta.url).href;
  const code = `
    import { aio, cell } from ${JSON.stringify(mod)};
    await aio.run({
      cells: [cell("cliblip", { state: { n: 0 }, methods: { inc(s) { s.n++; } } })],
      appId: "cliblip-${Deno.pid}-${port}",
      wsLimits: { messagesPerSec: 50 },
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

async function waitUp(base: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const up = await fetch(`${base}/__aio/health`).then(
      (r) => r.body?.cancel().then(() => true),
      () => false,
    );
    if (up) return;
    await sleep(50);
  }
  throw new Error("server did not come up");
}

Deno.test({
  name:
    "connectCli: a blip with more paced calls than the offline cap rejects none of them as 'queue full'",
  async fn() {
    const port = freePort();
    const base = `http://127.0.0.1:${port}`;
    const dir = await tempDir("aio-cliblip-");
    let proc = serverChild(port, dir);
    await waitUp(base);
    const counter = cell("cliblip", {
      state: { n: 0 },
      methods: {
        inc(s: Inc) {
          s.n++;
        },
      },
    });
    const cli = connectCli<Record<string, Inc>>(base, {
      readyTimeoutMs: 30_000,
    });
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      await cli.ready;
      cli.bind(counter as unknown as CellDef);
      await sleep(300); // the hello (50/sec → 30/sec paced) is in
      const N = WS_MAX_QUEUE + 60;
      const c = counter as unknown as { inc(): Promise<unknown> };
      const outcome: string[] = new Array(N).fill("pending");
      let doneOnA = 0;
      let onA = true;
      const calls = Array.from({ length: N }, (_, i) =>
        c.inc().then(
          () => {
            outcome[i] = "ok";
            if (onA) doneOnA++;
          },
          (e) => {
            outcome[i] = String(e instanceof Error ? e.message : e);
          },
        ));
      await sleep(500);
      await stopChild(proc, { label: "cliblip server A" });
      onA = false;
      // Pending, or already evicted for them — either way, unsent at the blip.
      const left = outcome.filter((o) =>
        o === "pending" || /queue full/.test(o)
      ).length;
      assert(
        left > WS_MAX_QUEUE,
        `precondition: more calls still paced (${left}) than the offline cap ` +
          `(${WS_MAX_QUEUE}) when the server went away`,
      );
      // A NEW call made while the queue is over its cap with accepted calls
      // is the one refused — at once, and saying why — not an old one evicted.
      const extra = await Promise.race([
        c.inc().then(() => "ok", (e) => String(e)),
        sleep(200).then(() => "pending"),
      ]);
      assert(
        /NOT sent .*accepted before the connection dropped/.test(extra),
        `the call made while offline over the cap: ${extra}`,
      );
      await sleep(300);
      proc = serverChild(port, dir);
      await waitUp(base);
      await Promise.race([
        Promise.all(calls),
        new Promise((r) => {
          guard = setTimeout(r, 40_000);
        }),
      ]).finally(() => clearTimeout(guard));

      const full = outcome.flatMap((o, i) => /queue full/.test(o) ? [i] : []);
      assertEquals(
        full,
        [],
        `calls accepted before the blip were evicted by the offline cap — ` +
          `the earliest first, while later ones applied`,
      );
      // In flight at the blip: lost with the socket, or refused by server A
      // while it shut down. Nothing else is an honest rejection here.
      const other = outcome.filter((o) =>
        o !== "ok" && !/connection lost|dispatch after close/.test(o)
      );
      assertEquals(other, [], "every call either applied or was in flight");
      const inFlight = N - outcome.filter((o) => o === "ok").length;
      assert(inFlight <= 12, `${inFlight} calls were in flight at the blip`);
      // Server B started from zero: what it counts arrived after the blip.
      const replayed = outcome.filter((o) => o === "ok").length - doneOnA;
      for (let k = 0; k < 100 && cli.state?.cliblip?.n !== replayed; k++) {
        await sleep(30);
      }
      assertEquals(
        cli.state?.cliblip?.n,
        replayed,
        "every call still paced at the blip replayed onto the new server, once",
      );
    } finally {
      clearTimeout(guard);
      cli.close();
      await stopChild(proc, { label: "cliblip server B", quiet: true });
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

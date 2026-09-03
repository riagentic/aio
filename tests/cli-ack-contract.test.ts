// The CLI client's ack contract — what a bound call over connectCli means.
//
// Field report (relay app, item 3): `connectCli().bind(cell)` resolved a call even when
// the server-side method THREW. The ack frame carries `ok` and `error`, and
// the handler read only `cid`. So an app could not tell "applied" from
// "refused" — the reporter built a parallel error channel (a `problems` array
// on the server, filtered per user, folded into client state and cleared after
// display, ~150 lines) whose entire reason to exist was that a promise could
// not reject.
//
// Verifying it surfaced three more on the same seam, all silent:
//   * RETURN VALUES were dropped — `await cell.method()` yielded undefined
//     even though the server sent the value (AIO-427's transport, ignored).
//   * ASYNC bound methods were BROKEN OUTRIGHT: bindCell's async branch
//     returned a LOCAL pending-call promise that only an in-process executor
//     can settle, so a remote call waited out the full ceiling and then
//     rejected with "stopped waiting" — 30 seconds after a method that had
//     already succeeded. Success and failure alike.
//   * A disconnect RESOLVED every outstanding call, reporting success for
//     work whose fate is unknown.
//
// The browser transports have always branched on `ok`. This file pins the CLI
// to the same contract, against a real server in a real subprocess.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { connectCli } from "../src/server/cli-client.ts";
import { freePort } from "../src/testing/server-test.ts";
import type { CellDef } from "../src/state/cell-types.ts";
import { stopChild } from "./stop-child.ts";
import { childCoverageDir } from "../src/testing/temp-dir.ts";
const _childCovDir = childCoverageDir();

async function waitFor<T>(fn: () => T | null, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== null && v !== undefined) return v as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timeout waiting for condition");
}

/** A server app whose methods cover every ack outcome. */
const SERVER_APP = `
import { cell, aio } from "${new URL("../mod.ts", import.meta.url).href}";

cell("box", {
  state: { n: 0, log: [] },
  methods: {
    ok(s, by = 1) { s.n += by; return { n: s.n }; },
    boom(s) { throw new Error("refused: not allowed"); },
    async aok(s, by = 1) { await new Promise(r => setTimeout(r, 10)); s.n += by; return { async: true, n: s.n }; },
    async aboom(s) { await new Promise(r => setTimeout(r, 10)); throw new Error("async refusal"); },
  },
});

await aio.run({ client: "server-only", persist: false, appId: "ack-contract-probe" });
`;

async function withServer(
  fn: (
    cli: ReturnType<typeof connectCli<{ box: { n: number } }>>,
    box: Record<string, ((...a: unknown[]) => Promise<unknown>)>,
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "aio-ack-contract-" });
  await Deno.writeTextFile(`${dir}/app.ts`, SERVER_APP);
  const port = freePort();
  const proc = new Deno.Command(Deno.execPath(), {
    env: { DENO_COVERAGE_DIR: _childCovDir, AIO_APPS_DIR: dir },
    // --config: the child runs from a temp cwd with no deno.json, so aio's
    // own config supplies the import map its bare specifiers need (the same
    // trick install.sh uses for a path install).
    args: [
      "run",
      "-A",
      "--unstable-kv",
      "--config",
      new URL("../deno.json", import.meta.url).pathname,
      "app.ts",
      `--port=${port}`,
    ],
    cwd: dir,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  // Drain so the child can never wedge on a full pipe.
  const sink = new WritableStream({ write() {} });
  proc.stdout.pipeTo(sink).catch(() => {});
  proc.stderr.pipeTo(new WritableStream({ write() {} })).catch(() => {});

  const box = cell("box", {
    state: { n: 0, log: [] as string[] },
    methods: {
      ok(s: { n: number }, by = 1) {
        s.n += by;
      },
      boom(_s: unknown) {},
      // deno-lint-ignore require-await
      async aok(s: { n: number }, by = 1) {
        s.n += by;
      },
      // deno-lint-ignore require-await
      async aboom(_s: unknown) {},
    },
  });

  const cli = connectCli<{ box: { n: number } }>(`http://localhost:${port}`);
  try {
    await waitFor(() => cli.connected ? true : null);
    await cli.ready;
    cli.bind(box as unknown as CellDef);
    await fn(
      cli,
      box as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>,
    );
  } finally {
    cli.close();
    await stopChild(proc, { quiet: true });
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name: "cli ack: a refused SYNC method rejects with the server's reason",
  fn: () =>
    withServer(async (_cli, box) => {
      const err = await assertRejects(
        () => box["boom"]!(),
        Error,
      );
      assert(
        /not allowed|refused/i.test(err.message),
        `the server's own reason must survive the wire: ${err.message}`,
      );
    }),
});

Deno.test({
  name: "cli ack: a SYNC method's return value reaches the caller",
  fn: () =>
    withServer(async (_cli, box) => {
      const ret = await box["ok"]!(4);
      assertEquals(
        ret,
        { n: 4 },
        "the ack carries the method's return value (AIO-427) — it was dropped",
      );
    }),
});

Deno.test({
  name:
    "cli ack: an ASYNC method resolves promptly with its value (not a 30s hang)",
  fn: () =>
    withServer(async (_cli, box) => {
      const t0 = Date.now();
      const ret = await box["aok"]!(3);
      const ms = Date.now() - t0;
      assertEquals(ret, { async: true, n: 3 });
      // Generous on purpose: this proves the call settled on its ACK rather
      // than at the call ceiling, and the bug rejected at ~30 000ms. A tighter
      // bound only measures how loaded the machine is when a child server
      // spawns — which is how a real assertion becomes a flaky one.
      assert(
        ms < 12_000,
        `an async bound method must settle on its ack, not at the call ` +
          `ceiling — took ${ms}ms (the bug rejected at ~30000ms)`,
      );
    }),
});

Deno.test({
  name:
    "cli ack: a refused ASYNC method rejects (and does not wait out the ceiling)",
  fn: () =>
    withServer(async (_cli, box) => {
      const t0 = Date.now();
      await assertRejects(() => box["aboom"]!(), Error);
      assert(
        Date.now() - t0 < 12_000,
        "an async refusal must arrive on the ack, not at the ceiling",
      );
    }),
});

Deno.test({
  name: "cli ack: close() rejects outstanding calls — it never reports success",
  fn: () =>
    withServer(async (cli, box) => {
      // Fire without awaiting, then close before the ack can land. The call
      // must NOT resolve: closing does not make an unconfirmed action succeed.
      const inflight = box["ok"]!(1);
      cli.close();
      await assertRejects(() => inflight, Error);
    }),
});

Deno.test("cli bind: close() gives the cell definitions back (rebindable)", () => {
  // A cell def binds to exactly ONE dispatcher (D2) and `bindCell` refuses a
  // second bind with a good message — but nothing ever released one, so a
  // client that closed could never be replaced: `connectCli(url).bind(cell)`
  // after a close threw "already bound" forever, and a test file that ran the
  // server in-process could not then bind a client at all. close() now
  // releases exactly the defs THIS client bound (never another app's).
  const c = cell("rebind-probe", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n += 1;
      },
    },
  });
  // No server needed: binding is a local operation, and the refusal it used to
  // throw was local too.
  const a = connectCli<{ "rebind-probe": { n: number } }>(
    "http://127.0.0.1:1/",
  );
  a.bind(c as unknown as CellDef);
  a.close();

  const b = connectCli<{ "rebind-probe": { n: number } }>(
    "http://127.0.0.1:1/",
  );
  // Must not throw "already bound".
  b.bind(c as unknown as CellDef);
  b.close();
});

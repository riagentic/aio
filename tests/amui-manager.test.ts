// amui — the visual app manager (a peer aio app that observes and DRIVES other
// aio apps). Its logic is exercised by amui/src/amui.test.ts, which no root gate
// runs; these are the contracts that must never rot, so they live under
// `deno task test` with the rest of the suite.
//
// Every test here drives amui's REAL manager cell through its REAL public
// method surface (`t.send.*` == what any connected client, `am dispatch`, or
// the trojan can call) against a fake app whose lock entry + HTTP control plane
// are real enough for `src/am/am-http.ts` to talk to.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { testCell } from "../src/testing/cell-test.ts";
import { manager } from "../amui/src/manager.ts";
import { envelopePayload } from "../src/am/am-cmd-state.ts";
import { removeLock, writeLock } from "../src/server/single-instance-lock.ts";
import { freePort } from "../src/testing/server-test.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";

/** A throwaway aio-shaped project on disk (deno.json importing aio). */
async function makeProject(
  files: Record<string, string> = {},
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "amui-test-" });
  const real = await Deno.realPath(dir);
  await Deno.writeTextFile(
    `${real}/deno.json`,
    JSON.stringify({
      name: "fixture",
      // `aio` is what marks the dir as an aio project for discovery; the rest
      // lets a fixture entry point import framework modules when it needs to.
      imports: {
        aio: new URL("../mod.ts", import.meta.url).href,
        "@std/path": "jsr:@std/path@1.1.3",
      },
    }),
  );
  for (const [rel, body] of Object.entries(files)) {
    const abs = `${real}/${rel}`;
    await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(abs, body);
  }
  return real;
}

/** Stand a project up as a RUNNING app: a real idle child process (so the pid
 *  is alive AND is not amui's own — a lock entry carrying amui's pid marks the
 *  dir as `self`), a lock-registry entry discovery believes, and a control
 *  plane answering the trojan routes `src/am/am-http.ts` speaks. */
function fakeApp(
  opts: {
    dir: string;
    appId: string;
    onDispatch?: (a: unknown) => void;
    /** What the app does when the trojan asks it to shut down. "exit" removes
     *  its registry entry (a well-behaved app); "ignore" acks and keeps running
     *  (the wedged app amui used to report as "stopped"). */
    onShutdown?: "exit" | "ignore";
  },
): { port: number; stop: () => Promise<void> } {
  const port = freePort();
  const ac = new AbortController();
  const srv = Deno.serve(
    { port, signal: ac.signal, onListen: () => {} },
    async (req) => {
      const p = new URL(req.url).pathname;
      if (p === "/__aio/health") {
        return Response.json({
          appId: opts.appId,
          status: "ok",
          version: "1.0.0-test",
          cells: {},
        });
      }
      if (p === "/__aio/trojan/dispatch") {
        opts.onDispatch?.(await req.json());
        return Response.json({ ok: true });
      }
      if (p === "/__aio/trojan/shutdown") {
        if (opts.onShutdown === "exit") removeLock(opts.appId);
        return Response.json({ ok: true });
      }
      return Response.json({});
    },
  );
  const child = new Deno.Command("sleep", {
    args: ["120"],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  writeLock({
    appId: opts.appId,
    pid: child.pid,
    port,
    startedAt: Date.now(),
    status: "started",
    cwd: opts.dir,
  });
  _resetInstanceVerify();
  return {
    port,
    stop: async () => {
      removeLock(opts.appId);
      _resetInstanceVerify();
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
      await child.status;
      ac.abort();
      await srv.finished;
    },
  };
}

/** Point discovery at exactly one directory for the duration of `fn`. */
async function withRoots<T>(roots: string, fn: () => Promise<T>): Promise<T> {
  const prev = Deno.env.get("AMUI_ROOTS");
  Deno.env.set("AMUI_ROOTS", roots);
  try {
    return await fn();
  } finally {
    if (prev === undefined) Deno.env.delete("AMUI_ROOTS");
    else Deno.env.set("AMUI_ROOTS", prev);
  }
}

// ── the dispatch envelope: ONE decider ───────────────────────────────────────
//
// A cell method is called with POSITIONAL arguments and its wire form is
// `{args:[…]}` (src/state/cell-methods-internals.ts reads `payload.args`).
// `am` learned that the hard way and put the rule in ONE place —
// `envelopePayload`. amui re-derived it as a bare `{type, payload}`, so every
// argument sent from amui was dropped on the floor while the trojan still
// answered ok and amui still reported "dispatched <type>": the loudest possible
// lie about the quietest possible failure.
testCell(
  manager,
  "dispatch sends the SAME envelope am does (payload reaches the method)",
  async (t) => {
    const dir = await makeProject();
    const seen: unknown[] = [];
    const app = fakeApp({
      dir,
      appId: "amui-fixture-dispatch",
      onDispatch: (a) => seen.push(a),
    });
    try {
      await withRoots(dir, async () => {
        await t.send.discover();
        assert(
          t.getState().projects.some((p) => p.path === dir && !!p.running),
          "the fixture app is discovered as running",
        );
        await t.send.dispatch(dir, "counter:add", '{"n":5}');
      });
      assertEquals(seen.length, 1, "the dispatch reached the app");
      assertEquals(
        seen[0],
        // `envelopePayload` is the ONE decider for this wire fact.
        {
          type: "counter:add",
          payload: envelopePayload("counter:add", { n: 5 }),
        },
        "a cell method's named payload must arrive as its positional {args:[…]} " +
          "envelope — a bare {type,payload} calls the method with NO arguments " +
          "and still reports success",
      );
      // The concrete consequence, spelled out: this is what the method receives.
      const payload = (seen[0] as { payload: { args?: unknown[] } }).payload;
      assertEquals(payload.args, [{ n: 5 }], "the method gets its argument");
      assertStringIncludes(t.getState().dispatchMsg ?? "", "dispatched");
    } finally {
      await app.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
);

// A plain (non-cell) redux-style action keeps its payload verbatim — the other
// half of the same rule, so a "fix" that wraps everything is caught too.
testCell(
  manager,
  "dispatch keeps a plain action's payload verbatim (no args wrapper)",
  async (t) => {
    const dir = await makeProject();
    const seen: unknown[] = [];
    const app = fakeApp({
      dir,
      appId: "amui-fixture-plain",
      onDispatch: (a) => seen.push(a),
    });
    try {
      await withRoots(dir, async () => {
        await t.send.discover();
        await t.send.dispatch(dir, "Increment", '{"by":1}');
      });
      assertEquals(seen[0], {
        type: "Increment",
        payload: envelopePayload("Increment", { by: 1 }),
      });
      assertEquals((seen[0] as { payload: unknown }).payload, { by: 1 });
    } finally {
      await app.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
);

// ── "started" must mean STARTED ──────────────────────────────────────────────
//
// `start` spawned detached, slept a fixed 2.5s, rescanned, and then reported
// `started <app>` UNCONDITIONALLY — so an app that died on boot (port taken,
// bad import, a throw in a cell) showed a green success message next to its own
// stopped dot, with the reason sitting unread in the launcher log. `am start
// --wait` has always verified this; amui did not.
testCell(
  manager,
  "start reports a boot failure instead of claiming success",
  async (t) => {
    const dir = await makeProject({
      "src/app.ts":
        'console.error("boom: port 8000 already in use");\nDeno.exit(1);\n',
    });
    try {
      await withRoots(dir, async () => {
        await t.send.discover();
        await t.send.start(dir);
      });
      const msg = t.getState().actionMsg ?? "";
      // The app is genuinely down — that is the fact the message must match.
      assertEquals(
        t.getState().projects.find((p) => p.path === dir)?.running ?? null,
        null,
        "fixture app is not running",
      );
      assert(
        /fail/i.test(msg),
        `"started" must not be claimed for an app that never came up — got: ${msg}`,
      );
      // …and the reason has to travel, not sit in a file nobody opens.
      assertStringIncludes(msg, "boom: port 8000 already in use");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

// ── entry resolution: ONE decider, shared with `am start` ────────────────────
//
// `am start` resolves `deno.json`'s `"entry"` first (src/am/am-utils.ts). amui
// probed four hard-coded filenames instead, so on any app that renamed its
// entry the two disagreed: `am start` ran it, amui refused it — and with a
// stale `src/app.ts` still on disk, amui launched the WRONG file.
Deno.test("amui resolves an app's entry exactly like `am start` does", async () => {
  const { resolveEntry } = await import("../amui/src/server/proc.ts");
  const { resolveEntry: amResolveEntry } = await import(
    "../src/am/am-utils.ts"
  );
  // `am`'s resolver is cwd-relative; run it inside each fixture and restore.
  const amAnswer = (dir: string): string | null => {
    const cwd = Deno.cwd();
    try {
      Deno.chdir(dir);
      return amResolveEntry();
    } finally {
      Deno.chdir(cwd);
    }
  };

  // 1. A declared entry wins, even with a stale src/app.ts alongside it.
  const renamed = await makeProject({
    "src/server.ts": "// the real entry\n",
    "src/app.ts": "// stale leftover — must NOT be launched\n",
  });
  // 2. A declared entry that does not exist is a refusal, not a fallback.
  const broken = await makeProject({ "src/app.ts": "// leftover\n" });
  // 3. No declaration → the convention.
  const conventional = await makeProject({ "src/app.ts": "// entry\n" });
  const declare = async (dir: string, entry: string) => {
    const cfg = JSON.parse(await Deno.readTextFile(`${dir}/deno.json`));
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ ...cfg, entry }),
    );
  };
  try {
    await declare(renamed, "src/server.ts");
    await declare(broken, "src/gone.ts");

    const r1 = await resolveEntry(renamed);
    assertEquals(r1, { ok: true, entry: "src/server.ts" });
    assertEquals(amAnswer(renamed), "src/server.ts", "am agrees");

    const r2 = await resolveEntry(broken);
    assertEquals(r2.ok, false, "a declared-but-missing entry is refused");
    assertStringIncludes(
      r2.ok ? "" : r2.error,
      "src/gone.ts",
      "the refusal names the entry that is missing",
    );
    assertEquals(amAnswer(broken), null, "am refuses it too");

    const r3 = await resolveEntry(conventional);
    assertEquals(r3, { ok: true, entry: "src/app.ts" });
    assertEquals(amAnswer(conventional), "src/app.ts", "am agrees");
  } finally {
    for (const d of [renamed, broken, conventional]) {
      await Deno.remove(d, { recursive: true });
    }
  }
});

// The other half: a real registration must still read as success — a "fix" that
// simply always reports failure fails here.
testCell(
  manager,
  "start reports success once the app registers as running",
  async (t) => {
    const appId = "amui-fixture-boot-ok";
    const port = freePort();
    const lockMod =
      new URL("../src/server/single-instance-lock.ts", import.meta.url)
        .href;
    const dir = await makeProject({
      // A stand-in app: it registers in the lock registry exactly as a booted
      // aio app does, then idles until the test kills it.
      "src/app.ts": `import { writeLock } from ${JSON.stringify(lockMod)};
writeLock({ appId: ${JSON.stringify(appId)}, pid: Deno.pid, port: ${port},
  startedAt: Date.now(), status: "started", cwd: Deno.cwd() });
await new Promise((r) => setTimeout(r, 60_000));
`,
    });
    let pid: number | undefined;
    try {
      await withRoots(dir, async () => {
        await t.send.discover();
        await t.send.start(dir);
      });
      pid = t.getState().projects.find((p) => p.path === dir)?.running?.pid;
      const msg = t.getState().actionMsg ?? "";
      assert(
        !/fail/i.test(msg) && msg.includes("started"),
        `a booted app must read as started — got: ${msg}`,
      );
      assert(pid !== undefined, "discovery sees it running");
    } finally {
      removeLock(appId);
      if (pid !== undefined) {
        try {
          Deno.kill(pid, "SIGKILL");
        } catch { /* already gone */ }
      }
      await Deno.remove(dir, { recursive: true });
    }
  },
);

// ── "stopped" must mean STOPPED ──────────────────────────────────────────────
//
// `stopApp` only reports that the shutdown REQUEST was delivered (or that
// SIGTERM did not throw). `stop` printed `stopped <app>` off that alone, so an
// app that acked and kept serving read as stopped in the one UI whose whole job
// is to say what is running.
testCell(
  manager,
  "stop reports the truth when the app refuses to go down",
  async (t) => {
    const dir = await makeProject();
    const app = fakeApp({
      dir,
      appId: "amui-fixture-wedged",
      onShutdown: "ignore",
    });
    try {
      await withRoots(dir, async () => {
        await t.send.discover();
        await t.send.stop(dir);
      });
      const msg = t.getState().actionMsg ?? "";
      assert(
        !!t.getState().projects.find((p) => p.path === dir)?.running,
        "the fixture app is still registered as running",
      );
      assert(
        !/^stopped /.test(msg) && /still running|did not stop|fail/i.test(msg),
        `an app that is still up must not read as stopped — got: ${msg}`,
      );
    } finally {
      await app.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
);

// …and a clean shutdown still reads as success.
testCell(
  manager,
  "stop reports success when the app actually goes down",
  async (t) => {
    const dir = await makeProject();
    const app = fakeApp({
      dir,
      appId: "amui-fixture-clean-stop",
      onShutdown: "exit",
    });
    try {
      await withRoots(dir, async () => {
        await t.send.discover();
        await t.send.stop(dir);
      });
      const msg = t.getState().actionMsg ?? "";
      assertStringIncludes(msg, "stopped");
      assert(!/fail|still running/i.test(msg), msg);
      assertEquals(
        t.getState().projects.find((p) => p.path === dir)?.running ?? null,
        null,
      );
    } finally {
      await app.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
);

// restart = stop THEN start. It used to sleep 800ms after the stop request and
// start regardless, so a still-live instance meant the "restart" either lost
// the singleton race or left the OLD process serving under a success message.
testCell(
  manager,
  "restart refuses to start on top of an instance that did not stop",
  async (t) => {
    const dir = await makeProject({ "src/app.ts": "// never reached\n" });
    const app = fakeApp({
      dir,
      appId: "amui-fixture-wedged-restart",
      onShutdown: "ignore",
    });
    try {
      await withRoots(dir, async () => {
        await t.send.discover();
        await t.send.restart(dir);
      });
      const msg = t.getState().actionMsg ?? "";
      assert(
        /fail|did not stop/i.test(msg) && !/^restarted /.test(msg),
        `a wedged instance must not read as restarted — got: ${msg}`,
      );
      // …and nothing was spawned on top of it (the launcher log is the proof:
      // startApp creates it the moment it runs).
      const { startLogPath } = await import("../amui/src/server/proc.ts");
      let spawned = true;
      try {
        await Deno.stat(startLogPath(dir));
      } catch {
        spawned = false;
      }
      assertEquals(spawned, false, "no second process was launched");
    } finally {
      await app.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
);

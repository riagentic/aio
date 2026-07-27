// `worker: true` — a cell whose methods run in their own Deno worker.
//
// The property under test is ISOLATION, and it is tested against a real process
// with a real worker: a method that blocks the CPU for seconds must not delay
// another cell's action, the HTTP loop, or shutdown. Everything else (state,
// persistence, broadcast) must behave exactly as it does for a normal cell,
// because the worker only streams patches home.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { enc } from "../src/protocol/envelope.ts";
import { join } from "@std/path";
import { validateWorkerCells } from "../src/server/cell-worker-pool.ts";
import { cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";

const REPO = new URL("../", import.meta.url).pathname;

/** Write a throwaway app whose `heavy` cell is worker-hosted and whose `ticker`
 *  cell is not, then run it as a real process. */
async function writeApp(dir: string, port: number): Promise<void> {
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      imports: {
        "aio": `${REPO}mod.ts`,
        "aio/": `${REPO}src/`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@1.1.2",
      },
    }),
  );
  await Deno.writeTextFile(
    join(dir, "app.ts"),
    `import { aio, cell, schedule, serverRequest, serverUser } from "aio";

export const heavy = cell("heavy", {
  worker: true,
  state: { runs: 0, lastMs: 0, note: "" },
  methods: {
    // Blocks its thread hard — the whole point of the test.
    burn(s: { runs: number; lastMs: number }, ms: number) {
      const end = performance.now() + ms;
      while (performance.now() < end) { /* busy */ }
      s.runs++;
      s.lastMs = ms;
      return "burned:" + ms;
    },
    async twoPhase(s: { note: string }) {
      s.note = "phase1";            // commits + streams home before the await
      await new Promise((r) => setTimeout(r, 60));
      s.note = "phase2";
    },
    boom() {
      throw new Error("heavy exploded");
    },
    // Reads a PEER cell from inside the worker — the trap risoto hit: this used
    // to silently return ticker's declared default (0) forever.
    peek(s: { note: string }) {
      s.note = "peer:" + ticker.n;
      return s.note;
    },
    // Returns a schedule effect — schedules live on the main isolate, so the
    // worker has to hand it back rather than run it.
    later(s: { note: string }) {
      s.note = "scheduled";
      return schedule.after("heavy:later", 40, heavy.mark.action());
    },
    mark(s: { note: string }) {
      s.note = "fired";
    },
    // Reads the ambient caller context INSIDE the worker thread.
    whoFrom(s: { note: string }) {
      const req = serverRequest();
      const u = serverUser();
      s.note = "ip:" + (req?.ip ?? "none") + " via:" + (req?.via ?? "none") +
        " user:" + (u?.id ?? "anon");
      return s.note;
    },
  },
});

export const other = cell("other", {
  worker: true,
  state: { runs: 0 },
  methods: {
    burn(s: { runs: number }, ms: number) {
      const end = performance.now() + ms;
      while (performance.now() < end) { /* busy */ }
      s.runs++;
      return "other:" + ms;
    },
  },
});

export const ticker = cell("ticker", {
  state: { n: 0 },
  methods: { bump(s: { n: number }) { s.n++; return s.n; } },
});

await aio.run({
  appId: "cell-worker-e2e",
  cells: [heavy, other, ticker],
  client: "server-only",
  persist: false,
  port: ${port},
  routes: {
    // Plain routes so the test can drive the app and read state over HTTP —
    // and, crucially, observe that the HTTP loop still answers while the
    // worker cell is busy.
    "/burn": async (req: Request) => {
      const ms = Number(new URL(req.url).searchParams.get("ms") ?? "300");
      const ret = await heavy.burn(ms);
      return Response.json({ ret });
    },
    "/burn-bg": (req: Request) => {
      const ms = Number(new URL(req.url).searchParams.get("ms") ?? "1500");
      void heavy.burn(ms);           // fire and forget — leaves the worker busy
      return new Response("started");
    },
    "/two-phase": (_req: Request) => { void heavy.twoPhase(); return new Response("started"); },
    "/boom": async (_req: Request) => {
      try { await heavy.boom(); return new Response("no-throw"); }
      catch (e) { return new Response((e as Error).message, { status: 500 }); }
    },
    "/bump": async (_req: Request) => Response.json({ n: await ticker.bump() }),
    "/who": async () => new Response(await heavy.whoFrom() as string),
    "/peek": async () => {
      try { return new Response(await heavy.peek() as string); }
      catch (e) { return new Response((e as Error).message, { status: 500 }); }
    },
    "/later": async () => { await heavy.later(); return new Response("ok"); },
    "/both": async () => {
      // Two worker cells burning at once — independent threads.
      const t0 = performance.now();
      const [a, b] = await Promise.all([heavy.burn(400), other.burn(400)]);
      return Response.json({ a, b, ms: Math.round(performance.now() - t0) });
    },
    "/order": async () => {
      // Three calls to the SAME worker cell — the worker must apply them in
      // the order they were posted.
      const rets = [] as string[];
      rets.push(await heavy.burn(5) as string);
      rets.push(await heavy.burn(6) as string);
      rets.push(await heavy.burn(7) as string);
      return Response.json({ rets, runs: heavy.runs });
    },
    "/state": () => Response.json({ heavy: heavy.runs, note: heavy.note, ticker: ticker.n, other: other.runs }),
  },
});
`,
  );
}

type Proc = {
  child: Deno.ChildProcess;
  url: string;
  stop: () => Promise<string>;
};

async function boot(dir: string, port: number): Promise<Proc> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(dir, "app.ts")],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/state`);
      if (res.ok) {
        await res.body?.cancel();
        break;
      }
      await res.body?.cancel();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    child,
    url,
    stop: async () => {
      try {
        child.kill("SIGTERM");
      } catch { /* gone */ }
      const out = await child.output();
      return new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
    },
  };
}

Deno.test({
  name:
    "cell worker e2e: a blocking method never stalls other cells or the HTTP loop",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-cell-worker-" });
    const port = freePort();
    await writeApp(dir, port);
    const app = await boot(dir, port);
    try {
      // Sanity: the worker cell works at all, and returns its value home.
      const first = await (await fetch(`${app.url}/burn?ms=120`)).json();
      assertEquals(first.ret, "burned:120", "return value crossed the thread");

      // Now leave the worker burning for 1.5s and hammer the rest of the app.
      // The burn request is deliberately NOT awaited: without isolation the
      // server blocks INSIDE this request, so awaiting it would wait out the
      // burn and measure an idle server (the mutation test that caught this).
      const burning = fetch(`${app.url}/burn-bg?ms=1500`).then((r) => r.text());
      await new Promise((r) => setTimeout(r, 100)); // ensure it's mid-burn

      const started = performance.now();
      const bumps: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${app.url}/bump`);
        bumps.push((await res.json()).n);
      }
      const elapsed = performance.now() - started;

      assertEquals(bumps, [1, 2, 3, 4, 5], "the other cell kept dispatching");
      assert(
        elapsed < 1000,
        `5 round trips took ${elapsed.toFixed(0)}ms while a worker cell was ` +
          `burning 1500ms — the main loop was NOT free`,
      );

      // And the worker's own state landed once it finished.
      await burning;
      await new Promise((r) => setTimeout(r, 1800));
      const state = await (await fetch(`${app.url}/state`)).json();
      assertEquals(state.heavy, 2, "both burns committed to the main replica");
      assertEquals(state.ticker, 5);
    } finally {
      await app.stop();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "cell worker e2e: mid-method commits stream home, and a throw rejects the caller",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-cell-worker-" });
    const port = freePort();
    await writeApp(dir, port);
    const app = await boot(dir, port);
    try {
      // An async method's write BEFORE its await must be visible immediately —
      // that's what makes `s.status = "working"` show a spinner.
      await (await fetch(`${app.url}/two-phase`)).text();
      await new Promise((r) => setTimeout(r, 25));
      const mid = await (await fetch(`${app.url}/state`)).json();
      assertEquals(mid.note, "phase1", "the pre-await commit streamed home");
      await new Promise((r) => setTimeout(r, 120));
      const after = await (await fetch(`${app.url}/state`)).json();
      assertEquals(after.note, "phase2", "the post-await commit followed");

      // A throwing method rejects the caller with its real message.
      const boom = await fetch(`${app.url}/boom`);
      assertEquals(boom.status, 500);
      assertStringIncludes(await boom.text(), "heavy exploded");
    } finally {
      await app.stop();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── Boot validation (pure — no worker needed) ──

Deno.test("worker cells: unsupported config fails at boot with the reason", () => {
  const cases: { def: unknown; expect: string }[] = [
    {
      def: cell("wsync", {
        worker: true,
        sync: true,
        state: { n: 0 },
        methods: {
          inc(s: { n: number }) {
            s.n++;
          },
        },
      }),
      expect: "sync: true",
    },
    {
      def: cell("wsel", {
        worker: true,
        state: { n: 0 },
        selectors: { double: (s: { n: number }) => s.n * 2 },
        methods: {
          inc(s: { n: number }) {
            s.n++;
          },
        },
      }),
      expect: "selectors",
    },
  ];
  for (const c of cases) {
    let msg = "";
    try {
      validateWorkerCells([c.def as never]);
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, c.expect);
    assertStringIncludes(msg, "worker: true", `names the flag: ${msg}`);
    assertStringIncludes(msg, "cell-workers.md", `points at the docs: ${msg}`);
  }
});

Deno.test("worker cells: a supported cell passes validation", () => {
  const ok = cell("wok", {
    worker: true,
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });
  validateWorkerCells([ok as never]); // must not throw
});

Deno.test({
  name:
    "cell worker e2e: ordering, ambient context, and a shutdown that never waits",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-cell-worker-" });
    const port = freePort();
    await writeApp(dir, port);
    const app = await boot(dir, port);
    let stopped = "";
    try {
      // Per-cell FIFO survives the thread hop.
      const ordered = await (await fetch(`${app.url}/order`)).json();
      assertEquals(ordered.rets, ["burned:5", "burned:6", "burned:7"]);
      assertEquals(ordered.runs, 3, "every call committed, in order");

      // serverRequest()/serverUser() answer INSIDE the worker.
      const who = await (await fetch(`${app.url}/who`)).text();
      assertStringIncludes(who, "ip:127.0.0.1");
      assertStringIncludes(who, "via:http");

      // A wedged method must not hold shutdown hostage: start a 5s burn, then
      // stop the app immediately and require a prompt exit.
      void fetch(`${app.url}/burn-bg?ms=5000`).catch(() => {});
      await new Promise((r) => setTimeout(r, 150));
      const t0 = performance.now();
      stopped = await app.stop();
      const elapsed = performance.now() - t0;
      assert(
        elapsed < 3000,
        `shutdown waited ${elapsed.toFixed(0)}ms for a busy worker — it must ` +
          `terminate the thread, not join it`,
      );
    } finally {
      if (!stopped) await app.stop();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "cell worker e2e: a NETWORK action reaches the worker, not the main isolate",
  ignore: Deno.build.os === "windows",
  async fn() {
    // The gap this pins: the network dispatcher used to be wired to the RAW
    // dispatcher, so a browser calling a worker cell would have executed the
    // method on the main isolate — no isolation, and two diverging copies of
    // the slice. Server-side routes went through the routed dispatch and
    // looked fine, which is exactly why this needs its own test.
    const dir = await Deno.makeTempDir({ prefix: "aio-cell-worker-" });
    const port = freePort();
    await writeApp(dir, port);
    const app = await boot(dir, port);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((res, rej) => {
        ws.onopen = () => res(null);
        ws.onerror = () => rej(new Error("ws failed to open"));
      });
      // Burn 1200ms via the WIRE, then immediately hammer the other cell.
      ws.send(enc("action", { type: "heavy:burn", payload: { args: [1200] } }));
      await new Promise((r) => setTimeout(r, 100));

      const t0 = performance.now();
      for (let i = 0; i < 5; i++) await (await fetch(`${app.url}/bump`)).json();
      const elapsed = performance.now() - t0;
      ws.close();

      assert(
        elapsed < 900,
        `5 round trips took ${elapsed.toFixed(0)}ms while a WS-dispatched ` +
          `worker action was burning 1200ms — the network path bypassed the worker`,
      );

      // …and the burn really did happen, in the worker, landing in main state.
      await new Promise((r) => setTimeout(r, 1500));
      const state = await (await fetch(`${app.url}/state`)).json();
      assertEquals(state.heavy, 1, "the worker committed the network action");
    } finally {
      await app.stop();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "cell worker e2e: state persists across a restart and the worker is re-seeded",
  ignore: Deno.build.os === "windows",
  async fn() {
    // The worker's slice is authoritative on the MAIN isolate — so persistence
    // must work untouched, and a fresh worker must start from the restored
    // state (not from the cell's defaults, which would silently reset data).
    const dir = await Deno.makeTempDir({ prefix: "aio-cell-worker-persist-" });
    const data = join(dir, "data");
    const port = freePort();
    await writeApp(dir, port);
    // Turn persistence ON for this app and pin its data dir.
    const src = await Deno.readTextFile(join(dir, "app.ts"));
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      src.replace(
        "persist: false,",
        // `appDir` keeps this app's state in the test's temp dir. A persisting
        // app otherwise writes to `~/.<appId>`, which would carry state between
        // runs and make the counts below meaningless (it did: 7 instead of 2).
        `persist: true,\n  appDir: ${JSON.stringify(data)},`,
      ),
    );

    const first = await boot(dir, port);
    try {
      await (await fetch(`${first.url}/burn?ms=10`)).json();
      await (await fetch(`${first.url}/burn?ms=10`)).json();
      const before = await (await fetch(`${first.url}/state`)).json();
      assertEquals(before.heavy, 2);
    } finally {
      await first.stop();
    }

    // Give the flush a beat, then boot the same app again.
    await new Promise((r) => setTimeout(r, 300));
    const second = await boot(dir, port);
    try {
      const restored = await (await fetch(`${second.url}/state`)).json();
      assertEquals(restored.heavy, 2, "main isolate restored the slice");
      // And the WORKER must be running from that restored state: one more burn
      // has to continue the count, not restart it.
      await (await fetch(`${second.url}/burn?ms=10`)).json();
      const after = await (await fetch(`${second.url}/state`)).json();
      assertEquals(
        after.heavy,
        3,
        "the worker was seeded with restored state, not the cell defaults",
      );
    } finally {
      await second.stop();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "cell worker e2e: two worker cells run in parallel, and effects come home",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-cell-worker-" });
    const port = freePort();
    await writeApp(dir, port);
    const app = await boot(dir, port);
    try {
      // Two cells, two threads: 400ms each, concurrently. Serial execution
      // would take ~800ms — the margin is generous so a loaded CI box passes.
      const both = await (await fetch(`${app.url}/both`)).json();
      assertEquals(both.a, "burned:400");
      assertEquals(both.b, "other:400");
      assert(
        both.ms < 700,
        `two worker cells took ${both.ms}ms for 400ms each — they serialized`,
      );

      // A schedule effect RETURNED by a worker method must execute on the main
      // isolate (that's where the scheduler lives) and dispatch back into the
      // worker when it fires.
      await (await fetch(`${app.url}/later`)).text();
      const mid = await (await fetch(`${app.url}/state`)).json();
      assertEquals(mid.note, "scheduled", "the method's own write landed");
      await new Promise((r) => setTimeout(r, 400));
      const fired = await (await fetch(`${app.url}/state`)).json();
      assertEquals(
        fired.note,
        "fired",
        "the forwarded schedule effect ran and dispatched back into the worker",
      );
    } finally {
      await app.stop();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "cell worker e2e: reading a PEER cell fails loud instead of returning defaults",
  ignore: Deno.build.os === "windows",
  async fn() {
    // Field report (risoto, 2026-07-26): boot validation catches config-level
    // misuse, but a peer read inside a METHOD BODY slipped through and silently
    // read the worker's unbooted copy — never-updated data, no error. Silent
    // wrong data is the failure mode this framework refuses to have.
    const dir = await Deno.makeTempDir({ prefix: "aio-cell-worker-" });
    const port = freePort();
    await writeApp(dir, port);
    const app = await boot(dir, port);
    try {
      // Move the peer's value away from its default first, so a silent read
      // would return something demonstrably WRONG (0) rather than coincidence.
      await (await fetch(`${app.url}/bump`)).json();
      await (await fetch(`${app.url}/bump`)).json();

      const res = await fetch(`${app.url}/peek`);
      const body = await res.text();
      assertEquals(res.status, 500, `peer read must throw, got: ${body}`);
      assertStringIncludes(body, "runs in a worker");
      assertStringIncludes(body, "ticker.n", "names the exact read");
      assertStringIncludes(body, "cell-workers.md", "points at the fix");
      assert(
        !body.includes("peer:0"),
        "the old behavior — a silent default — must be gone",
      );
    } finally {
      await app.stop();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

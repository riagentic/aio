// `own.set` from a `worker: true` cell — with a REAL worker thread.
//
// The bug this pins: an own effect returned by a worker-hosted method was
// posted home with the schedule effects, and the main isolate's `runEffect`
// had no branch for `__own` — so it was dispatched as an ACTION of type
// "__own" that no cell handles and dropped with no log at all. The factory
// could not have run there anyway: `own.set` parks it in a module-level map,
// which is per-isolate, so the closure never crossed the thread.
//
// Result: `own.set(id, () => openDevice())` from a worker cell was a silent
// no-op, while docs/state/methods.md documents `own.set` as THE way to hold a
// subprocess/FFI handle and docs/state/cell-workers.md's motivating example is
// a hardware wallet on its own thread — the exact combination.
//
// This has to run against a real process: an in-isolate worker cell (what
// libraryMode gives a test) shares the main isolate's pendingFactories, so it
// cannot reproduce the defect. The app below reports what happened INSIDE the
// worker over HTTP.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";

const REPO = new URL("../", import.meta.url).pathname;

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
    `import { aio, cell, own } from "aio";

// A stand-in for the device handle a worker cell exists to hold: it lives in
// the worker's globalThis, so only code running IN the worker can see it.
const W = globalThis as unknown as { __log?: string[] };
const wlog = () => (W.__log ??= []);

export const device = cell("device", {
  worker: true,
  state: { opened: 0, report: "" },
  methods: {
    open(s: { opened: number }) {
      s.opened++;
      const n = s.opened;
      s.$do(own.set("device:handle", () => {
        wlog().push("acquire:" + n);
        return () => wlog().push("dispose:" + n);
      }));
    },
    release(s) {
      s.$do(own.dispose("device:handle"));
    },
    // Reports from INSIDE the worker isolate.
    check(s: { report: string }) {
      s.report = wlog().join(",");
      return s.report;
    },
  },
});

export const plain = cell("plain", {
  state: { opened: 0 },
  methods: {
    open(s: { opened: number }) {
      s.opened++;
      s.$do(own.set("plain:handle", () => {
        (globalThis as any).__mainLog ??= [];
        (globalThis as any).__mainLog.push("acquire");
        return () => (globalThis as any).__mainLog.push("dispose");
      }));
    },
    check() {
      return ((globalThis as any).__mainLog ?? []).join(",");
    },
  },
});

await aio.run({
  appId: "cell-worker-own-e2e",
  cells: [device, plain],
  client: "server-only",
  persist: false,
  port: ${port},
  routes: {
    "/open": async () => new Response(String(await device.open())),
    "/release": async () => new Response(String(await device.release())),
    "/check": async () => new Response(await device.check() as string),
    "/plain-open": async () => { await plain.open(); return new Response("ok"); },
    "/plain-check": async () => new Response(await plain.check() as string),
    "/state": () => Response.json({ opened: device.opened }),
  },
});
`,
  );
}

async function boot(dir: string, port: number) {
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
      await res.body?.cancel();
      if (res.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
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

const text = async (url: string) => (await fetch(url)).text();

Deno.test({
  name: "cell worker: own.set really acquires — in the worker's own isolate",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-worker-own-" });
    const port = freePort();
    await writeApp(dir, port);
    const app = await boot(dir, port);
    let out = "";
    try {
      // Baseline: a PLAIN cell has always worked. It is the control — the two
      // must agree, which is the whole complaint.
      await text(`${app.url}/plain-open`);
      assertEquals(await text(`${app.url}/plain-check`), "acquire");

      await text(`${app.url}/open`);
      assertEquals(
        await text(`${app.url}/check`),
        "acquire:1",
        "own.set from a worker cell must run its factory (it used to vanish)",
      );

      // Replace semantics survive the thread boundary: same key ⇒ the previous
      // resource is disposed first.
      await text(`${app.url}/open`);
      assertEquals(
        await text(`${app.url}/check`),
        "acquire:1,dispose:1,acquire:2",
      );

      // …and an explicit dispose frees it.
      await text(`${app.url}/release`);
      assertEquals(
        await text(`${app.url}/check`),
        "acquire:1,dispose:1,acquire:2,dispose:2",
      );
    } finally {
      out = await app.stop();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
    // The old failure mode was silent. Make sure the new one isn't noisy in
    // the other direction: no "no pending factory" replay warning, which is
    // what routing the effect home would have produced.
    assert(
      !out.includes("no pending factory"),
      `own effects must not be shipped to the main isolate:\n${out}`,
    );
  },
});

Deno.test({
  name: "cell worker: a worker's owned resources are disposed on shutdown",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-worker-own-close-" });
    const port = freePort();
    await writeApp(dir, port);
    const app = await boot(dir, port);
    let out = "";
    try {
      await text(`${app.url}/open`);
      assertEquals(await text(`${app.url}/check`), "acquire:1");
    } finally {
      out = await app.stop(); // SIGTERM → graceful shutdown → worker close
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
    // The disposer runs in the worker as it closes; it must not throw or hang
    // the shutdown (the process exits, which is what stop() awaiting proves).
    assert(
      !out.includes("Unhandled"),
      `worker teardown must not raise:\n${out}`,
    );
  },
});

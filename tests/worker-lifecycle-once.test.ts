// A worker cell's `onInit` and `onDestroy` run ONCE per boot, not once per
// isolate.
//
// A `worker: true` cell composes on BOTH sides — main routes to it, the worker
// runs it — and both sides walked `initAll`/`destroyAll`. So the hook ran
// twice, on two threads. Measured: `inits=2`, `where: ["worker","worker"]`,
// for one boot. An `onInit` that opens a device, seeds a table or starts a
// watcher did all of it twice; an `onDestroy` closed twice.
//
// The in-isolate harness could never show it, because there is no second
// isolate there — it reported 1 and was right about its own world. That is the
// green-test-broken-prod shape, and it is why this test asserts the COUNT
// through the composed pipeline rather than through a harness that has one
// thread by construction.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { composeCells } from "../src/state/cell-compose.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function probe(worker: boolean) {
  const inits: string[] = [];
  const destroys: string[] = [];
  const c = cell(`wlo_${worker ? "w" : "m"}`, {
    state: { n: 0 },
    ...(worker ? { worker: true } : {}),
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
    onInit: () => void inits.push("init"),
    onDestroy: () => void destroys.push("destroy"),
  } as Any);
  return { c, inits, destroys };
}

Deno.test("worker cell: the isolate that RUNS it is the one that inits it", () => {
  const { c, inits, destroys } = probe(true);
  const composed = composeCells([c as Any]);
  const app = {
    dispatch: () => {},
    getState: () => composed.initialState as Record<string, unknown>,
  };
  // The pool owns this cell, so main skips it — exactly what the server's
  // bridge passes when `_hostWorkers` is true.
  const ownedByWorker = (id: string) => id === c.__aio.id;
  composed.initAllExcept!(app, ownedByWorker);
  composed.destroyAllExcept!(app, ownedByWorker);
  assertEquals(inits, [], "main must not init a cell the worker runs");
  assertEquals(destroys, [], "…nor destroy it");
});

Deno.test("worker cell: with NO pool hosting it, this isolate still inits it", () => {
  // `libraryMode` with no worker entry runs a `worker: true` cell in THIS
  // isolate. Skipping unconditionally would trade a double init for none —
  // which is what the first version of this fix did, and what the in-isolate
  // probe caught.
  const { c, inits, destroys } = probe(true);
  const composed = composeCells([c as Any]);
  const app = {
    dispatch: () => {},
    getState: () => composed.initialState as Record<string, unknown>,
  };
  composed.initAll(app);
  composed.destroyAll(app);
  assertEquals(inits, ["init"], "no pool means this isolate owns it");
  assertEquals(destroys, ["destroy"]);
});

Deno.test("an ordinary cell is never skipped", () => {
  const { c, inits, destroys } = probe(false);
  const composed = composeCells([c as Any]);
  const app = {
    dispatch: () => {},
    getState: () => composed.initialState as Record<string, unknown>,
  };
  composed.initAllExcept!(app, (id) => id === "somebody-else");
  composed.destroyAllExcept!(app, (id) => id === "somebody-else");
  assertEquals(inits, ["init"]);
  assertEquals(destroys, ["destroy"]);
  assert(c.__aio.worker !== true);
});

// ── A crashed worker answers; it does not hang ───────────────────────────
//
// `onerror` logged, rejected `ready` and failed the in-flight calls — and left
// `closed` false. So every LATER `call()` took the live path and posted into a
// dead thread. An async method was bounded by the 30s call ceiling; a SYNC
// method has no ceiling at all and never settled. Measured end to end: one
// stray unhandled rejection inside a worker cell made it permanently
// unreachable, with two subsequent calls still pending after six seconds.
//
// The `closed` branch in `call()` already answered correctly, settling both
// the transport promise and the registry one. Nothing ever reached it.
Deno.test("cell worker: a call after a crash is refused by name, not left hanging", async () => {
  const { createCellWorker } = await import("../src/server/cell-worker.ts");
  const { tempDir } = await import("../src/testing/temp-dir.ts");
  const dir = await tempDir("aio-wcrash-");
  // A worker entry that dies the moment it is loaded — the shortest path to
  // the `onerror` this test is about.
  const entry = `${dir}/boom.ts`;
  await Deno.writeTextFile(entry, `throw new Error("worker died on load");\n`);
  const fakeCell = { __aio: { id: "boomcell" } } as never;
  const w = createCellWorker(fakeCell, {
    entry: new URL(`file://${entry}`),
    initialState: () => ({}),
    prod: false,
    freezeState: false,
    applyPatches: () => {},
    runEffect: () => {},
    resolveCall: () => {},
  } as never);
  try {
    await w.ready().catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    let msg = "";
    try {
      await w.call({ type: "boomcell:noop", payload: {} } as never);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    // That it settles at all is the first half — a hang fails this test by
    // timing out rather than by an assertion. What it SAYS is the other half:
    // "closed" would be a lie (nobody closed it) and tells the reader to go
    // looking for a shutdown that never happened.
    assertStringIncludes(msg, "crashed");
    assertStringIncludes(msg, "boomcell");
  } finally {
    await Promise.resolve(w.close?.()).catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

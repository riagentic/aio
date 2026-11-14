// `await app.close()` waits for an `own` resource's ASYNC disposer.
//
// The disposer's promise was dropped (`release` caught it and returned
// nothing), so `disposeAll` returned void and shutdown's "own processes"
// phase had nothing to await: `close()` resolved while the teardown — a
// server draining, a child awaited to exit — was still running, and on a
// signal exit `Deno.exit` cut it off half-done.
import { assert, assertEquals } from "@std/assert";
import { aio, cell, own } from "../mod.ts";
import { createOwnManager } from "../src/state/own.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const steps: string[] = [];

const holder = cell("oadclose", {
  state: { n: 0 },
  methods: {
    arm(s) {
      s.$do(own.set("oadclose:res", () => async () => {
        steps.push("dispose:start");
        await new Promise((r) => setTimeout(r, 80));
        steps.push("dispose:done");
      }));
      s.n++;
    },
  },
});

Deno.test("own: await app.close() resolves only after an async disposer finished", async () => {
  const dir = await tempDir("oad-");
  const app = await aio.run({
    watch: false,
    cells: [holder],
    appId: "oadclose",
    client: "server-only",
    libraryMode: true,
    port: freePort(),
    appDir: dir,
  });
  try {
    await holder.arm();
    await app.close();
    steps.push("closed");
    assertEquals(steps, ["dispose:start", "dispose:done", "closed"]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("own: disposeAll starts every disposer synchronously in LIFO order and settles after the async ones", async () => {
  const seen: string[] = [];
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  // deno-lint-ignore no-explicit-any
  const m = createOwnManager(log as any);
  const set = (id: string, d: () => unknown) => {
    const e = own.set(id, () => d);
    m.handle(e);
  };
  set("a", () => seen.push("a"));
  set("b", async () => {
    seen.push("b:start");
    await new Promise((r) => setTimeout(r, 30));
    seen.push("b:done");
  });
  set("c", () => {
    throw new Error("c fails");
  });
  set("d", () => Promise.reject(new Error("d fails")));
  const p = m.disposeAll();
  assertEquals(seen, ["b:start", "a"], "all started, LIFO, synchronously");
  await p; // never rejects
  assert(seen.includes("b:done"));
  assertEquals(m.active(), []);
});

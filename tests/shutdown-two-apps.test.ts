// Two apps, one process — one of them closing must be invisible to the other.
//
// D2 makes the runtime instance-scoped, and EVERY `testServer()` pair relies on
// it. Shutdown is where the scoping is easiest to lose, because almost every
// thing it touches is a module-level registry: the in-flight-call map, the
// pre-abort window for late starters, the pending-call set the drain waits on.
// `tests/shutdown-inflight.test.ts` pins those registries directly; this file
// pins the same claim end to end, through two REAL apps with their own disks —
// because the thing that actually matters is that app B's write still reaches
// B's database after A has closed.
import { assert, assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import type { MethodDraftMeta } from "../src/state/cell-impl.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Doc = { log: string[]; status: string };

async function defineCell(name: string) {
  const { cell } = await import("../mod.ts");
  return cell(name, {
    state: { log: [] as string[], status: "idle" } as Doc,
    methods: {
      note(s: Doc, v: string) {
        s.log = [...s.log, v];
      },
      // A long-running write loop — the "streaming reply" shape.
      async stream(s: Doc & Partial<MethodDraftMeta>, n: number) {
        s.status = "streaming";
        for (let i = 0; i < n; i++) {
          if (s.$signal?.aborted) {
            s.status = "aborted";
            return;
          }
          await sleep(5);
          s.log = [...s.log, `c${i}`];
        }
        s.status = "done";
      },
    },
  });
}

async function boot(name: string, dir: string, def: unknown) {
  const { aio } = await import("../mod.ts");
  return await aio.run({
    cells: [def],
    appId: name,
    appVersion: "0.0.0",
    client: "server-only",
    persist: true,
    libraryMode: true,
    port: freePort(),
    appDir: dir,
  } as Any) as Any;
}

Deno.test({
  name: "shutdown: closing app A neither cancels nor loses app B's work",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dirA = await Deno.makeTempDir({ prefix: "aio-two-apps-a-" });
    const dirB = await Deno.makeTempDir({ prefix: "aio-two-apps-b-" });
    try {
      const defA = await defineCell("twoA");
      const defB = await defineCell("twoB");
      const appA = await boot("two-apps-a", dirA, defA);
      const appB = await boot("two-apps-b", dirB, defB);

      // Both streaming, both mid-flight.
      const runA = (defA as Any).stream(400) as Promise<unknown>;
      const runB = (defB as Any).stream(6) as Promise<unknown>;
      await sleep(40);

      const t0 = Date.now();
      await appA.close();
      // A's own drain budget is 3s; it must not have waited on B at all.
      assert(
        Date.now() - t0 < 3000,
        `A's shutdown waited ${Date.now() - t0}ms — it sat on B's work`,
      );
      await runA;

      // B is untouched: its stream runs to completion, not to an abort.
      await runB;
      assertEquals(
        (appB.getState().twoB as Doc).status,
        "done",
        "A's shutdown must not have aborted B's in-flight method",
      );

      // …and B still ACCEPTS work: A closing must not have closed B's queue.
      await (defB as Any).note("after-A");
      await appB.close();

      const app2 = await boot("two-apps-b", dirB, await defineCell("twoB"));
      const restored = app2.getState().twoB as Doc;
      await app2.close();
      assertEquals(restored.status, "done");
      assert(
        restored.log.includes("after-A"),
        `B's post-A write must be on disk — got ${
          JSON.stringify(restored.log)
        }`,
      );
      assertEquals(
        restored.log.filter((v) => v.startsWith("c")).length,
        6,
        "every chunk B streamed is on B's disk",
      );
    } finally {
      await Deno.remove(dirA, { recursive: true }).catch(() => {});
      await Deno.remove(dirB, { recursive: true }).catch(() => {});
    }
  },
});

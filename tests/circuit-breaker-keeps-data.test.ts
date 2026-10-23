// A circuit-breaker trip must not erase the cell's data.
//
// The trip ran the same disable as `app.cells.disable`, state reset included,
// and the reset is persisted like any write. So an upstream outage — an async
// method failing `maxErrors` times — emptied a persisted cell for good: empty
// right away, empty after `app.cells.enable` (the documented recovery), and
// empty after a restart. The trip still disables the cell and runs its
// `onDestroy`; only the reset is gone. An explicit `disable` still resets.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { wcb } from "./fixtures/leftovers-rt-app.ts";

// deno-lint-ignore no-explicit-any
type D = any;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

const kept: D = cell("cbkeep", {
  state: { items: [] as string[] },
  methods: {
    add(s: { items: string[] }, x: string) {
      s.items.push(x);
    },
    async flaky() {
      await Promise.resolve();
      throw new Error("upstream down");
    },
  },
} as D);

Deno.test("circuit breaker trip: a persisted cell keeps its data", async () => {
  const baseDir = await tempDir("aio-cb-keep-");
  const boot = () =>
    testServer({
      cells: [kept],
      persist: true,
      baseDir,
      appId: "cb-keep",
      circuitBreaker: { maxErrors: 3 },
    } as D);
  try {
    {
      await using srv = await boot();
      await kept.add("a");
      await kept.add("b");
      for (let i = 0; i < 3; i++) await kept.flaky().catch(() => {});
      await tick(50);
      const cells = (srv.app as D).cells;
      assertEquals(
        cells.health().find((h: D) => h.name === "cbkeep").enabled,
        false,
        "the breaker tripped",
      );
      assertEquals((srv.state() as D).cbkeep.items, ["a", "b"]);
      cells.enable("cbkeep");
      await kept.add("c");
      assertEquals((srv.state() as D).cbkeep.items, ["a", "b", "c"]);
    }
    {
      await using srv = await boot();
      assertEquals(
        (srv.state() as D).cbkeep.items,
        ["a", "b", "c"],
        "a restart brings back what the trip kept",
      );
    }
  } finally {
    await dropTempDir(baseDir);
  }
});

const C = wcb as unknown as Record<"boom" | "ok", () => Promise<unknown>>;
const ENTRY = import.meta.resolve("./fixtures/leftovers-rt-app.ts");

for (const real of [false, true]) {
  Deno.test(`circuit breaker trip: a worker cell keeps its data (${real ? "real worker" : "in-isolate"})`, async () => {
    await using srv = await testServer({
      cells: [wcb],
      ...(real ? { workers: "real" as const, workerEntry: ENTRY } : {}),
      circuitBreaker: { maxErrors: 3 },
    });
    const n = () => (srv.state() as { wcb: { n: number } }).wcb.n;
    await C.ok();
    for (let i = 0; i < 3; i++) await C.boom().catch(() => {});
    await tick(50);
    assertEquals(n(), 1, "the trip keeps main's copy");
    (srv.app as D).cells.enable("wcb");
    await C.ok();
    await tick(50);
    // The worker's copy was kept too: a reset one would have answered 1.
    assertEquals(n(), 2);
  });
}

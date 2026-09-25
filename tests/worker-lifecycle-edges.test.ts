// A `worker: true` cell at the edges of its lifecycle behaves as the same cell
// on the main isolate does.
import { assert, assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { wcr, wdt } from "./fixtures/worker-lifecycle-edges-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-lifecycle-edges-app.ts");
const D = wdt as unknown as { boom(): Promise<void> };
const C = wcr as unknown as {
  inc(k: number): Promise<number>;
  boom(): Promise<void>;
  crash(): Promise<void>;
};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Cells = {
  health(): { name: string; enabled: boolean; errors: number }[];
  enable(name: string): void;
  disable(name: string): void;
};

// The main-thread fix (circuit-breaker-destroy-throws.test.ts) decided "did it
// trip?" right after `disable` returned — but a worker cell's disable answers
// by reply, so at that moment the cell still LOOKED disabled: `onTrip` ran and
// "circuit breaker tripped … auto-disabled" was reported for a cell the worker
// had rolled back and that stayed enabled.
Deno.test("worker circuit breaker: a trip whose onDestroy throws is no trip", async () => {
  for (const real of [false, true]) {
    const trips: number[] = [];
    const reported: string[] = [];
    await using srv = await testServer({
      cells: [wdt],
      ...(real ? { workers: "real" as const, workerEntry: ENTRY } : {}),
      circuitBreaker: { maxErrors: 2, onTrip: (_n, c) => trips.push(c) },
      onError: (e: { message: string }) => reported.push(e.message),
    });
    for (let i = 0; i < 2; i++) await D.boom().catch(() => {});
    await tick(100);
    const cells = (srv.app as unknown as { cells: Cells }).cells;
    const row = cells.health().find((h) => h.name === "wdt")!;
    assertEquals(row.enabled, true, `real=${real}`);
    assertEquals(trips, [], `real=${real}: a rolled-back trip is not a trip`);
    assertEquals(
      reported.filter((m) => m.includes("circuit breaker tripped")),
      [],
      `real=${real}`,
    );
    assert(
      reported.some((m) => m.includes("rolled back")),
      `real=${real}: ${JSON.stringify(reported)}`,
    );
  }
});

// …and a worker trip that does settle is reported, once, after it settled.
Deno.test("worker circuit breaker: a trip that settles calls onTrip once", async () => {
  const trips: [string, number][] = [];
  const reported: string[] = [];
  await using srv = await testServer({
    cells: [wcr],
    workers: "real",
    workerEntry: ENTRY,
    circuitBreaker: { maxErrors: 2, onTrip: (n, c) => trips.push([n, c]) },
    onError: (e: { message: string }) => reported.push(e.message),
  });
  for (let i = 0; i < 2; i++) await C.boom().catch(() => {});
  await tick(100);
  const cells = (srv.app as unknown as { cells: Cells }).cells;
  assertEquals(cells.health().find((h) => h.name === "wcr")!.enabled, false);
  assertEquals(trips, [["wcr", 2]]);
  assertEquals(
    reported.filter((m) => m.includes("circuit breaker tripped")).length,
    1,
  );
});

// A crashed worker cell is unreachable until a restart; its main copy is the
// last committed state. `enable()` on it reset that copy to the defaults —
// the data looked lost (and was persisted that way).
Deno.test("worker crash: enable() keeps the cell's last committed state", async () => {
  await using srv = await testServer({
    cells: [wcr],
    workers: "real",
    workerEntry: ENTRY,
  });
  assertEquals(await C.inc(5), 5);
  await C.crash();
  let err = "";
  for (let i = 0; i < 100 && !err; i++) {
    await tick(20);
    err = await C.inc(1).then(() => "", (e: Error) => e.message);
  }
  assert(err.includes("crashed"), `the cell never crashed: ${err}`);
  const cells = (srv.app as unknown as { cells: Cells }).cells;
  const n = () => (srv.state() as { wcr: { n: number } }).wcr.n;
  assertEquals(n(), 5);
  cells.disable("wcr");
  await tick(50);
  assertEquals(n(), 5, "after disable");
  cells.enable("wcr");
  await tick(50);
  assertEquals(n(), 5, "after enable");
});

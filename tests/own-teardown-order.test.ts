// Three quiet defects in the resource-ownership seam.
//
// 1. `disposeAll` walked the slots in ACQUISITION order. A resource acquired
//    later may depend on one acquired earlier (a socket on the server it
//    belongs to); the reverse cannot happen, because the earlier one did not
//    exist yet. So acquisition order tears a dependency down while its
//    dependent is still live — and it disagreed with the framework's own rule
//    one level up, where `destroyAll` walks cells in REVERSE order.
// 2. A factory parked by `own.set()` whose effect never reached the runtime
//    (a method that threw after calling it, a cell disabled between reduce and
//    execute) was retained — with its whole closure — for the life of the
//    process, unbounded and unreported.
// 3. `blocking.cancel(id)` stopped at the FIRST match. Two tasks under one id
//    (nothing prevents it) meant cancel returned true with the other still
//    burning a thread.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  _pendingFactoryCount,
  _resetPendingFactories,
  _setOwnClockForTests,
  createOwnManager,
  own,
} from "../src/state/own.ts";
import { createBlockingPool } from "../src/state/blocking.ts";

const noop = {
  info: (_: string) => {},
  warn: (_: string) => {},
  error: (_: string) => {},
  debug: (_: string) => {},
};

Deno.test("own: disposeAll tears down in REVERSE acquisition order", () => {
  const order: string[] = [];
  const m = createOwnManager(noop);
  for (const id of ["server", "socket", "watcher"]) {
    m.handle(own.set(id, () => () => order.push(id)));
  }
  assertEquals(m.active(), ["server", "socket", "watcher"]);
  m.disposeAll();
  assertEquals(
    order,
    ["watcher", "socket", "server"],
    "a later resource may depend on an earlier one — never the other way " +
      "round — so teardown must be LIFO, like destroyAll one level up",
  );
  assertEquals(m.active(), []);
});

Deno.test("own: disposeByPrefix tears down in REVERSE acquisition order too", () => {
  const order: string[] = [];
  const m = createOwnManager(noop);
  for (const id of ["c:a", "other", "c:b", "c:c"]) {
    m.handle(own.set(id, () => () => order.push(id)));
  }
  m.disposeByPrefix("c");
  assertEquals(order, ["c:c", "c:b", "c:a"]);
  assertEquals(m.active(), ["other"], "another cell's slot is untouched");
  m.disposeAll();
});

Deno.test("own: a BURST of parked factories is kept whole — only STALE ones are dropped, and reported", () => {
  _resetPendingFactories();
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
  let t = 1_000_000;
  _setOwnClockForTests(() => t);
  try {
    // 500 own.set() in ONE dispatch — a loop acquiring resources. The runtime
    // has not had its turn yet, so nothing may be dropped: dropping by count
    // here was the bug (64 kept, 436 silently never acquired, one warning
    // about a leak that was not one).
    const heavy = new Uint8Array(1024);
    for (let i = 0; i < 500; i++) {
      own.set(`burst:${i}`, () => () => void heavy.length);
    }
    assertEquals(_pendingFactoryCount(), 500, "a fresh burst is intact");
    assertEquals(warnings.length, 0, "and nothing was reported as a leak");
    // Six seconds later the same 500 are still parked: the shape of a method
    // that threw after own.set(), repeated by a retry loop. The next park
    // sweeps them, keeps itself, and says so — once.
    t += 6_000;
    own.set("later", () => () => {});
    assertEquals(
      _pendingFactoryCount(),
      1,
      "stale factories swept, the fresh one kept",
    );
    assert(
      warnings.some((w) => /own\.set\(\) factories were parked/i.test(w)),
      `dropping them silently is the same bug one layer down: ${
        JSON.stringify(warnings)
      }`,
    );
    assertEquals(
      warnings.filter((w) => /factories were parked/i.test(w)).length,
      1,
      "warned once, not once per drop",
    );
    // The memory bound still holds for a FRESH flood.
    for (let i = 0; i < 5000; i++) own.set(`flood:${i}`, () => () => {});
    assert(
      _pendingFactoryCount() <= 4096,
      `bounded even when everything is fresh — held ${_pendingFactoryCount()}`,
    );
  } finally {
    console.warn = orig;
    _setOwnClockForTests(null);
    _resetPendingFactories();
  }
});

Deno.test("own: a normal set/handle pair leaves nothing parked", () => {
  _resetPendingFactories();
  const m = createOwnManager(noop);
  m.handle(own.set("fine", () => () => {}));
  assertEquals(_pendingFactoryCount(), 0);
  m.disposeAll();
});

Deno.test("blocking: cancel(id) stops EVERY task under that id", async () => {
  const pool = createBlockingPool({ size: 2 });
  try {
    // Two long tasks under one id occupy both workers; a third waits queued
    // under the same id.
    const a = pool.run("scan", () => new Promise((r) => setTimeout(r, 5000)));
    const b = pool.run("scan", () => new Promise((r) => setTimeout(r, 5000)));
    const queued = pool.run("scan", () => "never");
    const other = pool.run<number>("other", (x) => (x as number) + 1, 1);
    await new Promise((r) => setTimeout(r, 60)); // let a + b reach workers

    assertEquals(pool.cancel("scan"), true);
    await assertRejects(() => a, Error, "cancelled");
    await assertRejects(
      () => b,
      Error,
      "cancelled",
    );
    await assertRejects(() => queued, Error, "cancelled");
    // …and the pool is still usable, with unrelated ids untouched.
    assertEquals(await other, 2);
    assertEquals(
      await pool.run<number>("after", (x) => (x as number) * 3, 4),
      12,
    );
    assertEquals(pool.cancel("scan"), false, "nothing left under that id");
  } finally {
    await pool.dispose();
  }
});

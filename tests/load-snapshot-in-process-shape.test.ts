// `app.loadSnapshot()` — the in-process door — must refuse a snapshot whose
// SHAPE is wrong exactly as the HTTP and trojan doors do. It checked only "is
// it an object", so `{"counter":42}` loaded silently and the next `counter`
// method threw REDUCE_ERROR on a state that is a number, far from the call
// that caused it.
import { assertEquals, assertThrows } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { snapshotShapeError } from "../src/server/server-static.ts";

Deno.test("app.loadSnapshot: a non-object cell value is refused with the shared decider's message, and state is untouched", async () => {
  const counter = cell("counter", {
    state: { count: 1 },
    methods: {
      inc(s: { count: number }) {
        s.count++;
      },
    },
  });
  const dir = await Deno.makeTempDir({ prefix: "aio-loadsnap-shape-" });
  const app = await aio.run({
    cells: [counter],
    appId: `loadsnap-${crypto.randomUUID().slice(0, 8)}`,
    appDir: dir,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    persist: false,
    port: freePort(),
    // deno-lint-ignore no-explicit-any
  } as any);
  try {
    const bad = '{"counter":42}';
    const expected = snapshotShapeError(JSON.parse(bad))!;
    assertThrows(() => app.loadSnapshot!(bad), Error, expected);
    // `force` is the override for the CELL SET, not for a broken shape.
    assertThrows(
      // deno-lint-ignore no-explicit-any
      () => (app.loadSnapshot as any)(bad, { force: true }),
      Error,
      expected,
    );
    // Nothing was swapped in: the cell still works.
    await counter.inc();
    assertEquals(
      (app.getState() as { counter: { count: number } }).counter.count,
      2,
    );
    // A well-shaped snapshot still loads.
    app.loadSnapshot!('{"counter":{"count":7}}');
    await counter.inc();
    assertEquals(
      (app.getState() as { counter: { count: number } }).counter.count,
      8,
    );
  } finally {
    await app.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

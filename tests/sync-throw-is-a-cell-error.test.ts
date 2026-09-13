// A SYNC method that throws must count as a cell error, like an async one.
//
// The error counter had two feeders: the `:__error` action (the ASYNC path)
// and the effect executor's catch. A reduce throw propagates straight past
// both — so the most common failure there is, a reducer that throws on every
// dispatch, was invisible to every health surface and immune to the circuit
// breaker.
//
// Measured, same cell, same config, only sync/async differing:
//
//   3 SYNC throws  → health "healthy", cell errors: 0, aio_cell_errors_total 0
//   1 ASYNC throw  → health "healthy", cell errors: 1
//
//   10 SYNC throws,  circuitBreaker maxErrors:3 → onTrip fired: []
//   10 ASYNC throws, same config                → onTrip fired: ["cell:3"]
//
// `docs/debugging/troubleshooting.md` tells an operator to diagnose exactly
// this with "high error counts" at `/__aio/health`. The existing coverage uses
// `async crash()` only, which is why the gap survived.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { composeCells } from "../src/state/cell-compose.ts";

function countFor(kind: "sync" | "async") {
  const c = kind === "sync"
    ? cell(`throwcount_s`, {
      state: { n: 0 },
      methods: {
        boom(_s: { n: number }) {
          throw new Error("reducer exploded");
        },
      },
    })
    : cell(`throwcount_a`, {
      state: { n: 0 },
      methods: {
        // deno-lint-ignore require-await
        async boom(_s: { n: number }) {
          throw new Error("reducer exploded");
        },
      },
    });
  return composeCells([c], { perfCheck: false });
}

Deno.test("cell errors: a sync reduce throw is counted", () => {
  const composed = countFor("sync");
  const id = composed.cells[0]!.__aio.id;
  let state: Record<string, unknown> = composed.initialState;
  for (let i = 0; i < 3; i++) {
    try {
      state = composed.reduce(state, { type: `${id}:boom`, payload: {} })
        .state as Record<string, unknown>;
    } catch { /* aio-ok: the throw IS the thing being counted */ }
  }
  const health = composed.registry.health(state);
  const row = health.find((h: { name: string }) => h.name === id);
  assert(row, "the cell must appear in health");
  assertEquals(
    (row as { errors: number }).errors,
    3,
    "three sync throws must read as three errors — an operator told to " +
      "diagnose by 'high error counts' saw zero",
  );
});

Deno.test("cell errors: an async throw still counts, and a clean call does not", () => {
  // Controls: the path that always worked must keep working, and a reduce
  // that does NOT throw must not be counted — a catch-all that counted every
  // dispatch would pass the test above and make the breaker fire on healthy
  // cells.
  const ok = cell("throwcount_ok", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });
  const composed = composeCells([ok], { perfCheck: false });
  let state: Record<string, unknown> = composed.initialState;
  for (let i = 0; i < 5; i++) {
    state = composed.reduce(state, {
      type: "throwcount_ok:bump",
      payload: { args: [] },
    }).state as Record<string, unknown>;
  }
  const row = composed.registry.health(state).find((h: { name: string }) =>
    h.name === "throwcount_ok"
  );
  assertEquals(
    (row as { errors: number }).errors,
    0,
    "a healthy cell must stay at zero",
  );
});

// …and when the breaker acts on those errors, every surface must say so.
//
// Measured after a trip: `/__aio/health` said `"healthy"`, the cell row said
// `status: "active"` beside `enabled: false`, and `errors` was 0 — because
// `disable()` called `clearCell`, which wipes the very count the breaker had
// just acted on. Three surfaces, one fact, three answers, at the one moment an
// operator most needs the number.
Deno.test({
  name: "circuit breaker: a tripped cell is visible on every surface",
  sanitizeOps: false, // aio-ok: a live server, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const { aio, cell: mkCell } = await import("../mod.ts");
    const { freePort } = await import("../src/testing/server-test.ts");
    const { tempDir } = await import("../src/testing/temp-dir.ts");

    const c = mkCell("tripper", {
      state: { n: 0 },
      methods: {
        boom(_s: { n: number }) {
          throw new Error("reducer exploded");
        },
      },
    });
    const port = freePort();
    const dir = await tempDir("aio-trip-");
    const app = await aio.run({
      cells: [c],
      appId: `trip-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      singleton: false,
      port,
      baseDir: dir,
      circuitBreaker: { maxErrors: 3, windowMs: 60_000 },
      // deno-lint-ignore no-explicit-any
    } as any);
    try {
      for (let i = 0; i < 6; i++) await c.boom().catch(() => {});
      await new Promise((r) => setTimeout(r, 200));

      const health = await (await fetch(
        `http://127.0.0.1:${port}/__aio/health`,
      )).json() as {
        status: string;
        cells: Record<
          string,
          { status: string; enabled: boolean; errors: number }
        >;
      };
      const row = health.cells.tripper;
      assert(row, `the cell must appear: ${JSON.stringify(health.cells)}`);
      assertEquals(row.enabled, false, "the breaker disabled it");
      assertEquals(
        row.status,
        "disabled",
        `a disabled cell must not report "active" — two fields of one row ` +
          `disagreeing about whether the framework just killed it`,
      );
      assert(
        row.errors > 0,
        "the error count must SURVIVE the disable — it is the evidence the " +
          "breaker acted on",
      );
      assertEquals(
        health.status,
        "degraded",
        `an app with a cell the framework killed is not "healthy" — this is ` +
          `the field a monitor alerts on`,
      );
    } finally {
      await app.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

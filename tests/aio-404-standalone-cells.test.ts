// AIO-404 — cell-based apps work in standalone (Android WebView) builds.
// The android scaffold generates `cell()` + `aio.run()` code, but
// standalone-air only had the legacy initStandalone({reduce}) API — bundles
// failed with "No matching export for 'cell'". Pins the new bridge:
// compose → local dispatch → bound methods → localStorage persistence.
import { assertEquals } from "@std/assert";
import { _reset, aio, cell, ensureConnected } from "../src/standalone-air.ts";

// Mock localStorage (same pattern as standalone-air.test.ts)
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storage.set(k, v);
    },
    removeItem: (k: string) => {
      storage.delete(k);
    },
  },
  configurable: true,
});

Deno.test("aio-404: standalone aio.run binds cells to the local loop", async () => {
  _reset();
  storage.clear();
  const counter = cell("sacounter", {
    state: { count: 0 },
    methods: {
      increment(s: { count: number }, by = 1) {
        s.count += by;
      },
    },
  });

  ensureConnected(); // generated entry calls this — must be a no-op here
  const app = await aio.run({ appId: "aio404", cells: [counter] });

  await counter.increment(5);
  await counter.increment(2);

  const state = app.getState() as { sacounter: { count: number } };
  assertEquals(state.sacounter.count, 7);
  // direct cell read goes through the same state
  assertEquals((counter as unknown as { count: number }).count, 7);

  await app.close(); // flushes persistence
  const persisted = JSON.parse(storage.get("aio:aio404")!);
  assertEquals(persisted.sacounter.count, 7);
});

Deno.test("aio-404: standalone restore from localStorage on next run", async () => {
  _reset();
  const counter = cell("sacounter2", {
    state: { count: 0 },
    methods: {
      increment(s: { count: number }, by = 1) {
        s.count += by;
      },
    },
  });
  storage.set("aio:aio404b", JSON.stringify({ sacounter2: { count: 41 } }));

  const app = await aio.run({ appId: "aio404b", cells: [counter] });
  await counter.increment();

  const state = app.getState() as { sacounter2: { count: number } };
  assertEquals(state.sacounter2.count, 42);
  await app.close();
});

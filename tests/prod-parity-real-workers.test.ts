// Prod parity: `worker: true` means a REAL worker when the test asks for one.
//
// The gap: under `libraryMode` the entry module is the TEST file, so worker
// cells ran in-isolate. The serialization boundary was reproduced
// (`tests/prod-parity-worker-boundary.test.ts`); ISOLATION was not. A worker
// cell in production gets its own heap and its own module graph — nothing at
// module level is shared with the main isolate — and in-isolate everything is.
// So a cell that keeps a counter, a cache, a client handle or a `let` at module
// scope behaved one way in every test and another way in production, with no
// message anywhere. That is the harness-more-permissive-than-production class
// this project calls disqualifying.
//
// `testServer({ workers: "real", workerEntry })` closes it: the test names a
// real app entry, the pool spawns the real thing, and the property is MEASURED
// rather than assumed — the same two measurements `tests/build-e2e.test.ts`
// makes against a COMPILED binary (state comes home; the main isolate keeps
// running while the cell burns its thread).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { cell } from "../src/state/cell.ts";
import {
  isolationProbe,
  moduleCallsHere,
} from "./fixtures/worker-isolation-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-isolation-app.ts");

// ── the difference itself ────────────────────────────────────────────────────
// One cell, two modes, opposite observations. Delete `workers: "real"` from the
// first test and it fails on the module-state assertion — which is exactly the
// bug an app would have shipped.

Deno.test("real workers: the worker has its OWN module graph", async () => {
  // A DELTA, not an absolute: `moduleCalls` is module state, and this file's
  // other test deliberately shares it. An order-dependent assertion here would
  // be exactly the kind of test this file exists to argue against.
  const before = moduleCallsHere();
  await using srv = await testServer({
    cells: [isolationProbe],
    workers: "real",
    workerEntry: ENTRY,
  });
  void srv;

  assertEquals(await isolationProbe.bump(), 1, "the worker's return came home");
  assertEquals(await isolationProbe.bump(), 2);
  assertEquals(await isolationProbe.bump(), 3);

  // The authoritative replica on the main isolate saw every commit.
  assertEquals(isolationProbe.calls, 3, "patches streamed home");
  assertEquals(
    isolationProbe.ranInWorker,
    true,
    "the method body ran inside a real cell worker",
  );
  // …and the module-level `let` the method incremented three times is NOT the
  // one this isolate holds. This is the assertion the old harness could not
  // make: in-isolate it reads 3.
  assertEquals(
    moduleCallsHere() - before,
    0,
    "module-level state leaked across the worker boundary — the worker is " +
      "sharing this isolate's module graph, so it is not a real worker",
  );
});

Deno.test("in-isolate (the default): module state IS shared — the gap, pinned", async () => {
  const before = moduleCallsHere();
  await using srv = await testServer({ cells: [isolationProbe] });
  void srv;

  await isolationProbe.bump();
  await isolationProbe.bump();

  assertEquals(isolationProbe.calls, 2);
  assertEquals(
    isolationProbe.ranInWorker,
    false,
    "in-isolate mode does not run in a worker, and must not claim to",
  );
  // The whole point: the SAME cell, the SAME method, the opposite answer. A
  // test written against this mode proves nothing about module-level state in
  // production.
  assertEquals(
    moduleCallsHere() - before,
    2,
    "in-isolate, the worker cell shares this isolate's module scope — if this " +
      "ever reads 0, the default mode changed and the docs must change with it",
  );
});

// ── the compiled-binary property, measured in-process ────────────────────────
// `tests/build-e2e.test.ts` proves a compiled binary keeps ticking while a
// worker cell burns its thread (>20 ticks of a 20ms interval during a 1.2s
// burn). Same measurement, same threshold shape, without the build.

Deno.test("real workers: the main isolate keeps running while the cell burns its thread", async () => {
  await using srv = await testServer({
    cells: [isolationProbe],
    workers: "real",
    workerEntry: ENTRY,
  });
  void srv;

  let ticks = 0;
  const t = setInterval(() => ticks++, 20);
  const ret = await isolationProbe.burn(700);
  clearInterval(t);

  assertEquals(ret, "burned");
  assertEquals(isolationProbe.burns, 1, "the burn committed its state home");
  assert(
    ticks > 10,
    `the main isolate stalled during the burn (${ticks} ticks in 700ms) — the ` +
      `cell ran in-isolate, so this mode is not reproducing isolation`,
  );
});

// ── strictness travels with the thread ───────────────────────────────────────
// A worker gets a FRESH global, and every dev tripwire is gated on
// `globalThis.__aioDev`. Spawning a real worker without carrying the flag would
// have BOUGHT isolation at the price of a more permissive test isolate — the
// one trade this project never makes.

Deno.test("real workers: dev-strict is armed inside the worker too", async () => {
  await using srv = await testServer({
    cells: [isolationProbe],
    workers: "real",
    workerEntry: ENTRY,
  });
  void srv;

  assertEquals(
    await isolationProbe.devArmed(),
    true,
    "the worker isolate ran without __aioDev — frozen-state enforcement, the " +
      "readonly hint and the hidden-field read guard are all off in there, so " +
      "the worker is MORE permissive than the test that spawned it",
  );
});

// ── the boundary is the REAL one, not the harness's stand-in ─────────────────
// In-isolate, the harness clones arguments itself so an uncloneable value fails
// in the test instead of in production (prod-parity-worker-boundary.test.ts).
// Under `workers: "real"` that stand-in is not used and must not be needed: the
// value goes through an actual `postMessage`, which refuses it on its own.

Deno.test("real workers: an uncloneable argument is refused by the real boundary", async () => {
  await using srv = await testServer({
    cells: [isolationProbe],
    workers: "real",
    workerEntry: ENTRY,
  });
  void srv;

  assertEquals(
    await isolationProbe.take({ n: 1 }),
    "object",
    "plain data crosses untouched",
  );
  // A function cannot be structured-cloned. In-isolate the harness raises a
  // teachable error; here the thread boundary itself refuses — and BOTH must
  // reject, in the same words. `postMessage` throws synchronously, so a bare
  // `send` would have thrown out of a call whose contract is "always returns a
  // Promise": a `.catch()` on it would not have seen it, and the two modes
  // would disagree about the shape of one mistake.
  const err = await assertRejects(
    () => isolationProbe.take({ onDone: () => "hi" }),
    Error,
  );
  assert(/isolationProbe/.test(err.message), err.message);
  assert(
    /worker boundary/.test(err.message),
    `the failure must explain the boundary: ${err.message}`,
  );
});

// ── the option refuses every way of meaning nothing ──────────────────────────
// A harness option that silently does nothing is the same failure as a config
// key nothing reads. Each of these throws at the call, naming the fix.

Deno.test("real workers: the option fails loud rather than degrading", async () => {
  const w = cell("realWorkerMisuse", {
    worker: true,
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });
  const plain = cell("realWorkerNoWorkerCell", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });

  await assertRejects(
    () => testServer({ cells: [w], workers: "real" }),
    Error,
    "needs workerEntry",
  );
  await assertRejects(
    () => testServer({ cells: [w], workerEntry: ENTRY }),
    Error,
    "would govern nothing",
  );
  await assertRejects(
    () =>
      testServer({
        cells: [w],
        workers: "real",
        workerEntry: "https://example.com/app.ts",
      }),
    Error,
    "must be a file: URL",
  );
  await assertRejects(
    () =>
      testServer({
        cells: [w],
        workers: "real",
        workerEntry: import.meta.resolve("./fixtures/does-not-exist.ts"),
      }),
    Error,
    "does not exist",
  );
  await assertRejects(
    () => testServer({ cells: [plain], workers: "real", workerEntry: ENTRY }),
    Error,
    "no cell in `cells` has worker: true",
  );

  // …and the internal key it sets is refused outside a harness. An app whose
  // worker cells were hosted from someone else's module is a data-owner change
  // wearing an underscore.
  const { aio } = await import("../src/server/aio.ts");
  await assertRejects(
    () =>
      aio.run({
        cells: [w],
        client: "server-only",
        persist: false,
        _workerEntry: ENTRY,
      }),
    Error,
    "only accepted under libraryMode",
  );
});

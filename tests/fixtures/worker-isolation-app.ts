// A REAL app entry, used two ways — which is the whole point.
//
// The TEST imports it to get the cell def (and `moduleCallsHere()`, this
// isolate's view of the module-level counter). A real cell worker spawned by
// `testServer({ workers: "real", workerEntry })` RE-IMPORTS it, gets its own
// copy of the module graph, and boots into cell-host mode — exactly what a
// compiled binary's worker does with the app's own entry.
//
// Not a test file: `deno test` only collects `*.test.ts`.
import { aio, cell, isCellWorker } from "aio";

/** Module-level state — the thing an isolate does NOT share with a worker.
 *  In-isolate this is the SAME binding the test reads; in a real worker the
 *  test's copy stays at 0 forever. */
let moduleCalls = 0;

/** What this isolate's copy of the module has counted. */
export function moduleCallsHere(): number {
  return moduleCalls;
}

export const isolationProbe = cell("isolationProbe", {
  worker: true,
  state: { calls: 0, burns: 0, ranInWorker: false },
  methods: {
    /** Touch module state and report where the body ran. */
    bump(s: { calls: number; ranInWorker: boolean }) {
      moduleCalls++;
      s.calls = moduleCalls;
      s.ranInWorker = isCellWorker();
      return moduleCalls;
    },
    /** Block this thread solid. The caller's isolate must keep ticking — that
     *  is the isolation property `tests/build-e2e.test.ts` measures on a
     *  COMPILED binary, measured here in-process. */
    burn(s: { burns: number }, ms: number) {
      const end = performance.now() + ms;
      while (performance.now() < end) { /* busy */ }
      s.burns++;
      return "burned";
    },
    /** Accept a payload, so the REAL postMessage clone can be exercised. */
    take(s: { calls: number }, payload: unknown) {
      s.calls++;
      return typeof payload;
    },
    /** Is `globalThis.__aioDev` armed where this body runs?
     *
     *  Every dev tripwire (frozen state, the readonly hint, the hidden-field
     *  read guard) is gated on it, and a worker gets a FRESH global — so a real
     *  worker that did not inherit the flag would be a test environment more
     *  permissive than the one that spawned it. */
    devArmed(_s: unknown) {
      return (globalThis as Record<string, unknown>).__aioDev === true;
    },
  },
});

// The production shape, verbatim: the entry calls aio.run() at the top level,
// aio.run() notices the cell-host worker name and serves that one cell forever.
// Guarded because the TEST imports this module too, and a test isolate must not
// boot a second app behind the harness's back.
if (isCellWorker()) {
  await aio.run({
    appId: "worker-isolation-probe",
    cells: [isolationProbe],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}

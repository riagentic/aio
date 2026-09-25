// A real app entry whose worker cell counts its own `onInit` runs — in the
// WORKER's module graph, which is the only place a real worker runs it.
//
// The test imports it for the def; a real cell worker spawned by
// `testServer({ workers: "real", workerEntry })` re-imports it and boots into
// cell-host mode. Not a test file: `deno test` only collects `*.test.ts`.
import { aio, cell, isCellWorker } from "aio";

/** onInit runs in THIS isolate's copy of the module. */
let inits = 0;

export const reseedProbe = cell("reseedProbe", {
  worker: true,
  state: { n: 0, boots: 0 },
  onInit(app) {
    inits++;
    // Idiom #1 of docs/state/lifecycle.md: an onInit that dispatches.
    app.dispatch({ type: "reseedProbe:booted", payload: { args: [] } });
  },
  methods: {
    set(s: { n: number }, n: number) {
      s.n = n;
    },
    booted(s: { boots: number }) {
      s.boots++;
    },
    /** How many times onInit ran where this body runs. */
    initCount(_s: unknown) {
      return inits;
    },
  },
});

if (isCellWorker()) {
  await aio.run({
    appId: "worker-reseed-probe",
    cells: [reseedProbe],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}

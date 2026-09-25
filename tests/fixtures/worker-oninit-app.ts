// A real app entry whose worker cells have the three `onInit` shapes an app
// writes: async (awaits, then dispatches), throwing, and rejecting — for
// tests/worker-oninit-failures.test.ts. The test imports it for the defs; a
// real cell worker spawned by `testServer({ workers: "real", workerEntry })`
// re-imports it and boots into cell-host mode.
import { aio, cell, isCellWorker } from "aio";

type S = { boots: number; n: number };
const methods = {
  booted(s: S) {
    s.boots++;
  },
  set(s: S, n: number) {
    s.n = n;
  },
  async boom(_s: S) {
    await Promise.resolve();
    throw new Error("boom in a method");
  },
};

/** Awaits, then dispatches — lifecycle.md idiom #1 across an await. */
export const wiAsync = cell("wiAsync", {
  worker: true,
  state: { boots: 0, n: 0 } as S,
  async onInit(app) {
    await new Promise((r) => setTimeout(r, 20));
    app.dispatch({ type: "wiAsync:booted", payload: { args: [] } });
  },
  methods,
});

/** Throws synchronously. */
export const wiThrow = cell("wiThrow", {
  worker: true,
  state: { boots: 0, n: 0 } as S,
  onInit() {
    throw new Error("wiThrow onInit exploded");
  },
  methods,
});

/** Rejects after an await. */
export const wiReject = cell("wiReject", {
  worker: true,
  state: { boots: 0, n: 0 } as S,
  async onInit() {
    await new Promise((r) => setTimeout(r, 5));
    throw new Error("wiReject onInit rejected");
  },
  methods,
});

if (isCellWorker()) {
  await aio.run({
    appId: "worker-oninit-probe",
    cells: [wiAsync, wiThrow, wiReject],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}

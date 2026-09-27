// A REAL app entry with the same cell twice — once `worker: true` — whose
// methods write whatever they are given into a `number` field. Imported by the
// test for the defs, and re-imported by a real cell worker spawned by
// `testServer({ workers: "real", workerEntry })`.
//
// Not a test file: `deno test` only collects `*.test.ts`.
import { aio, cell, isCellWorker } from "aio";

type N = { n: number };
const methods = {
  setN(s: N, v: unknown) {
    // deno-lint-ignore no-explicit-any
    (s as any).n = v;
  },
  async setNLater(s: N, v: unknown) {
    await Promise.resolve();
    // deno-lint-ignore no-explicit-any
    (s as any).n = v;
  },
};

export const typedWorker = cell("typedWorker", {
  worker: true,
  state: { n: 0 },
  methods,
  // `worker` is a real cell option; the inline literal needs the cast.
  // deno-lint-ignore no-explicit-any
} as any);

export const typedMain = cell("typedMain", { state: { n: 0 }, methods });

if (isCellWorker()) {
  await aio.run({
    appId: "worker-type-guard-probe",
    cells: [typedWorker, typedMain],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}

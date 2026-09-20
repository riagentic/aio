// A REAL app entry with a cell whose `validate` refuses, used two ways — the
// test imports the cell defs, and a real cell worker spawned by
// `testServer({ workers: "real", workerEntry })` re-imports it and boots into
// cell-host mode.
//
// The pair matters: `refusingWorker` and `refusingMain` are the SAME cell with
// one option different, so "does an in-process `await` reject?" has a control.
//
// Not a test file: `deno test` only collects `*.test.ts`.
import { aio, cell, isCellWorker } from "aio";

type N = { n: number };
const capped = (s: N) => s.n <= 10 ? true : "n may not exceed 10";

export const refusingWorker = cell("refusingWorker", {
  worker: true,
  state: { n: 0 },
  validate: capped,
  methods: {
    setN(s: N, n: number) {
      s.n = n;
      return s.n;
    },
  },
  // `worker` is a real cell option; the inline literal needs the cast.
  // deno-lint-ignore no-explicit-any
} as any);

export const refusingMain = cell("refusingMain", {
  state: { n: 0 },
  validate: capped,
  methods: {
    setN(s: N, n: number) {
      s.n = n;
      return s.n;
    },
  },
});

if (isCellWorker()) {
  await aio.run({
    appId: "worker-validate-probe",
    cells: [refusingWorker, refusingMain],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}

// A `worker: true` cell whose async methods use `concurrency: "first"` and
// `ttl` — for tests/worker-pending-policy-parity.test.ts. The test imports it
// for the def; a real cell worker spawned by `testServer({ workers: "real",
// workerEntry })` re-imports it and boots into cell-host mode.
import { aio, cell } from "aio";

type S = { runs: number };

export const wpp = cell("wpp", {
  worker: true,
  state: { runs: 0 } as S,
  concurrency: { scan: "first" },
  ttl: { get: 60_000 },
  methods: {
    async scan(s: S, key: string) {
      s.runs++;
      await new Promise((r) => setTimeout(r, 80));
      return `scan:${key}`;
    },
    async get(s: S, key: string) {
      s.runs++;
      await new Promise((r) => setTimeout(r, 40));
      return `get:${key}`;
    },
  },
});

if ((globalThis as { name?: string }).name?.startsWith("aio-cell:")) {
  await aio.run({
    appId: "worker-pending-policy-probe",
    cells: [wpp],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}

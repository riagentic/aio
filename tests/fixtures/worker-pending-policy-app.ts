// A `worker: true` cell whose async methods use `concurrency: "first"` and
// `ttl` — for tests/worker-pending-policy-parity.test.ts. The test imports it
// for the def; a real cell worker spawned by `testServer({ workers: "real",
// workerEntry })` re-imports it and boots into cell-host mode.
import { aio, cell } from "aio";

type S = { runs: number };

// Each `scan(key)` runs until the test calls `open(key)` — in whichever
// isolate executes the cell — so no reading depends on how long a timer took
// under load.
const gates = new Map<string, { p: Promise<void>; open: () => void }>();
const gate = (key: string) => {
  let g = gates.get(key);
  if (!g) {
    let open!: () => void;
    const p = new Promise<void>((r) => open = r);
    gates.set(key, g = { p, open });
  }
  return g;
};

export const wpp = cell("wpp", {
  worker: true,
  state: { runs: 0 } as S,
  concurrency: { scan: "first" },
  ttl: { get: 60_000 },
  methods: {
    async scan(s: S, key: string) {
      s.runs++;
      await gate(key).p;
      return `scan:${key}`;
    },
    open(_s: S, key: string) {
      gate(key).open();
      gates.delete(key);
    },
    /** A sync no-op: its reply comes back after every report the worker
     *  posted before it (both directions are FIFO) — a round trip, not a
     *  timer. */
    ping(_s: S) {},
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

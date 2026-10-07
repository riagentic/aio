// For tests/worker-respawn.test.ts: one `workerRespawn: true` cell and one plain
// `worker: true` cell with the same methods. Imported by the test for the
// defs; re-imported by a real worker, which hosts one of them.
import { aio, cell, isCellWorker } from "aio";

/** Per ISOLATE: a respawned worker has a fresh copy of both. */
let inits = 0;
const isolate = crypto.randomUUID();

type S = { n: number };

const probe = (name: string, workerRespawn: boolean) =>
  cell(name, {
    worker: true,
    workerRespawn,
    state: { n: 0 } as S,
    onInit() {
      inits++;
    },
    methods: {
      inc(s: S, k: number) {
        s.n += k;
        return s.n;
      },
      /** Which isolate ran this, and how many times `onInit` ran there. */
      where(_s: S) {
        return { isolate, inits };
      },
      crash(_s: S) {
        // An uncaught throw on the worker's own loop: the thread dies.
        setTimeout(() => {
          throw new Error("worker loop died");
        }, 0);
      },
      /** Commits one write, then dies with the call still in flight. */
      async dieMidway(s: S) {
        s.n += 100;
        await new Promise((r) => setTimeout(r, 20));
        setTimeout(() => {
          throw new Error("worker loop died");
        }, 0);
        await new Promise((r) => setTimeout(r, 5_000));
        s.n += 1000; // never reached
      },
      async hold(s: S, ms: number) {
        await new Promise((r) => setTimeout(r, ms));
        s.n += 1;
        return s.n;
      },
    },
  });

export const respawnProbe = probe("respawnProbe", true);
export const plainProbe = probe("plainProbe", false);

if (isCellWorker()) {
  await aio.run({
    watch: false,
    appId: "worker-respawn-probe",
    cells: [respawnProbe, plainProbe],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}

// A real app entry whose worker cell reaches for a PEER — the two things a
// real worker refuses (reading another cell's state, calling any cell's
// method) — plus a long async method to read `$pending` against.
//
// The test imports it for the defs; a real cell worker spawned by
// `testServer({ workers: "real", workerEntry })` re-imports it and boots into
// cell-host mode.
import { aio, cell, isCellWorker } from "aio";

export const wpPeer = cell("wpPeer", {
  state: { v: 7, bumps: 0 },
  methods: {
    bump(s: { v: number; bumps: number }) {
      s.bumps++;
      return s.bumps;
    },
  },
});

type H = { n: number };
export const wpHeavy = cell("wpHeavy", {
  worker: true,
  state: { n: 0 },
  methods: {
    readPeer(_s: H) {
      return (wpPeer as unknown as { v: number }).v;
    },
    async callPeer(_s: H): Promise<number> {
      await Promise.resolve();
      return await (wpPeer as unknown as { bump: () => Promise<number> })
        .bump();
    },
    /** Its OWN method, called from inside: nothing is bound in a worker. */
    async callSelf(_s: H): Promise<number> {
      return await (wpHeavy as unknown as { readOwn: () => Promise<number> })
        .readOwn();
    },
    readOwn(s: H) {
      return s.n;
    },
    async slow(s: H, ms: number) {
      await new Promise((r) => setTimeout(r, ms));
      s.n++;
      return s.n;
    },
  },
});

if (isCellWorker()) {
  await aio.run({
    appId: "worker-peer-access-probe",
    cells: [wpPeer, wpHeavy],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}

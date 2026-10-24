// For tests/worker-close-sync-burn-said.test.ts: a worker cell whose method
// spins synchronously. Re-imported by a real worker.
import { aio, cell, isCellWorker } from "aio";

export const wburn = cell("wburn", {
  worker: true,
  state: { n: 0 },
  methods: {
    spin(s, ms: number) {
      const end = Date.now() + ms;
      while (Date.now() < end) { /* a CPU loop nothing can interrupt */ }
      s.n += 1;
    },
    async wait(s, ms: number) {
      await new Promise((r) => setTimeout(r, ms)); // ignores s.$signal
      s.n += 1;
    },
    inc(s) {
      s.n += 1;
    },
  },
});

if (isCellWorker()) {
  await aio.run({
    watch: false,
    appId: "worker-sync-burn",
    cells: [wburn],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}

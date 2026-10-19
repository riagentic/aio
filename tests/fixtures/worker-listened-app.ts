// For tests/worker-listened-by-main-cell.test.ts: a main cell listening to a
// worker cell's method. Re-imported by a real worker.
import { aio, cell, isCellWorker } from "aio";

export const wlisSrc = cell("wlisSrc", {
  worker: true,
  state: { n: 0 },
  methods: {
    inc(s: { n: number }) {
      s.n += 1;
      return s.n;
    },
  },
});

export const wlisTarget = cell("wlisTarget", {
  state: { heard: 0 },
  listensTo: { onInc: wlisSrc.inc },
  methods: {
    onInc(s: { heard: number }) {
      s.heard += 1;
    },
  },
});

if (isCellWorker()) {
  await aio.run({
    watch: false,
    appId: "worker-listened",
    cells: [wlisSrc, wlisTarget],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}

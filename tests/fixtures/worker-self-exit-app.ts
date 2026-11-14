// A real app entry whose worker cells END THEIR OWN THREAD — `Deno.exit()`,
// `self.close()` — or crash while closing. Imported by
// tests/worker-self-exit.test.ts for the cell defs; a real cell worker
// spawned by `testServer({ workers: "real", workerEntry })` re-imports it and
// boots into cell-host mode.
import { aio, cell, own } from "aio";

type N = { n: number };

/** Exits its thread with `Deno.exit(3)` from a sync method. */
export const wexit = cell("wexit", {
  worker: true,
  state: { n: 0 },
  methods: {
    inc(s: N) {
      s.n++;
      return s.n;
    },
    quit(_s: N) {
      Deno.exit(3);
    },
  },
});

/** Ends its thread with `self.close()` from an ASYNC method. */
export const wclose = cell("wclose", {
  worker: true,
  state: { n: 0 },
  methods: {
    inc(s: N) {
      s.n++;
      return s.n;
    },
    async shut(_s: N) {
      await Promise.resolve();
      (globalThis as unknown as { close: () => void }).close();
      await new Promise(() => {}); // the thread is gone; never settles here
    },
  },
});

/** `workerRespawn: true` — an exit is one crash, and a fresh thread follows. */
export const wexitr = cell("wexitr", {
  worker: true,
  workerRespawn: true,
  state: { n: 0 },
  methods: {
    inc(s: N) {
      s.n++;
      return s.n;
    },
    quit(_s: N) {
      Deno.exit(4);
    },
  },
});

/** Its owned resource's disposer crashes the thread DURING close(). */
export const wteardown = cell("wteardown", {
  worker: true,
  state: { n: 0 },
  methods: {
    inc(s) {
      s.n++;
      s.$do(own.set("wteardown:res", () => async () => {
        setTimeout(() => {
          throw new Error("died-in-teardown");
        }, 0);
        await new Promise((r) => setTimeout(r, 200));
      }));
      return s.n;
    },
  },
});

if ((globalThis as { name?: string }).name?.startsWith("aio-cell:")) {
  await aio.run({
    watch: false,
    appId: "worker-self-exit-probe",
    cells: [wexit, wclose, wexitr, wteardown],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}

// A real app entry with a PEER-cell cancelOn trigger on a worker cell.
//
// The test imports it for the two cell defs; a real cell worker spawned by
// `testServer({ workers: "real", workerEntry })` re-imports it and boots into
// cell-host mode, exactly as a compiled binary's worker does.
import { aio, cell, notify } from "aio";

/** An ordinary main-isolate cell. Its `stop` is the TRIGGER. */
export const ctl = cell("ctl", {
  state: { stops: 0 },
  methods: {
    stop(s: { stops: number }) {
      s.stops++;
    },
  },
});

/** The worker cell whose in-flight method the trigger is supposed to abort. */
export const job = cell("job", {
  worker: true,
  state: { started: 0, aborted: false, finished: false },
  cancelOn: { slow: [ctl.stop] },
  methods: {
    async slow(s: { started: number; aborted: boolean; finished: boolean }) {
      s.started++;
      const sig = (s as unknown as { $signal: AbortSignal }).$signal;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 25));
        if (sig.aborted) {
          s.aborted = true;
          return "aborted";
        }
      }
      s.finished = true;
      return "finished";
    },
    /** A trigger that ORIGINATES in the worker. */
    poke(s: { started: number }) {
      s.started += 0;
    },
    /** A framework effect emitted from INSIDE the worker isolate. It is posted
     *  home and executed on main — which is where it used to vanish. */
    ping(s: { started: number }) {
      s.started += 0;
      (s as unknown as { $do: (e: unknown) => void }).$do(
        notify({ title: "from-a-worker-cell", body: "b" }),
      );
    },
  },
});

/** The OTHER direction: a main-isolate cell whose in-flight method a WORKER
 *  cell's action is supposed to abort. `route` hands a worker-cell action
 *  straight to its thread and never touches the main dispatch, so main's
 *  reduce — the only caller of `notifyMethodCancel` there — never ran for it. */
export const main = cell("main", {
  state: { aborted: false, finished: false },
  cancelOn: { wait: [job.poke] },
  methods: {
    async wait(s: { aborted: boolean; finished: boolean }) {
      const sig = (s as unknown as { $signal: AbortSignal }).$signal;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 25));
        if (sig.aborted) {
          s.aborted = true;
          return "aborted";
        }
      }
      s.finished = true;
      return "finished";
    },
  },
});

if ((globalThis as { name?: string }).name?.startsWith("aio-cell:")) {
  await aio.run({
    appId: "worker-cancelon-probe",
    cells: [ctl, job, main],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}

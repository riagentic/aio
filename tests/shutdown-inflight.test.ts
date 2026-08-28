// Shutdown must let in-flight async methods FINISH WRITING.
//
// Field report: a chat was streaming a reply from a local model when the
// window closed. Shutdown closed dispatch and *then* drained, so the method's
// next draft write hit a closed queue — it died mid-reply with
// EFFECT_ASYNC_ERROR, and everything it had streamed so far never reached the
// final persist. On the next launch the conversation was simply missing.
//
// The contract now, and what each test below pins:
//   1. shutdown ABORTS every in-flight call first (`s.$signal.aborted`), so a
//      stream that has no reason of its own to stop takes its own documented
//      cancellation path instead of being waited on for minutes;
//   2. the writes it makes on the way out COMMIT — a draining effect is the
//      framework's own work, not the late client input `close()` exists to
//      refuse (`tests/dispatch.test.ts` pins that half at the queue);
//   3. the final persist, which runs after the drain, therefore contains them;
//   4. a call that ignores its signal is bounded, never a held-open window.
import { assert, assertEquals } from "@std/assert";
import {
  _resetMethodCancel,
  abortAllInflight,
  pendingCalls,
  settlePending,
  trackPending,
} from "../src/state/method-cancel.ts";
import { freePort } from "../src/testing/server-test.ts";
import type { MethodDraftMeta } from "../src/state/cell-impl.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

type StreamState = { chunks: string[]; status: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot(dir: string, cells: unknown[]) {
  const { aio } = await import("../mod.ts");
  return await aio.run({
    cells,
    appId: "shutdown-inflight-app",
    appVersion: "0.0.0",
    client: "server-only",
    persist: true,
    libraryMode: true,
    port: freePort(),
    appDir: dir,
  } as Any);
}

Deno.test({
  name: "shutdown: a streaming method is aborted, and its last write persists",
  async fn() {
    const { cell } = await import("../mod.ts");
    const dir = await Deno.makeTempDir({ prefix: "aio-shutdown-inflight-" });
    const make = () =>
      cell("stream", {
        // alpha52: streaming = incremental by nature — the documented opt-out
        // (a transaction would buffer every chunk and discard on abort).
        transaction: false,
        state: { chunks: [] as string[], status: "idle" } as StreamState,
        methods: {
          // The shape of every streaming reply: an open-ended loop that only
          // its abort signal can end.
          async reply(s: StreamState & Partial<MethodDraftMeta>) {
            s.status = "streaming";
            for (let i = 0; i < 500; i++) {
              if (s.$signal?.aborted) {
                // The write that used to be lost: what the stream produced
                // before the window closed, plus how it ended.
                s.status = "aborted";
                return;
              }
              await sleep(4);
              s.chunks = [...s.chunks, `c${i}`];
            }
            s.status = "done";
          },
        },
      });

    try {
      const streamer = make();
      const app = await boot(dir, [streamer]) as Any;

      // Fire and do NOT await — the call is still running when we close, which
      // is the entire scenario.
      const call = (streamer as Any).reply() as Promise<unknown>;
      await sleep(60); // a few chunks in

      const mid = app.getState().stream as StreamState;
      assertEquals(mid.status, "streaming", "the scenario is real: mid-stream");
      assert(mid.chunks.length > 0, "chunks were already arriving");

      await app.close();

      // The caller is told the truth: the method ended, it did not blow up.
      await call;

      // Read the DISK, not `app.getState()` — a closed app releases its cells,
      // which resets the in-memory slice so the defs can bind again. What the
      // user gets back on next launch is the persisted document, and that is
      // exactly what the drain has to have reached.
      const app2 = await boot(dir, [make()]) as Any;
      const restored = app2.getState().stream as StreamState;
      await app2.close();
      assertEquals(
        restored.status,
        "aborted",
        "shutdown must abort in-flight calls so a stream can end itself, the " +
          "write it makes on the way out must COMMIT rather than die on a " +
          "closed queue, and the final persist must then capture it",
      );
      assert(
        restored.chunks.length >= mid.chunks.length &&
          restored.chunks.length < 500,
        `the partial stream survives: had ${mid.chunks.length} chunks ` +
          `mid-flight, persisted ${restored.chunks.length}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test("shutdown: settlePending is bounded — an unresponsive call cannot hold the window open", async () => {
  _resetMethodCancel();
  try {
    // A call that ignores its abort signal. Shutdown reports it and moves on;
    // waiting forever would mean a desktop app that never closes.
    trackPending(new Promise<void>(() => {}));
    assertEquals(pendingCalls(), 1);
    const t0 = Date.now();
    const stuck = await settlePending(50);
    assert(Date.now() - t0 < 2000, "settlePending must respect its deadline");
    assertEquals(stuck, 1, "it reports how many were still running");
  } finally {
    _resetMethodCancel();
  }
});

Deno.test("shutdown: settlePending returns 0 once every call has finished writing", async () => {
  _resetMethodCancel();
  try {
    let done = false;
    trackPending(
      sleep(20).then(() => {
        done = true;
      }),
    );
    assertEquals(await settlePending(2000), 0);
    assert(done, "it waited for the call, it did not just time out");
    assertEquals(pendingCalls(), 0, "settled calls are forgotten");
  } finally {
    _resetMethodCancel();
  }
});

Deno.test("shutdown: abortAllInflight aborts regardless of cancelOn triggers", async () => {
  _resetMethodCancel();
  try {
    const { trackCall } = await import("../src/state/method-cancel.ts");
    // No registerCancelOn for this method — nothing would ever abort it.
    const c = new AbortController();
    const untrack = trackCall("cellx", "streams", c);
    assertEquals(abortAllInflight(), 1);
    assert(c.signal.aborted, "shutdown aborts even an uncancellable method");
    // Idempotent: a second pass finds nothing, and untracking stays safe.
    assertEquals(abortAllInflight(), 0);
    untrack();
  } finally {
    _resetMethodCancel();
  }
});

Deno.test("shutdown: one app's shutdown leaves another app's calls alone", async () => {
  // Two apps in one process is a supported shape (D2: an instance-scoped
  // runtime — every `testServer()` pair does it), and cell BINDINGS are
  // already released per app. Cancellation is the same claim: an unscoped
  // abort would have app A's shutdown kill app B's streaming method mid-write,
  // which is precisely the data loss this whole change exists to stop.
  _resetMethodCancel();
  try {
    const { trackCall } = await import("../src/state/method-cancel.ts");
    const mine = new AbortController();
    const theirs = new AbortController();
    trackCall("appA-chat", "reply", mine);
    trackCall("appB-chat", "reply", theirs);
    trackPending(new Promise<void>(() => {}), "appB-chat"); // B, still running

    assertEquals(abortAllInflight(new Set(["appA-chat"])), 1);
    assert(mine.signal.aborted, "our own cell's call is aborted");
    assert(
      !theirs.signal.aborted,
      "the other app's call must survive our shutdown",
    );
    // …and our wait does not sit on their work either.
    const t0 = Date.now();
    assertEquals(await settlePending(500, new Set(["appA-chat"])), 0);
    assert(
      Date.now() - t0 < 400,
      "waiting on OUR cells must not block on theirs",
    );
  } finally {
    _resetMethodCancel();
  }
});

Deno.test("shutdown: a call that STARTS during the drain is born aborted", async () => {
  // `serialize: true` queues call B behind call A. Shutdown's abort sweep can
  // only reach controllers that exist at sweep time — B starts a moment later
  // with a FRESH controller, and without this pin it would stream signal-less
  // through the whole drain deadline and then lose its writes at the sealed
  // queue. The contract is "in-flight finishes writing, new work never
  // starts": a late starter gets an already-fired signal and takes its
  // documented cancellation path on the first check.
  _resetMethodCancel();
  try {
    const { endShutdownAbort, trackCall } = await import(
      "../src/state/method-cancel.ts"
    );
    const a = new AbortController();
    trackCall("appA-chat", "reply", a);
    abortAllInflight(new Set(["appA-chat"]));
    // B: was queued behind A, starts after the sweep.
    const b = new AbortController();
    trackCall("appA-chat", "reply", b);
    assert(b.signal.aborted, "a call starting mid-shutdown is born aborted");
    // Scoped: another app's late starter is untouched.
    const other = new AbortController();
    trackCall("appB-chat", "reply", other);
    assert(!other.signal.aborted, "another app's calls start live");
    // The window closes with the drain: the same names boot clean afterwards
    // (sequential tests reuse cell names in one process).
    endShutdownAbort(new Set(["appA-chat"]));
    const fresh = new AbortController();
    trackCall("appA-chat", "reply", fresh);
    assert(!fresh.signal.aborted, "after shutdown the name is reusable");
  } finally {
    _resetMethodCancel();
  }
});

// flow.test.ts — async-method workflows (perfect-aio D1)
//
// The method-native workflow capabilities that generators used to provide:
// multi-step async work, waiting on conditions (until), racing branches
// (race), sleeping, retries/timeouts (call), cancellation (cancelOn +
// s.$signal), and cross-cell coordination.

import { assertEquals, assertExists } from "@std/assert";
import { bindCell, cell, composeCells } from "../src/state/cell.ts";
import { race, sleep, until } from "../src/state/async-helpers.ts";
import { call, type MethodDraftMeta } from "../src/state/cell-impl.ts";

// ── Helpers ──────────────────────────────────────────────────────────

type Cat = Record<
  string,
  (...a: unknown[]) => { type: string; payload: unknown }
>;

/** Mini dispatch loop for testing — processes actions + effects synchronously where possible */
function createTestApp(entries: Parameters<typeof composeCells>[0]) {
  const composed = composeCells(entries);
  let state = { ...composed.initialState };
  const dispatched: { type: string; payload: unknown }[] = [];

  const app = {
    dispatch(action: { type: string; payload: unknown }) {
      dispatched.push(action);
      const result = composed.reduce(state, action);
      state = { ...result.state };
      for (const effect of result.effects) {
        composed.execute(app, effect as { type: string; payload: unknown });
      }
    },
    getState: () => state,
    dispatched,
    /** Wait for async work to complete */
    flush: () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
  };

  return app;
}

/** bindCell-compatible dispatch wrapper for the mini app. */
function wrapDispatch(
  app: { dispatch: (a: { type: string; payload: unknown }) => void },
): (a: { type: string; payload?: unknown }) => Promise<unknown> {
  return (a) =>
    Promise.resolve(
      app.dispatch(a as { type: string; payload: unknown }),
    );
}

// ── Basic workflow ───────────────────────────────────────────────────

const basic = cell("basic", {
  state: { value: 0, done: false },
  methods: {
    async start(s, n: number) {
      const doubled = await Promise.resolve(n * 2);
      s.value = doubled;
      s.done = true;
    },
  },
});

Deno.test("flow: basic async workflow updates state", async () => {
  const app = createTestApp([basic]);
  app.dispatch((basic.__aio.actions as Cat).start!(5));
  await app.flush();

  const s = app.getState().basic as { value: number; done: boolean };
  assertEquals(s.value, 10);
  assertEquals(s.done, true);
});

// ── Workflow-only cell (no sync methods) ─────────────────────────────

const flowOnly = cell("flowOnly", {
  state: { result: "" },
  methods: {
    async go(s, input: string) {
      const upper = await Promise.resolve(input.toUpperCase());
      s.result = upper;
    },
  },
});

Deno.test("flow: cell with only async workflow methods", async () => {
  const app = createTestApp([flowOnly]);
  app.dispatch((flowOnly.__aio.actions as Cat).go!("hello"));
  await app.flush();

  const s = app.getState().flowOnly as { result: string };
  assertEquals(s.result, "HELLO");
});

// ── Mixed cell (sync + async methods) ────────────────────────────────

const mixed = cell("mixed", {
  state: { count: 0, synced: false },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
    async sync(s) {
      await Promise.resolve();
      s.synced = true;
    },
  },
});

Deno.test("flow: mixed cell — sync method works independently", () => {
  const app = createTestApp([mixed]);
  app.dispatch((mixed.__aio.actions as Cat).increment!(5));
  const s = app.getState().mixed as { count: number };
  assertEquals(s.count, 5);
});

Deno.test("flow: mixed cell — async workflow works alongside sync methods", async () => {
  const app = createTestApp([mixed]);
  app.dispatch((mixed.__aio.actions as Cat).increment!(3));
  app.dispatch((mixed.__aio.actions as Cat).sync!());
  await app.flush();

  const s = app.getState().mixed as { count: number; synced: boolean };
  assertEquals(s.count, 3);
  assertEquals(s.synced, true);
});

// ── Workflow triggers another method ─────────────────────────────────

Deno.test("flow: async method triggers another method of the same cell", async () => {
  // deno-lint-ignore no-explicit-any
  let self: any;
  const putter = cell("putter", {
    state: { step: "" },
    methods: {
      update(s, step: string) {
        s.step = step;
      },
      async start(_s) {
        await self.update("from-flow");
      },
    },
  });
  self = putter;

  const app = createTestApp([putter]);
  bindCell(putter, wrapDispatch(app), () => app.getState());

  app.dispatch((putter.__aio.actions as Cat).start!());
  await app.flush();

  const s = app.getState().putter as { step: string };
  assertEquals(s.step, "from-flow");
  const updateAction = app.dispatched.find((d) => d.type === "putter:update");
  assertExists(updateAction);
});

// ── Throwing workflow stops before later writes ──────────────────────

const failer = cell("failer", {
  state: { value: 0 },
  methods: {
    async start(s) {
      const ok = await Promise.resolve(false);
      if (!ok) throw new Error("something went wrong");
      s.value = 999; // unreachable — the throw stops the workflow
    },
  },
});

Deno.test("flow: a throwing workflow stops — later writes never apply", async () => {
  const app = createTestApp([failer]);
  app.dispatch((failer.__aio.actions as Cat).start!());
  await app.flush();

  const s = app.getState().failer as { value: number };
  assertEquals(s.value, 0); // unreachable write didn't execute
});

// ── Workflow with sleep ──────────────────────────────────────────────

const sleeper = cell("sleeper", {
  state: { woke: false },
  methods: {
    async start(s) {
      await sleep(10);
      s.woke = true;
    },
  },
});

Deno.test("flow: sleep() pauses then continues", async () => {
  const app = createTestApp([sleeper]);
  app.dispatch((sleeper.__aio.actions as Cat).start!());

  const before = app.getState().sleeper as { woke: boolean };
  assertEquals(before.woke, false);

  await new Promise((r) => setTimeout(r, 80));

  const after = app.getState().sleeper as { woke: boolean };
  assertEquals(after.woke, true);
});

// ── Parallel work (Promise.all) ──────────────────────────────────────

const parallel = cell("parallel", {
  state: { a: 0, b: 0 },
  methods: {
    async start(s) {
      const [a, b] = await Promise.all([
        Promise.resolve(10),
        Promise.resolve(20),
      ]);
      s.a = a;
      s.b = b;
    },
  },
});

Deno.test("flow: Promise.all runs work in parallel", async () => {
  const app = createTestApp([parallel]);
  app.dispatch((parallel.__aio.actions as Cat).start!());
  await app.flush();

  const s = app.getState().parallel as { a: number; b: number };
  assertEquals(s.a, 10);
  assertEquals(s.b, 20);
});

// ── Racing branches ──────────────────────────────────────────────────

const racer = cell("racer", {
  state: { winner: "" },
  methods: {
    async start(s) {
      const result = await race({
        fast: Promise.resolve("fast-wins"),
        slow: sleep(500).then(() => "slow-wins"),
      });
      s.winner = result.winner;
    },
  },
});

Deno.test({
  name: "flow: race() picks first to resolve",
  // sanitizers disabled: race has intentional fire-and-forget losers (dangling timers)
}, async () => {
  const app = createTestApp([racer]);
  app.dispatch((racer.__aio.actions as Cat).start!());
  await app.flush();

  const s = app.getState().racer as { winner: string };
  assertEquals(s.winner, "fast");
});

// ── Multiple staged writes execute in order ──────────────────────────

const multiStep = cell("multiStep", {
  state: { steps: [] as string[] },
  methods: {
    async start(s) {
      s.steps.push("one");
      await Promise.resolve();
      s.steps.push("two");
      await Promise.resolve();
      s.steps.push("three");
    },
  },
});

Deno.test("flow: multiple staged writes execute in order", async () => {
  const app = createTestApp([multiStep]);
  app.dispatch((multiStep.__aio.actions as Cat).start!());
  await app.flush();

  const s = app.getState().multiStep as { steps: string[] };
  assertEquals(s.steps, ["one", "two", "three"]);
});

// ── until(): wait for a signal ───────────────────────────────────────

const waiter = cell("waiter", {
  // alpha52: pins pre-transaction live/incremental semantics explicitly.
  transaction: false,
  state: { received: "", inbox: "" },
  methods: {
    signal(s, msg: string) {
      s.inbox = msg;
    },
    async start(s) {
      await until(() => s.inbox !== "", { timeoutMs: 2000, intervalMs: 5 });
      s.received = s.inbox;
    },
  },
});

Deno.test("flow: until() pauses a workflow until a signal arrives", async () => {
  const app = createTestApp([waiter]);
  app.dispatch((waiter.__aio.actions as Cat).start!());
  await new Promise((r) => setTimeout(r, 20));

  assertEquals((app.getState().waiter as { received: string }).received, "");

  app.dispatch((waiter.__aio.actions as Cat).signal!("hello"));
  await new Promise((r) => setTimeout(r, 50));

  assertEquals(
    (app.getState().waiter as { received: string }).received,
    "hello",
  );
});

const timeoutWaiter = cell("timeoutWaiter", {
  state: { timedOut: false },
  methods: {
    async start(s) {
      try {
        await until(() => false, { timeoutMs: 50, intervalMs: 5 });
      } catch {
        s.timedOut = true;
      }
    },
  },
});

Deno.test("flow: until() with timeout throws on expiry", async () => {
  const app = createTestApp([timeoutWaiter]);
  app.dispatch((timeoutWaiter.__aio.actions as Cat).start!());
  await new Promise((r) => setTimeout(r, 200));

  assertEquals(
    (app.getState().timeoutWaiter as { timedOut: boolean }).timedOut,
    true,
  );
});

// ── Fresh state reads mid-workflow ───────────────────────────────────

const stateReader = cell("stateReader", {
  state: { count: 0, doubled: 0 },
  methods: {
    async start(s) {
      s.count = 5;
      await Promise.resolve();
      // s.count reads fresh state through the live proxy
      s.doubled = s.count * 2;
    },
  },
});

Deno.test("flow: workflow reads fresh state after a write", async () => {
  const app = createTestApp([stateReader]);
  app.dispatch((stateReader.__aio.actions as Cat).start!());
  await app.flush();

  const s = app.getState().stateReader as { count: number; doubled: number };
  assertEquals(s.count, 5);
  assertEquals(s.doubled, 10);
});

// ── cancelOn + s.$signal ─────────────────────────────────────────────

const cancellable = cell("cancellable", {
  // alpha52: pins pre-transaction live/incremental semantics explicitly.
  transaction: false,
  state: { running: false, finished: false },
  cancelOn: { start: ["cancellable:stop"] },
  methods: {
    stop(_s) {},
    async start(
      s: { running: boolean; finished: boolean } & Partial<MethodDraftMeta>,
    ) {
      s.running = true;
      await sleep(100);
      if (s.$signal!.aborted) {
        s.running = false;
        return;
      }
      s.running = false;
      s.finished = true;
    },
  },
});

Deno.test("flow: cancelOn aborts the workflow when matching action dispatched", async () => {
  const app = createTestApp([cancellable]);
  app.dispatch((cancellable.__aio.actions as Cat).start!());
  await new Promise((r) => setTimeout(r, 30));

  assertEquals(
    (app.getState().cancellable as { running: boolean }).running,
    true,
  );

  app.dispatch((cancellable.__aio.actions as Cat).stop!());
  await new Promise((r) => setTimeout(r, 150));

  assertEquals(
    (app.getState().cancellable as { finished: boolean }).finished,
    false,
  );
});

// ══════════════════════════════════════════════════════════════════════
// Edge cases — race, until, cancellation corner cases
// ══════════════════════════════════════════════════════════════════════

// ── race with 3 entries resolving near-simultaneously ────────────────

const race3 = cell("race3", {
  state: { winner: "" },
  methods: {
    async start(s) {
      const result = await race({
        a: sleep(5).then(() => "A"),
        b: sleep(5).then(() => "B"),
        c: sleep(5).then(() => "C"),
      });
      s.winner = result.winner;
    },
  },
});

Deno.test({
  name: "flow edge: race() with 3 near-simultaneous entries picks exactly one",
}, async () => {
  const app = createTestApp([race3]);
  app.dispatch((race3.__aio.actions as Cat).start!());
  await new Promise((r) => setTimeout(r, 100));

  const s = app.getState().race3 as { winner: string };
  assertEquals(["a", "b", "c"].includes(s.winner), true);
});

// ── race where instant (already-resolved) entry beats async ──────────

const raceSyncAsync = cell("raceSyncAsync", {
  state: { winner: "" },
  methods: {
    async start(s) {
      const result = await race({
        sync: Promise.resolve("instant"),
        slow: sleep(500).then(() => "delayed"),
      });
      s.winner = result.winner;
    },
  },
});

Deno.test({
  name: "flow edge: race() — already-resolved branch beats async",
}, async () => {
  const app = createTestApp([raceSyncAsync]);
  app.dispatch((raceSyncAsync.__aio.actions as Cat).start!());
  await app.flush();

  const s = app.getState().raceSyncAsync as { winner: string };
  assertEquals(s.winner, "sync");
});

// ── until with timeoutMs=0 — times out on first poll ─────────────────

const zeroTimeout = cell("zeroTimeout", {
  state: { timedOut: false },
  methods: {
    async start(s) {
      try {
        await until(() => false, { timeoutMs: 0, intervalMs: 5 });
      } catch {
        s.timedOut = true;
      }
    },
  },
});

Deno.test("flow edge: until() with timeoutMs=0 times out immediately", async () => {
  const app = createTestApp([zeroTimeout]);
  app.dispatch((zeroTimeout.__aio.actions as Cat).start!());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals(
    (app.getState().zeroTimeout as { timedOut: boolean }).timedOut,
    true,
  );
});

// ── timeout on slow work via race() timeout sugar ────────────────────

const callTimeout = cell("callTimeout", {
  state: { result: "" },
  methods: {
    async start(s) {
      const r = await race({ work: sleep(500), timeout: 20 });
      s.result = r.winner === "timeout" ? "timed-out" : "completed";
    },
  },
});

Deno.test({
  name: "flow edge: race() timeout sugar bounds slow work",
}, async () => {
  const app = createTestApp([callTimeout]);
  app.dispatch((callTimeout.__aio.actions as Cat).start!());
  await new Promise((r) => setTimeout(r, 100));

  assertEquals(
    (app.getState().callTimeout as { result: string }).result,
    "timed-out",
  );
});

// ── call() with retries — retries then succeeds ──────────────────────

const callRetry = cell("callRetry", {
  state: { attempts: 0, result: "" },
  methods: {
    async start(s) {
      let attempts = 0;
      const val = await call({ retries: 3 }, () => {
        attempts++;
        if (attempts < 3) return Promise.reject(new Error("not yet"));
        return Promise.resolve("ok");
      });
      s.attempts = attempts;
      s.result = val as string;
    },
  },
});

Deno.test("flow edge: call() with retries recovers after failures", async () => {
  const app = createTestApp([callRetry]);
  app.dispatch((callRetry.__aio.actions as Cat).start!());
  await new Promise((r) => setTimeout(r, 200));

  const s = app.getState().callRetry as { attempts: number; result: string };
  assertEquals(s.attempts, 3);
  assertEquals(s.result, "ok");
});

// ── call() with retries — exhausts retries and fails ─────────────────

const callRetryFail = cell("callRetryFail", {
  state: { result: "" },
  methods: {
    async start(s) {
      try {
        await call({ retries: 2 }, () => Promise.reject(new Error("nope")));
        s.result = "ok";
      } catch {
        s.result = "exhausted";
      }
    },
  },
});

Deno.test("flow edge: call() exhausts retries then throws", async () => {
  const app = createTestApp([callRetryFail]);
  app.dispatch((callRetryFail.__aio.actions as Cat).start!());
  await app.flush();

  assertEquals(
    (app.getState().callRetryFail as { result: string }).result,
    "exhausted",
  );
});

// ── Cancel mid-Promise.all — completion writes don't apply ───────────

const cancelMidAll = cell("cancelMidAll", {
  state: { done: false },
  cancelOn: { start: ["cancelMidAll:abort"] },
  methods: {
    abort(_s) {},
    async start(s: { done: boolean } & Partial<MethodDraftMeta>) {
      await Promise.all([Promise.resolve(1), sleep(200)]);
      if (s.$signal!.aborted) return;
      s.done = true;
    },
  },
});

Deno.test({
  name: "flow edge: cancel mid-Promise.all prevents done",
}, async () => {
  const app = createTestApp([cancelMidAll]);
  app.dispatch((cancelMidAll.__aio.actions as Cat).start!());
  await new Promise((r) => setTimeout(r, 20));

  // Cancel while the slow branch is still pending
  app.dispatch((cancelMidAll.__aio.actions as Cat).abort!());
  await new Promise((r) => setTimeout(r, 250));

  assertEquals((app.getState().cancelMidAll as { done: boolean }).done, false);
});

// ── Promise.all with one entry throwing — whole all fails ────────────

const allWithError = cell("allWithError", {
  state: { result: "" },
  methods: {
    async start(s) {
      try {
        await Promise.all([
          Promise.resolve(1),
          Promise.reject(new Error("fail")),
        ]);
        s.result = "ok";
      } catch {
        s.result = "caught";
      }
    },
  },
});

Deno.test("flow edge: Promise.all fails if any entry throws", async () => {
  const app = createTestApp([allWithError]);
  app.dispatch((allWithError.__aio.actions as Cat).start!());
  await app.flush();

  assertEquals(
    (app.getState().allWithError as { result: string }).result,
    "caught",
  );
});

// ── race where all entries reject — race rejects ─────────────────────

const raceAllFail = cell("raceAllFail", {
  state: { result: "" },
  methods: {
    async start(s) {
      try {
        await race({
          a: Promise.reject(new Error("a-fail")),
          b: Promise.reject(new Error("b-fail")),
        });
        s.result = "ok";
      } catch {
        s.result = "all-failed";
      }
    },
  },
});

Deno.test("flow edge: race() rejects when first entry rejects", async () => {
  const app = createTestApp([raceAllFail]);
  app.dispatch((raceAllFail.__aio.actions as Cat).start!());
  await app.flush();

  assertEquals(
    (app.getState().raceAllFail as { result: string }).result,
    "all-failed",
  );
});

// ── Cross-cell state reads ───────────────────────────────────────────

Deno.test("flow: workflow reads another cell's state", async () => {
  const provider = cell("provider", {
    state: { value: 42 },
    methods: {},
  });

  const consumer = cell("consumer", {
    state: { grabbed: 0 },
    methods: {
      async start(s) {
        await Promise.resolve();
        s.grabbed = provider.value;
      },
    },
  });

  const app = createTestApp([provider, consumer]);
  bindCell(provider, wrapDispatch(app), () => app.getState());

  app.dispatch((consumer.__aio.actions as Cat).start!());
  await app.flush();

  assertEquals((app.getState().consumer as { grabbed: number }).grabbed, 42);
});

// ── until() on conditions ────────────────────────────────────────────

const whenImmediate = cell("whenImmediate", {
  state: { ready: true, proceeded: false },
  methods: {
    async start(s) {
      // Condition is already true — resolves instantly
      await until(() => s.ready, { timeoutMs: 500, intervalMs: 5 });
      s.proceeded = true;
    },
  },
});

Deno.test("flow: until() resolves immediately when condition already true", async () => {
  const app = createTestApp([whenImmediate]);
  app.dispatch((whenImmediate.__aio.actions as Cat).start!());
  await app.flush();

  assertEquals(
    (app.getState().whenImmediate as { proceeded: boolean }).proceeded,
    true,
  );
});

Deno.test("flow: until() resolves when another cell's state changes", async () => {
  const whenTrigger = cell("whenTrigger", {
    state: { active: false },
    methods: {
      activate(s) {
        s.active = true;
      },
    },
  });

  const whenWaiter = cell("whenWaiter", {
    state: { saw: false },
    methods: {
      async start(s) {
        await until(() => whenTrigger.active === true, {
          timeoutMs: 2000,
          intervalMs: 5,
        });
        s.saw = true;
      },
    },
  });

  const app = createTestApp([whenTrigger, whenWaiter]);
  bindCell(whenTrigger, wrapDispatch(app), () => app.getState());

  app.dispatch((whenWaiter.__aio.actions as Cat).start!());
  await new Promise((r) => setTimeout(r, 30));

  // Condition not yet true
  assertEquals((app.getState().whenWaiter as { saw: boolean }).saw, false);

  // Trigger the condition
  app.dispatch((whenTrigger.__aio.actions as Cat).activate!());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenWaiter as { saw: boolean }).saw, true);
});

// ── Cancellation while waiting on a condition ────────────────────────

const whenCancelled = cell("whenCancelled", {
  state: { done: false },
  cancelOn: { start: ["whenCancelled:stop"] },
  methods: {
    stop(_s) {},
    async start(s: { done: boolean } & Partial<MethodDraftMeta>) {
      try {
        // never true — the abort signal is the only way out
        await until(() => false, {
          timeoutMs: 5000,
          intervalMs: 5,
          signal: s.$signal,
        });
      } catch {
        return; // aborted (or timed out) — don't mark done
      }
      s.done = true;
    },
  },
});

Deno.test({
  name: "flow: cancelling a workflow waiting on until() stops the wait",
}, async () => {
  const app = createTestApp([whenCancelled]);
  app.dispatch((whenCancelled.__aio.actions as Cat).start!());
  await new Promise((r) => setTimeout(r, 30));

  // Cancel
  app.dispatch((whenCancelled.__aio.actions as Cat).stop!());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenCancelled as { done: boolean }).done, false);
});

// ── Multiple independent waiters ─────────────────────────────────────

Deno.test("flow: multiple until() waiters resolve independently", async () => {
  const whenMultiTrigger = cell("whenMultiTrigger", {
    state: { a: false, b: false },
    methods: {
      setA(s) {
        s.a = true;
      },
      setB(s) {
        s.b = true;
      },
    },
  });

  const whenMultiA = cell("whenMultiA", {
    state: { resolved: false },
    methods: {
      async start(s) {
        await until(() => whenMultiTrigger.a === true, {
          timeoutMs: 2000,
          intervalMs: 5,
        });
        s.resolved = true;
      },
    },
  });

  const whenMultiB = cell("whenMultiB", {
    state: { resolved: false },
    methods: {
      async start(s) {
        await until(() => whenMultiTrigger.b === true, {
          timeoutMs: 2000,
          intervalMs: 5,
        });
        s.resolved = true;
      },
    },
  });

  const app = createTestApp([whenMultiTrigger, whenMultiA, whenMultiB]);
  bindCell(whenMultiTrigger, wrapDispatch(app), () => app.getState());

  app.dispatch((whenMultiA.__aio.actions as Cat).start!());
  app.dispatch((whenMultiB.__aio.actions as Cat).start!());
  await new Promise((r) => setTimeout(r, 30));

  // Trigger A only
  app.dispatch((whenMultiTrigger.__aio.actions as Cat).setA!());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals(
    (app.getState().whenMultiA as { resolved: boolean }).resolved,
    true,
  );
  assertEquals(
    (app.getState().whenMultiB as { resolved: boolean }).resolved,
    false,
  );

  // Trigger B
  app.dispatch((whenMultiTrigger.__aio.actions as Cat).setB!());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals(
    (app.getState().whenMultiB as { resolved: boolean }).resolved,
    true,
  );
});

// ── Two sequential waits in one workflow ─────────────────────────────

Deno.test("flow: workflow with two sequential waits (condition then signal)", async () => {
  const whenAndWaitForTrigger = cell("whenAndWaitForTrigger", {
    state: { ready: false },
    methods: {
      activate(s) {
        s.ready = true;
      },
    },
  });

  const whenAndWaitFor = cell("whenAndWaitFor", {
    // alpha52: live until()-waits — the opted-out shape.
    transaction: false,
    state: { phase: "init", signalled: false },
    methods: {
      signal(s) {
        s.signalled = true;
      },
      async start(s) {
        // First wait for another cell's state condition
        await until(() => whenAndWaitForTrigger.ready === true, {
          timeoutMs: 2000,
          intervalMs: 5,
        });
        s.phase = "condition-met";

        // Then wait for our own signal
        await until(() => s.signalled, { timeoutMs: 2000, intervalMs: 5 });
        s.phase = "complete";
      },
    },
  });

  const app = createTestApp([whenAndWaitForTrigger, whenAndWaitFor]);
  bindCell(whenAndWaitForTrigger, wrapDispatch(app), () => app.getState());

  app.dispatch((whenAndWaitFor.__aio.actions as Cat).start!());
  await new Promise((r) => setTimeout(r, 30));

  assertEquals(
    (app.getState().whenAndWaitFor as { phase: string }).phase,
    "init",
  );

  // Satisfy the state condition
  app.dispatch((whenAndWaitForTrigger.__aio.actions as Cat).activate!());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals(
    (app.getState().whenAndWaitFor as { phase: string }).phase,
    "condition-met",
  );

  // Satisfy the signal
  app.dispatch((whenAndWaitFor.__aio.actions as Cat).signal!());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals(
    (app.getState().whenAndWaitFor as { phase: string }).phase,
    "complete",
  );
});

// ── until() inside race() ────────────────────────────────────────────

Deno.test({
  name: "flow: until() inside race() resolves when condition met",
}, async () => {
  const whenRaceTrigger = cell("whenRaceTrigger", {
    state: { flag: false },
    methods: {
      setFlag(s) {
        s.flag = true;
      },
    },
  });

  const whenRace = cell("whenRace", {
    state: { winner: "" },
    methods: {
      async start(s) {
        const result = await race({
          condition: until(() => whenRaceTrigger.flag === true, {
            timeoutMs: 2000,
            intervalMs: 5,
          }),
          timeout: 500,
        });
        s.winner = result.winner;
      },
    },
  });

  const app = createTestApp([whenRaceTrigger, whenRace]);
  bindCell(whenRaceTrigger, wrapDispatch(app), () => app.getState());

  app.dispatch((whenRace.__aio.actions as Cat).start!());
  await new Promise((r) => setTimeout(r, 30));

  app.dispatch((whenRaceTrigger.__aio.actions as Cat).setFlag!());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals(
    (app.getState().whenRace as { winner: string }).winner,
    "condition",
  );
});

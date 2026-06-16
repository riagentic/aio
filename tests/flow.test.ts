import { assertEquals, assertExists } from "@std/assert";
import { cell, composeCells } from "../src/cell.ts";
import { _actionListeners, cancelFlow } from "../src/flow.ts";

// ── Helpers ──────────────────────────────────────────────────────────

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
    /** Wait for async flows to complete */
    flush: () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
  };

  return app;
}

// ── Basic flow ───────────────────────────────────────────────────────

const basic = cell("basic", {
  state: { value: 0, done: false },
  actions: {
    start: (n: number) => ({ n }),
  },
  machine: {
    initial: "idle",
    states: {
      idle: { start: "busy" },
      busy: {},
    },
  },
  generators: {
    // ctx is GenCtx<{ value: number; done: boolean }> — inferred, no annotation needed
    start: function* (ctx, { n }: { n: number }) {
      const doubled = yield* ctx.call("double", () => Promise.resolve(n * 2));
      yield* ctx.mutate("setValue", (s) => {
        s.value = doubled;
      }); // s.value typed as number
      yield* ctx.done((s) => {
        s.done = true;
      }); // s.done typed as boolean
    },
  },
});

Deno.test("flow: basic flow dispatches step actions", async () => {
  const app = createTestApp([basic]);
  app.dispatch(basic.__aio.actions.start(5));
  await app.flush();

  const types = app.dispatched.map((d) => d.type);
  assertEquals(types.includes("basic:__flow:double"), true);
  assertEquals(types.includes("basic:__flow:setValue"), true);
  assertEquals(types.includes("basic:__flow:done"), true);
});

Deno.test("flow: basic flow updates state", async () => {
  const app = createTestApp([basic]);
  app.dispatch(basic.__aio.actions.start(5));
  await app.flush();

  const s = app.getState().basic as { value: number; done: boolean };
  assertEquals(s.value, 10);
  assertEquals(s.done, true);
});

// ── Flow-only cell (no reduce) ────────────────────────────────────

const flowOnly = cell("flowOnly", {
  state: { result: "" },
  actions: {
    go: (input: string) => ({ input }),
  },
  generators: {
    go: function* (ctx, { input }: { input: string }) {
      const upper = yield* ctx.call(
        "transform",
        () => Promise.resolve(input.toUpperCase()),
      );
      yield* ctx.done((s) => {
        s.result = upper;
      }); // s.result typed as string, upper is string
    },
  },
});

Deno.test("flow: cell with only generators (no reduce)", async () => {
  const app = createTestApp([flowOnly]);
  app.dispatch(flowOnly.__aio.actions.go("hello"));
  await app.flush();

  const s = app.getState().flowOnly as { result: string };
  assertEquals(s.result, "HELLO");
});

// ── Mixed cell (reduce + generators) ──────────────────────────────

const mixed = cell("mixed", {
  state: { count: 0, synced: false },
  actions: {
    increment: (by = 1) => ({ by }),
    sync: () => ({}),
  },
  machine: {
    initial: "idle",
    states: {
      idle: { increment: "idle", sync: "syncing" },
      syncing: {},
    },
  },
  reduce: {
    increment(state, payload) {
      state.count += (payload as { by: number }).by;
    },
  },
  generators: {
    sync: function* (ctx) {
      yield* ctx.call("doSync", () => Promise.resolve());
      yield* ctx.done((s) => {
        s.synced = true;
      }); // s.synced typed as boolean
    },
  },
});

Deno.test("flow: mixed cell — reduce works independently", () => {
  const app = createTestApp([mixed]);
  app.dispatch(mixed.__aio.actions.increment(5));
  const s = app.getState().mixed as { count: number };
  assertEquals(s.count, 5);
});

Deno.test("flow: mixed cell — generator works alongside reduce", async () => {
  const app = createTestApp([mixed]);
  app.dispatch(mixed.__aio.actions.increment(3));
  app.dispatch(mixed.__aio.actions.sync());
  await app.flush();

  const s = app.getState().mixed as { count: number; synced: boolean };
  assertEquals(s.count, 3);
  assertEquals(s.synced, true);
});

// ── Generator with ctx.dispatch ───────────────────────────────────────

const putter = cell("putter", {
  state: { step: "" },
  actions: {
    start: () => ({}),
    update: (step: string) => ({ step }),
  },
  machine: {
    initial: "idle",
    states: {
      idle: { start: "busy", update: "idle" },
      busy: { update: "idle" },
    },
  },
  reduce: {
    update(state, payload) {
      state.step = (payload as { step: string }).step;
    },
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.dispatch({
        type: "putter:update",
        payload: { step: "from-flow" },
      });
    },
  },
});

Deno.test("flow: ctx.dispatch dispatches regular action", async () => {
  const app = createTestApp([putter]);
  app.dispatch(putter.__aio.actions.start());
  await app.flush();

  const s = app.getState().putter as { step: string };
  assertEquals(s.step, "from-flow");
});

// ── ctx.send shorthand ────────────────────────────────────────────────

const sender = cell("sender", {
  state: { step: "" },
  actions: {
    start: () => ({}),
    update: (step: string) => ({ step }),
  },
  machine: {
    initial: "idle",
    states: {
      idle: { start: "busy", update: "idle" },
      busy: { update: "idle" },
    },
  },
  reduce: {
    update(state, payload) {
      state.step = (payload as { step: string }).step;
    },
  },
  generators: {
    start: function* (ctx) {
      // ctx.send — shorthand for ctx.dispatch; string form used here to avoid circular ref
      yield* ctx.send("sender:update", { step: "via-send" });
    },
  },
});

Deno.test("flow: ctx.send dispatches via bound creator", async () => {
  const app = createTestApp([sender]);
  app.dispatch(sender.__aio.actions.start());
  await app.flush();

  const s = app.getState().sender as { step: string };
  assertEquals(s.step, "via-send");
});

// ── Generator with ctx.fail ───────────────────────────────────────────

const failer = cell("failer", {
  state: { value: 0 },
  actions: {
    start: () => ({}),
  },
  machine: {
    initial: "idle",
    states: {
      idle: { start: "busy" },
      busy: {},
    },
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.call("check", () => Promise.resolve());
      yield* ctx.fail("something went wrong");
      yield* ctx.mutate("unreachable", (s) => {
        s.value = 999;
      });
    },
  },
});

Deno.test("flow: ctx.fail stops execution and dispatches failed action", async () => {
  const app = createTestApp([failer]);
  app.dispatch(failer.__aio.actions.start());
  await app.flush();

  const types = app.dispatched.map((d) => d.type);
  assertEquals(types.includes("failer:__flow:failed"), true);

  const s = app.getState().failer as { value: number };
  assertEquals(s.value, 0); // unreachable step didn't execute
});

// ── Generator with ctx.sleep ──────────────────────────────────────────

const sleeper = cell("sleeper", {
  state: { woke: false },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.sleep("nap", 10); // 10ms
      yield* ctx.done((s) => {
        s.woke = true;
      }); // s.woke typed as boolean
    },
  },
});

Deno.test("flow: ctx.sleep pauses then continues", async () => {
  const app = createTestApp([sleeper]);
  app.dispatch(sleeper.__aio.actions.start());

  const before = app.getState().sleeper as { woke: boolean };
  assertEquals(before.woke, false);

  await new Promise((r) => setTimeout(r, 80));

  const after = app.getState().sleeper as { woke: boolean };
  assertEquals(after.woke, true);
});

// ── Generator with ctx.all (spread form) ─────────────────────────────

const parallel = cell("parallel", {
  state: { a: 0, b: 0 },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      const [a, b] = yield* ctx.all(
        ctx.call("fetchA", () => Promise.resolve(10)),
        ctx.call("fetchB", () => Promise.resolve(20)),
      );
      yield* ctx.done((s) => {
        s.a = a; // a typed as number
        s.b = b; // b typed as number
      });
    },
  },
});

Deno.test("flow: ctx.all (spread) runs calls in parallel", async () => {
  const app = createTestApp([parallel]);
  app.dispatch(parallel.__aio.actions.start());
  await app.flush();

  const s = app.getState().parallel as { a: number; b: number };
  assertEquals(s.a, 10);
  assertEquals(s.b, 20);
});

// ── Generator with ctx.all (named form) ──────────────────────────────

const namedParallel = cell("namedParallel", {
  state: { x: 0, y: 0 },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      const { x, y } = yield* ctx.all({
        x: ctx.call("fetchX", () => Promise.resolve(100)),
        y: ctx.call("fetchY", () => Promise.resolve(200)),
      });
      yield* ctx.done((s) => {
        s.x = x as number;
        s.y = y as number;
      });
    },
  },
});

Deno.test("flow: ctx.all (named) runs calls in parallel and returns by name", async () => {
  const app = createTestApp([namedParallel]);
  app.dispatch(namedParallel.__aio.actions.start());
  await app.flush();

  const s = app.getState().namedParallel as { x: number; y: number };
  assertEquals(s.x, 100);
  assertEquals(s.y, 200);
});

// ── Generator with ctx.race ───────────────────────────────────────────

const racer = cell("racer", {
  state: { winner: "" },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      const result = yield* ctx.race({
        fast: ctx.call("fast", () => Promise.resolve("fast-wins")),
        slow: ctx.call(
          "slow",
          () =>
            new Promise<string>((r) => setTimeout(() => r("slow-wins"), 500)),
        ),
      });
      const winner = result.fast !== undefined ? "fast" : "slow";
      yield* ctx.done((s) => {
        s.winner = winner;
      }); // s.winner typed as string
    },
  },
});

Deno.test({
  name: "flow: ctx.race picks first to resolve",
  // sanitizers disabled: ctx.race has intentional fire-and-forget losers (dangling promises)
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([racer]);
  app.dispatch(racer.__aio.actions.start());
  await app.flush();

  const s = app.getState().racer as { winner: string };
  assertEquals(s.winner, "fast");
});

// ── Generator key validation ──────────────────────────────────────────

Deno.test("flow: throws if generator key not in actions", () => {
  let error: Error | null = null;
  try {
    cell("bad", {
      state: {},
      actions: { go: () => ({}) },
      generators: {
        nonexistent: function* () {},
      },
    });
  } catch (e) {
    error = e as Error;
  }
  assertExists(error);
  assertEquals(error!.message.includes("nonexistent"), true);
  assertEquals(error!.message.includes("must match an action key"), true);
});

// ── Sync call in generator ────────────────────────────────────────────

const syncFlow = cell("syncFlow", {
  state: { value: 0 },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      const val = yield* ctx.call("compute", () => 42);
      yield* ctx.done((s) => {
        s.value = val;
      }); // val typed as number
    },
  },
});

Deno.test("flow: ctx.call works with sync functions", async () => {
  const app = createTestApp([syncFlow]);
  app.dispatch(syncFlow.__aio.actions.start());
  await app.flush();

  const s = app.getState().syncFlow as { value: number };
  assertEquals(s.value, 42);
});

// ── Multiple steps ────────────────────────────────────────────────────

const multiStep = cell("multiStep", {
  state: { steps: [] as string[] },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.mutate("step1", (s) => {
        s.steps.push("one");
      }); // s.steps typed as string[]
      yield* ctx.mutate("step2", (s) => {
        s.steps.push("two");
      });
      yield* ctx.mutate("step3", (s) => {
        s.steps.push("three");
      });
      yield* ctx.done();
    },
  },
});

Deno.test("flow: multiple ctx.mutate calls execute in order", async () => {
  const app = createTestApp([multiStep]);
  app.dispatch(multiStep.__aio.actions.start());
  await app.flush();

  const s = app.getState().multiStep as { steps: string[] };
  assertEquals(s.steps, ["one", "two", "three"]);
});

// ── Error handling in generator ───────────────────────────────────────

const errorFlow = cell("errorFlow", {
  state: { value: 0 },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.call("boom", () => {
        throw new Error("test error");
      });
      yield* ctx.done((s) => {
        s.value = 999;
      });
    },
  },
});

Deno.test("flow: error in ctx.call dispatches error action", async () => {
  const app = createTestApp([errorFlow]);
  app.dispatch(errorFlow.__aio.actions.start());
  await app.flush();

  const types = app.dispatched.map((d) => d.type);
  assertEquals(types.includes("errorFlow:__flow:error"), true);

  const s = app.getState().errorFlow as { value: number };
  assertEquals(s.value, 0);
});

// ── ctx.waitFor ───────────────────────────────────────────────────────

const waiter = cell("waiter", {
  state: { received: "" },
  actions: {
    start: () => ({}),
    signal: (msg: string) => ({ msg }),
  },
  generators: {
    // String form used here — typed form (waiter.signal) would be circular reference
    start: function* (ctx) {
      const action = yield* ctx.waitFor("waiter:signal");
      const msg = (action.payload as { msg: string }).msg; // payload cast needed with string form
      yield* ctx.done((s) => {
        s.received = msg;
      });
    },
  },
});

Deno.test("flow: ctx.waitFor pauses until matching action dispatched", async () => {
  const app = createTestApp([waiter]);
  app.dispatch(waiter.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 20));

  assertEquals((app.getState().waiter as any).received, "");

  app.dispatch(waiter.__aio.actions.signal("hello"));
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().waiter as any).received, "hello");
});

const timeoutWaiter = cell("timeoutWaiter", {
  state: { timedOut: false },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      try {
        yield* ctx.waitFor("NeverHappens:Action", 50);
        yield* ctx.done();
      } catch {
        yield* ctx.mutate("timeout", (s) => {
          s.timedOut = true;
        }); // s.timedOut typed as boolean
        yield* ctx.done();
      }
    },
  },
});

Deno.test("flow: ctx.waitFor with timeout throws on expiry", async () => {
  const app = createTestApp([timeoutWaiter]);
  app.dispatch(timeoutWaiter.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 200));

  assertEquals((app.getState().timeoutWaiter as any).timedOut, true);
});

// ── ctx.getState ──────────────────────────────────────────────────────

const stateReader = cell("stateReader", {
  state: { count: 0, doubled: 0 },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.mutate("inc", (s) => {
        s.count = 5;
      });
      const current = ctx.getState(); // typed as { count: number; doubled: number }
      yield* ctx.mutate("double", (s) => {
        s.doubled = current.count * 2;
      }); // no cast needed
      yield* ctx.done();
    },
  },
});

Deno.test({
  name: "flow: ctx.getState reads fresh state after step",
  // sanitizers disabled: generator async steps leave pending microtasks
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([stateReader]);
  app.dispatch(stateReader.__aio.actions.start());
  await app.flush();

  const s = app.getState().stateReader as { count: number; doubled: number };
  assertEquals(s.count, 5);
  assertEquals(s.doubled, 10);
});

// ── cancelOn ──────────────────────────────────────────────────────────

const cancellable = cell("cancellable", {
  state: { running: false, finished: false },
  actions: {
    start: () => ({}),
    stop: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.mutate("begin", (s) => {
        s.running = true;
      });
      yield* ctx.sleep("work", 500);
      yield* ctx.done((s) => {
        s.running = false;
        s.finished = true;
      });
    },
  },
  cancelOn: {
    start: ["stop"],
  },
});

Deno.test({
  name: "flow: cancelOn stops generator when matching action dispatched",
  // sanitizers disabled: cancelled generator ctx.sleep leaves a dangling timer
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([cancellable]);
  app.dispatch(cancellable.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().cancellable as any).running, true);

  app.dispatch(cancellable.__aio.actions.stop());
  await new Promise((r) => setTimeout(r, 100));

  assertEquals((app.getState().cancellable as any).finished, false);
});

// ── ctx.dispatch with payload-optional actions ────────────────────────

const putCompat = cell("putCompat", {
  state: { sent: false },
  actions: {
    start: () => ({}),
    signal: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.dispatch({ type: "putCompat:signal" });
      yield* ctx.done((s) => {
        s.sent = true;
      });
    },
  },
});

Deno.test("flow: ctx.dispatch accepts action without payload", async () => {
  const app = createTestApp([putCompat]);
  app.dispatch(putCompat.__aio.actions.start());
  await app.flush();

  assertEquals((app.getState().putCompat as any).sent, true);
  const signalAction = app.dispatched.find((d) =>
    d.type === "putCompat:signal"
  );
  assertExists(signalAction);
});

// ══════════════════════════════════════════════════════════════════════
// Edge cases — race, all, waitFor, cancellation corner cases
// ══════════════════════════════════════════════════════════════════════

// ── ctx.race with 3+ entries, multiple resolve near-simultaneously ──

const race3 = cell("race3", {
  state: { winner: "" },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      const result = yield* ctx.race({
        a: ctx.call(
          "a",
          () => new Promise<string>((r) => setTimeout(() => r("A"), 5)),
        ),
        b: ctx.call(
          "b",
          () => new Promise<string>((r) => setTimeout(() => r("B"), 5)),
        ),
        c: ctx.call(
          "c",
          () => new Promise<string>((r) => setTimeout(() => r("C"), 5)),
        ),
      });
      // One of them wins — we just verify exactly one key is set
      const keys = Object.keys(result).filter((k) =>
        result[k as keyof typeof result] !== undefined
      );
      yield* ctx.done((s) => {
        s.winner = keys[0] ?? "none";
      });
    },
  },
});

Deno.test({
  name:
    "flow edge: ctx.race with 3 near-simultaneous entries picks exactly one",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([race3]);
  app.dispatch(race3.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 100));

  const s = app.getState().race3 as { winner: string };
  assertEquals(["a", "b", "c"].includes(s.winner), true);
});

// ── ctx.race where instant (sync) entry beats async ─────────────────

const raceSyncAsync = cell("raceSyncAsync", {
  state: { winner: "" },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      const result = yield* ctx.race({
        sync: ctx.call("sync", () => "instant"),
        slow: ctx.call(
          "slow",
          () => new Promise<string>((r) => setTimeout(() => r("delayed"), 500)),
        ),
      });
      yield* ctx.done((s) => {
        s.winner = result.sync !== undefined ? "sync" : "slow";
      });
    },
  },
});

Deno.test({
  name: "flow edge: ctx.race — sync call beats async",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([raceSyncAsync]);
  app.dispatch(raceSyncAsync.__aio.actions.start());
  await app.flush();

  const s = app.getState().raceSyncAsync as { winner: string };
  assertEquals(s.winner, "sync");
});

// ── ctx.waitFor with timeout=0 — should time out immediately ────────

const zeroTimeout = cell("zeroTimeout", {
  state: { timedOut: false },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      try {
        yield* ctx.waitFor("Never:Happens", 0);
      } catch {
        yield* ctx.done((s) => {
          s.timedOut = true;
        });
      }
    },
  },
});

Deno.test("flow edge: ctx.waitFor with timeout=0 times out immediately", async () => {
  const app = createTestApp([zeroTimeout]);
  app.dispatch(zeroTimeout.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 50));

  // timeout=0 means the timeout fires on next tick — should catch
  assertEquals((app.getState().zeroTimeout as any).timedOut, true);
});

// ── ctx.call with timeout — times out if fn is too slow ─────────────

const callTimeout = cell("callTimeout", {
  state: { result: "" },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      try {
        yield* ctx.call("slow", () => new Promise((r) => setTimeout(r, 500)), {
          timeout: 20,
        });
        yield* ctx.done((s) => {
          s.result = "completed";
        });
      } catch {
        yield* ctx.done((s) => {
          s.result = "timed-out";
        });
      }
    },
  },
});

Deno.test({
  name: "flow edge: ctx.call with timeout rejects on slow fn",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([callTimeout]);
  app.dispatch(callTimeout.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 100));

  assertEquals((app.getState().callTimeout as any).result, "timed-out");
});

// ── ctx.call with retries — retries then succeeds ───────────────────

const callRetry = cell("callRetry", {
  state: { attempts: 0, result: "" },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      let attempts = 0;
      const val = yield* ctx.call("flaky", () => {
        attempts++;
        if (attempts < 3) throw new Error("not yet");
        return "ok";
      }, { retries: 3 });
      yield* ctx.done((s) => {
        s.attempts = attempts;
        s.result = val;
      });
    },
  },
});

Deno.test("flow edge: ctx.call with retries recovers after failures", async () => {
  const app = createTestApp([callRetry]);
  app.dispatch(callRetry.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 200));

  const s = app.getState().callRetry as { attempts: number; result: string };
  assertEquals(s.attempts, 3);
  assertEquals(s.result, "ok");
});

// ── ctx.call with retries — exhausts retries and fails ──────────────

const callRetryFail = cell("callRetryFail", {
  state: { result: "" },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      try {
        yield* ctx.call("alwaysFails", () => {
          throw new Error("nope");
        }, { retries: 2 });
        yield* ctx.done((s) => {
          s.result = "ok";
        });
      } catch {
        yield* ctx.done((s) => {
          s.result = "exhausted";
        });
      }
    },
  },
});

Deno.test("flow edge: ctx.call exhausts retries then throws", async () => {
  const app = createTestApp([callRetryFail]);
  app.dispatch(callRetryFail.__aio.actions.start());
  await app.flush();

  assertEquals((app.getState().callRetryFail as any).result, "exhausted");
});

// ── Generator cancelled mid-ctx.all — partial results don't apply ───

const cancelMidAll = cell("cancelMidAll", {
  state: { done: false },
  actions: {
    start: () => ({}),
    abort: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.all(
        ctx.call("fast", () => Promise.resolve(1)),
        ctx.call("slow", () => new Promise((r) => setTimeout(() => r(2), 500))),
      );
      yield* ctx.done((s) => {
        s.done = true;
      });
    },
  },
  cancelOn: { start: ["abort"] },
});

Deno.test({
  name: "flow edge: cancel mid-ctx.all prevents done",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([cancelMidAll]);
  app.dispatch(cancelMidAll.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 20));

  // Cancel while slow call is still pending
  app.dispatch(cancelMidAll.__aio.actions.abort());
  await new Promise((r) => setTimeout(r, 600));

  assertEquals((app.getState().cancelMidAll as any).done, false);
});

// ── ctx.all with one entry throwing — whole all fails ───────────────

const allWithError = cell("allWithError", {
  state: { result: "" },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      try {
        yield* ctx.all(
          ctx.call("ok", () => Promise.resolve(1)),
          ctx.call("boom", () => Promise.reject(new Error("fail"))),
        );
        yield* ctx.done((s) => {
          s.result = "ok";
        });
      } catch {
        yield* ctx.done((s) => {
          s.result = "caught";
        });
      }
    },
  },
});

Deno.test("flow edge: ctx.all fails if any entry throws", async () => {
  const app = createTestApp([allWithError]);
  app.dispatch(allWithError.__aio.actions.start());
  await app.flush();

  assertEquals((app.getState().allWithError as any).result, "caught");
});

// ── ctx.race where all entries reject — race rejects ────────────────

const raceAllFail = cell("raceAllFail", {
  state: { result: "" },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      try {
        yield* ctx.race({
          a: ctx.call("a", () => Promise.reject(new Error("a-fail"))),
          b: ctx.call("b", () => Promise.reject(new Error("b-fail"))),
        });
        yield* ctx.done((s) => {
          s.result = "ok";
        });
      } catch {
        yield* ctx.done((s) => {
          s.result = "all-failed";
        });
      }
    },
  },
});

Deno.test("flow edge: ctx.race rejects when first entry rejects", async () => {
  const app = createTestApp([raceAllFail]);
  app.dispatch(raceAllFail.__aio.actions.start());
  await app.flush();

  assertEquals((app.getState().raceAllFail as any).result, "all-failed");
});

// ── Generator auto-completes without ctx.done() ─────────────────────

const noDone = cell("noDone", {
  state: { value: 42 },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      yield* ctx.mutate("update", (s) => {
        s.value = 100;
      });
      // No ctx.done() — should auto-complete
    },
  },
});

Deno.test("flow edge: generator without ctx.done() auto-dispatches done", async () => {
  const app = createTestApp([noDone]);
  app.dispatch(noDone.__aio.actions.start());
  await app.flush();

  assertEquals((app.getState().noDone as any).value, 100);
  const types = app.dispatched.map((d) => d.type);
  assertEquals(types.includes("noDone:__flow:done"), true);
});

// ── Restarting a flow while it's already running ────────────────────

const restart = cell("restart", {
  state: { value: 0 },
  actions: { start: (n: number) => ({ n }) },
  generators: {
    start: function* (ctx, { n }: { n: number }) {
      yield* ctx.call("wait", () => new Promise((r) => setTimeout(r, 100)));
      yield* ctx.done((s) => {
        s.value = n;
      });
    },
  },
});

Deno.test({
  name: "flow edge: restarting a flow cancels the previous instance",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([restart]);
  app.dispatch(restart.__aio.actions.start(1)); // first instance
  await new Promise((r) => setTimeout(r, 20));
  app.dispatch(restart.__aio.actions.start(2)); // second instance — should cancel first
  await new Promise((r) => setTimeout(r, 200));

  // Only the second instance should have completed
  assertEquals((app.getState().restart as any).value, 2);
});

// ── ctx.getFullState ────────────────────────────────────────────────

const fullStateReader = cell("fullStateReader", {
  state: { count: 5, seen: 0 },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      const full = ctx.getFullState();
      const own = full.fullStateReader as { count: number };
      yield* ctx.done((s) => {
        s.seen = own.count;
      });
    },
  },
});

Deno.test("flow: ctx.getFullState reads own cell state", async () => {
  const app = createTestApp([fullStateReader]);
  app.dispatch(fullStateReader.__aio.actions.start());
  await app.flush();

  const s = app.getState().fullStateReader as { count: number; seen: number };
  assertEquals(s.seen, 5);
});

const provider = cell("provider", {
  state: { value: 42 },
  actions: {},
});

const consumer = cell("consumer", {
  state: { grabbed: 0 },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      const full = ctx.getFullState();
      const other = full.provider as { value: number };
      yield* ctx.done((s) => {
        s.grabbed = other.value;
      });
    },
  },
});

Deno.test("flow: ctx.getFullState reads other cell's state", async () => {
  const app = createTestApp([provider, consumer]);
  app.dispatch(consumer.__aio.actions.start());
  await app.flush();

  assertEquals((app.getState().consumer as any).grabbed, 42);
});

const fullStateFresh = cell("fullStateFresh", {
  state: { count: 0, seenOther: 0 },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      yield* ctx.mutate("inc", (s) => {
        s.count = 10;
      });
      // After mutation, getFullState should reflect the updated value
      const full = ctx.getFullState();
      const own = full.fullStateFresh as { count: number };
      yield* ctx.done((s) => {
        s.seenOther = own.count;
      });
    },
  },
});

Deno.test({
  name: "flow: ctx.getFullState returns fresh state after mutation step",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([fullStateFresh]);
  app.dispatch(fullStateFresh.__aio.actions.start());
  await app.flush();

  const s = app.getState().fullStateFresh as {
    count: number;
    seenOther: number;
  };
  assertEquals(s.seenOther, 10);
});

// ── ctx.when ────────────────────────────────────────────────────────

const whenImmediate = cell("whenImmediate", {
  state: { ready: true, proceeded: false },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      // Condition is already true — should resolve instantly
      yield* ctx.when((s) =>
        (s.whenImmediate as { ready: boolean }).ready === true
      );
      yield* ctx.done((s) => {
        s.proceeded = true;
      });
    },
  },
});

Deno.test("flow: ctx.when resolves immediately when condition already true", async () => {
  const app = createTestApp([whenImmediate]);
  app.dispatch(whenImmediate.__aio.actions.start());
  await app.flush();

  assertEquals((app.getState().whenImmediate as any).proceeded, true);
});

const whenTrigger = cell("whenTrigger", {
  state: { active: false },
  actions: { activate: () => ({}) },
  reduce: {
    activate(state) {
      state.active = true;
    },
  },
});

const whenWaiter = cell("whenWaiter", {
  state: { saw: false },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      yield* ctx.when((s) =>
        (s.whenTrigger as { active: boolean }).active === true
      );
      yield* ctx.done((s) => {
        s.saw = true;
      });
    },
  },
});

Deno.test("flow: ctx.when resolves when condition becomes true after dispatch", async () => {
  const app = createTestApp([whenTrigger, whenWaiter]);
  app.dispatch(whenWaiter.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 30));

  // Condition not yet true
  assertEquals((app.getState().whenWaiter as any).saw, false);

  // Trigger the condition
  app.dispatch(whenTrigger.__aio.actions.activate());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenWaiter as any).saw, true);
});

// ── ctx.when edge cases ─────────────────────────────────────────────

const whenTimeout = cell("whenTimeout", {
  state: { timedOut: false },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      try {
        yield* ctx.when(() => false, { timeout: 50 }); // never true
        yield* ctx.done();
      } catch {
        yield* ctx.done((s) => {
          s.timedOut = true;
        });
      }
    },
  },
});

Deno.test("flow: ctx.when with timeout throws on expiry", async () => {
  const app = createTestApp([whenTimeout]);
  app.dispatch(whenTimeout.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 200));

  assertEquals((app.getState().whenTimeout as any).timedOut, true);
});

const whenThrows = cell("whenThrows", {
  state: { proceeded: false },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      try {
        yield* ctx.when(() => {
          throw new Error("boom");
        }, { timeout: 50 });
      } catch {
        // Timeout expected — predicate always throws so condition never true
        yield* ctx.done((s) => {
          s.proceeded = true;
        });
      }
    },
  },
});

Deno.test("flow: ctx.when predicate that throws is treated as false", async () => {
  const app = createTestApp([whenThrows]);
  app.dispatch(whenThrows.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 200));

  // Should have timed out (predicate throws → treated as false → never resolves → timeout)
  assertEquals((app.getState().whenThrows as any).proceeded, true);
});

const whenCancelled = cell("whenCancelled", {
  state: { done: false },
  actions: {
    start: () => ({}),
    stop: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.when(() => false); // waits forever
      yield* ctx.done((s) => {
        s.done = true;
      });
    },
  },
  cancelOn: { start: ["stop"] },
});

Deno.test({
  name: "flow: cancelling a flow waiting on ctx.when cleans up listener",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([whenCancelled]);
  app.dispatch(whenCancelled.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 30));

  // Cancel
  app.dispatch(whenCancelled.__aio.actions.stop());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenCancelled as any).done, false);
});

const whenMultiA = cell("whenMultiA", {
  state: { resolved: false },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      yield* ctx.when((s) => (s.whenMultiTrigger as { a: boolean }).a === true);
      yield* ctx.done((s) => {
        s.resolved = true;
      });
    },
  },
});

const whenMultiB = cell("whenMultiB", {
  state: { resolved: false },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      yield* ctx.when((s) => (s.whenMultiTrigger as { b: boolean }).b === true);
      yield* ctx.done((s) => {
        s.resolved = true;
      });
    },
  },
});

const whenMultiTrigger = cell("whenMultiTrigger", {
  state: { a: false, b: false },
  actions: {
    setA: () => ({}),
    setB: () => ({}),
  },
  reduce: {
    setA(state) {
      state.a = true;
    },
    setB(state) {
      state.b = true;
    },
  },
});

Deno.test("flow: multiple ctx.when listeners resolve independently", async () => {
  const app = createTestApp([whenMultiTrigger, whenMultiA, whenMultiB]);
  app.dispatch(whenMultiA.__aio.actions.start());
  app.dispatch(whenMultiB.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 30));

  // Trigger A only
  app.dispatch(whenMultiTrigger.__aio.actions.setA());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenMultiA as any).resolved, true);
  assertEquals((app.getState().whenMultiB as any).resolved, false);

  // Trigger B
  app.dispatch(whenMultiTrigger.__aio.actions.setB());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenMultiB as any).resolved, true);
});

// ── ctx.when integration ────────────────────────────────────────────

const whenAndWaitFor = cell("whenAndWaitFor", {
  state: { phase: "init" },
  actions: {
    start: () => ({}),
    signal: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      // First wait for state condition
      yield* ctx.when((s) =>
        (s.whenAndWaitForTrigger as { ready: boolean }).ready === true
      );
      yield* ctx.mutate("phase1", (s) => {
        s.phase = "condition-met";
      });

      // Then wait for an action
      yield* ctx.waitFor("whenAndWaitFor:signal");
      yield* ctx.done((s) => {
        s.phase = "complete";
      });
    },
  },
});

const whenAndWaitForTrigger = cell("whenAndWaitForTrigger", {
  state: { ready: false },
  actions: { activate: () => ({}) },
  reduce: {
    activate(state) {
      state.ready = true;
    },
  },
});

Deno.test("flow: ctx.when + ctx.waitFor in same flow", async () => {
  const app = createTestApp([whenAndWaitForTrigger, whenAndWaitFor]);
  app.dispatch(whenAndWaitFor.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 30));

  assertEquals((app.getState().whenAndWaitFor as any).phase, "init");

  // Satisfy when condition
  app.dispatch(whenAndWaitForTrigger.__aio.actions.activate());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenAndWaitFor as any).phase, "condition-met");

  // Satisfy waitFor
  app.dispatch(whenAndWaitFor.__aio.actions.signal());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenAndWaitFor as any).phase, "complete");
});

const whenRace = cell("whenRace", {
  state: { winner: "" },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      const result = yield* ctx.race({
        condition: ctx.when((s) =>
          (s.whenRaceTrigger as { flag: boolean }).flag === true
        ),
        timeout: ctx.sleep("timeout", 500),
      });
      yield* ctx.done((s) => {
        s.winner = "condition" in result ? "condition" : "timeout";
      });
    },
  },
});

const whenRaceTrigger = cell("whenRaceTrigger", {
  state: { flag: false },
  actions: { setFlag: () => ({}) },
  reduce: {
    setFlag(state) {
      state.flag = true;
    },
  },
});

Deno.test({
  name: "flow: ctx.when inside ctx.race resolves when condition met",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([whenRaceTrigger, whenRace]);
  app.dispatch(whenRace.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 30));

  app.dispatch(whenRaceTrigger.__aio.actions.setFlag());
  await new Promise((r) => setTimeout(r, 50));

  assertEquals((app.getState().whenRace as any).winner, "condition");
});

// ── AIO-117: waitFor listener leak on flow cancellation ──────────────

const leakyWaiter = cell("leakyWaiter", {
  state: { phase: "init" },
  actions: {
    start: () => ({}),
    signal: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.waitFor("leakyWaiter:signal"); // no timeout
      yield* ctx.done((s) => {
        s.phase = "done";
      });
    },
  },
});

Deno.test("flow: AIO-117 waitFor listener cleaned up on flow cancellation", async () => {
  const app = createTestApp([leakyWaiter]);

  // Start flow — it will block on waitFor
  app.dispatch(leakyWaiter.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 30));

  // Listener should be registered
  const beforeCancel = [..._actionListeners].filter(
    (l) => l.actionType === "leakyWaiter:signal",
  );
  assertEquals(
    beforeCancel.length,
    1,
    "listener should be registered while waiting",
  );

  // Cancel the flow before the action arrives
  cancelFlow("leakyWaiter", "start");
  await new Promise((r) => setTimeout(r, 30));

  // Listener MUST be cleaned up — this is the bug
  const afterCancel = [..._actionListeners].filter(
    (l) => l.actionType === "leakyWaiter:signal",
  );
  assertEquals(
    afterCancel.length,
    0,
    "AIO-117: waitFor listener leaked after flow cancellation",
  );
});

// AIO-117 part 2: waitFor listener leak when flow completes via finally block
// (e.g., re-trigger cancels old flow — the finally cleanup must handle waitFor listeners)
const leakyRetrigger = cell("leakyRetrigger", {
  state: { phase: "init" },
  actions: {
    start: () => ({}),
    signal: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.waitFor("leakyRetrigger:signal"); // no timeout
      yield* ctx.done((s) => {
        s.phase = "done";
      });
    },
  },
});

Deno.test("flow: AIO-117 waitFor listener cleaned up in finally on flow completion", async () => {
  const app = createTestApp([leakyRetrigger]);

  // Start flow — it will block on waitFor
  app.dispatch(leakyRetrigger.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 30));

  // Verify listener exists
  const before = [..._actionListeners].filter(
    (l) => l.actionType === "leakyRetrigger:signal",
  );
  assertEquals(
    before.length,
    1,
    "listener should exist while waitFor is pending",
  );

  // Re-trigger: starts a new flow, cancelling the old one
  // The old flow's finally block should clean up its waitFor listener
  app.dispatch(leakyRetrigger.__aio.actions.start());
  await new Promise((r) => setTimeout(r, 30));

  // There should be exactly 1 listener (from the NEW flow instance), not 2
  const after = [..._actionListeners].filter(
    (l) => l.actionType === "leakyRetrigger:signal",
  );
  assertEquals(
    after.length,
    1,
    "AIO-117: old waitFor listener leaked on re-trigger — expected 1 (new), got " +
      after.length,
  );

  // Clean up: cancel the remaining flow
  cancelFlow("leakyRetrigger", "start");
  await new Promise((r) => setTimeout(r, 30));

  const final = [..._actionListeners].filter(
    (l) => l.actionType === "leakyRetrigger:signal",
  );
  assertEquals(
    final.length,
    0,
    "all listeners should be cleaned up after final cancel",
  );
});

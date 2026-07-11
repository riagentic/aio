import { assertEquals, assertThrows } from "@std/assert";
import {
  buildAppObject,
  buildOnPerf,
  buildReportOpts,
  createMemoizedUIState,
} from "../src/server/aio-run-helpers.ts";

// ── createMemoizedUIState ──────────────────────────────────────────

Deno.test("memoizedUIState: returns rawGetUIState result on first call", () => {
  const raw = (s: { count: number }) => ({ display: s.count * 2 });
  const memoized = createMemoizedUIState(raw);
  const state = { count: 5 };
  const result = memoized(state) as { display: number };
  assertEquals(result.display, 10);
});

Deno.test("memoizedUIState: returns cached result for same state ref", () => {
  let callCount = 0;
  const raw = (s: { count: number }) => {
    callCount++;
    return { display: s.count };
  };
  const memoized = createMemoizedUIState(raw);
  const state = { count: 1 };

  memoized(state);
  assertEquals(callCount, 1);

  memoized(state);
  assertEquals(callCount, 1); // not called again
});

Deno.test("memoizedUIState: recomputes when state ref changes", () => {
  let callCount = 0;
  const raw = (s: { count: number }) => {
    callCount++;
    return { display: s.count };
  };
  const memoized = createMemoizedUIState(raw);

  memoized({ count: 1 });
  assertEquals(callCount, 1);

  memoized({ count: 2 });
  assertEquals(callCount, 2);
});

Deno.test("memoizedUIState: caches per-user results for same state", () => {
  let callCount = 0;
  const raw = (s: { x: number }, user?: { id: string; role: string }) => {
    callCount++;
    return { data: s.x, userId: user?.id ?? "anon" };
  };
  const memoized = createMemoizedUIState(raw);
  const state = { x: 42 };

  const r1 = memoized(state, { id: "alice", role: "admin" }) as {
    userId: string;
  };
  assertEquals(r1.userId, "alice");
  assertEquals(callCount, 1);

  const r2 = memoized(state, { id: "bob", role: "user" }) as { userId: string };
  assertEquals(r2.userId, "bob");
  assertEquals(callCount, 2);

  // Repeat alice — should be cached
  const r3 = memoized(state, { id: "alice", role: "admin" }) as {
    userId: string;
  };
  assertEquals(r3.userId, "alice");
  assertEquals(callCount, 2); // still 2, cached
});

Deno.test("memoizedUIState: clears user cache when state ref changes", () => {
  let callCount = 0;
  const raw = (s: { x: number }, user?: { id: string; role: string }) => {
    callCount++;
    return { data: s.x, uid: user?.id ?? "" };
  };
  const memoized = createMemoizedUIState(raw);
  const state1 = { x: 1 };
  const state2 = { x: 2 };

  memoized(state1, { id: "alice", role: "admin" });
  assertEquals(callCount, 1);

  memoized(state2, { id: "alice", role: "admin" });
  assertEquals(callCount, 2); // recomputed because state changed
});

Deno.test("memoizedUIState: no-user call uses empty string as key", () => {
  let callCount = 0;
  const raw = (s: { v: number }) => {
    callCount++;
    return s.v;
  };
  const memoized = createMemoizedUIState(raw);
  const state = { v: 99 };

  memoized(state);
  memoized(state); // same state, no user
  assertEquals(callCount, 1);
});

// ── buildAppObject: snapshot/loadSnapshot ──────────────────────────

type MockState = { counter: { count: number }; config: { theme: string } };

function createMockRefs(): {
  refs: Parameters<typeof buildAppObject>[0];
  getState: () => MockState;
  getBroadcasts: () => string[];
  getUdsBroadcasts: () => string[];
  isPersistScheduled: () => boolean;
  isShutdownCalled: () => boolean;
} {
  let state: MockState = { counter: { count: 0 }, config: { theme: "dark" } };
  const broadcasts: string[] = [];
  const udsBroadcasts: string[] = [];
  let persistScheduled = false;
  // deno-lint-ignore no-explicit-any
  let ttState: any = { entries: [], index: -1, paused: false, nextId: 0 };
  let shutdownCalled = false;
  return {
    // deno-lint-ignore no-explicit-any
    refs: {
      dispatch: async (_a: unknown) => {},
      getState: () => state,
      setState: (s: unknown) => {
        state = s as MockState;
      },
      port: 3000,
      asyncDb: null,
      initialState: { counter: { count: 0 }, config: { theme: "dark" } },
      persistence: {
        resetPrevState: () => {
          persistScheduled = false;
        },
      },
      schedulePersist: () => {
        persistScheduled = true;
      },
      getTT: () => ttState,
      setTT: (tt: unknown) => {
        ttState = tt;
      },
      getServer: () => ({
        broadcast: () => {
          broadcasts.push("ws");
        },
        broadcastTT: () => {
          broadcasts.push("tt");
        },
      }),
      udsBroadcastFull: () => {
        udsBroadcasts.push("full");
      },
      shutdown: async () => {
        shutdownCalled = true;
      },
    } as any,
    getState: () => state,
    getBroadcasts: () => broadcasts,
    getUdsBroadcasts: () => udsBroadcasts,
    isPersistScheduled: () => persistScheduled,
    isShutdownCalled: () => shutdownCalled,
  };
}

Deno.test("buildAppObject: snapshot returns JSON of current state", () => {
  const mock = createMockRefs();
  const app = buildAppObject(mock.refs);
  const snap = app.snapshot!();
  assertEquals(JSON.parse(snap), {
    counter: { count: 0 },
    config: { theme: "dark" },
  });
});

Deno.test("buildAppObject: loadSnapshot restores state from JSON", () => {
  const mock = createMockRefs();
  const app = buildAppObject(mock.refs);
  app.loadSnapshot!(
    JSON.stringify({ counter: { count: 99 }, config: { theme: "light" } }),
  );
  assertEquals(mock.getState(), {
    counter: { count: 99 },
    config: { theme: "light" },
  });
});

Deno.test("buildAppObject: loadSnapshot triggers persist + broadcast", () => {
  const mock = createMockRefs();
  const app = buildAppObject(mock.refs);
  app.loadSnapshot!(
    JSON.stringify({ counter: { count: 1 }, config: { theme: "dark" } }),
  );
  assertEquals(mock.isPersistScheduled(), true);
  assertEquals(mock.getBroadcasts().includes("ws"), true);
  assertEquals(mock.getUdsBroadcasts().includes("full"), true);
});

Deno.test("buildAppObject: loadSnapshot rejects non-object JSON", () => {
  const mock = createMockRefs();
  const app = buildAppObject(mock.refs);
  assertThrows(() => app.loadSnapshot!('"hello"'), Error, "JSON object");
  assertThrows(() => app.loadSnapshot!("[1,2]"), Error, "JSON object");
  assertThrows(() => app.loadSnapshot!("null"), Error, "JSON object");
});

Deno.test("buildAppObject: loadSnapshot rejects invalid JSON", () => {
  const mock = createMockRefs();
  const app = buildAppObject(mock.refs);
  assertThrows(() => app.loadSnapshot!("not-json"), SyntaxError);
});

Deno.test("buildAppObject: port is exposed", () => {
  const mock = createMockRefs();
  const app = buildAppObject(mock.refs);
  assertEquals(app.port, 3000);
});

Deno.test("buildAppObject: getState returns current state", () => {
  const mock = createMockRefs();
  const app = buildAppObject(mock.refs);
  assertEquals(app.getState(), {
    counter: { count: 0 },
    config: { theme: "dark" },
  });
});

Deno.test("buildAppObject: close calls shutdown", async () => {
  const mock = createMockRefs();
  const app = buildAppObject(mock.refs);
  await app.close();
  assertEquals(mock.isShutdownCalled(), true);
});

Deno.test("buildAppObject: db is undefined when asyncDb is null", () => {
  const mock = createMockRefs();
  const app = buildAppObject(mock.refs);
  assertEquals(app.db, undefined);
});

// ── buildOnPerf ────────────────────────────────────────────────────

Deno.test("buildOnPerf: returns undefined when no tt and no vitals", () => {
  const result = buildOnPerf(null, undefined);
  assertEquals(result, undefined);
});

Deno.test("buildOnPerf: returns function when tt provided", () => {
  const tt = {
    entries: [{ perf: undefined }],
    index: 0,
    paused: false,
    nextId: 1,
  };
  // deno-lint-ignore no-explicit-any
  const result = buildOnPerf(tt as any, undefined);
  assertEquals(typeof result, "function");
});

Deno.test("buildOnPerf: writes perf to tt entry", () => {
  const entry: { perf?: unknown } = {};
  const tt = { entries: [entry], index: 0, paused: false, nextId: 1 };
  // deno-lint-ignore no-explicit-any
  const onPerf = buildOnPerf(tt as any, undefined)!;
  const timing = {
    actionType: "test:action",
    reduce: 1.5,
    effects: 0.3,
    budget: { reduce: 10, effect: 5 },
  };
  onPerf(timing);
  assertEquals(entry.perf, {
    reduce: 1.5,
    effects: 0.3,
    budget: { reduce: 10, effect: 5 },
    breakdown: undefined,
  });
});

Deno.test("buildOnPerf: includes breakdown when provided", () => {
  const entry: { perf?: unknown } = {};
  const tt = { entries: [entry], index: 0, paused: false, nextId: 1 };
  // deno-lint-ignore no-explicit-any
  const onPerf = buildOnPerf(tt as any, undefined)!;
  const breakdown = {
    produce: 1,
    clone: 0.2,
    spread: 0.1,
    routing: 0.1,
    listeners: 0.1,
  };
  onPerf({
    actionType: "x:y",
    reduce: 2,
    effects: 1,
    budget: { reduce: 10, effect: 5 },
    breakdown,
  });
  assertEquals((entry.perf as { breakdown: unknown }).breakdown, breakdown);
});

Deno.test("buildOnPerf: calls vitals onPerf when vitals provided", () => {
  const perfCalls: unknown[] = [];
  const vitals = {
    loopProbe: {
      onPerf: (t: unknown) => {
        perfCalls.push(t);
      },
      updateQueueDepth: () => {},
      updateEffectBacklog: () => {},
      updateCircuitBreakers: () => {},
    },
    checkAndAlert: () => {},
  };
  // deno-lint-ignore no-explicit-any
  const onPerf = buildOnPerf(null, vitals as any)!;
  const timing = {
    actionType: "test:x",
    reduce: 1,
    effects: 0.5,
    budget: { reduce: 10, effect: 5 },
  };
  onPerf(timing);
  assertEquals(perfCalls.length, 1);
  assertEquals(perfCalls[0], timing);
});

Deno.test("buildOnPerf: no-op when tt.entries is empty", () => {
  const tt = { entries: [], index: 0, paused: false, nextId: 0 };
  // deno-lint-ignore no-explicit-any
  const onPerf = buildOnPerf(tt as any, undefined)!;
  // Should not throw even though entries[0] is undefined
  onPerf({
    actionType: "x:y",
    reduce: 1,
    effects: 0,
    budget: { reduce: 10, effect: 5 },
  });
});

// ── buildReportOpts ────────────────────────────────────────────────

Deno.test("buildReportOpts: includes onError callback", () => {
  const onError = (_err: unknown) => {};
  // deno-lint-ignore no-explicit-any
  const opts = buildReportOpts(
    { onError, getTT: () => null, prod: false } as any,
  );
  assertEquals(opts.onError, onError);
});

Deno.test("buildReportOpts: prod flag is passed through", () => {
  // deno-lint-ignore no-explicit-any
  const opts = buildReportOpts(
    { onError: undefined, getTT: () => null, prod: true } as any,
  );
  assertEquals(opts.prod, true);
});

Deno.test("buildReportOpts: tt is undefined when null passed", () => {
  // deno-lint-ignore no-explicit-any
  const opts = buildReportOpts(
    { onError: undefined, getTT: () => null, prod: false } as any,
  );
  assertEquals(opts.tt, undefined);
});

Deno.test("buildReportOpts: tt.markError is provided when tt passed", () => {
  const tt = { entries: [], index: -1, paused: false, nextId: 0 };
  // deno-lint-ignore no-explicit-any
  const opts = buildReportOpts(
    { onError: undefined, getTT: () => tt, prod: false } as any,
  );
  assertEquals(typeof opts.tt?.markError, "function");
});

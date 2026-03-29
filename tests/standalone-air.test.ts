// tests/standalone-air.test.ts
// Tests for AIR standalone runtime (Android WebView with AIR renderer)

import { assertEquals, assertExists } from "@std/assert";
import {
  _reset,
  draft,
  initStandalone,
  useAio,
  useLocal,
} from "../src/standalone-air.ts";

// Mock localStorage
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storage.set(k, v);
    },
    removeItem: (k: string) => {
      storage.delete(k);
    },
    clear: () => storage.clear(),
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
  },
  writable: true,
  configurable: true,
});

// Test types
type State = { count: number };
type Action = { type: string; payload?: { by?: number } };
type Effect = { type: string; payload: { message: string } };

function makeReduce() {
  return (
    state: State,
    action: Action,
  ): { state: State; effects: Effect[] } => {
    if (action.type === "INC") {
      return {
        state: { count: state.count + (action.payload?.by ?? 1) },
        effects: [{ type: "LOG", payload: { message: "inc" } }],
      };
    }
    if (action.type === "DEC") {
      return { state: { count: state.count - 1 }, effects: [] };
    }
    return { state, effects: [] };
  };
}

function setup() {
  storage.clear();
  _reset();
  const executed: Effect[] = [];
  const app = initStandalone<State, Action, Effect>({ count: 0 }, {
    reduce: makeReduce(),
    execute: (_app, effect) => {
      executed.push(effect);
    },
    persist: false,
  });
  return { app, executed };
}

// ── initStandalone ──────────────────────────────────────────────────

Deno.test("standalone-air: initStandalone returns app with dispatch", () => {
  const { app } = setup();
  assertExists(app);
  assertExists(app.dispatch);
  assertEquals(app.mode, "standalone");
});

Deno.test("standalone-air: dispatch updates state", () => {
  const { app } = setup();
  app.dispatch({ type: "INC" });
  assertEquals(app.getState().count, 1);
});

Deno.test("standalone-air: dispatch executes effects", () => {
  const { app, executed } = setup();
  app.dispatch({ type: "INC" });
  assertEquals(executed.length, 1);
  assertEquals(executed[0]!.type, "LOG");
});

Deno.test("standalone-air: multiple dispatches accumulate", () => {
  const { app } = setup();
  app.dispatch({ type: "INC", payload: { by: 5 } });
  app.dispatch({ type: "INC", payload: { by: 3 } });
  assertEquals(app.getState().count, 8);
});

// ── useAio (signal-based) ───────────────────────────────────────────

Deno.test("standalone-air: useAio returns current state", () => {
  const { app } = setup();
  app.dispatch({ type: "INC" });
  const { state } = useAio<State>();
  assertExists(state);
  assertEquals(state!.count, 1);
});

Deno.test("standalone-air: useAio.send dispatches", () => {
  setup();
  const { send } = useAio<State>();
  send({ type: "INC", payload: { by: 10 } });
  const { state } = useAio<State>();
  assertEquals(state!.count, 10);
});

Deno.test("standalone-air: useAio reflects state after dispatch", () => {
  const { app } = setup();
  assertEquals(useAio<State>().state!.count, 0);
  app.dispatch({ type: "INC" });
  assertEquals(useAio<State>().state!.count, 1);
  app.dispatch({ type: "DEC" });
  assertEquals(useAio<State>().state!.count, 0);
});

// ── useLocal (signal-based) ─────────────────────────────────────────

Deno.test("standalone-air: useLocal returns initial value", () => {
  const { local } = useLocal(42);
  assertEquals(local, 42);
});

Deno.test("standalone-air: useLocal.set updates value", () => {
  const ref = useLocal(0);
  ref.set(99);
  assertEquals(ref.local, 99);
});

Deno.test("standalone-air: useLocal.set with updater fn", () => {
  const ref = useLocal(10);
  ref.set((prev) => prev + 5);
  assertEquals(ref.local, 15);
});

// ── draft ───────────────────────────────────────────────────────────

Deno.test("standalone-air: draft produces immutable state", () => {
  const original = { count: 0 };
  const result = draft<State, Effect>(original, (d) => {
    d.count = 5;
    return [{ type: "LOG", payload: { message: "drafted" } }];
  });
  assertEquals(result.state.count, 5);
  assertEquals(original.count, 0); // original unchanged
  assertEquals(result.effects.length, 1);
});

// ── Persistence ─────────────────────────────────────────────────────

Deno.test("standalone-air: persists state to localStorage", async () => {
  storage.clear();
  _reset();
  const app = initStandalone<State, Action, Effect>({ count: 0 }, {
    reduce: makeReduce(),
    execute: () => {},
    persist: true,
    persistDebounceMs: 10,
  });
  app.dispatch({ type: "INC", payload: { by: 42 } });
  // Wait for debounce
  await new Promise((r) => setTimeout(r, 50));
  const raw = storage.get("aio_state");
  assertExists(raw);
  const persisted = JSON.parse(raw!);
  assertEquals(persisted.count, 42);
});

Deno.test("standalone-air: restores state from localStorage", () => {
  storage.clear();
  storage.set("aio_state", JSON.stringify({ count: 77 }));
  _reset();
  const app = initStandalone<State, Action, Effect>({ count: 0 }, {
    reduce: makeReduce(),
    execute: () => {},
    persist: true,
  });
  assertEquals(app.getState().count, 77);
});

// ── onRestore ───────────────────────────────────────────────────────

Deno.test("standalone-air: onRestore transforms restored state", () => {
  storage.clear();
  storage.set("aio_state", JSON.stringify({ count: 10 }));
  _reset();
  const app = initStandalone<State, Action, Effect>({ count: 0 }, {
    reduce: makeReduce(),
    execute: () => {},
    persist: true,
    onRestore: (s) => ({ count: s.count * 2 }),
  });
  assertEquals(app.getState().count, 20);
});

// ── close ───────────────────────────────────────────────────────────

Deno.test("standalone-air: close flushes persist and resolves", async () => {
  storage.clear();
  _reset();
  const app = initStandalone<State, Action, Effect>({ count: 0 }, {
    reduce: makeReduce(),
    execute: () => {},
    persist: true,
  });
  app.dispatch({ type: "INC", payload: { by: 99 } });
  await app.close();
  const raw = storage.get("aio_state");
  assertExists(raw);
  assertEquals(JSON.parse(raw!).count, 99);
});

// ── _reset ──────────────────────────────────────────────────────────

Deno.test("standalone-air: _reset clears state", () => {
  setup();
  const { state } = useAio<State>();
  assertExists(state);
  _reset();
  const { state: after } = useAio<State>();
  assertEquals(after, null);
});

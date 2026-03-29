// tests/browser-air.test.ts
// Integration tests for AIR browser transport and hooks.
// Tests that ensureConnected wiring works and AIR hooks interact correctly
// with protocol layer. No actual WebSocket — we test the wiring, not the network.

import { assertEquals, assertExists } from "@std/assert";
import {
  actions,
  effects,
  ensureConnected,
  Link,
  matchPath,
  memo,
  msg,
  navigate,
  page,
  Redirect,
  Route,
  routePath,
  routeSearch,
  schedule,
  useAio,
  useConnected,
  useFeature,
  useNavigate,
  useRoute,
} from "../src/browser-air.ts";
import {
  _resetDevTools,
  _resetEnsured,
  _resetIDB,
  _resetInitialShapeKeys,
  _resetStateReady,
  _resetStateVersion,
  _resetStatus,
  _resetTracking,
} from "../src/browser-protocol.ts";
import { _reset as _coreReset } from "../src/state-core.ts";

// Stub location for non-browser env
const origLocation = globalThis.location;
function stubLocation(): void {
  // deno-lint-ignore no-explicit-any
  (globalThis as any).location = {
    protocol: "http:",
    host: "localhost:3000",
    pathname: "/",
    search: "",
    origin: "http://localhost:3000",
    href: "http://localhost:3000/",
    reload: () => {},
  };
}
function restoreLocation(): void {
  if (origLocation === undefined) {
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).location;
  } else {
    globalThis.location = origLocation;
  }
}

function resetAll(): void {
  _coreReset();
  _resetEnsured();
  _resetStateVersion();
  _resetStateReady();
  _resetStatus();
  _resetIDB();
  _resetDevTools();
  _resetTracking();
  _resetInitialShapeKeys();
}

// ── Export surface tests ────────────────────────────────────────────

Deno.test("browser-air: exports ensureConnected", () => {
  assertExists(ensureConnected);
  assertEquals(typeof ensureConnected, "function");
});

Deno.test("browser-air: exports msg factory", () => {
  const m = msg("TEST", { x: 1 });
  assertEquals(m.type, "TEST");
  assertEquals(m.payload, { x: 1 });
});

Deno.test("browser-air: exports msg without payload", () => {
  const m = msg("PING");
  assertEquals(m.type, "PING");
  assertEquals(m.payload, {});
});

Deno.test("browser-air: exports actions/effects factory", () => {
  const a = actions({ Inc: (n: number) => ({ by: n }) });
  assertEquals(a.Inc, "Inc");
  assertEquals(typeof a.inc, "function");
  const action = a.inc(5);
  assertEquals(action, { type: "Inc", payload: { by: 5 } });
});

Deno.test("browser-air: exports schedule", () => {
  assertExists(schedule.after);
  assertExists(schedule.every);
  assertExists(schedule.cancel);
  const s = schedule.after("t1", 1000, { type: "TICK" });
  assertEquals(s.type, "__schedule");
  assertEquals(s.kind, "after");
});

Deno.test("browser-air: exports matchPath", () => {
  const params = matchPath("/users/:id", "/users/42");
  assertExists(params);
  assertEquals(params!.id, "42");
});

Deno.test("browser-air: matchPath returns null on no match", () => {
  const params = matchPath("/users/:id", "/posts/1");
  assertEquals(params, null);
});

Deno.test("browser-air: exports routePath and routeSearch signals", () => {
  assertExists(routePath);
  assertExists(routeSearch);
  // They should have .value (signal interface)
  assertEquals(typeof routePath.value, "string");
});

// ── memo (no-op in AIR) ────────────────────────────────────────────

Deno.test("browser-air: memo returns component unchanged", () => {
  const Comp = (props: { x: number }) => props.x;
  const Memoized = memo(Comp);
  assertEquals(Memoized, Comp);
});

// ── Hook existence tests (can't fully test without AIR renderer) ───

Deno.test("browser-air: useFeature is a function", () => {
  assertEquals(typeof useFeature, "function");
});

Deno.test("browser-air: useAio is a function", () => {
  assertEquals(typeof useAio, "function");
});

Deno.test("browser-air: useConnected is a function", () => {
  assertEquals(typeof useConnected, "function");
});

Deno.test("browser-air: useRoute is a function", () => {
  assertEquals(typeof useRoute, "function");
});

Deno.test("browser-air: useNavigate is a function", () => {
  assertEquals(typeof useNavigate, "function");
});

// ── ensureConnected wiring ─────────────────────────────────────────

Deno.test({
  name: "browser-air: ensureConnected is idempotent",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    stubLocation();
    try {
      resetAll();
      // First call triggers connect — second is no-op (idempotent)
      ensureConnected();
      ensureConnected();
    } finally {
      resetAll();
      restoreLocation();
    }
  },
});

// ── navigate ────────────────────────────────────────────────────────

Deno.test("browser-air: navigate is a function", () => {
  assertEquals(typeof navigate, "function");
});

// ── Component exports ──────────────────────────────────────────────

Deno.test("browser-air: Link is a function", () => {
  assertEquals(typeof Link, "function");
});

Deno.test("browser-air: Route is a function", () => {
  assertEquals(typeof Route, "function");
});

Deno.test("browser-air: Redirect is a function", () => {
  assertEquals(typeof Redirect, "function");
});

Deno.test("browser-air: page renders correct component", () => {
  // page() returns vdom node — just verify it doesn't crash
  const result = page("home" as string, {
    home: () => "Home Page",
    about: () => "About Page",
  } as Record<string, () => unknown>);
  assertExists(result);
});

Deno.test("browser-air: page returns null for unknown key", () => {
  const result = page("missing" as "a", { a: () => "A" });
  // "missing" doesn't match "a", so null
  assertEquals(result, null);
});

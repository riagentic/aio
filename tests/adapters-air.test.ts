import { assertEquals } from "@std/assert";
import { _injectState, _reset } from "../src/state-core.ts";
// `useCell` was REMOVED in alpha52 (direct cell access replaced it) — its
// tests went with it; direct reads are covered by cell-reactive tests.
import { useAio, useConnected, useLocal } from "../src/adapters/air.ts";

Deno.test("air: useAio reads full state", () => {
  _reset();
  _injectState({ counter: { count: 1 }, todo: { items: [] } });
  const { state } = useAio();
  assertEquals((state as Record<string, unknown>).counter, { count: 1 });
  _reset();
});

Deno.test("air: useLocal holds client-only state", () => {
  const local = useLocal(false);
  assertEquals(local.local, false);
  local.set(true);
  assertEquals(local.local, true);
});

Deno.test("air: useConnected reads connection status", () => {
  _reset();
  assertEquals(useConnected(), false);
  _reset();
});

Deno.test("air: useAio state proxy does not answer for Object.prototype names", () => {
  // `prop in sig.value` is true for every Object.prototype name, so
  // `"toString" in state` was true even when no cell held that key — the
  // proxy's `has` / `getOwnPropertyDescriptor` traps walked the prototype.
  _reset();
  _injectState({ counter: { count: 1 } });
  const { state } = useAio();
  assertEquals("toString" in state, false);
  assertEquals("constructor" in state, false);
  assertEquals("valueOf" in state, false);
  assertEquals("counter" in state, true);
  _reset();
});

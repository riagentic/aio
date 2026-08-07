import { assertEquals } from "jsr:@std/assert";
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

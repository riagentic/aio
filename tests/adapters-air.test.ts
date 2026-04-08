import { assertEquals } from "jsr:@std/assert";
import { _injectDelta, _injectState, _reset } from "../src/state-core.ts";
import {
  useAio,
  useCell,
  useConnected,
  useLocal,
} from "../src/adapters/air.ts";

// CellRef interface requires __aio — this is the public type shape for client-side cell references
const fakeRef = {
  __aio: {
    id: "counter",
    actionKeys: ["increment"],
    actions: { increment: () => ({ type: "counter:increment" }) },
    state: { count: 0 },
  },
};

Deno.test("air: useCell reads cell state", () => {
  _reset();
  _injectState({ counter: { count: 42 } });
  const { state } = useCell(fakeRef);
  assertEquals(state.count, 42);
  _reset();
});

Deno.test("air: useCell falls back to ref default when no state", () => {
  _reset();
  const { state } = useCell(fakeRef);
  assertEquals(state.count, 0);
  _reset();
});

Deno.test("air: useCell send has typed methods", () => {
  _reset();
  _injectState({ counter: { count: 0 } });
  const { send } = useCell(fakeRef);
  assertEquals(typeof send.increment, "function");
  _reset();
});

Deno.test("air: useCell state updates on delta", () => {
  _reset();
  _injectState({ counter: { count: 0 } });
  const { state } = useCell(fakeRef);
  assertEquals(state.count, 0);
  _injectDelta({ $p: { counter: { count: 5 } } });
  assertEquals(state.count, 5);
  _reset();
});

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

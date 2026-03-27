import { assertEquals } from "jsr:@std/assert";
import { _injectDelta, _injectState, _reset } from "../src/state-core.ts";
import {
  useAio,
  useConnected,
  useFeature,
  useLocal,
} from "../src/adapters/air.ts";

const fakeRef = {
  __aio: {
    id: "counter",
    actionKeys: ["increment"],
    actions: { increment: () => ({ type: "counter:increment" }) },
    state: { count: 0 },
  },
};

Deno.test("air: useFeature reads feature state", () => {
  _reset();
  _injectState({ counter: { count: 42 } });
  const { state } = useFeature(fakeRef);
  assertEquals(state.count, 42);
  _reset();
});

Deno.test("air: useFeature falls back to ref default when no state", () => {
  _reset();
  const { state } = useFeature(fakeRef);
  assertEquals(state.count, 0);
  _reset();
});

Deno.test("air: useFeature send has typed methods", () => {
  _reset();
  _injectState({ counter: { count: 0 } });
  const { send } = useFeature(fakeRef);
  assertEquals(typeof send.increment, "function");
  _reset();
});

Deno.test("air: useFeature state updates on delta", () => {
  _reset();
  _injectState({ counter: { count: 0 } });
  const { state } = useFeature(fakeRef);
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

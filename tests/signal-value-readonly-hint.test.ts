// A write to `.value` names the door. It always threw (a getter-only
// property); the engine's message just never said `.set` / `.update` — a
// field-report trap that cost a cycle.
import { assertEquals, assertThrows } from "@std/assert";
import { computed, signal } from "../src/state/signal.ts";

Deno.test("signal.value = x throws, naming .set and .update — and changes nothing", () => {
  const s = signal(1, "count");
  const e = assertThrows(
    () => ((s as unknown as { value: number }).value = 2),
    TypeError,
  );
  assertEquals(
    e.message,
    '[aio] signal "count".value is read-only — use .set(v) or .update((v) => next)',
  );
  assertEquals(s.value, 1);
  s.set(3);
  assertEquals(s.value, 3, "the door it names works");
});

Deno.test("computed.value = x throws, saying it is derived", () => {
  const s = signal(2);
  const c = computed(() => s.value * 2);
  assertThrows(
    () => ((c as unknown as { value: number }).value = 1),
    TypeError,
    "it is derived",
  );
  assertEquals(c.value, 4);
});

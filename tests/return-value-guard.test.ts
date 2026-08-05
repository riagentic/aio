// Unit coverage for serializeReturn — the guard that vets a method's return
// value before it crosses the wire in an ack frame. JSON-clean values pass
// through; anything that can't survive JSON is coerced to undefined + flagged
// dropped (the transports warn in dev and resolve the caller with undefined
// rather than hanging).
import { assert, assertEquals } from "@std/assert";
import { serializeReturn } from "../src/protocol/return-value.ts";

Deno.test("serializeReturn: undefined passes as undefined, not dropped", () => {
  const r = serializeReturn(undefined);
  assertEquals(r, { value: undefined, dropped: false, lossy: [] });
});

Deno.test("serializeReturn: primitives round-trip", () => {
  for (const v of [0, 1, -1, 3.14, "hi", "", true, false, null]) {
    const r = serializeReturn(v);
    assertEquals(r.dropped, false);
    assertEquals(r.value, v);
  }
});

Deno.test("serializeReturn: plain objects/arrays round-trip by value", () => {
  const r = serializeReturn({ sum: 5, nested: { a: [1, 2, 3] } });
  assertEquals(r.dropped, false);
  assertEquals(r.value, { sum: 5, nested: { a: [1, 2, 3] } });
});

Deno.test("serializeReturn: a bare function is dropped to undefined", () => {
  const r = serializeReturn(() => 42);
  assertEquals(r, { value: undefined, dropped: true, lossy: [] });
});

Deno.test("serializeReturn: BigInt (JSON.stringify throws) is dropped", () => {
  const r = serializeReturn(10n);
  assertEquals(r, { value: undefined, dropped: true, lossy: [] });
});

Deno.test("serializeReturn: a circular structure is dropped, never throws", () => {
  const a: Record<string, unknown> = {};
  a.self = a;
  const r = serializeReturn(a);
  assertEquals(r, { value: undefined, dropped: true, lossy: [] });
});

Deno.test("serializeReturn: functions nested in an object are stripped by JSON", () => {
  // JSON.stringify drops function-valued props silently — the surviving object
  // is clean and transportable, so this is NOT a drop.
  const r = serializeReturn({ keep: 1, fn: () => 0 });
  assertEquals(r.dropped, false);
  assertEquals(r.value, { keep: 1 });
});

Deno.test("serializeReturn: returned value is a fresh clone (no proxy/alias leak)", () => {
  const src = { a: 1 };
  const r = serializeReturn(src);
  assert(
    r.value !== src,
    "must be a JSON round-tripped copy, not the original",
  );
  assertEquals(r.value, { a: 1 });
});

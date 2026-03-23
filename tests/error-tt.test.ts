import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createTT,
  markError,
  record,
  toBroadcast,
} from "../src/time-travel.ts";

Deno.test("TT — error entry has error field", () => {
  let tt = createTT<{ x: number }, { type: string }>();
  tt = record(tt, { type: "a" }, { x: 1 });
  markError(tt, {
    code: "REDUCE_ERROR",
    message: "kaboom",
    featureName: "test",
  });
  assertEquals(tt.entries[tt.index]!.error, {
    code: "REDUCE_ERROR",
    message: "kaboom",
    featureName: "test",
  });
});

Deno.test("TT — non-error entry has no error field", () => {
  let tt = createTT<{ x: number }, { type: string }>();
  tt = record(tt, { type: "a" }, { x: 1 });
  assertEquals(tt.entries[tt.index]!.error, undefined);
});

Deno.test("TT — toBroadcast includes error in wire format", () => {
  let tt = createTT<{ x: number }, { type: string }>();
  tt = record(tt, { type: "a" }, { x: 1 });
  markError(tt, { code: "EFFECT_ERROR", message: "fail" });
  const bc = toBroadcast(tt);
  assertEquals(bc.entries[0]!.error, { code: "EFFECT_ERROR", message: "fail" });
});

Deno.test("TT — toBroadcast omits error when absent", () => {
  let tt = createTT<{ x: number }, { type: string }>();
  tt = record(tt, { type: "a" }, { x: 1 });
  const bc = toBroadcast(tt);
  assertEquals(bc.entries[0]!.error, undefined);
});

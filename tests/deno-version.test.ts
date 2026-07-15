// deno-version — the boot-time min-Deno gate. aio uses ≥2.9 behavior directly,
// so running older Deno must fail fast with a clear message, not cryptically.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertDenoVersion,
  meetsMinDeno,
  MIN_DENO,
} from "../src/server/deno-version.ts";

Deno.test("deno-version: MIN_DENO is 2.9.0", () => {
  assertEquals(MIN_DENO, "2.9.0");
});

Deno.test("deno-version: exact floor and above pass", () => {
  assert(meetsMinDeno("2.9.0"));
  assert(meetsMinDeno("2.9.1"));
  assert(meetsMinDeno("2.10.0")); // minor > 9 (not string-compared)
  assert(meetsMinDeno("2.100.0"));
  assert(meetsMinDeno("3.0.0"));
  assert(meetsMinDeno("10.0.0"));
});

Deno.test("deno-version: below the floor fails", () => {
  assertEquals(meetsMinDeno("2.8.9"), false);
  assertEquals(meetsMinDeno("2.6.0"), false);
  assertEquals(meetsMinDeno("2.0.0"), false);
  assertEquals(meetsMinDeno("1.46.0"), false);
});

Deno.test("deno-version: rc/canary suffix on the floor still passes", () => {
  // "2.9.0-rc.1".split(".") → patch "0-rc" parses as 0 → still meets 2.9.0
  assert(meetsMinDeno("2.9.0-rc.1"));
  assert(meetsMinDeno("2.10.0-rc.1"));
});

Deno.test("deno-version: assertDenoVersion throws an actionable error below floor", () => {
  const err = assertThrows(
    () => assertDenoVersion("2.8.0"),
    Error,
    "requires Deno 2.9.0+",
  );
  assert(String(err).includes("2.8.0"), "names the running version");
  assert(String(err).includes("deno upgrade"), "gives the fix");
});

Deno.test("deno-version: assertDenoVersion is a no-op at/above floor", () => {
  assertDenoVersion("2.9.0");
  assertDenoVersion("2.9.5");
  assertDenoVersion("3.1.0");
  // and the live runtime (tests run on a supported Deno)
  assertDenoVersion();
});

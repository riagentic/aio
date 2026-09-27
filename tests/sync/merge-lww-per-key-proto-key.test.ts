// lww-per-key: an own "__proto__" key (JSON.parse produces one) must survive
// the merge as DATA — the rule deep-merge's `setOwn` and state-patch.ts
// already enforce. `merged[key] = value` on a plain `{}` sets the PROTOTYPE in
// a browser, where this merge runs (sync-engine's client view).
import { assert, assertEquals } from "@std/assert";
import { mergeField } from "../../src/sync/merge.ts";
import type { HLC } from "../../src/sync/types.ts";

const older: HLC = [1000, 0, "B"];
const newer: HLC = [2000, 0, "A"];

Deno.test("lww-per-key: an own __proto__ key is kept as data, not turned into the prototype", () => {
  // Deno stubs Object.prototype.__proto__ (assignment makes an own key); every
  // browser has the standard accessor. Install it for this test only.
  const original = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "__proto__",
  );
  Object.defineProperty(Object.prototype, "__proto__", {
    configurable: true,
    get(this: object) {
      return Object.getPrototypeOf(this);
    },
    set(this: object, v: unknown) {
      if (typeof v === "object" || typeof v === "function") {
        Object.setPrototypeOf(this, v as object | null);
      }
    },
  });
  try {
    // Off the wire, as every remote record arrives.
    const remote = JSON.parse('{"__proto__":{"polluted":1}}');
    assert(Object.hasOwn(remote, "__proto__"));
    const r = mergeField("lww-per-key", { a: 1 }, newer, remote, older);
    const v = r.value as Record<string, unknown>;
    assertEquals((v as { polluted?: unknown }).polluted, undefined);
    assert(Object.hasOwn(v, "__proto__"), "own __proto__ key was dropped");
    assertEquals(JSON.stringify(v), '{"__proto__":{"polluted":1},"a":1}');
  } finally {
    if (original) {
      Object.defineProperty(Object.prototype, "__proto__", original);
    } else delete (Object.prototype as { __proto__?: unknown }).__proto__;
  }
});

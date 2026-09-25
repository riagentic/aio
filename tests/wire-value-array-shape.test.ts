// `findLossy` is the one decider for "did this value cross the JSON wire
// intact". Its Array branch compared indices only, so two array shapes that
// JSON changes were reported as EXACT (`lossy: []`):
//   • named properties on an array — a RegExp match's `index`/`input`/`groups`,
//     a tag an app hung on a list — which JSON erases (it writes indices only);
//   • an Array SUBCLASS, which arrives as a plain array with its prototype,
//     methods and fields gone — exactly what the walk reports for any other
//     class instance.
// Both directions share the walk: a method's return value and a call's args.
import { assert, assertEquals } from "@std/assert";
import { serializeReturn } from "../src/protocol/return-value.ts";
import { serializeArgs } from "../src/protocol/wire-value.ts";

Deno.test("wire-value: named properties on an array are reported, not called exact", () => {
  const m = "xab".match(/(?<g>a)b/)!;
  const r = serializeReturn(m, "t:match");
  assertEquals(
    r.lossy.map((l) => `${l.path}:${l.from}→${l.to}`),
    [
      "value.index:number→absent",
      "value.input:string→absent",
      "value.groups:object→absent",
    ],
  );
  const tagged = Object.assign([1, 2], { total: 2 });
  const a = serializeArgs([tagged], "t:args");
  assertEquals(a.lossy.map((l) => l.path), ["args[0].total"]);
  // A plain (even sparse-free) array is still exact.
  assertEquals(serializeReturn([1, [2, 3], { a: 4 }]).lossy, []);
});

Deno.test("wire-value: an Array subclass is reported like any class instance", () => {
  class Rows extends Array<number> {
    sum() {
      return this.reduce((a, b) => a + b, 0);
    }
  }
  const rows = new Rows();
  rows.push(1, 2);
  const r = serializeReturn(rows, "t:rows");
  assert(r.lossy.length > 0, "an Array subclass was reported as exact");
  assertEquals(r.lossy[0], { path: "value", from: "Rows", to: "Array" });
});

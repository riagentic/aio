// A state key sharing its name with a SELECTOR throws at cell(), like one
// sharing it with a method.
//
// docs/state/cells.md lists "state ↔ selector ❌ throws at cell()". The
// definition-time check only knew methods, so the pair passed cell() and the
// boot died installing the state getter over the selector — a bare
// "Cannot set property count of #<Object> which has only a getter" that named
// neither the cell, the key, nor the fix.
import { assertStringIncludes, assertThrows } from "@std/assert";
import { cell } from "../mod.ts";

Deno.test("cell(): a state key colliding with a selector throws, naming cell, key and the rename", () => {
  const err = assertThrows(
    () =>
      cell("selcollide", {
        state: { count: 0 },
        methods: {
          inc(s: { count: number }) {
            s.count++;
          },
        },
        selectors: { count: (s: { count: number }) => s.count },
      } as never),
    Error,
  );
  assertStringIncludes(err.message, "selcollide");
  assertStringIncludes(err.message, "state key 'count'");
  assertStringIncludes(err.message, "selector 'count'");
  assertStringIncludes(err.message, "Rename one");
});

Deno.test("cell(): a deps-form selector collides the same way", () => {
  assertThrows(
    () =>
      cell("selcollide2", {
        state: { total: 0 },
        selectors: {
          total: { deps: ["other"], fn: () => 1 },
        },
      } as never),
    Error,
    "state key 'total' collides with selector 'total'",
  );
});

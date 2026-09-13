// `args:` naming a method the cell does not have throws at cell(), like its
// siblings `ttl`, `concurrency`, `long` and `cancelOn` already did.
//
// A rule list filed under a typo'd name never runs, so the boundary the app
// believes is guarded accepts anything — and nothing ever hits or misses to
// make that visible.
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { cell } from "../mod.ts";

const methods = {
  setAge(s: { age: number }, age: number) {
    s.age = age;
  },
};

Deno.test("cell(): args naming a nonexistent method throws, listing the methods", () => {
  const err = assertThrows(
    () =>
      cell("argsnope", {
        state: { age: 0 },
        methods,
        args: { setage: [(v: unknown) => typeof v === "number" || "a number"] },
      } as never),
    Error,
  );
  assertStringIncludes(err.message, "argsnope");
  assertStringIncludes(err.message, `args names "setage"`);
  assertStringIncludes(err.message, "setAge");
});

Deno.test("cell(): args for a method must be a positional list", () => {
  assertThrows(
    () =>
      cell("argsshape", {
        state: { age: 0 },
        methods,
        args: { setAge: (v: unknown) => typeof v === "number" },
      } as never),
    Error,
    "POSITIONAL list",
  );
});

Deno.test("cell(): args for a real method still builds", () => {
  const ok = cell("argsok", {
    state: { age: 0 },
    methods,
    args: { setAge: [null] },
  } as never) as unknown as { setAge: unknown };
  assertEquals(typeof ok.setAge, "function");
});

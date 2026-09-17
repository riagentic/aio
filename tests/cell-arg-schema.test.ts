// `args:` — an optional schema for a method's arguments.
//
// The boundary is untyped at RUNTIME. A method's TypeScript signature protects
// the call sites you compile; nothing protects `am dispatch`, a hand-written
// `{ type, payload: { args } }`, a form, a URL or an agent. aio's arity warning
// exists precisely because of that, and two reports counted the consequence: a
// dozen hand-written coercions in one week (report 9 §9.6, report 3 §12.7).
//
// STANDARD SCHEMA, not a DSL of aio's own — Zod, Valibot and ArkType all
// implement it, so this is the app's existing validator doing the job it
// already does. Inventing a schema language here would have been a second one
// to learn and a second one to keep correct.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { cell } from "../mod.ts";
import { testCell } from "../src/cell-test.ts";
import {
  isStandardSchema,
  validateMethodArgs,
} from "../src/state/arg-schema.ts";

// deno-lint-ignore no-explicit-any
type D = any;

/** A minimal Standard Schema, exactly as the spec defines it — so these tests
 *  prove interop with Zod/Valibot/ArkType without importing one. */
const num = (opts: { min?: number; coerce?: boolean } = {}) => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate(v: unknown) {
      const n = opts.coerce ? Number(v) : v;
      if (typeof n !== "number" || Number.isNaN(n)) {
        return { issues: [{ message: "expected a number" }] };
      }
      if (opts.min !== undefined && n < opts.min) {
        return { issues: [{ message: `must be >= ${opts.min}` }] };
      }
      return { value: n };
    },
  },
});

Deno.test("a Standard Schema is recognized; other things are not", () => {
  assert(isStandardSchema(num()));
  for (
    const v of [null, undefined, 1, "x", {}, { "~standard": {} }, () => true]
  ) {
    assertEquals(isStandardSchema(v), false, `over-matched: ${String(v)}`);
  }
});

Deno.test("it COERCES — which is the hand-written coercions, deleted", () => {
  // The half that matters more than the refusal. A schema returns the PARSED
  // value, and that value is what the method receives.
  assertEquals(
    validateMethodArgs("c", "m", [num({ coerce: true })], ["42"]),
    [42],
  );
});

Deno.test("a failure names the cell, the method and the POSITION", () => {
  // "invalid argument" sends a reader to read the method. The position is the
  // difference between a message and a lead.
  const e = assertThrows(() =>
    validateMethodArgs("user", "setAge", [null, num({ min: 0 })], ["ok", -3])
  );
  const msg = String(e);
  assert(msg.includes("user:setAge"), msg);
  assert(msg.includes("argument 2"), `the position: ${msg}`);
  assert(msg.includes("must be >= 0"), `the schema's own reason: ${msg}`);
});

Deno.test("a plain predicate works, for an app with no schema library", () => {
  assertEquals(
    validateMethodArgs("c", "m", [
      (v: unknown) => typeof v === "string" || "want a string",
    ], ["hi"]),
    ["hi"],
  );
  assert(
    String(
      assertThrows(() =>
        validateMethodArgs("c", "m", [
          (v: unknown) => typeof v === "string" || "want a string",
        ], [1])
      ),
    ).includes("want a string"),
  );
  // `false` with no reason still refuses, and says so rather than printing
  // "false". The TYPE forbids it (`true | string`), which is why the cast is
  // here — a JS caller, a compiled-away `any`, or an older schema can still
  // hand one back, and the runtime has to answer.
  assert(
    String(
      assertThrows(() =>
        validateMethodArgs("c", "m", [(() => false) as D], [1])
      ),
    ).includes("returned false"),
  );
});

Deno.test("`null` skips a position, and extra arguments pass through", () => {
  // Declaring a rule for the first argument must not silently forbid the rest
  // — a schema that quietly dropped arguments would be worse than none.
  assertEquals(
    validateMethodArgs("c", "m", [null, num()], ["anything", 5, "extra", 9]),
    ["anything", 5, "extra", 9],
  );
  assertEquals(validateMethodArgs("c", "m", [], [1, 2]), [1, 2]);
  assertEquals(validateMethodArgs("c", "m", undefined, [1, 2]), [1, 2]);
});

Deno.test("an ASYNC schema is refused by name, not silently skipped", () => {
  // This runs on the dispatch path, which is synchronous for a sync method.
  // Awaiting would make one method kind behave differently from the other, and
  // a schema that silently did not run is worse than no schema — the app
  // believes the boundary is guarded.
  const asyncSchema = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: () => Promise.resolve({ value: 1 }),
    },
  };
  const msg = String(
    assertThrows(() => validateMethodArgs("c", "m", [asyncSchema as D], [1])),
  );
  assert(msg.includes("ASYNCHRONOUSLY"), msg);
  assert(msg.includes("fix:"), `it must say what to do instead: ${msg}`);
});

// ── through a real cell, on the real dispatch path ──────────────────────────

const guarded = cell("argguard", {
  state: { age: 0, name: "" },
  args: {
    setAge: [num({ min: 0, coerce: true })],
    rename: [
      (v: unknown) =>
        (typeof v === "string" && v.length > 0) || "name must not be empty",
    ],
  },
  methods: {
    setAge(s: { age: number }, age: number) {
      s.age = age;
    },
    rename(s: { name: string }, name: string) {
      s.name = name;
    },
    unguarded(s: { name: string }, name: unknown) {
      s.name = String(name);
    },
  },
} as D);

testCell(guarded, "a good argument passes, coerced", async (t: D) => {
  await t.send.setAge("42");
  assertEquals(
    t.getState().age,
    42,
    "the method must receive the PARSED value, not the raw one",
  );
});

testCell(
  guarded,
  "a bad argument is refused on the dispatch path",
  async (t: D) => {
    t.init();
    let msg = "";
    try {
      await t.send.setAge(-1);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(msg.includes("argguard:setAge"), `it must name the method: ${msg}`);
    assert(msg.includes("must be >= 0"), msg);
    assertEquals(t.getState().age, 0, "a refused call must not have written");
  },
);

testCell(guarded, "a predicate rule refuses too", async (t: D) => {
  t.init();
  let msg = "";
  try {
    await t.send.rename("");
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(msg.includes("must not be empty"), msg);
  assertEquals(t.getState().name, "");
});

testCell(guarded, "a method with NO rule is untouched", async (t: D) => {
  t.init();
  // The schema is opt-in per method. A cell that declares one rule must not
  // start guarding its other methods.
  await t.send.unguarded(123);
  assertEquals(t.getState().name, "123");
});

Deno.test("`args` is a known cell key, and a typo is still refused", () => {
  const c = cell("argkey", { state: { n: 0 }, args: {}, methods: {} } as D);
  assertEquals((c as D).__aio.argSchemas, {});
  let threw = "";
  try {
    cell("argtypo", { state: { n: 0 }, arg: {}, methods: {} } as D);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert(
    threw.includes("arg"),
    `adding a key must not make the validator permissive: ${threw}`,
  );
});

Deno.test("a rule that is neither predicate nor schema is refused clearly", () => {
  // Without the check it is `undefined is not a function` from inside aio, for
  // a value the app put in its own config.
  const msg = String(
    assertThrows(() => validateMethodArgs("c", "m", [{ min: 0 } as D], [1])),
  );
  assert(msg.includes("neither a function nor a Standard Schema"), msg);
  assert(
    msg.includes("fix:"),
    `it must say what a good rule looks like: ${msg}`,
  );
});

Deno.test("the position is said both ways: 1-based argument AND the 0-based schema index", () => {
  // "argument 1 is invalid" (1-based, how a caller counts) beside a schema
  // declared as `args.setLength[0]` (0-based, how the config is written) sent
  // a reader to the wrong slot. Both are stated now; the existing phrase is
  // kept whole — agents grep for it.
  const e = assertThrows(() =>
    validateMethodArgs(
      "timer",
      "setLength",
      [(v: unknown) => typeof v === "number" || "must be a number"],
      ["5"],
    )
  );
  const msg = String(e);
  assert(msg.includes("argument 1 is invalid"), msg);
  assert(
    msg.includes(
      "[timer:setLength] argument 1 is invalid (args.setLength[0]): must be a number",
    ),
    msg,
  );
  const e2 = assertThrows(() =>
    validateMethodArgs("user", "setAge", [null, num({ min: 0 })], ["ok", -3])
  );
  assert(
    String(e2).includes("argument 2 is invalid (args.setAge[1]):"),
    String(e2),
  );
});

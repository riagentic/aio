// A returned API object's methods must not depend on HOW they are called.
//
// `useForm()` hands back `{ fields, values, validate, reset, bind, … }`, and
// taking a handler out of it is the ordinary thing to do — `const { validate }
// = useForm(…)`, `onClick={form.reset}`, passing `bind` down as a prop. One
// method reached its siblings through `this` (`this.values()` inside
// `validate`), so a detached call threw `Cannot read properties of undefined
// (reading 'values')`, naming neither the form nor the cause.
//
// The worst part was WHEN: `this` was only dereferenced inside the
// `options.validators` branch, so the same call site worked for months and
// started throwing the day someone added a cross-field rule.
//
// Per-instance this is a one-line fix. The class is "an API object whose
// methods are receiver-dependent", so it is pinned by construction: every
// function on every object these hooks return is detached and called, and must
// behave identically.
import { assert, assertEquals } from "@std/assert";
import { useFieldArray, useForm } from "../src/air/form.ts";

/** Call `fn` with no receiver, the way a destructured handler is called. */
// deno-lint-ignore no-explicit-any
const detach = <F extends (...a: any[]) => any>(fn: F): F =>
  ((...a: unknown[]) => fn.apply(undefined, a)) as F;

Deno.test("useForm: every method works detached from its object", () => {
  const make = () =>
    useForm(
      {
        password: { initial: "" },
        confirm: { initial: "" },
      },
      {
        // The branch that used to dereference `this`.
        validators: [
          (f) =>
            f.password === f.confirm ? null : { confirm: "Passwords differ" },
        ],
      },
    );

  const onObject = make();
  onObject.fields.password.set("secret");
  onObject.fields.confirm.set("nope");
  const boundResult = onObject.validate();
  const boundError = onObject.fields.confirm.error;

  const detached = make();
  detached.fields.password.set("secret");
  detached.fields.confirm.set("nope");
  const validate = detach(detached.validate);
  const values = detach(detached.values);
  const reset = detach(detached.reset);
  const bind = detach(detached.bind);

  assertEquals(
    validate(),
    boundResult,
    "validate() must not care whether it was called on the form object",
  );
  assertEquals(detached.fields.confirm.error, boundError);
  assertEquals(values(), { password: "secret", confirm: "nope" });
  assert(typeof bind("password").onInput === "function");
  reset();
  assertEquals(values(), { password: "", confirm: "" });
});

Deno.test("useFieldArray: every method works detached from its object", () => {
  const arr = useFieldArray<string>(["a", "b"]);
  const push = detach(arr.push);
  const remove = detach(arr.remove);
  const move = detach(arr.move);
  const set = detach(arr.set);
  const reset = detach(arr.reset);

  push("c");
  assertEquals(arr.items, ["a", "b", "c"]);
  set(0, "A");
  assertEquals(arr.items, ["A", "b", "c"]);
  move(0, 2);
  assertEquals(arr.items, ["b", "c", "A"]);
  remove(1);
  assertEquals(arr.items, ["b", "A"]);
  reset();
  assertEquals(arr.items, ["a", "b"]);
});

Deno.test("useFieldArray: an out-of-range index is reported, not swallowed", () => {
  const dev = (globalThis as Record<string, unknown>).__aioDev;
  (globalThis as Record<string, unknown>).__aioDev = true;
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (line.includes("useFieldArray.")) warns.push(line);
    else orig(...a);
  };
  try {
    const arr = useFieldArray<string>(["a", "b"]);
    arr.remove(7);
    arr.set(-1, "x");
    arr.move(7, 0);
    arr.move(0, 9);
    assertEquals(
      arr.items,
      ["a", "b"],
      "an out-of-range index must still change nothing",
    );
    assertEquals(
      warns.length,
      4,
      `each out-of-range call must say so in dev — got:\n${warns.join("\n")}`,
    );
    assert(warns.every((w) => /holds 2 item\(s\)/.test(w)), warns.join("\n"));
  } finally {
    console.warn = orig;
    (globalThis as Record<string, unknown>).__aioDev = dev;
  }
});

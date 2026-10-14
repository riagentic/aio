// `bindInput(form, name)` — `form.bind(name)` with the field's own type.
//
// `FormState.bind` answers `value: unknown` (frozen surface), so a number
// field's bound value could not be used as a number without a cast. The first
// `@ts-expect-error` pins that; the rest is the typed door, which hands back
// the very object `bind` builds.
import { assertEquals } from "@std/assert";
import { bindInput, useForm } from "../src/air.ts";
import * as browserAir from "../src/browser-air.ts";
import * as standaloneAir from "../src/standalone-air.ts";

Deno.test("bindInput: value has the field's type, and the handlers are bind()'s", () => {
  const form = useForm({
    name: { initial: "ann" },
    age: { initial: 41 },
  });
  // @ts-expect-error bind() answers `unknown`: not a number
  const _n: number = form.bind("age").value;

  const age = bindInput(form, "age");
  const next: number = age.value + 1;
  const name: string = bindInput(form, "name").value.toUpperCase();
  assertEquals([next, name], [42, "ANN"]);
  const _typo = () =>
    // @ts-expect-error a field the form does not have
    bindInput(form, "nope");

  assertEquals(Object.keys(age).sort(), ["onBlur", "onInput", "value"]);
  bindInput(form, "name").onInput({ target: { value: "bob" } } as never);
  assertEquals(form.fields.name.value, "bob");
  assertEquals(bindInput(form, "name").value, "bob", "a fresh snapshot");
  assertEquals(form.fields.age.touched, false);
  age.onBlur();
  assertEquals(form.fields.age.touched, true);
});

Deno.test("bindInput: every entry that exports useForm exports it — a UI importing it from aio/air loads in the browser too", () => {
  assertEquals(browserAir.bindInput, bindInput);
  assertEquals(standaloneAir.bindInput, bindInput);
});

// `useForm(config, { schema })` — the app's own schema, not a second copy.
//
// Two reports wrote the same adapter by hand (composer §10.6, newjob §8.7):
// the app already has a Zod / Valibot / ArkType schema for the thing being
// edited, and restating it as `rules` is one constraint written twice, in two
// languages, drifting from the moment either changes.
//
// THE SCHEMAS HERE ARE HAND-BUILT, and that is deliberate — Standard Schema v1
// is a shape, not a package, so a real library would add a dependency to prove
// something about a property name. What the tests DO carry is both real issue
// spellings: Zod emits bare path keys, Valibot emits `{ key }` wrappers, and
// reading only one shape would put every issue from the other library on the
// form instead of on its field, which looks exactly like the schema
// half-working.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { useForm } from "../src/air/form.ts";
import type { StandardSchemaLike } from "../src/state/arg-schema.ts";

type Issue = {
  message: string;
  path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
};

/** A synchronous Standard Schema built from a plain function. */
const schemaOf = (
  fn: (v: Record<string, unknown>) =>
    | { value: unknown }
    | { issues: Issue[] },
): StandardSchemaLike => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (v) => fn(v as Record<string, unknown>) as never,
  },
});

Deno.test("an issue with a BARE path key lands on that field", () => {
  const schema = schemaOf((v) =>
    typeof v.email === "string" && v.email.includes("@")
      ? { value: v }
      : { issues: [{ message: "not an email", path: ["email"] }] }
  );
  const form = useForm({ email: { initial: "nope" } }, { schema });
  assertEquals(form.fields.email.error, null, "not validated until asked");
  assertEquals(form.validate(), false);
  assertEquals(form.fields.email.error, "not an email");
  assertEquals(form.formError ?? null, null, "it was attributable");

  form.fields.email.set("a@b.c");
  assertEquals(form.validate(), true);
});

Deno.test("an issue with a `{ key }` path wrapper lands on that field too", () => {
  // Valibot's spelling. Reading only the bare form would send this to the
  // form-level bucket and the field would look fine while the form refused.
  const schema = schemaOf(() => ({
    issues: [{ message: "too short", path: [{ key: "name" }] }],
  }));
  const form = useForm({ name: { initial: "x" } }, { schema });
  assertEquals(form.validate(), false);
  assertEquals(form.fields.name.error, "too short");
  assertEquals(form.formError ?? null, null);
});

Deno.test("an issue that names NO field is still seen", () => {
  // A cross-field refinement ("passwords must match") has no single owner.
  // Dropping it is how a form refuses to submit while every field looks fine —
  // the failure nobody can debug.
  const schema = schemaOf(() => ({
    issues: [{ message: "passwords must match" }],
  }));
  const form = useForm(
    { a: { initial: "1" }, b: { initial: "2" } },
    { schema },
  );
  assertEquals(form.validate(), false);
  assertEquals(form.formError, "passwords must match");
  assertEquals(form.fields.a.error, null, "it belongs to neither field");
  assert(!form.valid, "a form-level issue makes the form invalid");

  // …and it clears when the schema is satisfied.
  const ok = schemaOf((v) => ({ value: v }));
  const form2 = useForm({ a: { initial: "1" } }, { schema: ok });
  assertEquals(form2.validate(), true);
  assertEquals(form2.formError ?? null, null);
});

Deno.test("a field's OWN rule keeps its message — the specific one wins", () => {
  const schema = schemaOf(() => ({
    issues: [{ message: "schema says no", path: ["age"] }],
  }));
  const form = useForm({
    age: { initial: "", rules: [(v) => (v ? null : "required")] },
  }, { schema });
  assertEquals(form.validate(), false);
  assertEquals(
    form.fields.age.error,
    "required",
    "the field's own rule is the more specific statement",
  );
});

Deno.test("parsed() gives the COERCED values; values() stays honest", () => {
  // The dozen hand-written `Number(v)` calls, deleted — but on their own
  // method. `values()` returns `T`, inferred from each field's `initial`, so a
  // form whose initial is `""` and whose schema coerces to a number would have
  // a `values()` that SAYS string and HOLDS a number. A signature that lies
  // costs more than the convenience is worth.
  const schema = schemaOf((v) => ({ value: { age: Number(v.age) } }));
  const form = useForm({ age: { initial: "42" } }, { schema });
  assertEquals(form.parsed!(), { age: 42 });
  assertEquals(form.values(), { age: "42" }, "values() is still T");
  assertEquals(
    form.fields.age.value,
    "42",
    "the FIELD still holds what the user typed, so the input still shows it",
  );
});

Deno.test("parsed() is null when there is no schema, or nothing parses", () => {
  // Inventing a value for a form that does not validate is worse than saying
  // there isn't one — `valid` is already false.
  const plain = useForm({ a: { initial: "x" } });
  assertEquals(plain.parsed!(), null);
  const bad = schemaOf(() => ({ issues: [{ message: "no" }] }));
  const form = useForm({ a: { initial: "typed" } }, { schema: bad });
  assertEquals(form.parsed!(), null);
  assertEquals(form.values(), { a: "typed" }, "values() never swallows input");
});

Deno.test("an ASYNC schema is refused by name, not silently skipped", () => {
  // `validate()`/`values()`/`valid` are synchronous — `valid` is read during
  // render — so there is nowhere here to await. A schema that silently did not
  // run is worse than no schema, because the form believes it is guarded.
  const asyncSchema = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: () => Promise.resolve({ value: {} }),
    },
  } as unknown as StandardSchemaLike;
  const form = useForm({ a: { initial: "1" } }, { schema: asyncSchema });
  const e = assertThrows(() => form.validate()) as Error;
  assert(e.message.includes("ASYNCHRONOUSLY"), e.message);
  assert(e.message.includes("asyncRules"), `it names the fix: ${e.message}`);
});

Deno.test("no schema: everything behaves exactly as before", () => {
  const form = useForm({
    a: { initial: "x", rules: [(v) => (v ? null : "required")] },
  });
  assertEquals(form.validate(), true);
  assertEquals(form.values(), { a: "x" });
  assertEquals(form.formError ?? null, null);
  form.fields.a.set("");
  assertEquals(form.validate(), false);
  assertEquals(form.fields.a.error, "required");
});

Deno.test("reset() clears a form-level error too", () => {
  const schema = schemaOf(() => ({ issues: [{ message: "nope" }] }));
  const form = useForm({ a: { initial: "1" } }, { schema });
  form.validate();
  assertEquals(form.formError, "nope");
  form.reset();
  assertEquals(form.formError ?? null, null);
  assert(form.valid, "a reset form is valid again");
});

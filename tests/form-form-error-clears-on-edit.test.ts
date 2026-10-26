// A form-level schema error (an issue with no `path` — Zod's `.refine()`
// without `path`, the docs' "passwords must match") was a snapshot taken in
// `validate()`. Fixing the field left `formError` stale and `valid` false, so
// the documented `disabled={!form.valid}` submit — the only thing that would
// call `validate()` again — stayed disabled for good.
import { assertEquals } from "@std/assert";
import { useForm } from "../src/air/form.ts";
import type { StandardSchemaLike } from "../src/state/arg-schema.ts";

const schema: StandardSchemaLike = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (v: unknown) => {
      const o = v as { pw: string; confirm: string };
      return o.pw === o.confirm
        ? { value: o }
        : { issues: [{ message: "passwords must match" }] };
    },
  },
} as StandardSchemaLike;

Deno.test("useForm: fixing the field clears a form-level schema error without validate()", () => {
  const form = useForm({ pw: { initial: "" }, confirm: { initial: "" } }, {
    schema,
  });
  form.fields.pw.set("secret12");
  form.fields.confirm.set("secret13");
  assertEquals(form.formError, null, "nothing said before validate()");
  assertEquals(form.validate(), false);
  assertEquals(form.formError, "passwords must match");
  assertEquals(form.valid, false);

  form.fields.confirm.set("secret12");
  assertEquals(form.formError, null);
  assertEquals(form.valid, true);

  form.fields.confirm.set("nope");
  assertEquals(form.formError, null, "re-checks only once validate() said so");
  assertEquals(form.validate(), false);
  form.fields.confirm.reset();
  form.fields.pw.reset();
  assertEquals(form.formError, null, "a field reset re-checks too");
  assertEquals(form.valid, true);
});

import { assertEquals } from "@std/assert";
import { useForm } from "../src/form.ts";

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

Deno.test({
  name: "form: async validator runs after sync rules pass",
  async fn() {
    const form = useForm({
      username: {
        initial: "",
        rules: [(v: string) => (v.length >= 3 ? null : "Too short")],
        asyncRules: [
          async (v: string) => (v === "taken" ? "Already taken" : null),
        ],
      },
    });

    const field = form.fields.username;

    // Sync rule fails — async should not run
    field.set("ab");
    field.touch();
    assertEquals(field.error, "Too short");
    assertEquals(field.validating, false);

    // Sync passes, async runs
    field.set("taken");
    field.touch();
    assertEquals(field.validating, true);

    await delay(20);
    assertEquals(field.error, "Already taken");
    assertEquals(field.validating, false);

    // Valid input
    field.set("available");
    field.touch();
    assertEquals(field.validating, true);

    await delay(20);
    assertEquals(field.error, null);
    assertEquals(field.validating, false);
  },
});

Deno.test({
  name: "form: async validator debounce",
  async fn() {
    let callCount = 0;
    const form = useForm({
      email: {
        initial: "",
        asyncRules: [
          async (v: string) => {
            callCount++;
            return v.includes("@") ? null : "Invalid";
          },
        ],
        debounceMs: 50,
      },
    });

    const field = form.fields.email;

    // Rapid changes — only last should trigger async
    field.set("a");
    field.touch();
    field.set("ab");
    field.touch();
    field.set("abc");
    field.touch();

    await delay(30);
    assertEquals(callCount, 0);

    await delay(40);
    assertEquals(callCount, 1);
    assertEquals(field.error, "Invalid");
  },
});

Deno.test({
  name: "form: cross-field validation",
  fn() {
    const form = useForm(
      {
        password: { initial: "" },
        confirm: { initial: "" },
      },
      {
        validators: [
          (fields) =>
            fields.password === fields.confirm
              ? null
              : { confirm: "Passwords don't match" },
        ],
      },
    );

    form.fields.password.set("secret");
    form.fields.confirm.set("nope");
    form.validate();

    assertEquals(form.fields.confirm.error, "Passwords don't match");

    form.fields.confirm.set("secret");
    form.validate();

    assertEquals(form.fields.confirm.error, null);
  },
});

Deno.test({
  name: "form: cross-field + per-field rules work together",
  fn() {
    const form = useForm(
      {
        password: {
          initial: "",
          rules: [(v: string) => (v.length >= 6 ? null : "Too short")],
        },
        confirm: { initial: "" },
      },
      {
        validators: [
          (fields) =>
            fields.password === fields.confirm
              ? null
              : { confirm: "Passwords don't match" },
        ],
      },
    );

    form.fields.password.set("abc");
    form.fields.confirm.set("abc");
    form.validate();

    assertEquals(form.fields.password.error, "Too short");
    assertEquals(form.fields.confirm.error, null);
  },
});

Deno.test({
  name: "form: existing sync-only useForm still works unchanged",
  fn() {
    const form = useForm({
      name: {
        initial: "",
        rules: [(v: string) => (v ? null : "Required")],
      },
    });

    form.fields.name.touch();
    assertEquals(form.fields.name.error, "Required");
    assertEquals(form.fields.name.validating, false);

    form.fields.name.set("Alice");
    form.fields.name.touch();
    assertEquals(form.fields.name.error, null);
  },
});

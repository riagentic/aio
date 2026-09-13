import { assertEquals } from "@std/assert";
import { useForm } from "../src/air/form.ts";
import { closeWindow } from "../src/testing/close-window.ts";

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

// `bind()` used to return a LIVE GETTER for `value`. Its result is handed
// straight to `h()` as props (the shape this file's source docstring shows), so
// the getter moved the read out of the render pass: the component never
// subscribed to the field, and `prev.value === next.value` was unconditionally
// true because both getters read the same live field — the DOM value was never
// rewritten. Measured: `form.reset()` left the typed text on screen.
Deno.test("form.bind(): reset() puts the DOM back, and the value is a snapshot", async () => {
  const { Window } = await import("happy-dom");
  const { h } = await import("../src/air/vdom.ts");
  const { _setDocument, _unmount, mount } = await import(
    "../src/air/aio-renderer.ts"
  );
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);

  const form = useForm({ name: { initial: "start" } });

  // bind() hands back plain data, not a live getter — the props a render
  // describes must be the values that render saw.
  const bound = form.bind("name");
  assertEquals(Object.getOwnPropertyDescriptor(bound, "value")?.get, undefined);
  assertEquals(bound.value, "start");

  const App = () => h("input", form.bind("name"));
  const handle = mount(root, App);
  const input = root.querySelector("input") as HTMLInputElement;
  assertEquals(input.value, "start");

  input.value = "typed";
  input.dispatchEvent(
    // deno-lint-ignore no-explicit-any
    new (doc.defaultView as any).Event("input", { bubbles: true }),
  );
  await new Promise((r) => setTimeout(r, 5));
  handle._flush();
  assertEquals(form.fields.name.value, "typed");
  assertEquals(input.value, "typed");

  form.reset();
  await new Promise((r) => setTimeout(r, 5));
  handle._flush();
  assertEquals(form.fields.name.value, "start");
  assertEquals(input.value, "start", "reset() must clear the DOM too");

  _unmount(handle);
  await closeWindow(win);
});

// ── validate() and a form that has async rules ───────────────────────────
//
// `validate()` touches every field and then, on the very next line, treats
// `f.validating` as invalid — so it failed on the flag it had just set.
// `form.validate()` returned FALSE for a form whose rules all pass, and stayed
// false: calling it again after everything had settled restarted the same
// rules on the same unchanged value and failed again. `air-forms.md` documents
// submit as `if (form.validate()) …`, so a form with ANY async rule could
// never be submitted through the documented path, while `form.valid` said
// true. Two deciders, disagreeing.
Deno.test({
  name: "form: validate() answers TRUE once the async verdict is in",
  async fn() {
    const form = useForm({
      name: {
        initial: "ada",
        asyncRules: [async (v) => {
          await delay(5);
          return String(v) === "taken" ? "already taken" : null;
        }],
      },
    });
    // The realistic flow: the field settles (a blur, a keystroke on a touched
    // field), then the user submits.
    form.fields.name.touch();
    await delay(30);
    assertEquals(form.valid, true, "the async rule passed");
    assertEquals(
      form.validate(),
      true,
      "validate() must not restart a verdict it already has",
    );
    // …and twice in a row, because a submit button can be clicked twice.
    assertEquals(form.validate(), true);
  },
});

Deno.test({
  name: "form: a CHANGED value still re-validates, and a failure still fails",
  async fn() {
    let runs = 0;
    const form = useForm({
      name: {
        initial: "ada",
        asyncRules: [async (v) => {
          runs++;
          await delay(5);
          return String(v) === "taken" ? "already taken" : null;
        }],
      },
    });
    form.fields.name.touch();
    await delay(30);
    assertEquals(runs, 1);
    assertEquals(form.validate(), true);
    assertEquals(runs, 1, "an unchanged value is not re-run");

    form.fields.name.set("taken");
    await delay(30);
    assertEquals(runs, 2, "a CHANGED value is re-run");
    assertEquals(form.fields.name.error, "already taken");
    assertEquals(form.validate(), false, "and a real failure still fails");

    // reset() forgets the verdict, so the next touch really re-validates.
    form.fields.name.reset();
    form.fields.name.touch();
    await delay(30);
    assertEquals(runs, 3, "reset() clears the memo");
  },
});

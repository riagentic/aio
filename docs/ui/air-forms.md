# AIR Forms

Signal-based form state with field-level reactivity and built-in validation.

---

## useForm()

```ts
function useForm<T>(config): FormState<T>;
```

Call outside the component body (like `signal`).

```tsx
import { useForm } from "aio/air";

const form = useForm({
  email: {
    initial: "",
    rules: [
      (v) => v ? null : "Required",
      (v) => v.includes("@") ? null : "Must be an email",
    ],
  },
  password: {
    initial: "",
    rules: [(v) => v.length >= 8 ? null : "Min 8 characters"],
  },
});

const LoginForm = () => (
  <form
    onSubmit={() => {
      // submit never navigates — AIR prevents the default for handled forms
      // (opt back into native submission with data-native-submit)
      if (form.validate()) console.log(form.values());
    }}
  >
    <input
      type="email"
      {...form.bind("email")}
      value={form.fields.email.value}
    />
    {form.fields.email.error && (
      <span className="err">{form.fields.email.error}</span>
    )}

    <input
      type="password"
      {...form.bind("password")}
      value={form.fields.password.value}
    />
    {form.fields.password.error && (
      <span className="err">{form.fields.password.error}</span>
    )}

    <button type="submit" disabled={!form.valid}>Login</button>
  </form>
);
```

**FormState\<T\>:**

| Member       | Type                         | Description                            |
| ------------ | ---------------------------- | -------------------------------------- |
| `fields`     | `{ [K]: FieldState<T[K]> }`  | Per-field state objects                |
| `valid`      | `boolean`                    | All fields have no error               |
| `dirty`      | `boolean`                    | Any field modified from initial        |
| `values()`   | `T`                          | Get all current values as plain object |
| `validate()` | `boolean`                    | Touch all, return valid                |
| `reset()`    | `void`                       | Reset all fields to initial            |
| `bind(name)` | `{ value, onInput, onBlur }` | Bind props for `<input>`               |

**FieldState\<T\>:**

| Member      | Type             | Description                                  |
| ----------- | ---------------- | -------------------------------------------- |
| `value`     | `T`              | Signal-tracked current value                 |
| `error`     | `string \| null` | Current validation error                     |
| `dirty`     | `boolean`        | Modified from initial                        |
| `touched`   | `boolean`        | Has been blurred                             |
| `set(next)` | `void`           | Set value, update dirty, validate if touched |
| `touch()`   | `void`           | Mark touched, run validation                 |
| `reset()`   | `void`           | Reset to initial                             |

---

## Your own schema (Zod, Valibot, ArkType)

If the thing being edited already has a schema, use it — restating it as `rules`
is one constraint written twice, in two languages, drifting from the moment
either changes. Any library that implements
[Standard Schema](https://standardschema.dev) v1 works, with no adapter and no
dependency in aio:

```tsx
import { z } from "zod";

const Signup = z.object({
  email: z.string().email("that is not an email"),
  age: z.coerce.number().min(18, "18 or over"),
});

const form = useForm(
  { email: { initial: "" }, age: { initial: "" } },
  { schema: Signup },
);

if (form.validate()) {
  // `parsed()` is the schema's OUTPUT: `age` is a number here. The `!` is
  // for the type only — see "parsed() is separate" below.
  await api.signup(form.parsed!() as z.infer<typeof Signup>);
}
```

Three things worth knowing:

- **Issues land on the field they name.** `path: ["email"]` puts the message on
  `form.fields.email.error`, whichever spelling your library uses (Zod emits
  bare keys, Valibot emits `{ key }` wrappers — both are read). An issue that
  names no field — a cross-field refinement like "passwords must match" —
  becomes `form.formError`, and makes the form invalid. It is never dropped.
- **A field's own `rules` win.** They are the more specific statement, so a
  field that already has an error keeps its message.
- **`parsed()` is separate from `values()` on purpose.** `values()` returns `T`,
  inferred from each field's `initial` — so a form whose `initial` is `""` and
  whose schema coerces to a number would have a `values()` that says `string`
  and holds a number. `parsed()` returns `unknown`, so the one cast sits where
  you already know the answer. It is `null` when there is no schema or the
  values do not parse. Every form `useForm` returns has it, but `FormState`
  declares it optional (so a hand-built `FormState` in a test still compiles),
  which is why the call is written `form.parsed!()` — plain `form.parsed()` is
  `TS2722: Cannot invoke an object which is possibly 'undefined'`.

The schema must be **synchronous**: `validate()`, `values()` and `valid` are,
and `valid` is read during render. An async schema throws by name rather than
quietly not running — use a field's `asyncRules` for work that waits.

## useFieldArray()

```ts
function useFieldArray<T>(initial?: T[]): FieldArrayState<T>;
```

Dynamic array field. Call outside the component body.

```tsx
import { useFieldArray } from "aio/air";

const tags = useFieldArray<string>(["default"]);

const TagEditor = () => (
  <div>
    {tags.items.map((tag, i) => (
      <div key={i}>
        <span>{tag}</span>
        <button onClick={() => tags.remove(i)}>x</button>
      </div>
    ))}
    <button onClick={() => tags.push("new")}>Add Tag</button>
  </div>
);
```

**FieldArrayState\<T\>:**

| Member             | Type   | Description            |
| ------------------ | ------ | ---------------------- |
| `items`            | `T[]`  | Signal-tracked array   |
| `push(item)`       | `void` | Append                 |
| `remove(index)`    | `void` | Remove at index        |
| `move(from, to)`   | `void` | Reorder                |
| `set(index, item)` | `void` | Replace at index       |
| `reset()`          | `void` | Reset to initial array |

## Testing form inputs

AIR delegates DOM events on the root container, so a synthetic event **must
bubble** to be handled. `testUI` does this for you (`ui.Form.Email.type("…")`).
If you hand-roll a harness (raw CDP / dispatched events), set `bubbles: true` —
otherwise the input handler never fires and the bound state stays empty:

```js
input.value = "alice@example.com";
input.dispatchEvent(new Event("input", { bubbles: true })); // ← bubbles required
```

(You do **not** need React's native-setter trick — AIR reads `e.target.value`
directly; the only requirement is a bubbling event. Prefer `testUI`, which
handles this and re-resolves elements at action time.)

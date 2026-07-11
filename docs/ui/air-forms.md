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
    <input type="email" {...form.bind("email")} />
    {form.fields.email.error && (
      <span className="err">{form.fields.email.error}</span>
    )}

    <input type="password" {...form.bind("password")} />
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

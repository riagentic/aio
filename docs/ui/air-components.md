# AIR Components

A component is a plain function returning TSX (or `null`).

---

## Props & Children

```tsx
interface GreetingProps {
  name: string;
  children?: any;
}

const Greeting = (props: GreetingProps) => (
  <div>
    Hello, {props.name}!
    {props.children}
  </div>
);

<Greeting name="Alice">
  <span>(friend)</span>
</Greeting>;
```

---

## Conditional Rendering

Ternary or `&&` (same as React):

```tsx
const loggedIn = signal(false);

const App = () => (
  <div>
    {loggedIn.value ? <Dashboard /> : <LoginForm />}
    {loggedIn.value && <UserMenu />}
  </div>
);
```

**`<Show>` component** — conditional rendering with TypeScript narrowing:

```tsx
import { Show, signal } from "aio/air";

const user = signal<{ name: string } | null>(null);

const App = () => (
  <Show when={user.value} fallback={<span>Loading...</span>}>
    {(u) => <div>Hello, {u.name}!</div>}
  </Show>
);
```

| Prop       | Type                   | Description                       |
| ---------- | ---------------------- | --------------------------------- |
| `when`     | `T \| falsy`           | Condition — truthy enables render |
| `fallback` | `VChild`               | Shown when `when` is falsy        |
| `children` | `(value: T) => VChild` | Render function with narrowed T   |

---

## Lists & Keys

Same as React — `.map()` with `key`:

```tsx
const users = signal([
  { id: 1, name: "Alice" },
  { id: 2, name: "Bob" },
]);

const UserList = () => (
  <ul>
    {users.value.map((user) => <li key={user.id}>{user.name}</li>)}
  </ul>
);
```

Without keys, positional comparison. With keys, elements matched by identity —
DOM nodes moved instead of recreated.

---

## Fragments

Group children without a wrapper element:

```tsx
const Pair = () => (
  <>
    <li>One</li>
    <li>Two</li>
  </>
);
```

Or import `Fragment` explicitly:

```tsx
import { Fragment } from "aio/air";
```

---

## Refs

Direct access to DOM nodes:

```tsx
// Callback ref
<input
  ref={(el) => {
    if (el) el.focus();
  }}
/>;

// Object ref (from useRef)
import { useRef } from "aio/air";

const inputRef = useRef<HTMLInputElement>(null!);

const App = () => (
  <div>
    <input ref={inputRef} />
    <button onClick={() => inputRef.current.focus()}>Focus</button>
  </div>
);
```

Callback refs receive `null` when the element is removed.

---

## Style & Class

```tsx
// Style object (camelCase -> CSS)
<div style={{ backgroundColor: "red", fontSize: "16px" }} />

// className — string
<div className="foo bar" />

// className — array (truthy values joined)
<div className={["foo", isActive && "active"]} />

// className — object (keys with truthy values)
<div className={{ foo: true, bar: false, active: isActive }} />
```

Style diffing is incremental — only changed properties are updated.

---

## Events

Event handlers use `on` + event name (camelCase), same as React:

```tsx
<button
  onClick={() => console.log("clicked")}
  onMouseEnter={() => hover.set(true)}
  onMouseLeave={() => hover.set(false)}
>
  Hover me
</button>

<input onInput={(e: Event) => name.set((e.target as HTMLInputElement).value)} />
```

> **Note:** AIR uses native DOM events, not React synthetic events. Use
> `onInput` instead of `onChange` for text inputs.

---

## SVG

SVG elements are automatically detected and created with the correct namespace:

```tsx
<svg viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="40" fill="red" />
</svg>;
```

All standard SVG tags are recognized.

---

## dangerouslySetInnerHTML

Inject raw HTML (no XSS sanitization):

```tsx
<div dangerouslySetInnerHTML={{ __html: "<b>bold</b>" }} />;
```

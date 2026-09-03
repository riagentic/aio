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

### A component that renders nothing keeps its place

`null` is a first-class thing to render, and it does **not** mean "no node":

```tsx
const Banner = () => alert.value ? <aside>{alert.value}</aside> : null;

<main>
  <Banner /> {/* absent → an empty comment node holds this slot */}
  <Article />
</main>;
```

While `Banner` is absent AIR leaves a comment node (`<!---->`) where it is
written, so when it comes back it appears **first**, not after `<Article/>`.
Without that placeholder the component has no DOM anchor, and a renderer with
nothing to insert before can only append — which is how a prompt written as the
first child of a panel ends up below a screenful of settings.

This is the same slot a `null` child has always used, and the server emits it
too, so mount, re-render, SSR and hydration all agree on where an absent
component sits. What it costs is one comment node per absent component; what it
buys is that position never depends on render order.

The visible consequences, if you assert on markup:

```ts
// a component that renders null
root.innerHTML; // "<!---->"  — not ""
root.children.length; // 0    — comment nodes are not elements
root.querySelector("aside"); // null
```

Assert on **elements** (`children`, `querySelector`) rather than exact
`innerHTML` and absence reads the same either way.

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

### `false` removes an attribute

`false` is treated as "no attribute", including for `aria-*` and `data-*`:
`<button aria-pressed={false}>` renders `<button>`, not `aria-pressed="false"`
(React writes the string for `aria-*`). Pass the string when the false state is
meaningful — `aria-pressed={pressed ? "true" : "false"}` — and note that `""`
and `0` are values, so they are kept.

### Reactive styles

An object style updates reactively **as long as the signal read happens inside
the component's render** — the read is what subscribes the component:

```tsx
// ✅ reactive — `.value` read during render subscribes this component
<div style={{ color: theme.value === "dark" ? "#eee": "#111" }} />

// ✅ reactive — a raw signal in the style object is auto-bound per-property
<div style={{ color: colorSignal }} />
```

The one way a style "freezes at mount" is if the value is computed **outside**
the tracked render — from module scope, a helper that ran once, or under
`untrack` — so no subscription is registered:

```tsx
// ⚠️ frozen — style built once, outside any tracked read
const frozen = { color: colorSignal.value }; // read at module load
export default () => <div style={frozen} />; // never re-tracked
```

Keep the signal read (or the raw signal) **in the JSX**, or drive dynamic
appearance with `className` + CSS. (This is purely about _where_ the read
happens; the diff/patch path itself is fully reactive.)

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

<input onInput={(e) => name.set(e.currentTarget.value)} />
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

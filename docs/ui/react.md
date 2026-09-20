# React on aio

Write React and it works. aio's renderer (AIR) re-runs components the way React
does, and React's hooks are on `aio/air`:

```tsx
import { cell } from "aio";
import { useState } from "aio/air";

const notes = cell("notes", {
  state: { items: [] as { id: string; text: string }[] },
  methods: {
    add(s, text: string) {
      s.items.push({ id: crypto.randomUUID(), text });
    },
  },
});

export default function App() {
  const [draft, setDraft] = useState("");
  return (
    <form onSubmit={() => notes.add(draft)}>
      <input value={draft} onChange={(e) => setDraft(e.currentTarget.value)} />
      <ul>{notes.items.map((n) => <li key={n.id}>{n.text}</li>)}</ul>
    </form>
  );
}
```

What aio adds is the **cell**: shared and server state is `notes.items`, read
directly; writes are `notes.add()`. No fetch, no store, no reducer.

## Checked, not claimed

`tests/react-patterns.test.ts` runs the same components under **React 19** and
under AIR and requires the same page, the same input values and the same effect
order after every interaction. It covers state updates batched in one handler,
effects with deps and cleanup order, `useCallback` identity as an effect dep,
`useMemo`, `useRef` (a value and a DOM ref), context, keyed lists that keep a
child's state across a reorder, a controlled input, and a child whose cleanup
runs on unmount.

**One known difference:** React also writes a controlled input's value into the
`value` _attribute_; AIR sets the property only. What the user sees and types is
identical. It shows only in `form.reset()` and `[value=…]` CSS selectors.

## One way per job

Every spelling below works. When you have no habit to keep, use the first:

| job                    | use                                               | also works                       |
| ---------------------- | ------------------------------------------------- | -------------------------------- |
| shared / server state  | a cell: read `notes.items`, call `notes.add()`    | —                                |
| local UI state         | `useLocal` (tuple `[v, setV]`, or `.patch`)       | `useState`, `useSignal`          |
| run on mount / cleanup | `onMount(() => … return cleanup)`                 | `useEffect(fn, [])`              |
| re-run when X changes  | `useEffect(fn, [x])`                              | `effect()` (auto-tracks signals) |
| derived value          | `computed()` at module scope, `useMemo` in a body | —                                |
| test a cell            | `testCell`                                        | `bootCells`                      |
| test a UI              | `testUI`                                          | —                                |

The local-state spellings are proven equal by
`tests/local-state-spellings.test.ts`: same page at every step, including a
child that keeps its state across a re-render and starts fresh after an unmount.

## Going faster

A component that reads a cell re-runs when that cell changes. For a hot path,
read a `signal()` or `computed()` directly in JSX: AIR updates that text node
without re-running the component. See
[reactivity tracking](reactivity-tracking.md).

Mounting real React _components_ (a React library you cannot rewrite) is a
different job: see [React islands](react-islands.md).

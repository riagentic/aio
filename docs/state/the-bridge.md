# The bridge — what crosses, what doesn't, what freezes

A shared cell's methods run on the **server**; the browser holds a live,
reactive **replica** of state. One network hop — the _bridge_ — sits between a
component calling `cell.method()` and the reducer that runs it. This page is the
single reference for what that hop does to your data. (Client-scoped cells —
`scope: "client"` — run entirely in the browser and have no bridge; none of the
caveats here apply to them.)

## TL;DR

| Thing                                                   | Crosses the bridge?                                        |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| A method's **arguments**                                | ✅ yes (JSON-serialized)                                   |
| A method's **return value**                             | ✅ yes, if JSON-serializable (else `undefined` + dev warn) |
| **State** the method wrote                              | ✅ yes — synced to the replica reactively                  |
| A returned **schedule/own effect**                      | ▶️ scheduled server-side; `await` resolves `undefined`     |
| A non-serializable return (fn, class, `BigInt`, cyclic) | ⚠️ becomes `undefined` on the client                       |
| A **thrown error**                                      | ✅ the client `await` rejects with the message             |

## Return values cross the bridge

`await cell.method()` in a browser resolves with the method's **actual return
value** — the same value an in-process caller (server code, a test, the CLI)
gets. This holds for sync and async methods alike:

```ts
// cells.ts (runs on the server)
export const cart = cell("cart", {
  state: { items: [] as Item[] },
  methods: {
    addItem(s, item: Item): string {
      const id = crypto.randomUUID();
      s.items.push({ ...item, id });
      return id; // ← returned to the caller
    },
    async checkout(s): Promise<{ ok: boolean; ref: string }> {
      const res = await charge(s.items); // real server-side await
      s.items = [];
      return { ok: true, ref: res.ref }; // ← settles when checkout COMPLETES
    },
  },
});

// a browser component
const id = await cart.addItem({ name: "Book", price: 12 }); // "a1b2-…"
const rcp = await cart.checkout(); // { ok: true, ref: "…" }
```

**How it works** (no annotations, nothing to configure): each awaited client
dispatch carries a correlation id; the server runs the method and sends the
return value back in that action's ack frame. Async methods settle the promise
on **completion**, not on receipt.

## The one rule: returns must be JSON-serializable

Only what JSON can carry survives the hop. Plain objects, arrays, strings,
numbers, booleans, and `null` are fine. These are **not** and resolve to
`undefined` on the client (with a loud dev-mode warning naming the method):

- functions / methods
- class instances (a `Map`, `Date`, custom class — the prototype is lost)
- `BigInt`
- circular structures

```ts
methods: {
  makeHandler(s) { return () => {} },   // ⚠️ client await → undefined + warning
}
```

In-process callers still receive the raw value — only the network boundary
requires JSON. If you need to hand a browser something non-serializable, convert
it to plain data first (`date.toISOString()`, `[...map]`, `n.toString()`).

## Effects don't come back as values

Returning a `schedule.*` / own-effect (or an array of them) **schedules** the
effect server-side; it is not treated as a return value, so `await` resolves
`undefined`. A method can't both schedule an effect and return a value in one
call. See
[Methods → Returning schedule effects](methods.md#returning-schedule-effects).

## Prefer reactive state when the answer is already synced

The return value is the right tool for a **one-shot result** the caller needs
inline (a new id, a receipt, a validation verdict). But when what you want is
_state the method changed_, don't thread it through the return — **read it
reactively**. It syncs to the replica anyway, and reactive reads keep the UI
live as the value changes:

```ts
// ✅ inline result you act on once
const id = await todos.add({ title });

// ✅ ongoing value — read the replica, don't return it
const count = todos.items.length; // reactive; re-renders when it changes
```

## Inline `style={{}}` is reactive (this used to be a trap)

A cell-dependent inline `style={{ width: bar.pct + "%" }}` updates like any
other read — on both read paths (the server store and the browser's
signal-backed binding), pinned by regression tests. An older version froze it at
mount, and that warning outlived the fix long enough to become folklore: apps
kept converting working styles to classes "just in case".

The one genuine freeze is a value computed **outside** the tracked render — at
module scope, in a helper that ran once, or under `untrack` — where no
subscription is ever registered. See [air-components](../ui/air-components.md).

## See also

- [Methods → Returning a value](methods.md#returning-a-value)
- [Methods → Every `await` is a commit + render point](methods.md#async-methods)

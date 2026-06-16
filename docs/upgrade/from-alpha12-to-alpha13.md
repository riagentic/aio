# Upgrading from alpha12 to alpha13

alpha13 is the **DX overhaul + production hardening** release — the largest
behavior change since the `feature()` → `cell()` rename. Most apps need only the
defaults review below; the rest are dev-only loud-failures that point at the fix
when you hit them. It also rolls in nuclear audit waves 6–11 (~194 fixes across
sync, CRDT, signals, rate limiter, op buffer) — those are internal, no action.

```diff
-    "aio": "jsr:@riagentic/aio@1.0.0-alpha12",
+    "aio": "jsr:@riagentic/aio@1.0.0-alpha13",
```

## Breaking: `persist` and `ui` default to `"all"`

The single most important change — **it reverses the alpha10→alpha11 default.**
Zero-config cells now persist to Deno.Kv and sync to clients, matching the
README ("State persists across restarts. WebSocket sync included."). The "mode
cliff" (one configured cell flipping global behavior) is gone — each cell
resolves independently.

If you relied on the alpha11–alpha12 behavior where state did **not** persist or
sync by default, opt out explicitly:

```diff
  const session = cell("session", {
+   persist: "none",   // was the implicit default in alpha11–alpha12
+   ui: "none",        // don't broadcast this cell to clients
    state: { token: "" },
  });
```

Narrow instead of all-or-nothing with `{ include: [...] }` /
`{ exclude: [...] }`. The startup log now prints a `cells:` visibility table so
you can confirm what each cell exposes.

## Breaking: name collisions throw at `cell()` time

A state key that collides with a method/action/effect/generator/selector name
now throws when the cell is defined (previously the callable silently shadowed
the state). Rename one side:

```diff
  const gateway = cell("gateway", {
-   state: { error: null },
+   state: { lastError: null },   // 'error' collided with the action below
    actions: { error: (msg: string) => ({ msg }) },
  });
```

## Dev-only loud failures (no action unless you hit them)

These fail loudly in dev with a fix message; prod degrades gracefully.

- **Calling a method before `aio.run()`** throws in dev (was a silent inert
  action object). Register the cell in `aio.run({ cells: [...] })` first.
- **A sync-classified method that returns a Promise** throws in dev (your build
  transpiled an async function). Wrap it: `save: markAsync(async (s) => {…})`.
- **Mutating synced state outside a method** throws in dev (state is frozen).
  Call a cell method instead (rule AIO2).

## `await method()` now means "applied"

Bound methods return Promises everywhere. On the server the Promise resolves
after the dispatch is applied; in the browser it resolves on server **ack**, so
a state read on the next line is fresh. Existing `await`s get more correct;
unawaited calls are unchanged (fire-and-forget).

## Removed: React compat hooks on the main surface

`useState`/`useEffect`/`useMemo`/`useCallback` are **no longer exported from
`aio/air`** — import them from `aio/air/compat` instead. (`useRef` is a native
AIR primitive and stays on `aio/air`.) Native equivalents:
`useState`→`useLocal`/`signal`, `useEffect`→`onMount`/`effect`,
`useMemo`→`computed`. (`useEffect` honors a non-empty deps array with React
semantics.)

```diff
- import { useState, useEffect } from "aio/air";
+ import { useState, useEffect } from "aio/air/compat";
```

## Also new (non-breaking)

- **`scope: "client"` cells** — browser-local, per-tab, signal-backed, sync
  methods only. Use for per-client UI state (the todo example's filter).
- **Typed events** — `e.currentTarget` is element-typed on intrinsic handlers
  (`AirEvent<T>`); `onDoubleClick` is aliased to `dblclick`; unknown event names
  warn in dev. Existing `as HTMLInputElement` casts can be deleted.
- **`ui.entry`** — override the hardcoded `App.tsx` convention.
- **`aio doctor`** / `deno task doctor` — validates the six magic `deno.json`
  lines with one-line fixes.
- Child component signal subscriptions are independent of their parents — the
  `void sig.value` incantation is gone.

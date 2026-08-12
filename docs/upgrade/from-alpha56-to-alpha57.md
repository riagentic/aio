# alpha56 → alpha57

**One thing to check, and it is a behaviour change: `transaction` is opt-in
again.** Everything else is additive or a test-harness improvement you will only
meet if a test was relying on something that was never true.

## `transaction: true` is no longer the async default

alpha52 made `transaction: true` the default for async methods. alpha57 puts it
back: **a cell gets it when it asks for it.**

```ts
cell("editor", {
  transaction: true, //  ← say it if you want it
  methods: {/* … */},
});
```

If you wrote your app on alpha52–alpha56 and want the transactional model, add
that line. If you never thought about it, you are already where you want to be.

Why it moved back: the flip did not break a spelling, it silently re-specified
every async method already written. Two shapes, both from the field —

- a **stand-down guard** —
  `s.query = q; await fetch(); if (s.query !== q) return` — reads its own pinned
  write under a transaction, so the comparison can never fire and a stale
  response overwrites a fresh one
- a **spinner** — `s.loading = true` announcing the fetch it precedes — buffers
  to the end of the method doing the fetching, so it never reaches the client

Neither produces a type error, a runtime error, or a failing test. The app runs,
differently. The rule that now decides such questions is in `.katana/_aio.md`:
detectable at boot/build/lint → be strict and refuse with the exact replacement;
only observable by watching runtime behaviour → the default never changes.

**If you already added `transaction: false`** on aiol's advice, nothing to do —
it now states the default. `transaction: true` and `{ serialize: true }` are
unchanged for the cells that want them.

## Tests: module-level `signal()`s now reset between tests

`testUI`, `testCell` and `bootCells` restore every module-scope `signal()` to
the value it was created with, exactly as they already did for cells. Signals
created _during_ a render (`useLocal`, `useRef(signal(…))`) are per-mount and
untouched.

This can only turn a passing-by-accident test into a failing one, and only when
the test depended on a previous test's leftovers:

```ts
// Before: this passed only because an earlier test had set it.
testUI(App, "shows landscape", (ui) => {
  assertEquals(ui.orientation.text, "landscape"); // now: "portrait"
});
```

The fix is to say what the test needs — `{ seed: { … } }` at mount, or set it in
the test body. If you wrote defensive setup lines to work around the leak, you
can delete them.

## Tests: `present`/`absent` answer about the element first

`t` on an element names that element; `t` on a **component** is a rename-proof
handle for the component — and aio's own kit forwards `t` down
(`<Button t="Home">`), so one string often addresses both. Presence now resolves
a live element first, and takes a kind when you want to be explicit:

```ts
ui.absent("image-negative", "element"); // no such element on screen
ui.present("image-negative", "component"); // the component is rendering something
```

An element with no live DOM node no longer counts as present — `present()`,
handle resolution and `ui.html()` now answer from one definition of "on screen".
If a test asserted `present(x)` for something that had a surface entry but no
DOM node, it was asserting a thing that was not visible.

## Tests: a handle survives a remount

Handles are addressed by NAME (a path only tie-breaks same-named siblings), so a
handle taken before a subtree remounts keeps working:

```ts
const prompt = ui.prompt; // resolved inside <StageA/>
await ui.toVideo.click(); // …StageA unmounts, StageB mounts
await prompt.setValue("a cat"); // still the right element
```

Nothing to change — code that worked keeps working, and the workaround of
setting state before the first render is no longer needed.

## Also new

- **`signal.get()`** — the tracked read, mirroring `.set()`. `.value` and
  `.peek()` are unchanged; pick whichever reads better at the call site.
- **`ui.Name1`** — the explicit spelling of "the first instance", beside the
  existing `ui.Name2…`. Same instance the bare name has always meant.
- **Failure listings are readable** — a missing handle lists the closest
  candidates instead of every name in the app. `AIO_TEST_NAMES=all` restores the
  exhaustive list.
- **[Reactivity — what is tracked, and where](../ui/reactivity-tracking.md)** —
  the tracking boundary, written down: a read subscribes only during the
  synchronous execution of a component body, a `computed()` or an `effect()`.

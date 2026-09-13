# Reactivity — what is tracked, and where

A field report gave up an hour to this and asked for exactly one thing: "nowhere
does the documentation say where a tracking boundary begins and ends." This is
that page.

The rule fits in one sentence:

> **A read is tracked when it happens during the synchronous execution of a
> component body, a `computed()`, or an `effect()` — and at no other time.**

Everything below is a consequence of that sentence.

---

## The boundary is time, not syntax

The tracking scope opens when a component function is CALLED and closes when it
RETURNS. It is not a region of your source file — it is a window in time.

```tsx
function Stage() {
  studio.card; //  tracked — the body is running
  const later = () => studio.card; //  NOT tracked when `later()` runs afterwards
  setTimeout(() => studio.card, 0); //  NOT tracked — the body already returned
  return <div>{studio.card}</div>; //  tracked — evaluated before the return
}
```

This is why nesting makes no difference. A read inside a ternary, inside a
fragment, inside a `.map()`, inside a helper function you called — all still
inside the same window:

```tsx
function App() {
  return (
    <div>
      {studio.view === "simple" ? <SimpleView /> : (
        <>
          {studio.card === "image" ? <ImageStage /> : null}
          {studio.card === "video" ? <VideoStage /> : null}
        </>
      )}
    </div>
  );
}
```

Both `studio.view` and `studio.card` are read while `App` runs, so both are
dependencies of `App`. Changing either re-renders it. (Pinned by
`tests/feedback-ui-reactivity-rules.test.tsx`.)

## Dependencies are re-collected on every render

There is no "first render decides" rule. Each render starts with an empty
dependency set and subscribes to whatever it reads THIS time.

So a conditional read is safe in both directions:

- A branch not taken this render contributes no dependency — a change to state
  that is currently invisible correctly re-renders nothing.
- A branch entered for the first time on the fifth render subscribes on the
  fifth render.

## One cell is one signal

Reading any field of a cell subscribes to that whole cell:

```tsx
studio.card; // subscribes to `studio` — all of it
```

Two reads of the same cell can therefore never disagree about whether they are
subscribed. Splitting state across cells is what makes subscriptions narrower;
reading fewer fields of one cell does not.

Selectors are a tracked read of the cell they are declared on, and a deps-form
selector additionally tracks each OTHER cell it touches — precisely those, not
all of them.

A selector that returns a function (`choicesFor: (s) => (role) => …`) is tracked
at the moment you CALL the accessor, not when you call the function it returned:

```tsx
// declared: choicesFor: (s) => (role) => …
const pick = studio.choicesFor; //  no read yet
const opts = studio.choicesFor()("image"); //  tracked at the FIRST call
```

Note the empty `()`. The accessor reads the cell and hands back your inner
function; the argument goes to that function, not to the accessor. Passing it to
the accessor (`studio.choicesFor("image")`) returns the inner function itself —
the argument lands on the selector's second parameter, which a curried selector
does not declare.

If you would rather write it flat, declare the parameter instead and call it in
one step — this shape takes its arguments on the accessor:

```tsx
// declared: choicesFor: (s, role) => …
const opts = studio.choicesFor("image"); //  tracked here
```

Either way, calling during render is the normal case, and it is tracked.

## What is NOT tracked

| Where the read happens                           | Tracked? |
| ------------------------------------------------ | -------- |
| Component body, `computed()`, `effect()` body    | **yes**  |
| An event handler (`onClick`, `onInput`, …)       | no       |
| `onMount` / `onCleanup` / `afterRender`          | no       |
| `setTimeout` / `queueMicrotask` / a `.then()`    | no       |
| Anything after an `await` inside an async fn     | no       |
| A cell method (methods write state, not read UI) | no       |
| `.peek()`, anywhere                              | no       |
| Module top level                                 | no       |
| **A cache HIT that returns before reading**      | **no**   |

Most of these are correct and deliberate — an event handler reading
`count.peek()` to compute the next value must NOT subscribe the handler to
anything.

The one that bites is **a read you deferred by accident**: capturing a value in
`onMount` and storing it, or reading after an `await`. The symptom is always the
same — state is correct, the DOM is stale.

**In dev, `onMount` and `afterRender` now warn** when they read something the
render body did not, naming the value and the component:

```
[aio-dev] `speech.spokenId` was read inside afterRender in <App>, but NOT
during its render. A component subscribes only to what its render body
touches, so <App> will not re-render when this changes and afterRender will
run once and never again — the feature works exactly once and then reports
itself as "it works sometimes". Read it in the render body and close over the
value.
```

That last sentence is why the warning exists rather than only this page. One
codebase shipped this bug three times, in three features, by an author who had
written the explaining comment into two of the earlier ones and read both while
writing the third. Understanding the rule is not enough when nothing on the
failing path mentions it.

The other rows in the table still warn about nothing: an event handler and a
`setTimeout` are _supposed_ to read untracked, so warning there would fire on
correct code.

### A cell is the right place to keep a fact, and the wrong place to test one against

The corollary, and the one that reached a user. To do something exactly once —
read a message aloud, send a notification — the obvious shape is to keep the
marker in a cell and check against it:

```tsx
if (msg.id !== speech.spokenId) { // ✗ the marker has not moved yet
  speak(msg.text);
  speech.mark(msg.id); // a DISPATCH — lands on a later render
}
```

`mark` is a dispatch, so the field does not move until a later render, and a
streaming reply produces dozens of renders inside that window. Every one of them
read the un-moved marker and spoke the message again. It was reported as "it
repeats my text twice and the answer three times" — the count varying with how
fast the tokens arrived, which is why it read as random.

Keep the decision in a module-local variable, written synchronously at the
moment it is made, and keep the cell field as the durable copy:

```tsx
let spoken = ""; // synchronous — the decision point
if (msg.id !== spoken) {
  spoken = msg.id;
  speak(msg.text);
  speech.mark(msg.id); // still persisted, for after a reload
}
```

From a component, a cell write looks synchronous and is not.

```tsx
// stale: `plan` is read once, after the body returned
function Stage() {
  const plan = signal("");
  onMount(() => plan.set(studio.card)); // ← reads outside the window
  return <div>{plan.value}</div>;
}

// live: read it in the body
function Stage() {
  return <div>{studio.card}</div>;
}
```

## If a UI is stale, ask these in order

1. **Is the read in the component body?** Move it there. Reading it at the top
   of the component is not a style preference — it is what subscribes.
2. **Is it `.peek()`?** `.peek()` never subscribes. Use `.value` / `.get()`.
3. **Is it behind an `await`, a timer, or a lifecycle hook?** Same fix as 1.
4. **Is the state actually changing?** `set()` skips shallow-equal updates — see
   [equality rules](air-signals.md). A named signal warns when it skips.
5. **Is the value derived once and cached?** A `computed()` re-runs when its own
   tracked reads change; if it read `.peek()`, it never will.
6. **Did a cache hand it back without reading?** See below — this one is
   permanent, per instance, and looks like nothing.
7. **Is the signal created in the component body with `signal()`?** The body
   re-runs on every render, so each render makes a fresh signal and a writer
   holding the first one updates nothing on screen. Use `useSignal()` (per
   instance) or a module-scope `signal()`.

## A cache hit skips the read — so it skips the subscription

Because [one cell is one signal](#one-cell-is-one-signal), any list large enough
to matter pushes an app toward memoizing. And a plain cache is the one shape
where "the read is in the body" is not enough — because on a **hit** there is no
read at all:

```tsx
import { cell } from "aio";

type Row = { name: string };
const accounts = cell("accounts", {
  state: { list: [] as Row[] },
  methods: {},
});
const cache = new Map<string, Row[]>();

function rows(filter: string) {
  const hit = cache.get(filter);
  if (hit) return hit; //  returns before touching the cell
  const v = accounts.list.filter((a) => a.name.includes(filter));
  cache.set(filter, v);
  return v;
}

function Panel({ filter }: { filter: string }) {
  return <ul>{rows(filter).map((a) => <li>{a.name}</li>)}</ul>; // subscribed only on a MISS
}
```

This is worse than "stale", in two ways:

- It is **per component instance and permanent**. The instance that got the miss
  works forever; the one that got the hit is dead forever — from the same cache,
  in the same frame. Nothing re-arms it, because nothing re-renders it.
- There is **no symptom**. A component that subscribes to nothing renders
  correctly, once. The data in the cell is right; only the DOM is old.

Use `trackedMemo`, which records the read set on a miss and **replays it on a
hit**, so the caller subscribes to exactly what computing the value would have
read. Freshness comes from the same recorded set — no dependency array:

```tsx
import { cell } from "aio";
import { trackedMemo } from "aio/air";

const accounts = cell("accounts", {
  state: { list: [] as { name: string }[] },
  methods: {},
});

const rows = trackedMemo((filter: string) =>
  accounts.list.filter((a) => a.name.includes(filter))
);

function Panel({ filter }: { filter: string }) {
  return <ul>{rows(filter).map((a) => <li>{a.name}</li>)}</ul>;
}
```

`trackedMemo(compute, { key, max })` — `key` maps the argument to a cache key
(default: the argument itself), `max` bounds the cache and evicts
least-recently-used.

In dev, aio names this when it sees it: a component that renders reading **no**
signals while another instance of the same component read some is reported by
name, with the fix. A component that reads nothing everywhere (a static one) is
not reported — that is not this bug.

## Extracting a component is a fix, but not for the reason it looks like

Pulling a branch into its own component (`function AdvancedView()`) and reading
the cell at the top of it does fix a stale subtree — because the read is now in
a body that runs. It is worth doing for scoping (a narrower subtree re-renders),
but if a read was already in a body that runs, extraction changes nothing about
tracking.

## Related

- [AIR Signals](air-signals.md) — the three reads, equality rules
- [AIR Lifecycle](air-lifecycle.md) — where `onMount` and friends run
- [Cells](../state/cells.md) — state, methods, selectors
- [Common Pitfalls](../basics/pitfalls.md)

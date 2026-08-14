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
`tests/t2v-feedback.test.tsx`.)

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

Most of these are correct and deliberate — an event handler reading
`count.peek()` to compute the next value must NOT subscribe the handler to
anything.

The one that bites is **a read you deferred by accident**: capturing a value in
`onMount` and storing it, or reading after an `await`. The symptom is always the
same — state is correct, the DOM is stale, nothing warns.

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

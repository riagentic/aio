# UI testing — semantic, selector-free, first-class

aio exposes every TSX component as an intuitive, deterministic API — tests and
tools drive the UI the way a user would, with **no DOM or selector lookup**. The
framework owns the renderer, events, transport, and state, so it publishes the
interactive surface it already knows and synchronizes every action with its own
render/dispatch loop (no sleeps, no flake).

## Testing a reducer → `testCell`

A cell's methods are driven with `testCell` (or through the UI with `testUI`).
There is no other handle: `cell.__aio` is framework-internal, and under a test
harness a read of a name it does not have — `cell.__aio.methods`, say — THROWS
(`[cell:<id>] __aio.<k> does not exist — drive methods with testCell/testUI`).
It used to resolve to `undefined`, and a guard like
`if (typeof fn === "function") { …assert… }` then passed while asserting
nothing. `testCell` runs the reducer on the raw, unfiltered state — the server's
context — so `visible.exclude` fields are present exactly as a server route sees
them.

```ts
import { cell } from "aio";
import { testCell } from "aio/testing";

const todos = cell("todos", {
  state: { items: [] as string[] },
  methods: { add: (s, text: string) => void s.items.push(text) },
});

testCell(todos, "add", (t) => {
  t.send.add("milk");
  t.expect.state((s) => s.items.length === 1);
});
```

## In tests: `testUI`

Zero boilerplate — one import, one call. The DOM is created for you, every
`cell()` your App imports boots automatically, and teardown is handled:

```ts
import { assertEquals } from "@std/assert";
import { testUI } from "aio/testing";
import { todo } from "../src/cell/todo.ts";
import App from "../src/App.tsx";

testUI(App, "add a todo end-to-end", async (ui) => {
  ui.TodoAdd.TitleInput.type("buy milk"); // actions queue — no await needed
  ui.TodoAdd.AddButton.click(); //           runs after the typing, in order
  await ui.expectCell(todo, (t) => t.items.length === 1); // observe = await
  assertEquals(ui.find("TodoRow", 1).text.includes("buy milk"), true);
});
```

- **Actions need no `await`** — they run in order on an internal queue, each
  settling the app before the next. You `await` only where you _observe_:
  `expectCell`, `waitFor`, `settle` (each drains the queue first and surfaces
  any queued failure — a typo'd name still fails the test, with the usual name
  listing). Awaiting an action still works and is equivalent.
- Acting on UI a previous action creates just works:
  `ui.OpenButton.click(); ui.Modal.ConfirmButton.click()` — the modal is
  resolved when its turn comes, not at access time.
- Actions: `click`, `dblclick`, `type`, `press` (Enter submits forms), `hover`,
  `focus`, `blur`, `select(value)`, `check()`, `uncheck()`, `clear()`,
  `scroll({top, left})`, `dragTo(other)` (full HTML5 DnD sequence with a shared
  DataTransfer).
- **What a user cannot do, a test cannot do** — the harness is never more
  permissive than the browser. Each of these **fails loud**, naming the element
  and what exists:
  - driving a `disabled` control, or typing into / clearing a `readonly` one;
  - `select()`ing a value with no option, a disabled option, or on something
    that is not a `<select>`;
  - `check()`/`uncheck()` on something with no checked state (a `<button>` is
    not a checkbox — this used to CLICK it and report success on the `am` tier);
  - clicking, typing or dragging something the user cannot see —
    `display: none`, `visibility: hidden`, the `hidden` attribute, on the
    element or on any ancestor, and `<input type="hidden">`;
  - typing into anything that is not an `<input>`/`<textarea>` (a `<div>` has no
    value; `contenteditable` is not driven), or past its `maxLength`.

  Assert the state instead (`.disabled`, `.readonly`). The same rules apply to
  `am trigger` — one implementation serves both tiers (`src/air/ui-trigger.ts`),
  and both are pinned by `tests/ui-harness-fidelity.test.tsx`.
- **Events are the browser's, not a shortcut** — `type()` fires
  keydown/input/keyup per character and `blur()` commits the edit with a
  `change` before the `blur` (so an `onChange` handler really runs); a modified
  click (`click({ ctrlKey: true })`) lets the control's own activation behaviour
  toggle a checkbox/radio, exactly as an unmodified click does; `mouseenter`
  does not bubble.
- Reads: `.text`, `.value`, `.checked`, `.disabled`, `.readonly`, `.required`,
  `ui.surface()`, `ui.html()`; waits: `ui.waitFor(pred)`. The four booleans
  **always answer with a boolean**, `false` included:

  ```ts
  assertEquals(ui.OneLanToggle.checked, false); // an unchecked box
  assertEquals(ui.SubmitButton.disabled, true);
  ```

  (`checked` used to be reported only when true, and any unknown property
  resolves to a lazy callable so un-awaited sequences can target UI a queued
  action will create — so the natural assertion for "off" compared against a
  function and the failure named neither cause. `am surface` serialises the same
  four, so a live app and a test agree.)
- Server-authoritative reads: `ui.serverState()` / `ui.fullState(cell)` return
  the UNFILTERED store — including `ui.exclude`d fields the client hides — so
  you can assert on state a server route reads but the browser can't see.
- Keyed list instances: `ui.find("TodoRow", key)`.
- Cells run on the real local dispatch loop (the android runtime). Hermetic by
  default (`persist: false`, unique key — no state leaks between tests).
- **Registered cells reset to their `state:` defaults on each mount** — no
  hand-rolled reset helper is needed.
- **Module-level `signal()`s reset too**, to the value they were created with —
  they are state a test writes exactly as easily as a cell, and from inside a
  test the two are indistinguishable. (They used to survive, so a test that set
  `zoom` changed the meaning of a later test: an order-dependent failure that
  passes under `--filter`, which is the worst way to find one.) Signals created
  _during_ a render — `useLocal`, `useRef(signal(…))` — are per-mount anyway.
  The same reset runs for `testCell` and `bootCells`.
- What still needs manual reset is module state that is neither: a `let`
  singleton, a module-level `Map`, a lazily-built client handle.
- **Fire schedules deterministically with `await ui.advance(ms)`** — advances a
  virtual clock and dispatches every **cell** `schedule.after`/`every` now due,
  which makes debounce, `backoff` and `poll` unit-testable without real timers.
  `schedule.at` and `schedule.cron` fire on it too (they used to be dropped with
  a warning — see `tests/harness-schedule-parity.test.ts`). What it does NOT
  move is anything on a raw `setTimeout`, including `aio/ui`'s `toast()`
  auto-dismiss: give that a short `duration` and
  `await ui.waitFor(() => ui.absent("…"))`.

For **multi-cell logic tests without a component**, `bootCells([a, b])` from
`aio/testing` boots several cells on the same runtime and returns a handle with
`advance(ms)` / `settle()` / `dispose()` — the counterpart to single-cell
`testCell`.

### Handle form — compose your own test

When you want the handle inside your own `Deno.test` (multiple apps, custom
setup), `await using` disposes it at scope end:

```ts
Deno.test("two flows", async () => {
  await using ui = await testUI(App);
  await ui.App.SaveButton.click();
});
```

Options — only when you need control (all optional):

| Option             | Default                        | Use when                       |
| ------------------ | ------------------------------ | ------------------------------ |
| `document`         | auto happy-dom window          | jsdom / a shared window        |
| `cells`            | all registered (App's imports) | restrict the booted set        |
| `persist`          | `false` (hermetic)             | testing persistence flows      |
| `settleIterations` | `20`                           | very slow cascades             |
| `seed`             | —                              | pin machine-dependent state    |
| `user`             | — (identity unresolved)        | mount an authenticated app     |
| `authFeatures`     | all `false`                    | `<SignIn/>` feature adaptation |

### `settle()` never guesses

`ui.settle()` and `ui.advance(ms)` wait for the app to go quiet: the render loop
stops changing the HTML and no cell method is still in flight. When the
`settleIterations` budget runs out they **throw**, naming what is still running
(`todos:load`, `sync:pull`) or saying that the HTML never stopped changing.

They used to return either way, which made "the app quiesced" and "I gave up
waiting" the same answer — so every assertion after a settle that gave up ran
against a half-finished app while looking guarded. The retry loops
(`expectCell`, `waitFor`) still poll, and fold the same explanation into their
own timeout message.

A legitimately long cascade takes `settleIterations`; a legitimately long call
should be awaited, or driven with `ui.advance(ms)` if it waits on a schedule.

### A failing call nobody awaited fails the test

`onClick={() => todo.add()}` is the ordinary shape, and it awaits nothing. When
that method rejects, production logs it and dispatches `cell:__error`; it does
not pretend the call succeeded, and neither does the harness — the failure
surfaces at the next observation point (`settle`, `expectCell`, `waitFor`,
`dispose`), naming the method.

Awaiting the call — including `await assertRejects(() => todo.add())` — counts
as observing it, and it is not reported a second time. This is the rule
`testCell` has always used; `testUI` and `bootCells` now use it too, so the same
app code cannot pass one harness and fail another.

### Testing an authenticated app (`user`)

An app that opens with `useUser()` renders `<SignIn/>` for `null` — so without
an identity, every UI test of every authenticated screen renders the login form.
`user` mounts the app already signed in, mirroring `serverUser()`'s ambience —
no `/__aio/auth/me` stub, no reaching into auth-UI internals:

```ts
await using ui = await testUI(App, { user: { id: "sita", role: "customer" } });
// the FIRST render is signed in — role tests read as claims:
if (ui.present("AdminPanel")) throw new Error("customer saw admin");
```

`user: null` mounts anonymous (the `<SignIn/>` branch — pass `authFeatures` to
shape what it offers). The identity resets on dispose, so the next mount cannot
inherit this test's user. Omit `user` entirely for today's behaviour (identity
unresolved until a real `/me` answers).

### Modified clicks, and the viewport

`click`, `dblclick` and `hover` take the same modifier bag `press` does, so a
ctrl+click gesture is one line instead of a raw `MouseEvent`:

```ts
await ui.node7.click({ ctrlKey: true }); //  add a sub-element
await ui.row3.click({ shiftKey: true }); //  extend the selection
await ui.canvas.hover({ ctrlKey: true }); //  reveal the delete crosses
```

The mount also has a **viewport**, and it defaults to 1024×768:

```ts
testUI(App, "zoom anchors on the top-left visible node", {
  viewport: { width: 1440, height: 900 },
}, async (ui) => {/* … */});
```

`window.innerWidth/innerHeight` and
`document.documentElement.clientWidth/clientHeight` all report it. Anything that
asks the viewport a question — a zoom that anchors on the first element fully
inside it, a responsive breakpoint, a virtualised list — otherwise reads
whatever the DOM stub happens to say, and **both branches of that question look
green**.

Element geometry is a different question with no honest answer: there is no
layout engine here, so `getBoundingClientRect()` is all zeros. testUI says so
out loud the first time you ask, because a silent zero is a measurement a
component will branch on:

```
[aio:testUI] getBoundingClientRect() was read, and there is no layout engine
here — every element measures 0×0 at position 0,0. A component that branches
on its own size therefore takes its DEGENERATE branch, and the test passes
without exercising the real one.
```

Assert the behaviour rather than the geometry, or stub the one measurement the
test is about (`Object.defineProperty(el, "clientWidth", { value: 800 })`).

### Global keys and `document` listeners

`document` and `window` are real under `testUI` (the mount's own happy-dom
window), so `document.addEventListener("keydown", …)` fires. `globalThis` is NOT
the same object — a listener there never fires, and under the harness the
registration FAILS the test (thrown at the site, rethrown by the next
`settle`/`expectCell`/`waitFor`/`dispose`), naming the fix. Outside test-strict
mode the same registration only warns.

### When setup fails

A mount that throws — a component that explodes on first render, a boot refusal,
a seed naming no cell — leaves **nothing** behind. `testUI` installs
`document`/`window`/`location`/`history`/`matchMedia`/`localStorage` and patches
`addEventListener` before it renders, and a throw used to leak all of them: the
next mount's "is one already installed?" guard then adopted the dead test's
document (`body.children` growing 1 → 2 → 3), and no `dispose()` could reach it,
because the initializer never returned a handle for `await using` to dispose.
Setup now undoes exactly what it installed, in the same order `dispose()` does.

### What testUI installs

`testUI` owns one happy-dom `Window` per mount (`http://localhost/`, the
configured viewport) and publishes, on `globalThis`, `document`, `window`,
`location` and `history` from it — restored on teardown, so files share nothing.
The same objects are on the handle: `ui.window` and `ui.document`. Use them for
what the component's own code would reach —
`ui.window.dispatchEvent(new ui.window.Event("resize"))`,
`ui.document.activeElement`, a listener registered where the component's one
lives. `localStorage` is a fresh in-memory store per mount (`{ persist: true }`
keeps it). Nothing is installed twice: a `document` you pass in is used as-is.

For the binding every app needs, there is a primitive:

```tsx
onGlobalKey("Escape", () => lightbox.close());
onGlobalKey("k", () => palette.open(), { mod: true }); //  Ctrl/⌘+K
```

It resolves the right document, removes itself on unmount, ignores the chord
while focus is in an input (`ignoreInInput: false` to opt out), and is driven by
an ordinary `ui.<anything>.press("Escape")`.

## How names are derived (deterministic)

`LABEL + ROLE`, both inferred from the TSX — a pure function of the render:

| TSX                                                 | Name                  |
| --------------------------------------------------- | --------------------- |
| `<button>Submit</button>`                           | `SubmitButton`        |
| `<div class="button">Submit</div>`                  | `SubmitButton`        |
| `<input placeholder="Title">`                       | `TitleInput`          |
| `<input type="checkbox" aria-label="Agree">`        | `AgreeCheckbox`       |
| `<label>Enable LAN<input type="checkbox"/></label>` | `EnableLANCheckbox`   |
| `<Field label="Email"><Input/></Field>`             | `EmailInput`          |
| `<tr onClick=…>` / `<li onClick=…>`                 | `Row` / `Item`        |
| `<div role="dialog" onClick=…>`                     | `Dialog`              |
| `<span t="status">…</span>`                         | `status` (verbatim)   |
| `<button data-testid="save-btn">…</button>`         | `save-btn` (verbatim) |

Label priority: `t` prop > `data-testid` > `aria-label` > visible text >
**wrapping `<label>`** > placeholder > `name` attr. A wrapping `<label>` names
the first labelable element inside it and only that one — HTML's own implicit
association, so the surface name matches the accessible name a user hears. Role
comes from an explicit `role` first, then the tag/type (a clickable `div.button`
is a Button). The `t` prop also puts **non-interactive** elements on the surface
(assertion targets) and is the stable handle to use where visible copy may
change — it's typed and stripped from the DOM.

Names match **exactly**. There is no prefix or substring matching anywhere in
the surface — `toggle-negative` and `negative` are two unrelated handles.

### `t` on a COMPONENT names the component

`t` on an element names that element; `t` on a component is an additional,
rename-proof handle for the component itself:

```tsx
<PlacementAdvice t="advice" />; // ui.find("advice") — survives a rename
```

One string can therefore name two things — and this is the trap a field report
called the most confusing thing it hit:

```tsx
// NegativePrompt CONSUMES t and forwards it to its inner field
<NegativePrompt t="image-negative" />; // a switch; the field only when on
ui.absent("image-negative"); // false — the COMPONENT is showing (the switch)
```

The field really was gone; the question answered was "is the component rendering
anything". Two ways out, either is fine:

- **Say which one you mean** — `present`/`absent` take a kind:

  ```ts
  ui.absent("image-negative", "element"); // true — no such element on screen
  ui.present("image-negative", "component"); // true — the switch is showing
  ```

- **Don't make one name mean two things** — rename the data prop a component
  forwards (`fieldT`), so `t` on the component stays the component's handle.

Omit the kind and a live element wins over a component; on the ambiguous frame
(a component matched only by a forwarded `t`, with no element behind it) the
harness warns and names both escape hatches rather than returning a confident
wrong boolean.

### Presence means SHOWING, and every API agrees on it

`present`/`absent`, handle resolution and `ui.html()` answer from one
definition: an element is on screen when it has a live DOM node, and a component
is present when it put something on screen (a component that rendered `null` is
absent).

Handles are addressed by **name**; a path is only a tie-breaker between
same-named siblings. So a handle taken before a subtree remounts still resolves
after it:

```ts
const prompt = ui.prompt; // resolved inside <StageA/>
await ui.toVideo.click(); // …the stage unmounts, <StageB/> mounts
await prompt.setValue("a cat"); // still the right element
```

When a name misses, the failure lists the **closest** candidates, not every
handle in the app — set `AIO_TEST_NAMES=all` to see the exhaustive list.

### Same-named siblings are positional; a deep search is not

Two rules, because they answer two different questions:

```ts
ui.TodoRow; //              the FIRST instance — bare name, by position
ui.TodoRow1; //             the first, said explicitly (same instance)
ui.TodoRow3; //             the third
ui.find("TodoRow", "b"); // by AIR list key — stable across reorders
```

A **name lookup within a scope** is positional: the bare name is the first
instance and the ordinals address the rest. Every miss listing teaches it
(`TodoRow ×3 — use TodoRow2…TodoRow3 for the later instances`).

A **deep hoist** — `ui.Save` reaching an element wherever it is nested — is a
search, and a search with two hits has no right answer, so it throws and lists
both paths. Disambiguate with the owning instance: `ui.TodoRow2.Save`.

## Typed clients: `testGen`

Generate a fully-typed client from what actually renders — autocomplete on every
component and element, and a renamed button breaks tests at **compile time**:

```ts
// scripts/testgen.ts — run after UI changes
import { Window } from "happy-dom";
import { testGen } from "aio/testing";
import App from "../src/App.tsx";
import { todo } from "../src/cell/todo.ts";

const src = await testGen(App, {
  document: new Window().document,
  cells: [todo],
});
await Deno.writeTextFile("tests/ui.gen.ts", src);
```

```ts
// in a test
import { testUI } from "aio/testing";
import type { TypedTestUI } from "./ui.gen.ts";
import { todo } from "../src/cell/todo.ts";
import App from "../src/App.tsx";
import { Window } from "happy-dom";

const document = new Window().document;
const ui = await testUI(App, { document, cells: [todo] }) as TypedTestUI;
await ui.App.SubmitButton.click(); // autocompleted, compile-checked
```

`generateUITypes(surface)` is the pure core — feed it any surface, including a
live client's `am surface --json`.

## On a live app: `am surface` / `am trigger`

```sh
am surface                                     # the newest UI client's semantic surface
am trigger "App/TodoAdd:AddButton" click       # simulate a user on the live UI
am trigger "App/TodoAdd:TitleInput" type "buy milk"
```

Works against any connected client — browser tab, Electron window, **Android
WebView** — over aio's own protocol; no driver install. Dev-mode only. Both
tiers share one trigger implementation and the **full action set** (including
`select`, `check`, `clear`, `scroll "top=200"`, `dragTo "<target path>"`), so a
test and an `am` session behave identically.

The whole stack is proven against a real browser:
`tests/e2e-ui-chromium.test.ts` boots an app, opens it in headless chromium, and
drives it purely through surface/trigger — no webdriver, no CDP.

## On a running app: `am surface` / `am trigger`

This is the dev loop, not an ops tool — the live counterpart of `testUI`, and
the thing that lets you claim "it works" rather than "the tests pass". Click a
real row, drill into a real folder, cancel a real scan, all from bash against
the app you already have open — no driver, no selectors, no screenshot diffing.

The surface is a complete **perception + action space**, for a person at a
terminal and an AI agent alike — neither needs the DOM:

1. **Observe** — `am surface --json` returns every component with its visible
   `text`, and every element with its `name`, `path`, `events`, live
   `value`/`checked`/`disabled`.
2. **Act** — `am trigger "<path>" <action> [text]`. The reply includes the
   **fresh surface after the action settled**, so observe→act→observe is one
   call per step.
3. **Self-correct** — a missed path replies with `available: [...paths]`; pick
   the right one and retry. Unknown names in `testUI` throw listing what exists.

The same loop works in-process: `ui.surface()` →
`ui.<Component>.<Element>.<action>()` → `ui.surface()`.

Spec: `docs/specs/2026-07-10-semantic-ui-testing.md`. Cell-level testing:
[cell-testing.md](cell-testing.md).

### Small edges (each cost an hour once)

- Handles are **lazy** — `ui.find("Row", 3)` resolves on use. There is no
  `.style` on a handle; read `.text`, `.value`, `.checked`, or assert on state.
- `type("x")` **appends** to the current value (a user typing); `setValue("x")`
  **replaces** it.
- A list key is matched by its string form: `find("Row", 5)` and
  `find("Row", "5")` both find `key={5}`.

## Real boot — when testUI is not enough

`testUI` mounts the client runtime in-process: no worker pool, no transport, no
window. A bug in the worker path or in the real renderer therefore needs a real
boot, and `aio/testing` has three primitives for it — all `await using`:

| Primitive                 | Boots                         | Client                 | Use it for                                           |
| ------------------------- | ----------------------------- | ---------------------- | ---------------------------------------------------- |
| `testServer(config)`      | real `aio.run()`              | none — `srv.fetch`     | routes, auth, persistence, a method's server context |
| `testMultiClient(cfg, n)` | real `aio.run()`              | n real WebSocket peers | broadcast, convergence, **received patches**         |
| `smoke(config)`           | real `aio.run()`, dev serving | the eager module fetch | "green everywhere, blank in the window" — see below  |

A `worker: true` cell still runs **in-isolate** under all three: the entry
module is the test file, so there is nothing to host a worker from. The
serialization boundary is reproduced either way; for the isolation as well, pass
`testServer({ workers: "real", workerEntry })` — see
[prod-parity.md](prod-parity.md), which is also where the differences between an
in-process method call and a client's call are listed.

`testMultiClient` exposes each client's **patch stream** — what a browser tab
actually applies, in arrival order — next to its state:

```ts
await using m = await testMultiClient({ cells: [counter] }, 2);
await m.clients[0].dispatch(counter.increment.action(1));
const p = await m.clients[1].waitForPatch((p) =>
  p.path.join(".") === "counter.count"
);
assertEquals(p.value, 1);
m.clients[1].patches; // every { op, path, value } received; a full-state
//                        resend is one `replace` at the empty path
m.clients[1].onPatch((batch) => {/* live */});
```

A hidden field (`visible.exclude`) is asserted the honest way — no patch carries
it — rather than by the client's state merely lacking it.

### Boot smoke: `smoke()`

A static `import` of a `*.server.ts` module from any client-loaded file
blank-screens the app: the dev server never serves that file to the browser. The
graph validator refuses it statically (a blocking `server-only-import`, in the
dev server and `deno task check:graph`), and `smoke()` is the dynamic half: it
boots the app headless and **fetches every eagerly-linked client module** at its
browser URL, failing on the first non-200 with the static-import chain that
loads it.

```ts
import { smoke } from "aio/testing";
Deno.test("boot smoke", async () => {
  await smoke({ baseDir: ".", cells: [/* … */] });
});
```

`baseDir` defaults to cwd and the entry to `ui.entry` (`App.tsx`); modules
outside `baseDir` must be reachable through `serveDirs`, as in the dev server.

## Two surfaces at once: `testMultiClient`

aio's central promise is that an Electron window, a browser tab and `am` all
read the same state with no transport code. `testMultiClient` is how you verify
that for YOUR app — real server, real WebSocket clients, real broadcast:

```ts
import { assertEquals } from "@std/assert";
import { cell } from "aio";
import { testMultiClient } from "aio/testing";

type S = { items: string[] };

const orders = cell("orders", {
  state: { items: [] } as S,
  methods: {
    add(s: S, name: string) {
      s.items.push(name);
    },
  },
});

Deno.test("both windows see the same order", async () => {
  await using m = await testMultiClient({ cells: [orders] }, 2);

  await m.clients[0].dispatch(orders.add.action("widget"));
  await m.converged(); // waits for the work, not a sleep

  assertEquals(m.clients[1].state<S>("orders").items.length, 1);
});
```

- `m.clients[i].state(cell)` — what THAT client received, not the server's copy
- `m.serverState(cell)` — the truth every client should converge on
- `m.converged({ timeoutMs, settleMs })` — throws naming the divergent client
  and cell, so a failure says which surface fell behind
- `m.clients[i].call(cell, method, ...args)` — call a method **the way a client
  does**, over that client's socket: JSON arguments, a JSON-vetted return value,
  `_source: "UI"` at the server, and a rejection on refusal. The in-process call
  (`orders.add("widget")`) skips all four; see
  [prod-parity.md](prod-parity.md#a-client-calling-a-method--clientcall)
- `m.dispatchAll(action)` — the same action from every client at once, which is
  the concurrency case you cannot reason about from the outside:

```ts
// Same action from every client, in the same tick:
await m.dispatchAll(orders.add.action("widget"));
await m.converged();
assertEquals(m.serverState<S>("orders").items.length, 2); // no lost update
```

**`converged()` waits for the work, not for equality.** Right after a send every
client still agrees with the server — because the action hasn't arrived yet — so
a naive comparison would pass at the moment it knows least. It requires a quiet
period after the last send and a stable server before it answers; raise
`settleMs` on a loaded CI box.

## e2e — test the REAL client (`deno task test:e2e`)

`testUI` runs in-process; some bugs only surface at the transport boundary or in
a real renderer (the `_static` vnode freeze class). `deno task test:e2e` is the
blessed "test the real thing" path: it boots a real server and drives it over
the real wire — a headless **Chromium** client (auto-detected; the suite skips
where no browser is present) plus transport-faithful subscription/dispatch
checks — asserting on the client DOM and the authoritative server state.

- Headless UI + DOM: `tests/e2e-ui-chromium.test.ts` (real Chromium surface +
  clicks), `tests/e2e-blank-screen.test.ts`, `tests/e2e-sync-browser.test.ts`.
- Transport boundary: `tests/e2e-direct-subscription.test.ts`,
  `tests/e2e-dispatch-ack.test.ts` — a passing assertion means the client↔server
  boundary actually worked, which in-process `testUI` can't cover.
- Assertions over live server state from a script: `am expect <path> <op> [v]`
  (`--wait=N` polls until it settles).

Three fidelity levels, one mental model: `testUI` (pure vdom, fast) → `test:e2e`
(real browser + real transport) — use the first for units, the second to prove
"green" means "works".

### Building your own e2e — `testServer` + `testBrowser`

Rolling a custom e2e (a route, an auth flow, a real browser)? Two `aio/testing`
helpers replace the boot + browser boilerplate apps used to hand-roll — both
`await using`-ready, both self-cleaning:

```ts
import { testBrowser, testServer } from "aio/testing";

Deno.test("checkout over the wire", async () => {
  await using srv = await testServer({ cells: [cart], routes: {/* … */} });
  // srv.url, srv.port, srv.app, srv.fetch(path), srv.state()
  const res = await srv.fetch("/api/health");
  assertEquals(res.status, 200);

  await using browser = await testBrowser(`${srv.url}/`); // headless Chromium
  // drive it via `am surface`/trigger over the trojan channel, then assert on
  // srv.state(). The browser process is killed + its profile removed on dispose
  // (and via an unload backstop, so a crashed test never leaks chrome).
});
```

`testServer` boots in libraryMode on a free port with a throwaway data dir and
`persist: false` (all overridable). `testBrowser` throws a clear error when no
browser is found (set `$CHROMIUM_BIN` or pass `{ browserPath }`);
`findChromium()` is exported if you want to gate a test on availability.

Booting a server yourself instead? Take the port from `freePort()`, never from a
constant or a pid formula — two test files that derive ports arithmetically
eventually pick the same one and the suite flakes on whichever ran second:

```ts
import { freePort } from "aio/testing";

const PORT = freePort(); // verified free at call time; one per server
```

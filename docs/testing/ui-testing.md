# UI testing — semantic, selector-free, first-class

aio exposes every TSX component as an intuitive, deterministic API — tests and
tools drive the UI the way a user would, with **no DOM or selector lookup**. The
framework owns the renderer, events, transport, and state, so it publishes the
interactive surface it already knows and synchronizes every action with its own
render/dispatch loop (no sleeps, no flake).

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
  permissive than the browser. Driving a `disabled` control, typing into (or
  clearing) a `readonly` one, `select()`ing a value with no option or a disabled
  option, `select()`ing on something that is not a `<select>`, or `check()`ing
  something with no checked state all **fail loud** naming the element and what
  exists. Assert the state instead (`.disabled`, `.readonly`). The same rules
  apply to `am trigger` — one implementation serves both tiers.
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
- **Registered cells reset to their `state:` defaults on each mount** — you do
  **not** need to hand-roll a `resetCells()`. Only _non-cell_ module state (e.g.
  a module-level vault holder, a `let` singleton) needs manual reset in your
  test.
- **Fire schedules deterministically with `await ui.advance(ms)`** — advances a
  virtual clock and dispatches every **cell** `schedule.after`/`every` now due,
  which makes debounce, `backoff` and `poll` unit-testable without real timers.
  (`schedule.at`/`cron` aren't fired by the virtual clock. Neither is anything
  on a raw `setTimeout` — including `aio/ui`'s `toast()` auto-dismiss: give it a
  short `duration` and `await ui.waitFor(() => ui.absent("…"))`.)

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

| Option             | Default                        | Use when                  |
| ------------------ | ------------------------------ | ------------------------- |
| `document`         | auto happy-dom window          | jsdom / a shared window   |
| `cells`            | all registered (App's imports) | restrict the booted set   |
| `persist`          | `false` (hermetic)             | testing persistence flows |
| `settleIterations` | `20`                           | very slow cascades        |

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

## Typed clients: `testgen`

Generate a fully-typed client from what actually renders — autocomplete on every
component and element, and a renamed button breaks tests at **compile time**:

```ts
// scripts/testgen.ts — run after UI changes
import { Window } from "happy-dom";
import { testgen } from "aio/testing";
import App from "../src/App.tsx";
import { todo } from "../src/cell/todo.ts";

const src = await testgen(App, {
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
am surface 0                                   # the client's semantic surface
am trigger 0 "App/TodoAdd:AddButton" click     # simulate a user on the live UI
am trigger 0 "App/TodoAdd:TitleInput" type "buy milk"
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

1. **Observe** — `am surface 0 --json` returns every component with its visible
   `text`, and every element with its `name`, `path`, `events`, live
   `value`/`checked`/`disabled`.
2. **Act** — `am trigger 0 "<path>" <action> [text]`. The reply includes the
   **fresh surface after the action settled**, so observe→act→observe is one
   call per step.
3. **Self-correct** — a missed path replies with `available: [...paths]`; pick
   the right one and retry. Unknown names in `testUI` throw listing what exists.

The same loop works in-process: `ui.surface()` →
`ui.<Component>.<Element>.<action>()` → `ui.surface()`.

Spec: `docs/specs/2026-07-10-semantic-ui-testing.md`. Cell-level testing:
[cell-testing.md](cell-testing.md).

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

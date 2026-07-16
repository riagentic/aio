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
- Reads: `.text`, `.value`, `ui.surface()`, `ui.html()`; waits:
  `ui.waitFor(pred)`.
- Keyed list instances: `ui.find("TodoRow", key)`.
- Cells run on the real local dispatch loop (the android runtime). Hermetic by
  default (`persist: false`, unique key — no state leaks between tests).
- **Registered cells reset to their `state:` defaults on each mount** — you do
  **not** need to hand-roll a `resetCells()`. Only *non-cell* module state (e.g.
  a module-level vault holder, a `let` singleton) needs manual reset in your test.
- **Fire schedules deterministically with `await ui.advance(ms)`** — advances a
  virtual clock and dispatches every `schedule.after`/`every` now due. This makes
  toast auto-dismiss, debounce, `backoff`, and `poll` unit-testable without real
  timers. (`schedule.at`/`cron` aren't fired by the virtual clock.)

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

| TSX                                          | Name                  |
| -------------------------------------------- | --------------------- |
| `<button>Submit</button>`                    | `SubmitButton`        |
| `<div class="button">Submit</div>`           | `SubmitButton`        |
| `<input placeholder="Title">`                | `TitleInput`          |
| `<input type="checkbox" aria-label="Agree">` | `AgreeCheckbox`       |
| `<span t="status">…</span>`                  | `status` (verbatim)   |
| `<button data-testid="save-btn">…</button>`  | `save-btn` (verbatim) |

Label priority: `t` prop > `data-testid` > `aria-label` > visible text >
placeholder > `name` attr. Role from the tag/type (a clickable `div.button` is a
Button). The `t` prop also puts **non-interactive** elements on the surface
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
import type { TypedTestUI } from "./ui.gen.ts";
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

## For AI agents

The surface is a complete **perception + action space** — you never need the
DOM:

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

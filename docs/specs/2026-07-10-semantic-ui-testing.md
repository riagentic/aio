# Semantic UI testing — first-class, selector-free (alpha18 foundation)

**Goal.** UI tests are a first-class aio capability: every TSX component is
automatically exposed as an intuitive, executable API — driven by tests
(`testUI`), by `am` (manually or by AI agents), never by DOM/text lookup. Every
action is `await`ed and settles the full loop (event → handler → dispatch →
broadcast → re-render) before resolving. Dev/test only — zero production
overhead.

**Why aio can do what other frameworks can't.** AIR creates every element and
binds every handler, so the framework already _knows_ the complete interactive
surface. Selector engines (Playwright/Cypress/RTL) exist because those tools sit
_outside_ the app. aio exposes the surface it already owns.

## 1. The UI surface (registry)

`buildUISurface(rootVNode)` walks the live vdom on demand (no render-time
bookkeeping, no prod cost) and produces a semantic tree:

- **Component nodes** — every function component: name (fn name), `key` (AIR's
  own list key → instance addressing), path (`App/TodoList/TodoRow[42]`).
- **Interactive elements** — every element with `on*` handlers, named by a
  deterministic LABEL + ROLE inference: label = **`t` prop** (verbatim) >
  `aria-label` > static text > placeholder > `name` attr; role = tag/type
  semantics (a clickable `div.button` is a Button). So `<button>Submit</button>`
  **and** `<div class="button">Submit</div>` both surface as `SubmitButton`;
  `<input placeholder="Title">` is `TitleInput`. The `t` prop is a typed,
  framework-owned handle — stripped from the DOM, never shipped as an attribute.

Serialization (`serializeSurface`) is wire-safe: the same tree drives local
tests, `am ui` inspection, and AI agents reading "what can be done on this
screen".

## 2. `testUI` (Tier 1 — in-process, default)

```ts
import { testUI } from "aio/testing";

const ui = await testUI(App, { cells: [todo] });

await ui.TodoAdd.TitleInput.type("buy milk"); // client-only useLocal — real events
await ui.TodoAdd.AddButton.click(); // settles automatically
await ui.find("TodoRow", 1).RemoveButton.click(); // keyed instance
ui.surface(); // the semantic tree (humans/AI)
await ui.expectCell(todo, (t) => t.items.length === 0);
ui.unmount();
```

- **Await-by-default**: every action runs `settle()` — flush scheduled renders +
  drain the dispatch microtasks, repeated until stable.
- **Real event dispatch**: actions resolve the address → element, then fire real
  DOM event sequences through AIR's own delegation (click/input/keydown/
  submit…) — identical to a user; `useLocal`/pure-client logic just works.
- **Stupid-proof errors**: unknown names list what _is_ available on that node.
- Cells optional: pure client-only components test without any server/state.

## 3. Tier 2 — live clients over the aio protocol (`am`)

The same surface + trigger, served by the client over the existing WS/UDS
command channel (extends today's `__click`/`InteractCommand` machinery):

- `__ui:surface` → serialized semantic tree of all mounts
- `__ui:trigger {path, action, payload}` → run the same real-event dispatch in
  the live client, reply after settle

`am surface <clientIdx>` prints the surface as a friendly tree;
`am trigger <clientIdx> "App/TodoAdd:AddButton" click` drives it — browser,
electron, **Android WebView**, no driver install. Dev-mode only (`!prod`),
served over the authenticated trojan/WS channel. Misses reply with the list of
available paths, so humans and AI agents self-correct in one round-trip.

## 4. Tier 3 (later) — real-browser orchestration

`aio test:e2e`: launch app + chromium/electron, reuse the Tier-2 protocol, add
pixels/screenshots. Same test code.

## 5. Typed clients (later)

`deno task testgen` mounts the app once, walks the surface, and emits a typed
client (`ui.App.TodoAdd.add.click()` autocompletes; renames break at compile
time). Types are generated from what actually renders — not from parsing TSX.

## Non-goals (v1)

Pixel assertions, visual diffing, non-AIR DOM, production use. Full static
typing of the dynamic proxy waits for `testgen` (index access is loosely typed
in v1; unknown names throw listing what exists).

## Foundation shipped in alpha18

`src/air/ui-surface.ts` (walker + LABEL+ROLE naming + serializer) ·
`src/air/ui-trigger.ts` (the one faithful event-sequence implementation both
tiers share) · `t` prop (typed, stripped) · `aio/testing` `testUI()` with
settle-by-default · `src/air/ui-remote.ts` + `__ui:surface`/`__ui:trigger`
protocol + trojan routes · `am surface` / `am trigger` CLIs · tests proving
component addressing, keyed instances, client-only interactions, cell
round-trips, and the live-executor path.

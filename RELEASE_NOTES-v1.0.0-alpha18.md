# aio v1.0.0-alpha18 — first-class semantic UI testing + intuitiveness hardening

The headline: **UI testing as a first-class framework feature.** Every TSX
component is automatically exposed as an intuitive, deterministic API — no DOM
walking, no selectors, no flake. The same surface drives tests, the `am` CLI,
and AI agents, and the whole stack is proven against a real browser.

## Semantic UI testing

```ts
const ui = await testUI(App, { document: win.document, cells: [todo] });
await ui.TodoAdd.TitleInput.type("buy milk"); // real events, client-only flows
await ui.TodoAdd.AddButton.click(); //           awaits full quiescence
await ui.expectCell(todo, (t) => t.items.length === 1);
```

- **Deterministic naming** from the TSX: `<div class="button">Submit</div>` →
  `SubmitButton`. Label priority `t` prop > aria-label > text > placeholder.
- **Every action is a faithful event sequence** (pointer→mouse→click,
  per-character typing, Enter-submits-forms, HTML5 drag-and-drop, scroll) —
  handlers are never called directly.
- **Typed clients** — `testgen(App)` generates one interface per component from
  what actually renders; a renamed button breaks tests at compile time.
- **Live apps** — `am surface <idx>` shows any connected client (browser tab,
  Electron window, Android WebView) as the same semantic tree; `am trigger`
  drives it with the full action set and replies with the fresh post-action
  surface (the natural observe→act→observe agent loop).
- **Proven end-to-end** — a Tier-3 test boots an app, opens it in headless
  chromium, and drives it purely over aio's own protocol. No webdriver.

## Intuitiveness hardening

- **Read-your-writes async methods** — `s.cpu = 5; s.history.push({cpu: s.cpu})`
  now pushes 5. Reads see committed state with your pending writes overlaid;
  what you read is exactly what commits.
- **`forUser` fully infers** — `(s, user) => …` with no annotations.
- **Deep-path excludes** — `ui: { exclude: ["accounts.encSecKey"] }` strips the
  field everywhere under `accounts`, in full-state broadcasts AND patch
  payloads.
- **Offline-capable dev** — the framework's browser deps are served locally; the
  CDN is only a fallback. Air-gapped dev works.

## Also in this release

- **Custom HTTP routes** — `aio.run({ routes })` for uploads, webhooks, APIs.
- **Prometheus metrics** at `GET /__aio/metrics`.
- **CRDT conflict handling is real** — `onConflict` fires, and per-field merge
  strategies (`counter`, `set-add`, …) apply to the client view.
- **Dashboard scaffold template** — poll loop with backoff, routes, filters, and
  built-in semantic UI + cell tests.
- **Three new permanent drift gates** (config allowlists, browser deps, doc
  imports) — each closes a bug class this release actually found in the wild.

## Verification

All gates green at tag time: type-check (242 files), lint, module boundaries,
API snapshot (14 entries / 355 documented symbols), docs links + coverage,
**2244 tests**, coverage 71.3% (floor 69), `deno publish --dry-run`.

Remote/thin-client targets remain **@experimental** — now smoke-tested over a
real LAN interface (0.0.0.0 + TLS + token), pending a true off-box field report.

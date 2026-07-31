# aio v1.0.0-alpha19 — zero-config DX + no-await UI tests

The theme: **delete the boilerplate**. Every line of ceremony that could be
inferred, queued, or defaulted is gone — without losing a single feature.

## Zero-config `aio.run()`

```ts
// src/app.ts — a complete, working app
import "./cell.ts";
import { aio } from "aio";
await aio.run();
```

Everything is inferred: cells from the registry (every imported `cell()`
self-registers — the mechanism the android runtime always used), `appId` from
`deno.json` (else the project directory, deterministic), `version`/`title` from
`deno.json`, `baseDir` from the entry module. Compiled binaries derive identity
from the binary name and never read the launch directory's config. Explicit
config still wins everywhere.

## UI tests: no boilerplate, no awaits

```ts
import { testUI } from "aio/testing";
import App from "../src/App.tsx";

testUI(App, "add a todo", async (ui) => {
  ui.TodoAdd.TitleInput.type("buy milk"); // actions queue — no await
  ui.TodoAdd.AddButton.click(); //           runs after typing, in order
  await ui.expectCell(todo, (t) => t.items.length === 1); // observe = await
});
```

- Auto happy-dom window, auto-booted cells, full teardown — zero setup.
- Actions run on an ordered queue; failures surface at the next observation
  point with the usual name listing. Acting on UI a prior action creates
  (`ui.OpenButton.click(); ui.Modal.ConfirmButton.click()`) just works.
- Handle form: `await using ui = await testUI(App)`.
- `data-testid` now works like `t` (verbatim names, assertion targets).

## More ceremony deleted

- **Bound remote cells** — `connectCli(url).bind(counter)`:
  `await counter.increment(1)` over the socket (resolves on the server ack),
  `counter.count` reads live state. Raw `{ type, payload }` wire actions are
  history.
- **`useLocal` tuple** — `const [text, setText] = useLocal("")` (object form
  still works).
- **Forms never navigate** — handled submits auto-prevent the default; opt out
  with `data-native-submit`.
- **Scaffolds**: 3-line app.ts, one `compile` task (was twelve), no
  `preventDefault`/`t.init()` rituals.

## Six audit rounds, twelve seam flaws fixed

Loop-until-dry (A–F, two consecutive clean rounds): bound-call hangs on dead
connections, `am` vs zero-config scaffolds, compiled binaries adopting a foreign
cwd identity, `am dom --all`, docs teaching removed tasks, a `WatchdogSec`
recommendation that would have killed healthy services, prod import maps
pointing at a dev-only route, a coverage pipeline that under-reported by 15
points, and more. Every flaw was an integration seam; zero pure-logic bugs — the
drift-gate strategy keeps working.

## Never a silent white page again

The #1 historical failure class, captured at runtime: every dev boot failure
(failed import, missing default export, state timeout, mount error, empty
render) shows an in-page diagnostic with a classified fix hint AND a loud
`BLANK SCREEN (<stage>)` warning in the server terminal — proven against real
Chromium for every stage. Plus a **bundle-smoke CI gate** that builds both
compile shapes (browser ESM, android IIFE) and asserts the invariants that
historically broke — it caught its first ship-blocker on its first run. A
symptom → cause → caught-by matrix in troubleshooting.md maps every failure
class we ever hit to its advance guard.

## Docs

Generated master contents page (`docs/content.md`, CI-gated), Mermaid
architecture diagrams (machine-verified), Common Pitfalls page,
going-to-production checklist, alpha17→18 upgrade guide.

## Verification

All gates green at tag time: type-check (242 files), lint, boundaries, API
snapshot (14 entries / 356 documented symbols), docs links + coverage + index,
**2264 tests** (incl. real-chromium e2e and a LAN TLS smoke), coverage 70.4%
(floor 69), `deno publish --dry-run`.

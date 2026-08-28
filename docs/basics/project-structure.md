# AIO -- Project Structure

> One structure that scales from 1 cell to 100. No reorganization needed.

## Directory Layout

```
src/
  app.ts              <- aio.run({ cells }) -- wiring only
  App.tsx             <- root layout + routing only
  cell.ts             <- THE cell (state + methods) -- while there is one
  cell/               <- one file per cell, once there are several
  type/               <- all exported types, always
  lib/                <- pure functions, no aio imports
  ui/                 <- components
```

…and `tests/` beside `src/`, mirroring that structure:

```
tests/
  cell.test.ts        <- what `am create` scaffolds
  cell/counter.test.ts
  lib/math.test.ts
```

Four folders under `src/`, one beside it, three root files. That is the entire
app.

> **`cell.ts` or `cell/` — one rule, not two spellings.** A file for one cell, a
> folder for many, and the folder is `cell/` (singular), never `cells/`.
> `am
> create` scaffolds `src/cell.ts` and the quickstart teaches it; the
> moment a second cell exists, `src/cell.ts` becomes `src/cell/<name>.ts` and
> every import moves with it. Everything below that says `cell/` applies
> unchanged to a single `cell.ts` — the placement rule is the same, the file is
> just not a folder yet.

> **One place, and only one.** Tests live in `tests/` at the project root — what
> `am create` scaffolds, what the quickstart's `deno task test` runs, and what
> the framework itself does. Three different answers used to be in circulation
> (`src/test/`, a co-located `src/cell.test.ts`, and `tests/`); any one of them
> works, and having three was the problem.

## The one load-bearing rule: your entry's directory IS the app root

**Everything the UI is served from resolves relative to the directory holding
your entry module** — `App.tsx`, `style.css`, `icon.png`, and every path the dev
server can serve. It is one rule, applied identically by the dev server
(`baseDir`) and by every build target (`BuildConfig.appDir`), which is what
makes dev and prod render the same page.

The consequence that surprises people: **move the entry deeper and you move the
root with it.**

```jsonc
// deno.json
"entry": "src/app.ts"          // app root = src/     ← the scaffold's layout
"entry": "app.ts"              // app root = the project root (flat app)
"entry": "src/client/app.ts"   // app root = src/client/  ← ../core/* will 404
```

Two independent field reports hit the third line: with the entry at
`src/client/app.ts`, every `../core/…` import 404'd and the window came up
blank, because those files sit outside the app root. Either keep the entry at
the top of the tree it needs to serve, or move the shared code under it.

A build refuses loudly rather than shipping the wrong thing: a missing `App.tsx`
next to the entry, or a stray `src/style.css` in an app whose root is elsewhere,
fails the build with the fix in the message.

### Sharing code between apps in one repository: `share`

Two apps in one repo want one `shared/`. A symlink out of the app root is
refused by the dev server (correctly — the root is an HTTP root), so declare the
directory instead:

```jsonc
// apps/a/deno.json
"share": ["../../shared"]
```

```ts
// apps/a/src/App.tsx — ONE spelling, both worlds
import { money } from "/shared/money.ts";
```

The dev server serves the share at `/shared/…` and the bundler resolves the same
import to the same directory, so what runs in dev is what ships. Each share is
addressed by its directory name (`/shared/` for `../../shared`), and gets every
guard the app root has: no traversal, no symlink out of it, no dotfiles, no
`*.server.*` files. It is never reachable through the control plane.

Refused, loudly, at boot and at build: a share that does not exist, one outside
the repository root (the nearest `.git`), and two shares with the same name.
Anything shared this way is browser-reachable, so it must be pure — the same
rule as `lib/`.

---

## Zero-Thought Placement Rules

| What you wrote                     | Where it goes           | Rule                           |
| ---------------------------------- | ----------------------- | ------------------------------ |
| `export type` / `export interface` | `type/`                 | Always. No exceptions.         |
| `cell()` definition                | `cell.ts`, then `cell/` | One cell per file, always.     |
| Extracted method helper            | `cell/` next to cell    | Imports aio = stays with cell. |
| Pure function, no aio import       | `lib/`                  | Always.                        |
| Component / JSX                    | `ui/`                   | Always.                        |
| Test                               | `tests/`                | Mirrors `src/`.                |
| `aio.run()`                        | `app.ts`                | One file.                      |

---

## Import Rules (Enforceable by Linter)

| Folder              | Can import from                      |
| ------------------- | ------------------------------------ |
| `type/`             | nothing (zero deps)                  |
| `lib/`              | `type/` only                         |
| `cell.ts` / `cell/` | `type/` + `lib/` + `aio`             |
| `ui/`               | `type/` + `lib/` + the cells + `aio` |
| `tests/`            | anything                             |

Types flow down. Logic flows down. Nothing flows up.

---

## Small App (Flat)

Two cells, so `src/cell.ts` has become `src/cell/`.

```
src/
  app.ts
  App.tsx
  cell/
    counter.ts
    auth.ts
  type/
    counter.ts
    auth.ts
  lib/
    math.ts
    format.ts
  ui/
    HomePage.tsx
    LoginPage.tsx
    shared/
      Button.tsx
```

```
tests/
  cell/counter.test.ts
  lib/math.test.ts
```

---

## Larger App (Domain Subdirs)

When a folder exceeds ~10 files, add one level of domain subdirectories.

```
src/
  app.ts
  App.tsx
  cell/
    trading/
      engine.ts
      orders.ts
    auth/
      login.ts
      session.ts
  type/
    trading/
      order.ts
      position.ts
    auth/
      user.ts
  lib/
    trading/
      risk.ts
      pnl.ts
    format.ts
  ui/
    trading/
      OrderBook.tsx
      TradeForm.tsx
    auth/
      LoginPage.tsx
    shared/
      Button.tsx
```

```
tests/
  cell/trading/engine.test.ts
  lib/trading/risk.test.ts
```

**Never nest deeper than `cell/[domain]/[cell].ts`.**

---

## Root Files

### `deno.json` -- identity and build

```jsonc
{
  "title": "notes", // the app's name (appId is its slug)
  "version": "1.2", // major.minor — the build number is derived from commits
  "client": "electron",
  "build": { "targets": ["electron", "android"] }
}
```

`version` is `major.minor` only: every build becomes `1.2.<commit count>`
(`-dirty.<hash8>` from uncommitted changes), every artifact is named with it and
reports it. A three-part version is accepted as a pin, and the build says so.
See [Versioning](../build/versioning.md).

### `app.ts` -- wiring only

```ts
import { aio } from "aio";
import { counter } from "./cell/counter.ts";
import { auth } from "./cell/auth.ts";

await aio.run({
  cells: [counter, auth],
  port: 8000,
});
```

No logic. No state. Just imports and boot.

### `App.tsx` -- layout and routing only

```tsx
import { page, useAio } from "aio/air";
import { TradePage } from "./ui/trading/TradePage.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";

type AppState = { page: string };

export default function App() {
  const { state } = useAio<AppState>();
  if (!state) return <div>Connecting...</div>;
  return (
    <div>
      <nav>...</nav>
      {page(state.page, { trade: TradePage, settings: SettingsPage })}
    </div>
  );
}
```

No business logic. No cell state management. Just layout and routing.

---

## Growth Rules

- Flat until ~10 files per folder, then domain subdirs (one level only)
- Never nest deeper than `cell/[domain]/[cell].ts`
- One cell per file, always
- Split when a file exceeds ~200 lines

---

## Forbidden

- No `src/state.ts` -- state lives inside cells
- No `src/actions.ts`, `src/effects.ts`, `src/reduce.ts` -- framework
  auto-generates
- No nesting deeper than one domain level
- No files over 200 lines -- split or extract
- No aio imports in `type/` or `lib/`

---

## The `'aio'` Import

Everything comes from a single import. `"aio"` maps to `jsr:@riagentic/aio`
(standard) or `./dep/aio/mod.ts` (vendored).

```ts
// Server-side (Deno)
import { aio, call, cell, schedule } from "aio";
import { testCell } from "aio/testing";

// Browser-side (App.tsx)
import { page, useAio, useLocal } from "aio/air";
```

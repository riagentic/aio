# AIO -- Project Structure

> One structure that scales from 1 cell to 100. No reorganization needed.

## Directory Layout

```
src/
  app.ts              <- aio.run({ cells }) -- wiring only
  App.tsx             <- root layout + routing only
  cell/               <- aio cell definitions (state + methods)
  type/               <- all exported types, always
  lib/                <- pure functions, no aio imports
  ui/                 <- components
  test/               <- tests, mirrors source structure
```

Six folders. Two root files. That is the entire app.

---

## Zero-Thought Placement Rules

| What you wrote                     | Where it goes        | Rule                           |
| ---------------------------------- | -------------------- | ------------------------------ |
| `export type` / `export interface` | `type/`              | Always. No exceptions.         |
| `cell()` definition                | `cell/`              | Always. One cell per file.     |
| Extracted method helper            | `cell/` next to cell | Imports aio = stays with cell. |
| Pure function, no aio import       | `lib/`               | Always.                        |
| Component / JSX                    | `ui/`                | Always.                        |
| Test                               | `test/`              | Mirrors source.                |
| `aio.run()`                        | `app.ts`             | One file.                      |

---

## Import Rules (Enforceable by Linter)

| Folder  | Can import from                    |
| ------- | ---------------------------------- |
| `type/` | nothing (zero deps)                |
| `lib/`  | `type/` only                       |
| `cell/` | `type/` + `lib/` + `aio`           |
| `ui/`   | `type/` + `lib/` + `cell/` + `aio` |
| `test/` | anything                           |

Types flow down. Logic flows down. Nothing flows up.

---

## Small App (Flat)

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
  test/
    cell/
      counter.test.ts
    lib/
      math.test.ts
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
  test/
    cell/trading/
      engine.test.ts
    lib/trading/
      risk.test.ts
```

**Never nest deeper than `cell/[domain]/[cell].ts`.**

---

## Root Files

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
import { aio, call, cell, schedule, testCell } from "aio";

// Browser-side (App.tsx)
import { page, useAio, useLocal } from "aio/air";
```

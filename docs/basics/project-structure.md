# AIO -- File & Directory Structure

> One structure that scales from 1 feature to 100. No reorganization needed.

## The Complete Structure

```
src/
  app.ts                  <- aio.run({ features }) -- boot, nothing else
  App.tsx                 <- root UI -- layout + routing only
  features/               <- all features live here
  shared/                 <- code used by 2+ features
    types/                <- domain types
    utils/                <- pure functions
    ui/                   <- reusable UI components
```

Three folders. Two root files. That's the entire app.

---

## Features

### One feature = one folder

```
features/
  counter/
    index.ts              <- feature() definition
```

### Growing feature (~200+ lines)

```
features/counter/
  index.ts                <- feature() call, imports from below
  types.ts                <- domain types, enums (no aio imports)
  helpers.ts              <- pure functions, factories (no aio imports)
```

### Feature with UI (~300+ lines)

```
features/counter/
  index.ts
  types.ts
  helpers.ts
  ui/
    CounterPage.tsx       <- uses useFeature(counter)
    CounterDisplay.tsx    <- pure component, props only
```

### Complex feature (~500+ lines)

```
features/counter/
  index.ts                <- feature() assembler
  types.ts
  helpers.ts
  reduce.ts               <- reducer logic
  execute.ts              <- executor logic
  selectors.ts            <- complex/memoized selectors
  ui/
    CounterPage.tsx
    CounterControls.tsx
```

### When to split files

| index.ts size   | Action                                                          |
| --------------- | --------------------------------------------------------------- |
| Under 200 lines | Keep everything in index.ts                                     |
| ~200 lines      | Extract types.ts and helpers.ts                                 |
| ~300 lines      | Add ui/ folder for components                                   |
| ~500 lines      | Extract reduce.ts, execute.ts, selectors.ts                     |
| ~1000 lines     | Ask: is this actually two features? Probably split the feature. |

**Rule: split when you feel the pain, not before.**

---

## Scaling: Domain Grouping

When the app grows beyond ~10-15 features, group by domain (one level only):

```
features/
  trading/
    engine/
      index.ts
    orders/
      index.ts
  data/
    collector/
      index.ts
    indicators/
      index.ts
  user/
    auth/
      index.ts
    settings/
      index.ts
```

Domain folders are pure organization -- no code, no index.ts. **Never nest
deeper than one domain level.**

---

## Shared

Code shared across 2+ features:

```
shared/
  types/
    order.ts              <- used by trading/engine + trading/orders
    price.ts              <- used by data/collector + trading/engine
  utils/
    format.ts             <- formatCurrency, formatDate, etc.
    math.ts               <- calculations used across features
  ui/
    Button.tsx            <- pure, reusable, no feature imports
    Modal.tsx
    Table.tsx
```

### Rules

- **Shared UI** -- pure: props in, JSX out. No `useFeature()`, no feature
  imports
- **Shared types** -- framework-agnostic: no aio imports
- **Shared utils** -- pure functions: no side effects, no state
- **Promote, don't pre-plan.** Move to `shared/` only when a second feature
  needs it

---

## State

**There is no state.ts in `src/`.** Each feature defines its own state inside
`feature()`. Framework composes `AppState` from all registered features
automatically.

---

## Root Files

### `app.ts` -- boot only

```typescript
import { aio } from "aio";
import { counter } from "./features/counter/index.ts";
import { dc } from "./features/dc/index.ts";

await aio.run({
  features: [counter, dc],
  port: 8000,
  ui: { electron: true, title: "My App" },
});
```

No logic. No state. Just imports and boot.

### `App.tsx` -- layout and routing only

```tsx
import { page, useAio } from "aio";
import { TradePage } from "./features/te/ui/TradePage.tsx";
import { SettingsPage } from "./features/settings/ui/SettingsPage.tsx";

export default function App() {
  const { state, send } = useAio();
  if (!state) return <div>Connecting...</div>;
  return (
    <div>
      <nav>...</nav>
      {page(state.page, { trade: TradePage, settings: SettingsPage })}
    </div>
  );
}
```

No business logic. No feature state management. Just layout and routing.

---

## What Goes Where -- Quick Reference

| Thing                             | Location                        |
| --------------------------------- | ------------------------------- |
| Feature logic (state, methods)    | `features/[feature]/index.ts`   |
| Feature domain types              | `features/[feature]/types.ts`   |
| Feature pure functions            | `features/[feature]/helpers.ts` |
| Feature reducer (when extracted)  | `features/[feature]/reduce.ts`  |
| Feature executor (when extracted) | `features/[feature]/execute.ts` |
| Feature UI components             | `features/[feature]/ui/`        |
| Feature scripts                   | `features/[feature]/scripts/`   |
| Shared domain types               | `shared/types/`                 |
| Shared pure functions             | `shared/utils/`                 |
| Reusable UI (no feature deps)     | `shared/ui/`                    |
| App boot                          | `src/app.ts`                    |
| Root layout + routing             | `src/App.tsx`                   |
| App-wide scripts                  | `scripts/` (project root)       |

---

## Forbidden

- No `src/state.ts` -- state lives inside features
- No `src/actions.ts`, `src/effects.ts`, `src/reduce.ts` -- framework
  auto-generates
- No `src/models/` or `src/lib/` -- use `shared/types/` or feature files
- No `src/components/` -- use `shared/ui/` or feature `ui/`
- No nesting deeper than `features/[domain]/[feature]/`
- No files over 300 lines -- split or extract
- No pre-planned shared abstractions -- promote from features when needed

---

## The `'aio'` import

Everything comes from a single import. `"aio"` maps to `jsr:@riagentic/aio`
(standard) or `./dep/aio/mod.ts` (vendored). Never import from
`'../dep/aio/...'` directly.

```ts
// Server-side (Deno)
import { aio, call, feature, schedule, testFeature } from "aio";

// Browser-side (App.tsx)
import { page, useAio, useFeature, useLocal } from "aio/react";
```

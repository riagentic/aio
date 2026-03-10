# AIO v0.5 — File & Directory Structure

> **One structure that scales from 1 feature to 100. No reorganization needed.**

---

## The Complete Structure

```
src/
  app.ts                  ← aio.run({ features }) — boot, nothing else
  App.tsx                 ← root UI — layout + routing only
  features/               ← all features live here
  shared/                 ← code used by 2+ features
    types/                ← domain types
    utils/                ← pure functions
    ui/                   ← reusable UI components
```

Three folders. Two root files. That's the entire app.

---

## Features

### One feature = one folder

```
features/
  counter/
    index.ts              ← feature() definition — everything starts here
```

`index.ts` contains state, actions, effects, machine, reduce, execute, selectors — all inside one `feature()` call. No other files needed initially.

### Growing feature (~200+ lines) — extract types and helpers

```
features/counter/
  index.ts                ← feature() call, imports from below
  types.ts                ← domain types, enums (framework-agnostic, no aio imports)
  helpers.ts              ← pure functions, factories, transforms (no aio imports)
```

### Feature with UI (~300+ lines)

```
features/counter/
  index.ts
  types.ts
  helpers.ts
  ui/
    CounterPage.tsx       ← uses useFeature(counter)
    CounterDisplay.tsx    ← pure component, props only
```

### Complex feature (~500+ lines)

```
features/counter/
  index.ts                ← feature() assembler, imports reduce/execute
  types.ts
  helpers.ts
  reduce.ts               ← reducer logic, imported into feature()
  execute.ts              ← executor logic, imported into feature()
  selectors.ts            ← complex/memoized selectors
  ui/
    CounterPage.tsx
    CounterControls.tsx
```

### Feature with scripts

```
features/dc/
  index.ts
  types.ts
  helpers.ts
  scripts/
    import-historical.ts  ← dc-specific tooling
  ui/
    DataDashboard.tsx
```

### When to split files

| index.ts size | Action |
|---|---|
| Under 200 lines | Keep everything in index.ts |
| ~200 lines | Extract types.ts and helpers.ts |
| ~300 lines | Add ui/ folder for components |
| ~500 lines | Extract reduce.ts, execute.ts, selectors.ts |
| ~1000 lines | Ask: is this actually two features? Probably split the feature. |

**Rule: split when you feel the pain, not before.**

---

## Scaling: Domain Grouping

When the app grows beyond ~10-15 features, group by domain. One level only:

```
features/
  trading/
    engine/
      index.ts
    orders/
      index.ts
    positions/
      index.ts
  data/
    collector/
      index.ts
    historical/
      index.ts
    indicators/
      index.ts
  user/
    auth/
      index.ts
    settings/
      index.ts
    portfolio/
      index.ts
  alerts/
    notifications/
      index.ts
    rules/
      index.ts
```

Domain folders (`trading/`, `data/`, `user/`, `alerts/`) are pure organization — no code, no index.ts. Just folders for navigation. Each feature inside works exactly the same way.

**Never nest deeper than one domain level.** `features/trading/engine/index.ts` — yes. `features/trading/engine/core/logic/index.ts` — never.

---

## Shared

Code shared across 2+ features:

```
shared/
  types/
    order.ts              ← used by trading/engine + trading/orders
    price.ts              ← used by data/collector + trading/engine
    instrument.ts
  utils/
    format.ts             ← formatCurrency, formatDate, etc.
    math.ts               ← calculations used across features
    validate.ts           ← validation helpers
  ui/
    Button.tsx            ← pure, reusable, no feature imports
    Modal.tsx
    Table.tsx
    Layout.tsx
    Spinner.tsx
    Chart.tsx
```

### Rules

- **Shared UI components** are pure: props in, JSX out. No `useFeature()`, no `useAio()`, no feature imports.
- **Shared types** are framework-agnostic: no aio imports. Pure domain descriptions.
- **Shared utils** are pure functions: no side effects, no state, no framework imports.
- **Promote, don't pre-plan.** Code starts in the feature that uses it. Move to `shared/` only when a second feature needs it.

---

## State

**There is no state.ts in `src/`.** Each feature defines its own state inside `feature()`:

```typescript
export const counter = feature('counter', {
  state: {
    count: 0,
    error: null as string | null,
  },
  // ...
})
```

Framework composes the full `AppState` from all registered features automatically when `aio.run({ features })` is called.

If you need an `AppState` type (e.g. for selectors), the framework infers it from registered features.

---

## Root Files

### `app.ts` — boot only

```typescript
import { aio } from 'aio'
import { counter } from './features/counter/index.ts'
import { dc } from './features/dc/index.ts'
import { bridge } from './features/bridge-dc-te/index.ts'
import { te } from './features/te/index.ts'

await aio.run({
  features: [
    counter,
    dc,
    { feature: bridge, dependsOn: ['dc'] },
    { feature: te, dependsOn: ['bridge-dc-te'] },
  ],
  port: 8000,
  ui: { electron: true, title: 'My App' },
})
```

No logic. No state. Just imports and boot.

### `App.tsx` — layout and routing only

```tsx
import { useAio, page } from 'aio'
import { TradePage } from './features/te/ui/TradePage.tsx'
import { SettingsPage } from './features/settings/ui/SettingsPage.tsx'

export default function App() {
  const { state, send } = useAio()
  if (!state) return <div>Connecting...</div>

  return (
    <div>
      <nav>...</nav>
      {page(state.page, { trade: TradePage, settings: SettingsPage })}
    </div>
  )
}
```

No business logic. No feature state management. Just layout and routing.

---

## App-Wide Scripts

Scripts not tied to any feature:

```
scripts/                  ← at project root, outside src/
  reset-db.ts
  backup.ts
  deploy.ts
```

Feature-specific scripts live in the feature: `features/dc/scripts/import-historical.ts`

---

## What Goes Where — Quick Reference

| Thing | Location |
|---|---|
| Feature logic (state, actions, reduce, etc.) | `features/[feature]/index.ts` |
| Feature domain types (when extracted) | `features/[feature]/types.ts` |
| Feature pure functions (when extracted) | `features/[feature]/helpers.ts` |
| Feature reducer (when extracted) | `features/[feature]/reduce.ts` |
| Feature executor (when extracted) | `features/[feature]/execute.ts` |
| Feature selectors (when extracted) | `features/[feature]/selectors.ts` |
| Feature UI components | `features/[feature]/ui/` |
| Feature scripts | `features/[feature]/scripts/` |
| Domain types shared by 2+ features | `shared/types/` |
| Pure functions shared by 2+ features | `shared/utils/` |
| Reusable UI components (no feature deps) | `shared/ui/` |
| App boot | `src/app.ts` |
| Root layout + routing | `src/App.tsx` |
| App-wide scripts | `scripts/` (project root) |

---

## Forbidden

- ❌ `src/state.ts` — state lives inside features
- ❌ `src/actions.ts` — actions live inside features
- ❌ `src/effects.ts` — effects live inside features
- ❌ `src/reduce.ts` — framework auto-generates from features
- ❌ `src/execute.ts` — framework auto-generates from features
- ❌ `src/models/` or `src/model/` — use `shared/types/` or feature `types.ts`
- ❌ `src/lib/` — use `shared/utils/` or feature `helpers.ts`
- ❌ `src/components/` — use `shared/ui/` or feature `ui/`
- ❌ Nesting deeper than `features/[domain]/[feature]/` — one level max
- ❌ Files over 300 lines — split or extract
- ❌ Pre-planned shared abstractions — promote from features when needed

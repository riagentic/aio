```
  _v_
 (o>o)  aio
  )/
 /|
```

**Full-stack Deno framework — one state, propagated everywhere.** · `v0.5.0` · beta

> Define state once. It persists, syncs to all clients, drives the UI.
> No glue code, no serialization, no sync logic. Write business logic — data plumbing is solved.

## Features

Everything is a **feature**. One `feature()` call replaces 7 files:

```typescript
import { feature, aio } from 'aio'

const counter = feature('counter', {
  state: { count: 0 },
  actions: {
    increment: (by = 1) => ({ by }),
    save:      () => ({}),
    saved:     () => ({}),
  },
  effects: {
    persist: (value: number) => ({ value }),
  },
  machine: {
    initial: 'idle',
    states: {
      idle:   { on: { increment: 'idle', save: 'saving' } },
      saving: { on: { saved: 'idle' } },
    },
  },
  reduce(state, action, { A, E }) {
    switch (action.type) {
      case A.Increment:
        state.count += action.payload.by
        break
      case A.Save:
        return [E.persist(state.count)]
    }
  },
  execute(app, effect, { E, A }) {
    switch (effect.type) {
      case E.Persist:
        Deno.writeTextFile('./data.json', String(effect.payload.value))
          .then(() => app.dispatch(A.saved()))
        break
    }
  },
})

await aio.run({ features: [counter] })
```

## Core concepts

| Concept | What | Where |
|---|---|---|
| `feature()` | State, actions, effects, machine, reduce, execute, selectors | Server |
| `A` / `E` | Action & effect labels (switch) + creators (dispatch) | Reduce & Execute |
| `aio.run()` | Boot the app — server, WebSocket, persistence, everything | Server |
| `useFeature()` | Scoped state, typed send, machine status | Browser |

## State machines

Built-in, validated at startup. Invalid transitions drop silently. Typos crash on boot (not in production).

```typescript
machine: {
  initial: 'idle',
  states: {
    idle:   { on: { save: 'saving' } },
    saving: { on: { saved: 'idle', failed: 'error' } },
    error:  { on: { retry: 'saving', dismiss: 'idle' } },
  },
}
// _status is auto-managed — never set manually
```

## Cross-feature communication

```typescript
// Selectors — read another feature's state
const price = dc.selectors.getPrice(app.getState())

// Foreign listeners — react to another feature's actions
case dc.A.PriceUpdated:
  state.lastPrice = action.payload.price

// Bridge — request/response with timeouts, retries, circuit breaker
const b = bridge('pricing', {
  from: 'te', to: 'dc',
  channels: {
    price: { request: (s) => ({ s }), response: (p) => ({ p }), timeout: 5000, retries: 3 },
  },
  circuitBreaker: { failureThreshold: 5, resetTimeout: 30000 },
})
```

## UI

```tsx
import { useFeature } from 'aio'
import { counter } from '../features/counter'

function CounterPage() {
  const { state, send, status } = useFeature(counter)
  return (
    <div>
      <p>Count: {state.count} ({status})</p>
      <button onClick={() => send.increment(5)}>+5</button>
    </div>
  )
}
```

## Testing

```typescript
import { testFeature, testBridge } from 'aio'

testFeature(counter, 'increment from idle', (t) => {
  t.init()
  t.send.increment(5)
  t.expect.state(s => s.count === 5)
  t.expect.status('idle')
})

testBridge(myBridge, 'happy path', (t) => {
  t.request.price('BTC')
  t.expect.pending(1)
  t.respond.price(45000)
  t.expect.pending(0)
})
```

## Runtime control

```typescript
const app = await aio.run({
  features: [counter, dc, te],
  middleware: [aio.middleware.logger(), aio.middleware.validate()],
  version: 2,
  migrations: [(s) => ({ ...s, counter: { ...s.counter, newField: 0 } })],
})

app.features.disable('counter')  // stop processing, reset state
app.features.enable('counter')   // re-init
app.features.health()            // status, errors, last action per feature
// GET /__health — built-in health endpoint
```

## Platform

One state, synced everywhere. Real-time delta patches, offline queue, time-travel debugging.

| | **local** | **remote** |
|---|:---:|:---:|
| **browser** | standalone binary | exposed server + systemd |
| **Electron** | AppImage | thin client AppImage |
| **CLI** | headless server + client | client-only binary |
| **Android** | APK with server | client APK |
| **service** | 127.0.0.1 + systemd | 0.0.0.0 + auth + systemd |

```sh
deno task dev              # development (hot reload)
deno task compile          # standalone binary
deno task compile:electron # desktop AppImage
deno task compile:android  # APK
```

## Project structure

```
src/
  app.ts              ← aio.run({ features }) — boot
  App.tsx             ← root UI — layout + routing
  features/
    counter/
      index.ts        ← feature() — everything in one file
    orders/
      index.ts        ← feature() assembler
      types.ts        ← domain types
      reduce.ts       ← extracted reducer (when it grows)
      execute.ts      ← extracted executor
      ui/
        OrderPage.tsx ← useFeature(orders)
  shared/             ← code used by 2+ features
```

Features start as a single `index.ts` and split only when they grow. See [Project Structure](dep/aio/structure.md).

## Docs

- [Quickstart](dep/aio/quickstart.md) — from scratch in 5 minutes
- [Manual](dep/aio/manual.md) — full API reference
- [Project Structure](dep/aio/structure.md) — file organization
- [Migration](dep/aio/migration.md) — adopt into existing app
- [Upgrade](dep/aio/upgrade.md) — version upgrades
- [Architecture](dep/aio/a4.md) — design overview

## Status

**v0.5.0** — feature-based architecture, stable and tested (635+ tests). Beta — things may break.

MIT

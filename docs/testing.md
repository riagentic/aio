# Testing

For the docs index, see [manual.md](manual.md). For reactive features, see [reactivity.md](reactivity.md). For generator-based workflows, see [generators.md](generators.md).

## `testFeature(feature, name, fn)` — isolated feature testing

Test harness that wraps `Deno.test` with typed helpers:

```ts
import { testFeature } from 'aio'
import { counter } from './features/counter/index.ts'

testFeature(counter, 'increment from idle', (t) => {
  t.init()
  t.send.increment(5)
  t.expect.state(s => s.count === 5)
  t.expect.status('idle')
  t.expect.effects(['Log'])
})

testFeature(counter, 'machine guards block invalid transitions', (t) => {
  t.init()
  t.send.save()                         // idle → saving
  t.expect.status('saving')
  t.send.increment(1)                   // blocked! increment not in saving.on
  t.expect.state(s => s.count === 0)    // unchanged
})

testFeature(counter, 'save flow: idle → saving → error → idle', (t) => {
  t.init()
  t.send.save()
  t.expect.status('saving')
  t.send.saveFailed('network error')
  t.expect.status('error')
  t.expect.state(s => s.error === 'network error')
  t.send.dismiss()
  t.expect.status('idle')
})

testFeature(counter, 'random action fuzzing', (t) => {
  t.init()
  t.randomActions(100)                  // dispatch 100 random valid actions
  t.expect.invariant(s => typeof s.count === 'number')
})
```

Async test functions are supported — use `t.runEffects()` + `t.settle()` for async reactive methods:

```ts
testFeature(loader, 'loads data', async (t) => {
  t.init()
  t.send.load()          // triggers reducer, queues effect
  t.runEffects()         // executes pending effects (starts async method)
  await t.settle()       // waits for microtasks + timers (default 50ms)
  t.expect.state(s => s.data === 'loaded')
  t.expect.state(s => s.loading === false)
})
```

## TestContext API

| Method | Description |
|--------|-------------|
| `t.init()` | Reset to initial state |
| `t.destroy()` | Reset + set status to 'uninitialized' |
| `t.send.<action>(...args)` | Dispatch an action |
| `t.expect.state(fn)` | Assert on feature state slice |
| `t.expect.status(str)` | Assert current machine status |
| `t.expect.effects(['Name'])` | Assert effect types from last action (short names, e.g. `'Persist'` not `'Counter:Persist'`) |
| `t.expect.effectCount(n)` | Assert number of effects from last action |
| `t.expect.invariant(fn)` | Assert a predicate holds |
| `t.getState()` | Get full feature state including `_status` |
| `t.getEffects()` | Get effects from last dispatched action |
| `t.randomActions(n)` | Dispatch N random valid actions (property-based testing) |
| `t.runEffects()` | Execute pending effects (required for async reactive methods) |
| `t.settle(ms?)` | Wait for async operations to complete (default 50ms) |

## `testBridge(bridge, name, fn)` — bridge testing

```ts
import { testBridge } from 'aio'
import { priceBridge } from './features/bridge/index.ts'

testBridge(priceBridge, 'request-response flow', (t) => {
  t.request.price('BTC')
  t.expect.pending(1)
  t.respond.price(42000)
  t.expect.pending(0)
})

testBridge(priceBridge, 'timeout triggers retry', (t) => {
  t.request.price('ETH')
  t.timeout()
  t.expect.retryCount(1)   // auto-retried
})

testBridge(priceBridge, 'circuit breaker opens after failures', (t) => {
  for (let i = 0; i < 5; i++) {
    t.request.price('X')
    t.timeout()
  }
  t.expect.circuitOpen(true)
})
```

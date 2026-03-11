# Debugging

Error interpretation, state forensics, and common fix patterns.

For the docs index, see [manual.md](manual.md). For time-travel details, see [ui.md](ui.md). For performance budgets, see [scaling.md](scaling.md).

## Error layer identification

When something goes wrong, the first step is identifying *which layer* produced the error. AIO errors follow a consistent pattern:

| Error prefix/source | Layer | Where to look |
|---------------------|-------|---------------|
| `[featureName]` | Feature system | feature definition, machine config |
| `Reduce took Xms > budget` | Performance | reducer — move heavy work to effects |
| `Effect took Xms > budget` | Performance | executor — make it async |
| `dispatch('X:Y') blocked` | Scoped dispatch | add feature name to `crossDispatch` |
| `machine guard: dropped X in state Y` | State machine | check machine transitions |
| `WebSocket` / `WS` | Transport | network, server restart, auth |
| `Build Error` (browser overlay) | Transpilation | syntax error in .tsx/.ts file |

### Action type prefix tells you the feature

All v0.5+ actions are prefixed: `Counter:Increment`, `Wallet:Transfer`, `PriceBridge:PriceRequest`. The prefix (before `:`) is the capitalized feature name. Use this to find the relevant feature code.

### Machine-dropped actions

When an action is dropped by a machine guard, the framework logs:

```
[counter] machine guard: dropped 'save' in state 'error' (allowed: retry, dismiss)
```

This means `save` was dispatched but the current machine state `error` only allows `retry` and `dismiss`. Either:
1. The UI dispatched the wrong action for the current state
2. The machine definition is missing a transition
3. A race condition dispatched an action after a state transition

## Time-travel for state forensics

Press **Ctrl+.** to open the time-travel panel. Walk through every action and state snapshot to find where things went wrong.

**Workflow:**
1. Reproduce the bug
2. Open the TT panel (Ctrl+.)
3. Click on actions to jump through state history
4. Find the action where state diverged from expected

The panel shows timing data per action — red highlights indicate actions that exceeded their performance budget.

For programmatic access, use `useTimeTravel()` — see [ui.md](ui.md#usetimetravel).

## Feature health audit

After `aio.run()`, inspect feature health at runtime:

```ts
const app = await aio.run({ features: [counter, wallet] })

// Check all features
app.features!.health()
// → [
//   { name: 'counter', status: 'idle', enabled: true, errors: 0, lastAction: 'Counter:Increment', lastActionAt: 1234567890 },
//   { name: 'wallet', status: 'saving', enabled: true, errors: 0, lastAction: 'Wallet:Save', lastActionAt: 1234567891 },
// ]

// Check specific feature
app.features!.status('counter')  // → 'idle'

// List all registered features
app.features!.list()  // → ['counter', 'wallet']

// Disable a broken feature at runtime
app.features!.disable('wallet')  // dispatches Wallet:Destroy, stops routing
```

The health endpoint is also available over HTTP: `GET /__health` returns JSON with per-feature status.

## Common error patterns

### "state._status is reserved"

```
[myFeature] state._status is reserved for machine status — rename it
```

The `_status` key is auto-managed by the machine system. Rename your field (e.g. `_status` → `currentStatus`).

### "already bound"

```
[counter] already bound — features can only bind to one app
```

You passed the same feature instance to `aio.run()` twice, or called `aio.run()` twice without creating new feature instances.

### "dispatch blocked"

```
[engine] dispatch('Wallet:Credit') blocked — add 'wallet' to crossDispatch
```

An executor tried to dispatch to another feature's actions. Add the target feature name to `crossDispatch`:

```ts
const engine = feature('engine', {
  crossDispatch: ['wallet'],
  // ...
})
```

### "machine initial state not found"

```
[counter] machine initial state 'active' not found in declared states
```

The `initial` value in your machine config doesn't match any key in `states`. Check for typos.

### Build errors in browser

The error overlay shows the exact file and line:

```
Build Error
App.tsx: Error: Transform failed with 1 error
<stdin>:5:0: ERROR: Unexpected "}"
```

Fix the syntax error in your editor, save — live reload picks it up automatically.

### Actions dropped while disconnected

After reconnecting, the status indicator shows "Connected" but actions sent during disconnect are lost. This is by design — only the initial connect race (before first WS open) queues actions.

For offline support, actions sent after the first connection are persisted to IndexedDB (up to 100) and replayed on reconnect.

## Performance debugging

### Slow reducer

```
Reduce took 250ms > 100ms budget for Counter:Analyze
```

The reducer is synchronous and blocks the dispatch loop. Move heavy computation to an effect:

```ts
// Bad — blocks for 250ms
case A.Analyze:
  state.results = heavyComputation(state.data)
  break

// Good — reducer returns fast, effect does the work
case A.Analyze:
  state.analyzing = true
  return [E.runAnalysis(state.data)]
```

### Slow effect (sync portion)

```
Effect took 15ms > 5ms budget for Counter:RunAnalysis
```

The *synchronous* part of your effect is too slow. Make sure you return immediately and do work asynchronously:

```ts
// Bad — blocking
case E.RunAnalysis:
  const data = JSON.parse(fs.readFileSync('big.json', 'utf8'))  // sync!
  app.dispatch(A.done(data))
  break

// Good — async
case E.RunAnalysis:
  Deno.readTextFile('big.json')
    .then(text => JSON.parse(text))
    .then(data => app.dispatch(A.done(data)))
  break
```

### Configure budgets

```ts
await aio.run({
  features: [counter],
  perfMode: 'soft',          // 'soft' = console.warn, 'strict' = onError callback
  perfBudget: { reduce: 50, effect: 10 },
})
```

See [scaling.md](scaling.md#performance-budgets) for the full reference.

## Startup linter output

The linter runs automatically on `aio.run()` and reports issues:

```
[aio] ✓ state (3 keys) ✓ reduce ✓ execute ✓ App.tsx
      ⚠ state has reserved key(s): $p — rename (used internally for delta patches)
      ℹ App.tsx has `import React` — not needed, JSX transforms are automatic
```

Categories: `✓` ok, `⚠` warning, `ℹ` hint, `✗` fatal. Fatal issues prevent startup.

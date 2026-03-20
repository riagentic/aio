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
| `dispatch('X:Y') blocked` | Scoped dispatch | add feature name to `dispatchTo` |
| `machine guard: dropped X in state Y` | State machine | check machine transitions |
| `WebSocket` / `WS` | Transport | network, server restart, auth |
| `Build Error` (browser overlay) | Transpilation | syntax error in .tsx/.ts file |
| `Runtime Error` (browser overlay) | JS runtime | bad import, null access, top-level throw |

### Action type prefix tells you the feature

All v0.5+ actions are prefixed: `counter:increment`, `wallet:transfer`, `priceBridge:priceRequest`. The format is `featureName:actionKey` (all lowercase). The prefix (before `:`) is the feature name. Use this to find the relevant feature code.

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
//   { name: 'counter', status: 'idle', enabled: true, errors: 0, lastAction: 'counter:increment', lastActionAt: 1234567890 },
//   { name: 'wallet', status: 'saving', enabled: true, errors: 0, lastAction: 'wallet:save', lastActionAt: 1234567891 },
// ]

// Check specific feature
app.features!.status('counter')  // → 'idle'

// List all registered features
app.features!.list()  // → ['counter', 'wallet']

// Disable a broken feature at runtime
app.features!.disable('wallet')  // dispatches wallet:__destroy, stops routing
```

The health endpoint is also available over HTTP: `GET /__aio/health` returns JSON with per-feature status.

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
[engine] dispatch('wallet:credit') blocked — add 'wallet' to dispatchTo
```

An executor tried to dispatch to another feature's actions. **In dev mode this throws** — you'll see a stack trace pointing to the exact dispatch call. In prod it logs and drops the action silently.

Fix: add the target feature to `dispatchTo`:

```ts
import { wallet } from '../wallet'

const engine = feature('engine', {
  dispatchTo: [wallet],
  // ...
})
```

### "machine initial state not found"

```
[counter] machine initial state 'active' not found in declared states
```

The `initial` value in your machine config doesn't match any key in `states`. Check for typos.

### Build errors in browser

A **Build Error** is a TypeScript/transpile failure caught by esbuild before the code runs. The overlay shows the exact file, line, column, and the offending source line with a `^` caret:

```
⚠ Build Error

App.tsx:15:8
Unexpected token ")"

 15 |   return (<div onClick={handleClick)}>
                                         ^
```

Fix the syntax error in your editor and save — live reload picks it up automatically.

### Runtime errors in browser

A **Runtime Error** is a JavaScript crash that occurs after successful transpilation — wrong import name, `null.x`, a top-level `throw`, or a React render exception. Previously these showed a blank page; now the overlay displays the full stack trace:

```
⚠ Runtime Error

TypeError: Cannot read properties of null (reading 'map')
  at App (App.tsx:23:18)
  at renderWithHooks (react-dom.development.js:...)
  ...
```

The error is also POSTed to `/__aio/client-error` and written to `debug.log` (visible via `am errors`), which is especially useful in Electron where DevTools isn't open by default.

**Both error types** also log to the DevTools console via `console.error` so the full trace is always available with F12.

### Actions dropped while disconnected

After reconnecting, the status indicator shows "Connected" but actions sent during disconnect are lost. This is by design — only the initial connect race (before first WS open) queues actions.

For offline support, actions sent after the first connection are persisted to IndexedDB (up to 100) and replayed on reconnect.

## Performance debugging

Check `log/perf.log` first — it records every budget violation, deduped per action type (logged once, then summarized hourly with count + worst duration). If the same action keeps exceeding budget, it shows up once with a count, not thousands of times.

### Slow reducer

```
Reduce took 250ms > 100ms budget for counter:analyze
```

The reducer is synchronous and blocks the dispatch loop. Move heavy computation to an effect:

```ts
// Bad — blocks for 250ms
reduce: {
  analyze(state) {
    state.results = heavyComputation(state.data)  // slow!
  },
}

// Good — reducer sets flag, execute does the work asynchronously
reduce: {
  analyze(state) {
    state.analyzing = true
    // effect triggered via execute.runAnalysis
  },
},
execute: {
  async runAnalysis(app, payload) {
    const results = await heavyComputation(payload.data)
    app.dispatch(myFeature.analysisDone(results))
  },
},
```

### Slow effect (sync portion)

```
Effect took 15ms > 5ms budget for counter:runAnalysis
```

The *synchronous* part of your effect is too slow. Make sure you return immediately and do work asynchronously:

```ts
// Bad — blocking
execute: {
  runAnalysis(app) {
    const data = JSON.parse(Deno.readTextFileSync('big.json'))  // sync!
    app.dispatch(myFeature.done(data))
  },
},

// Good — async
execute: {
  runAnalysis(app) {
    Deno.readTextFile('big.json')
      .then(text => JSON.parse(text))
      .then(data => app.dispatch(myFeature.done(data)))
  },
},
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

## Production failure scenarios

What actually happens when things go wrong at runtime.

### DB Worker crashes mid-transaction

The Worker-backed SQLite runs in a separate thread. If it crashes (OOM, Deno bug, corrupted WAL):

- **Callback transactions** (`db.transaction(fn)`): the Promise rejects with the Worker error. The write lock is released. State in memory is unaffected — the DB just missed a write.
- **Batch transactions** (`db.transaction([stmts])`): same — atomic failure, nothing committed.
- **Auto-persist (Deno.Kv)**: KV writes are fire-and-forget with error logging. A failed KV write means state restores from the last successful write on next restart.

**Recovery:** restart the process. SQLite WAL recovery handles partial writes automatically. If the DB file is corrupted, delete it — state will be rebuilt from the initial feature state on next run.

### WebSocket drops during a generator step

Generators run server-side — a client disconnect doesn't affect them. The flow continues to completion, state updates accumulate, and the client gets the latest state on reconnect via full-state sync.

If the *server* crashes mid-generator: the generator is lost (in-memory). On restart, features reinitialize to their persisted state. Design generators to be resumable — check state in `onInit` and re-trigger if needed.

### Electron process killed during state flush

Deno.Kv is crash-safe (it uses SQLite internally). A kill during write either commits fully or not at all. On next launch, state restores from the last committed write.

SQLite with WAL mode (the default) has the same guarantees — partial writes are rolled back on recovery.

### `deno compile` binary can't find assets

Compiled binaries embed `dist/app.js` and `dist/style.css` at build time. If the build step didn't run first (`deno task compile:browser` before assets exist), the binary serves empty responses.

**Fix:** always run the build task — it handles transpilation before compilation. If you see a blank page from a compiled binary, rebuild.

### Server restart while clients are connected

Each server start generates a boot ID sent to clients via `__boot:` message. If a client reconnects and sees a different boot ID, it triggers a page reload to pick up fresh code. This is automatic — no user action needed.

### Generator waitFor hangs forever

A `ctx.waitFor(action)` with no timeout waits indefinitely. In dev mode, a warning fires after 30 seconds. In prod, check `am health` — the flow will show as active in the feature's flow registry.

**Fix:** always pass a timeout to `waitFor` for actions that might not arrive: `ctx.waitFor(action, 30_000)`.

### Offline queue overflow

The offline queue (IndexedDB) caps at 100 actions. Beyond that, actions are silently dropped. This is intentional — a client that's been offline for hours shouldn't replay thousands of stale actions on reconnect.

**Symptoms:** user performs actions while disconnected, reconnects, but some actions are missing. The first 100 are replayed, the rest are lost.

### Feature error accumulation

Effect errors increment a per-feature counter visible via `registry.health()`. The feature keeps running — errors don't auto-disable it. Use `onPerf` or a periodic health check to detect features with high error counts and take action (alert, disable, restart).

### Memory growth in long-running apps

Common causes:
- **Time-travel history**: capped at 200 entries (dev mode only, zero in prod)
- **Action listeners (`waitFor`)**: cleaned up on flow completion or cancellation. A stuck generator leaks one listener — the 30s dev warning catches this
- **WebSocket client state**: each connected client holds a delta cache. Disconnected clients are cleaned up on close. Check `am status` for connection count

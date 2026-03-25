# Flow Cross-Feature State Access

**Date:** 2026-03-24 **Status:** Approved (brainstorm) **Scope:** ~50 lines
framework code, zero breaking changes

## Problem

Features manage their own state via machines and reducers. Generators (flows)
are the "smart" execution context for async orchestration, but they have two
gaps:

1. **`getFullState()` is not exposed in `GenCtx`** — flows can only read their
   own feature's state via `ctx.getState()`. The full state tree is already in
   the closure (`buildCtx` receives it at `flow.ts:281`) but is never passed
   through.

2. **No `when(predicate)` primitive** — flows can wait for a specific action
   (`waitFor`), but cannot wait for a **state condition**. Workarounds exist
   (poll loop with `sleep`, `race` over multiple `waitFor` calls) but are
   fragile, wasteful, and break when new actions are added.

### Why this matters

Most apps have cross-cutting state (connectivity, auth, lifecycle) that features
need to observe. Today:

- Machine foreign actions handle declarative reactions (e.g.,
  `'app:offline': 'paused'`). Works well.
- `getFullState()` is available in `onInit`, `onDestroy`, and `execute`. Works
  well.
- But flows — the primary async orchestration tool — are blind to other
  features' state.

## Design

### Change 1: Expose `getFullState()` on `GenCtx`

**File:** `src/flow.ts` — `buildCtx()` (line ~294)

Add one property to the returned `GenCtx` object:

```ts
return {
  // ... existing methods ...
  getState: () => getFullState()[featureName] as Record<string, unknown>,
  getFullState: () => getFullState(), // NEW
};
```

**Type change** in `GenCtx` (line ~89):

```ts
export type GenCtx<S = Record<string, unknown>> = {
  // ... existing ...
  getState: () => S;
  getFullState: () => Record<string, unknown>; // NEW
};
```

**Semantics:** Read-only snapshot of the full composed state tree. Same function
already used by `onInit`, `onDestroy`, and `execute`. Returns fresh state after
each flow step (same as `getState`).

### Change 2: `ctx.when(predicate, opts?)` primitive

A new flow step that suspends the generator until a state predicate returns
`true`. Checks immediately first — if already true, resolves without suspending.

#### GenCtx addition

```ts
export type GenCtx<S = Record<string, unknown>> = {
  // ... existing ...
  /** Wait until a state condition is true. Checks immediately, then after every dispatch.
   *  @param predicate — receives full app state, returns boolean
   *  @param opts.timeout — ms before the wait fails (default: no timeout) */
  when: (
    predicate: (appState: Record<string, unknown>) => boolean,
    opts?: { timeout?: number },
  ) => Gen<void>;
};
```

#### Internal: StateListener registry

Parallel to the existing `ActionListener` registry (`flow.ts:329`):

```ts
type StateListener = {
  predicate: (state: Record<string, unknown>) => boolean;
  resolve: () => void;
};

const _stateListeners = new Set<StateListener>();

/** Notify waiting flows when state changes — called after every reduce */
export function notifyStateListeners(state: Record<string, unknown>): void {
  for (const listener of _stateListeners) {
    try {
      if (listener.predicate(state)) {
        listener.resolve();
        _stateListeners.delete(listener);
      }
    } catch (e) {
      log.debug("aio", `when() predicate threw: ${e}`);
    }
  }
}
```

#### FlowStep union extension

Add to the `FlowStep` discriminated union (`flow.ts:57-75`):

```ts
| { kind: "when"; predicate: (state: Record<string, unknown>) => boolean; timeout?: number }
```

#### Flow runner handling

When the runner encounters a `when` step:

1. **Check immediately** — call `predicate(getFullState())`. If `true`, send
   `undefined` back to generator, continue.
2. **Register listener** — create `StateListener` with resolve/reject callbacks.
   Add to `_stateListeners`. Suspend generator by returning a Promise.
3. **On resolve** — predicate returned `true` after a dispatch. Remove listener,
   resume generator.
4. **On timeout** — use `Promise.race` + timeout sentinel (same pattern as
   `waitFor` at lines 656-671). Remove listener, throw timeout error into
   generator.
5. **On flow abort** — each `FlowInstance` tracks its active `StateListener`
   reference. `abortInstance` removes it from `_stateListeners` and rejects the
   promise. This mirrors the `AbortController` pattern used for `waitFor`.

#### `executeStep` handler

The flow runner's `executeStep` function (`flow.ts:502`) needs a `case "when"`
handler that returns a Promise — same as `waitFor`. This is required for `when`
to work inside `ctx.race` and `ctx.all`, which call `executeStep` and combine
results via `Promise.race`/`Promise.all`.

```ts
case "when": {
  // Immediate check
  if (step.predicate(getFullState())) return undefined;
  // Register and return promise
  return new Promise<void>((resolve, reject) => {
    const listener: StateListener = { predicate: step.predicate, resolve };
    _stateListeners.add(listener);
    instance.stateListener = listener;  // track for abort cleanup
    if (step.timeout) {
      setTimeout(() => {
        _stateListeners.delete(listener);
        reject(new Error(`when() timed out after ${step.timeout}ms`));
      }, step.timeout);
    }
  });
}
```

#### Call site in dispatch loop

**File:** `src/feature-compose.ts` — after `notifyFlowListeners(action)` (line
~532):

```ts
notifyFlowListeners(action);
notifyStateListeners(currentState); // NEW — one line
```

#### Cleanup

**File:** `src/flow.ts` — `resetFlows()` (line ~351):

```ts
export function resetFlows(): void {
  for (const [, instance] of activeFlows) abortInstance(instance);
  activeFlows.clear();
  _actionListeners.clear();
  _stateListeners.clear(); // NEW
}
```

## Usage Examples

### Reading cross-feature state in a flow

```ts
*executeTrade(ctx, order) {
  const { auth, app } = ctx.getFullState()

  if (app._status !== 'running') {
    yield* ctx.fail('app not running')
  }
  if (auth._status !== 'authenticated') {
    yield* ctx.fail('not authenticated')
  }

  yield* ctx.call('submit', () => exchange.submit(order))
  yield* ctx.done()
}
```

### Waiting for a state condition

```ts
*submitOrder(ctx, order) {
  // Blocks until app is running — resolves instantly if already true
  yield* ctx.when(s => s.app._status === 'running')

  // Also need auth — with timeout
  yield* ctx.when(s => s.auth._status === 'authenticated', { timeout: 10_000 })

  yield* ctx.call('submit', () => exchange.submit(order))
  yield* ctx.done()
}
```

### Replacing fragile waitFor race

Before (fragile — breaks when new auth paths are added):

```ts
yield * ctx.race({
  a: ctx.waitFor(auth.logout),
  b: ctx.waitFor(auth.sessionExpired),
  c: ctx.waitFor(auth.kicked),
});
```

After (robust — doesn't care how state was reached):

```ts
yield * ctx.when((s) => s.auth._status === "guest");
```

## Design Decisions

| Decision                                                 | Rationale                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Read-only access (no mutation via `getFullState`)        | Cross-feature mutation goes through `dispatch`. Observation is safe.                                                     |
| `when` checks immediately first                          | Prevents missed-state bugs. If condition is already true, no suspension.                                                 |
| Predicate errors treated as `false`                      | Dispatch loop must never crash from user predicate. Logged, not thrown.                                                  |
| `_stateListeners` is transient (flows remove on resolve) | Typically 0-5 entries. Not a performance concern.                                                                        |
| No `getFullState` for methods                            | Sync methods are pure reducers (machine gates them). Async methods needing cross-feature awareness should be generators. |
| Naming: `getFullState` not `getAppState`                 | Consistent with existing `ScopedApp.getFullState`. One name, one concept.                                                |

## Test Plan

### `getFullState` in flows

- Flow reads own feature state via `getFullState()[featureName]` — matches
  `getState()`
- Flow reads other feature's state — returns correct slice
- State is fresh after each flow step (not stale closure)

### `ctx.when` — happy path

- Condition already true — resolves immediately, no suspension
- Condition becomes true after dispatch — resolves
- Multiple `when` listeners resolve independently

### `ctx.when` — edge cases

- Timeout fires — flow receives error
- Predicate throws — treated as false, no crash, dispatch loop continues
- Flow cancelled — listener removed from `_stateListeners`
- `resetFlows()` clears all state listeners

### Integration

- App orchestrator pattern: app feature + dependent feature reacting via `when`
- Combine `when` with `waitFor` in same flow
- `when` inside `ctx.race` and `ctx.all`

## Files Changed

| File                     | Change                                                                     | Lines    |
| ------------------------ | -------------------------------------------------------------------------- | -------- |
| `src/flow.ts`            | `getFullState` on `GenCtx` type + `buildCtx` return                        | ~3       |
| `src/flow.ts`            | `StateListener` type, `_stateListeners` set, `notifyStateListeners` export | ~12      |
| `src/flow.ts`            | `whenGen()` helper function                                                | ~10      |
| `src/flow.ts`            | `when` on `GenCtx` type + `buildCtx` return                                | ~5       |
| `src/flow.ts`            | Handle `kind: 'when'` in flow runner + `executeStep`                       | ~20      |
| `src/flow.ts`            | Add `stateListener?` field to `FlowInstance` for abort tracking            | 1        |
| `src/flow.ts`            | Clean `_stateListeners` in `resetFlows()`                                  | 1        |
| `src/flow.ts`            | Clean state listener + reject in `abortInstance()`                         | ~5       |
| `src/feature-compose.ts` | Call `notifyStateListeners(currentState)` after `notifyFlowListeners`      | 1        |
| `examples/`              | App orchestrator pattern example                                           | New file |

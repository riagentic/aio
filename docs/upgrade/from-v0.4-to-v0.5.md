# Upgrade from v0.4 to v0.5

> **Note:** `feature()` was renamed to `cell()` in alpha11. See
> [upgrade guide](from-alpha10-to-alpha11.md).

### New features — feature-based architecture

v0.5 introduces `feature()` — one function defines state, actions, effects,
state machine, reducer, executor, and selectors. The classic v0.4 API
(`aio.run(initialState, config)`) has been removed as of v0.8 — migrate to
`aio.run({ features })` using the steps below.

Key additions:

- **`feature(name, config)`** — one function replaces 7 files. Auto-prefixes
  action/effect types. Wraps reducer in Immer `produce()` automatically
- **State machines** — required for every feature. Declares explicit states and
  transitions. `_status` field auto-managed by framework
- **`A` and `E` dual-role objects** — labels for `switch/case` + creators for
  `dispatch/return`
- **`aio.run({ features: [...] })`** — auto-composes state, reducer, executor.
  Validates dependency graph. Topological sort for init
- **`useFeature(counter)`** — scoped React hook: `{ state, send, status }`
- **`bridge()`** — cross-feature request/response with timeouts, retries,
  circuit breakers
- **`testFeature()`** — test harness with `send`, `expect.state()`,
  `expect.status()`, `expect.effects()`, `randomActions()`
- **Middleware system** — `aio.middleware.logger()`, `.validate()`,
  `.metrics()`, `.freeze()`, `.perfBudget()`, `.create(fn)`
- **Lifecycle `onInit`/`onDestroy`** — per-feature hooks with `ScopedApp`
- **State versioning & migrations** — `version: N` + `migrations: [fn]`
- **`--isolate` flag** — filter active features in dev mode
- **Health endpoint** — `GET /__aio/health`
- **Feature registry** — `app.features.enable()`, `.disable()`, `.status()`,
  `.health()`, `.list()`

### Breaking changes when adopting features

#### 1. State shape — feature-namespaced

```ts
// v0.4: flat state
const initialState = { count: 0, items: [] };

// v0.5: each feature's state lives under state.featureName
// { counter: { count: 0, _status: 'idle' }, items: { list: [], _status: 'idle' } }
```

**Impact:** existing Deno.Kv persistence is incompatible. First run after
migration starts from new initial state. Export a snapshot before migrating if
you need old data.

#### 2. Action naming — camelCase keys, auto-prefixed

```ts
// v0.4: PascalCase keys
const A = actions("Counter", { Increment: (by: number) => ({ by }) });

// v0.5: camelCase keys, same dispatched type strings
const counter = feature("counter", {
  actions: { increment: (by: number) => ({ by }) },
});
// counter.increment.type = 'Counter:Increment' — same string
```

#### 3. Reducer — no more `draft()`, state is the draft

```ts
// v0.4
import { draft } from "aio";
function reduce(state: AppState, action: Action) {
  return draft(state, (d) => {
    switch (action.type) {
      case A.Increment:
        d.count += action.payload.by;
        return [E.log("inc")];
      default:
        return [];
    }
  });
}

// v0.5 — state IS the Immer draft, { A, E } injected
reduce(state, action, { A, E }) {
  switch (action.type) {
    case A.Increment:
      state.count += action.payload.by    // mutate directly
      return [E.persist(state.count)]     // return effects or nothing
    case A.Reset:
      state.count = 0
      break                               // break = no effects
  }
}
```

#### 4. Executor — receives scoped app + context

```ts
// v0.4
function execute(app: AioApp<AppState, Action>, effect: Effect) {
  switch (effect.type) {
    case E.Persist:
      Deno.writeTextFile("./data.json", String(effect.payload.value))
        .then(() => app.dispatch(A.saved()));
      break;
  }
}

// v0.5 — { E, A } injected, dispatch scoped to own feature
execute(app, effect, { E, A }) {
  switch (effect.type) {
    case E.Persist:
      Deno.writeTextFile('./data.json', String(effect.payload.value))
        .then(() => app.dispatch(A.saved()))
      break
  }
}
```

#### 5. UI hooks — `useFeature()` replaces `useAio()`

```tsx
// v0.4
const { state, send } = useAio<AppState>();
send(A.increment(5));

// v0.5 — scoped state, typed send, machine status
const { state, send, status } = useFeature(counter);
send.increment(5); // state.count not state.counter.count
```

#### 6. State machines — new required field

```ts
machine: {
  initial: 'idle',
  states: {
    idle:   { increment: 'idle', save: 'saving' },
    saving: { saved: 'idle', saveFailed: 'error' },
    error:  { retry: 'saving', dismiss: 'idle' },
  },
}
```

Use `machine: false` for trivial features with no lifecycle.

#### 7. Selectors — feature-scoped

```ts
// v0.4
const getCount = (state: AppState) => state.count;

// v0.5 — receives feature's own state slice, call directly after aio.run()
selectors: {
  getCount: ((s) => s.count);
}
const count = counter.getCount();
```

#### 8. Boot — `aio.run()` config changes

```ts
// v0.4
await aio.run(initialState, { reduce, execute, persist: true, port: 8000 });

// v0.5 — no initialState/reduce/execute, auto-composed from features
await aio.run({
  features: [counter, dc, { feature: te, dependsOn: ["dc"] }],
  persist: true,
  port: 8000,
});
```

#### 9. Testing — `testFeature()` harness

```ts
// v0.4
Deno.test("increment", () => {
  const { state } = reduce(initialState, A.increment(5));
  assertEquals(state.count, 5);
});

// v0.5
testFeature(counter, "increment from idle", (t) => {
  t.init();
  t.send.increment(5);
  t.expect.state((s) => s.count === 5);
  t.expect.effects(["counter:log"]);
  t.expect.status("idle");
});
```

### Migration steps (converting to features)

Convert one feature at a time:

1. **Create feature directory:** `mkdir -p src/features/counter`
2. **Create feature definition** (`src/features/counter/index.ts`) — move state,
   actions, effects, machine, reduce, execute into a single `feature()` call
3. **Update entry point** — `aio.run({ features: [counter] })`
4. **Update UI** — replace `useAio()` with `useFeature(counter)`, replace
   `send(A.increment(5))` with `send.increment(5)`
5. **Platform APIs in execute** — if executor uses Deno globals, split into
   `def.ts` (browser-safe) + `index.ts` (adds execute with server imports)
6. **Delete old files** —
   `rm src/state.ts src/actions.ts src/effects.ts
   src/reduce.ts src/execute.ts`
7. **Clear persistence** — `rm -f *.sqlite3` (state shape changed)
8. **Run tests** — `deno task dev && deno task test`

### Key differences summary

| Aspect              | v0.4                                  | v0.5 features                                    |
| ------------------- | ------------------------------------- | ------------------------------------------------ |
| **Definition**      | 7 files                               | 1 file: `feature('name', { ... })`               |
| **Action keys**     | PascalCase                            | camelCase                                        |
| **Reducer wrapper** | `draft(state, d => { ... })`          | Auto-Immer: `state` IS the draft                 |
| **Reducer scope**   | Full app state                        | Feature's state slice only                       |
| **Executor scope**  | Can dispatch any action               | Scoped: own actions only                         |
| **State machine**   | None                                  | Required (or `false`)                            |
| **State shape**     | Flat                                  | Namespaced: `{ counter: { count: 0, _status } }` |
| **UI hook**         | `useAio<AppState>()`                  | `useFeature(counter)`                            |
| **UI dispatch**     | `send(A.increment(5))`                | `send.increment(5)`                              |
| **Boot**            | `aio.run(state, { reduce, execute })` | `aio.run({ features })`                          |
| **Testing**         | Manual `Deno.test`                    | `testFeature(counter, name, fn)`                 |

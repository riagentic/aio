# Upgrade from v0.7 to v0.8

### Breaking changes

**`reduce` and `execute` are now objects (named handlers)**

The function form with `{ A }` / `{ E }` context is removed from the default
path.

```ts
// BEFORE (v0.7)
reduce(state, action, { A, E }) {
  switch (action.type) {
    case A.Increment:
      state.count += action.payload.by
      return [E.log(`count: ${state.count}`)]
    case A.Reset:
      state.count = 0
      break
  }
},
execute(app, effect, { E, A }) {
  switch (effect.type) {
    case E.Log:
      console.log(effect.payload.message)
      break
    case E.Persist:
      db.save(effect.payload.value).then(() => app.dispatch(A.saved()))
      break
  }
},

// AFTER (v0.8)
reduce: {
  increment(state, payload) {
    state.count += payload.by
    // effects wired via execute — no return needed
  },
  reset(state) {
    state.count = 0
  },
},
execute: {
  log(_app, payload) {
    console.log(payload.message)
  },
  async persist(app, payload) {
    await db.save(payload.value)
    app.dispatch(myFeature.saved())
  },
},
```

**Migration:**

1. Convert `reduce(state, action, { A, E }) { switch ... }` →
   `reduce: { handlerName(state, payload) {} }`
2. Convert `execute(app, effect, { E, A }) { switch ... }` →
   `execute: { handlerName(app, payload) {} }`
3. Remove all `{ A }` and `{ E }` destructuring from reduce/execute signatures

**For foreign action handling** — use the function form with `{ on }`:

```ts
// When your reducer needs to react to another feature's actions
reduce(state, action, { on }) {
  on(counter.increment, (payload) => {
    state.watchedCount = payload.by
  })
  // own actions still handled normally
},
```

---

**Lowercase action type strings**

Action types changed from `'Feature:Action'` to `'feature:action'` format.

```ts
// BEFORE (v0.7)
if (action.type === 'Counter:Increment') { ... }
listensTo: ['Counter:Increment', 'Wallet:Transfer']
cancelOn(['Counter:Stop'], fn)
ctx.waitFor('Payment:Complete')
machine: { states: { active: { 'Counter:Increment': 'active' } } }

// AFTER (v0.8) — use .type or pass function directly
if (action.type === counter.increment.type) { ... }
listensTo: [counter.increment, wallet.transfer]
cancelOn([counter.stop], fn)
ctx.waitFor(payment.complete)
machine: { states: { active: { [counter.increment.type]: 'active' } } }
```

**Migration:** Find all raw action type strings (pattern: `'Foo:Bar'`) and
replace with bound method `.type` references or function references.

---

**Direct calling replaces all dispatch patterns**

Application code should call methods directly on the feature object:

```ts
// REMOVE from application code:
send(counter.increment(5)); // → send.increment(5)

// Direct calling after aio.run():
counter.increment(5);

// In generators — call directly:
yield * ctx.dispatch(wallet.credit(100));
```

---

**`dispatchTo` accepts feature objects — string form removed**

```ts
// BEFORE (v0.7)
dispatchTo: ["wallet", "fleet"];

// AFTER (v0.8)
import { wallet } from "../wallet";
import { fleet } from "../fleet";
dispatchTo: [wallet, fleet];
```

**Async method signature — `ctx` parameter removed**

Old async methods had `ctx` injected as the second parameter:

```ts
// v0.7 — ctx injected
async save(s, ctx, url: string) { ... }
async notify(s, ctx) { await ctx.call('notifications', 'send', 'done') }
```

In v0.8, async methods use the same `(s, ...args)` signature as sync methods:

```ts
// v0.8 — no ctx, direct import
async save(s, url: string) { ... }
async notify(s) { await notifications.send('done') }
```

**Migration:** remove `ctx` from all async method signatures. If you used
`ctx.call('feature', 'method', ...)`, replace with a direct import and call:
`import { notifications } from '../notifications'; await notifications.send('done')`.

**`machine: 'simple'` removed — use `machine: false`**

```ts
// before
feature('counter', { machine: 'simple', ... })

// after
feature('counter', { machine: false, ... })
```

**`flows:` key removed from `feature()` config — use `generators:` key instead**

```ts
// before (v0.7)
import { feature, flow } from 'aio'
feature('myFeature', {
  flows: {
    main: flow('start', function* (ctx) { ... }),
  },
})

// after (v0.8)
feature('myFeature', {
  generators: {
    start: function* (ctx) { ... },  // key matches action key
  },
})
```

**`flow()` export removed — use `generators` key directly**

`flow()` is no longer exported from `'aio'`. Wrap the generator function with
`cancelOn(triggers, fn)` if you need declarative cancellation:

```ts
import { feature, cancelOn } from 'aio'

feature('healthCheck', {
  generators: {
    start: cancelOn([counter.stop], function* (ctx) { ... }),
  },
})
```

**`ctx.put` renamed to `ctx.dispatch` in generator context**

```ts
// before (v0.7)
yield * ctx.put(someFeature.doThing());

// after (v0.8)
yield * ctx.dispatch(someFeature.doThing());
```

**`t.expect.effects()` requires full type strings**

```ts
// BEFORE (v0.7)
t.expect.effects(["log", "persist"]);

// AFTER (v0.8)
t.expect.effects(["counter:log", "counter:persist"]);
```

**Machine `on` is optional for terminal states**

```ts
// BEFORE — was required even when empty
states: { saving: {}, error: {} }

// AFTER — omit on entirely
states: { saving: {}, error: {} }
```

### What's NOT breaking

- `feature({ methods })` — unchanged
- `feature({ generators })` — unchanged
- `useFeature` / `send.method()` — unchanged
- `call()` / direct cross-feature calling — unchanged
- All tests using `testFeature` — unchanged (send proxy unchanged)
- The function form `reduce(state, action, fn)` — available as escape hatch with
  `{ on }` / `{ emit }`

### Migration steps

1. **Convert reduce** — find all `reduce(state, action, { A` patterns, convert
   to object form
2. **Convert execute** — find all `execute(app, effect, { E` patterns, convert
   to object form
3. **Fix action type strings** — find all `'PascalCase:PascalCase'` strings,
   replace with `.type` references
4. **Fix listensTo** — replace string arrays with bound method arrays
5. **Fix cancelOn** — replace string triggers with bound method triggers
6. **Fix ctx.waitFor** — replace string form with bound method form
7. **Fix machine on keys** — replace raw string keys with computed
   `[feature.method.type]`
8. **Remove `send(feature.method(args))`** — replace with `send.method(args)`
9. **Fix `dispatchTo`** — replace string arrays with imported feature refs
10. **Fix `t.expect.effects()`** — prefix all effect keys with `featureName:`
11. **Fix async method signatures** — remove `ctx` parameter
12. Replace `dep/aio/` with the v0.8 folder
13. Run `deno install && deno task dev` — linter will flag remaining issues

# Upgrade from v0.6 to v0.7

### New features — reactive features

v0.7 adds `reactive()`, improves `flow()`, and overhauls DX. No breaking
changes. All v0.6 code works unchanged.

**reactive() — plain methods instead of reduce/execute** _(removed in v0.8 — use
`feature({ methods })` instead)_

- Sync methods mutate state via Immer draft, can return schedule effects
- Async methods get live Proxy — reads always fresh, writes auto-dispatch
- Machine-gated async writes via method-tagged `__setMethod` actions
- Microtask batching — consecutive Proxy writes grouped into one action per sync
  frame
- `listensTo: string[]` — foreign action listeners without a full machine
- Selectors, dispatchTo, onInit/onDestroy hooks all work

**flow() improvements**

- `ctx.waitFor(actionType, timeout?)` — pause until external action dispatched
- `ctx.getState()` — read current feature state inside a flow
- `cancelOn: string[]` — declarative flow cancellation on arbitrary actions
- `ctx.dispatch()` accepts `{ type, payload? }` — payload optional
- Flow errors fed back into generator for try/catch support

**DX**

- Direct calling — `counter.increment(5)` after `aio.run()` (all three tiers)
- TypeScript inference — typed autocomplete for methods and selectors
- Pre-bind console.warn when methods called before `aio.run()`
- `machine: false` — no state machine guards, all actions always allowed
- FeatureDef phantom State type for testFeature inference
- `useSyncExternalStore` in useAio/useFeature for selective re-renders
- `useFeature(ref)` added — scoped state, typed send, machine status, selective
  re-renders
- Startup linter validates empty features, `_status` reserved key, empty
  actionKeys
- `--type` and `--template` CLI flags for non-interactive scaffolding
- Async `testFeature()` — `t.runEffects()` + `t.settle(ms?)`

**Infra**

- Nested delta patches for fine-grained state sync
- UDS transport — zero TCP ports in prod electron builds
- `Msg<P>` generic for typed payload access without casts
- WebSocket payload validation, per-user action authorization
- App identity with identity-based singleton lock

### What's NOT breaking

- `feature()` with reduce/execute works exactly as before
- `flow()` works exactly as before
- All existing tests pass unchanged
- Reactive features are fully optional — use any combination of reactive, flow,
  and feature

### Upgrade steps

1. Replace `dep/aio/` with the v0.7 folder
2. Update `deno.json` version to `"0.7.0"`
3. Done — no code changes required

### Using reactive (optional)

```ts
import { reactive } from "aio";

const counter = reactive("counter", {
  state: { count: 0 },
  listensTo: ["Other:ActionType"], // foreign listeners without a machine
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
    startTimer(s) {
      s.active = true;
      return {
        _schedule: true,
        key: "tick",
        type: "Counter:Tick",
        intervalMs: 1000,
      };
    },
    async save(s) {
      await Deno.writeTextFile("data.json", String(s.count));
      s.saved = true;
    },
  },
});

await aio.run({ features: [counter] });
counter.increment(5); // dispatches directly
```

### Flow improvements (optional)

```ts
// cancelOn — declarative cancellation
healthCheck: flow("start", { cancelOn: ["stop"] }, function* (ctx) {
  while (true) {
    yield* ctx.call("check", () => fetch("/health"));
    yield* ctx.sleep("wait", 30_000);
  }
});

// ctx.waitFor — pause until external action
// actions-style: payload destructured directly (no action wrapper)
purchase: flow("start", function* (ctx, { amount }: { amount: number }) {
  yield* ctx.dispatch(payment.charge(amount));
  const result = yield* ctx.waitFor("Payment:Complete", 10_000);
  yield* ctx.done((s) => {
    s.paid = true;
  });
});

// ctx.getState — read fresh state
yield * ctx.mutate("inc", (s) => {
  s.count++;
});
const s = ctx.getState();
if (s.count >= 10) {
  yield * ctx.done();
  return;
}
```

See [reactivity.md](reactivity.md) and [generators.md](generators.md) for full
guides.

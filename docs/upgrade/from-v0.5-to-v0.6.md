# Upgrade from v0.5 to v0.6

> **Note:** `feature()` was renamed to `cell()` in alpha11. See
> [upgrade guide](from-alpha10-to-alpha11.md).

### New features — generator-based flows

v0.6 adds `flow()` — sequential async workflows using generators. _(The `flows:`
key and `flow()` function were removed in v0.8 — use the `generators` key
instead.)_ No breaking changes from v0.5. All v0.5 code works unchanged on v0.6.

- **`flow(trigger, generatorFn)`** — define a sequential workflow triggered by
  an action. Write top-to-bottom async code; each yield point dispatches an
  action visible in time-travel
- **`GenCtx` API** — `ctx.call()` (async work), `ctx.step()` (state mutation),
  `ctx.done()` / `ctx.fail()` (terminal), `ctx.dispatch()` (dispatch),
  `ctx.all()` (parallel), `ctx.race()` (first wins), `ctx.sleep()` (pause)
- **`reduce` and `machine` now optional** — flow-only features don't need a
  reducer or machine definition
- **Auto-generated actions** — each yield point dispatches
  `{Feature}:Flow:{StepName}` automatically. No manual action/effect catalog
  needed for flows
- **Auto-cancellation** — re-triggering a flow cancels the previous instance.
  Feature disable/destroy cancels all running flows

### What's NOT breaking

- `feature()` with reduce/execute works exactly as before
- All existing tests pass unchanged
- `machine`, `reduce`, `execute`, `effects`, `bridge` — all untouched
- Flows are fully optional — features can use reduce, flows, or both

### Upgrade steps

1. Replace `dep/aio/` with the v0.6 folder
2. Update `deno.json` version to `"0.6.0"`
3. Done — no code changes required

### Using flows (optional)

```ts
import { feature, flow } from "aio";

const myFeature = feature("myFeature", {
  state: { result: null },
  actions: { start: () => ({}) },
  flows: {
    main: flow("start", function* (ctx) {
      const data = yield* ctx.call("fetch", () => fetchData());
      yield* ctx.done((s) => {
        s.result = data;
      });
    }),
  },
});
```

See [generators.md](../state/generators.md) for the full guide.

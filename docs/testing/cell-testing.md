# Cell Testing

## `testCell(cell, name, fn)` — isolated cell testing

Test harness that wraps `Deno.test` with typed helpers. Automatically resets all
flows and pending async calls before each test — no teardown needed.

```ts
import { testCell } from "aio/testing"; // or from "aio"
import { counter } from "./cell/counter/index.ts";

testCell(counter, "increment from idle", (t) => {
  t.init();
  t.send.increment(5);
  t.expect.state((s) => s.count === 5);
  t.expect.status("idle");
  t.expect.effects(["counter:log"]);
});

testCell(counter, "machine guards block invalid transitions", (t) => {
  t.init();
  t.send.save(); // idle -> saving
  t.expect.status("saving");
  t.send.increment(1); // blocked! increment not in saving.on
  t.expect.state((s) => s.count === 0); // unchanged
});

testCell(counter, "save flow: idle -> saving -> error -> idle", (t) => {
  t.init();
  t.send.save();
  t.expect.status("saving");
  t.send.saveFailed("network error");
  t.expect.status("error");
  t.expect.state((s) => s.error === "network error");
  t.send.dismiss();
  t.expect.status("idle");
});
```

### Random action fuzzing (property-based testing)

```ts
testCell(counter, "random action fuzzing", (t) => {
  t.init();
  t.randomActions(100); // dispatch 100 random valid actions
  t.expect.invariant((s) => typeof s.count === "number");
});
```

### Async tests

The simplest form mirrors production code — **await the send** (AIO-379):

```ts
testCell(loader, "loads data", async (t) => {
  t.init();
  await t.send.load(); // runs the async method, resolves when all writes applied
  t.expect.state((s) => s.data === "loaded");
  t.expect.state((s) => s.loading === false);
});
```

This is the same shape as production (`await loader.load()`), and it is
deterministic: the promise resolves on real method completion, no matter how
long the method takes (dynamic imports, file IO, slow fetches). If the method
throws, the awaited promise rejects — assert with `assertRejects`.

Not awaiting keeps the old fire-and-forget behavior: nothing executes until you
`settle()`. Sends blocked by the machine resolve immediately.

`await t.settle()` is the bulk alternative — run all pending effects and wait
for every triggered async method to actually finish:

```ts
testCell(loader, "loads data", async (t) => {
  t.init();
  t.send.load();
  await t.settle(); // tracks the async method to completion — no ms guessing
  t.expect.state((s) => s.data === "loaded");
});
```

Each effect runs at most once across `await send` / `settle()` calls — mixing
them never double-executes a method. `settle()` does not reject on method errors
(it waits for quiet; use `await send` to assert failures).

Reserve `await t.settle(100)` (timer-based) for code that uses **real timers**
outside the cell system, e.g. `setTimeout` chains.

### State machine transitions

```ts
testCell(door, "cannot open when already open", (t) => {
  t.init();
  t.send.open();
  t.expect.status("open");

  t.send.open(); // Should be dropped
  t.expect.status("open"); // Still 'open'
  t.expect.noStateChange();
});
```

## TestContext API

| Method                       | Description                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `t.init()`                   | Reset to initial state                                                                                  |
| `t.destroy()`                | Reset + set status to 'uninitialized'                                                                   |
| `t.send.<action>(...args)`   | Dispatch an action. Returns a promise — await it to run an async method to completion (AIO-379)         |
| `t.expect.state(fn)`         | Assert on cell state slice                                                                              |
| `t.expect.status(str)`       | Assert current machine status                                                                           |
| `t.expect.effects(['name'])` | Assert effect types from last action — use full `'cellName:effectKey'` format, e.g. `'counter:persist'` |
| `t.expect.effectCount(n)`    | Assert number of effects from last action                                                               |
| `t.expect.invariant(fn)`     | Assert a predicate holds                                                                                |
| `t.getState()`               | Get cell state slice (use `t.expect.status()` for machine status)                                       |
| `t.getEffects()`             | Get effects from last dispatched action                                                                 |
| `t.randomActions(n)`         | Dispatch N random valid actions (property-based testing)                                                |
| `t.runEffects()`             | Execute pending effects manually (deprecated — `settle()` now auto-runs effects)                        |
| `t.settle(ms?)`              | Run effects + wait for async. No arg: drain microtasks (fast). With ms: timer wait.                     |

## Testing inter-cell coordination

The preferred pattern is direct import + call — test it like any cell method:

```ts
testCell(inventory, "reserve: updates reserved list", async (t) => {
  t.init();
  t.send.reserve(["widget"]); // dispatches as normal action
  await t.settle();
  t.expect.state((s) => s.reserved.includes("widget"));
});
```

For testing `call()` with timeout/retry in isolation — call it in a Deno.test
after binding the app:

```ts
import { call } from "aio";

Deno.test("call resolves with return value", async () => {
  await aio.run({ appId: "my-app", cells: [inventory] });

  // Direct call — typed, no strings
  const stock = await inventory.checkStock("widget");
  assertEquals(stock, 10);

  // With timeout/retry
  const result = await call(
    { timeout: 1000, retries: 2 },
    () => inventory.checkStock("widget"),
  );
  assertEquals(result, 10);
});
```

The string form `call('cell', 'method', ...)` was removed in v0.8 — use direct
import and calling for type safety.

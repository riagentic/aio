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

`await t.settle()` runs effects + waits for async to complete:

```ts
testCell(loader, "loads data", async (t) => {
  t.init();
  t.send.load(); // triggers reducer, queues effect
  await t.settle(); // auto-runs effects + drains microtasks (fast, no timer)
  t.expect.state((s) => s.data === "loaded");
  t.expect.state((s) => s.loading === false);
});
```

For complex async with real timers: `await t.settle(100)` — timer-based settle.

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
| `t.send.<action>(...args)`   | Dispatch an action                                                                                      |
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

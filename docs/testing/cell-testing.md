# Cell Testing

## `testCell(cell, name, fn)` — isolated cell testing

Test harness that wraps `Deno.test` with typed helpers. Automatically resets all
flows and pending async calls before each test — no teardown needed. State
starts initialized — `t.init()` is only needed to RESET mid-test.

`testCell` runs the cell in the **server context**: in-process, on the raw
(unfiltered) state, effects collected and run by `settle()`/an awaited send —
never the client-replay slice. A hidden field is readable here and would throw
in a sync selector; see `docs/state/cell-contexts.md` for the full table.

```ts
import { testCell } from "aio/testing";
import { counter } from "./cell/counter/index.ts";

testCell(counter, "increment from idle", (t) => {
  t.send.increment(5);
  t.expect.state((s) => s.count === 5);
  t.expect.effects(["counter:log"]);
});

testCell(counter, "guard line blocks increment while saving", (t) => {
  t.send.save(); // status -> 'saving'
  t.expect.state((s) => s.status === "saving");
  t.send.increment(1); // guard line returns early
  t.expect.state((s) => s.count === 0); // unchanged
});

testCell(counter, "save flow: idle -> saving -> error -> idle", (t) => {
  t.send.save();
  t.expect.state((s) => s.status === "saving");
  t.send.saveFailed("network error");
  t.expect.state((s) => s.status === "error");
  t.expect.state((s) => s.error === "network error");
  t.send.dismiss();
  t.expect.state((s) => s.status === "idle");
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

Not awaiting is fire-and-forget, exactly like production `loader.load()`: **the
call starts immediately either way.** Awaiting only decides whether the test
waits for it.

`await t.settle()` is the bulk alternative — run all pending effects and wait
for every call started so far to actually finish, awaited or not:

```ts
testCell(loader, "loads data", async (t) => {
  t.send.load();
  await t.settle(); // tracks the async method to completion — no ms guessing
  t.expect.state((s) => s.data === "loaded");
});
```

#### Testing work that is still in flight

Because a call starts when you make it, a second action can land while the first
is still running — which is how you test cancellation, supersession, and "a new
navigation aborts the previous scan":

```ts
testCell(disk, "cancel aborts a running scan", async (t) => {
  const scanning = t.send.open("/"); // the scan is running NOW
  await t.send.cancel(); // …so this lands mid-flight and aborts it
  await scanning;
  t.expect.state((s) => s.path === null);
});
```

Two things behave the way they do in production, and both matter here:

- A method's **state writes are batched** and commit on a microtask, so a sync
  action dispatched in the same tick commits _first_ and can then be overwritten
  by the async method's prefix. Don't build cancellation on a state flag you set
  before the first `await` — use
  [`cancelOn`](../state/methods.md#cancellation--cancelon--ssignal) and
  `s.$signal`, which abort at dispatch time.
- Anything the method does that is **not** state — spawning a subprocess,
  opening a socket — has already happened when the call returns.

Leave no call running at the end of a test: `await` it, or `await t.settle()`.

Each effect runs at most once across `await send` / `settle()` calls — mixing
them never double-executes a method.

**A failure nobody looked at surfaces.** If a method throws and the test never
observed that call, `settle()` re-raises it (and so does the end of the test, if
`settle()` is never called) — a fire-and-forget send cannot fail silently into a
green test. Observing it yourself keeps `settle()` quiet:

```ts
await assertRejects(() => t.send.boom(), Error, "kaboom"); // handled here…
await t.settle(); // …so this does not raise it again
```

Reserve `await t.settle(100)` (timer-based) for code that uses **real timers**
outside the cell system, e.g. `setTimeout` chains.

### Guard-line transitions

```ts
testCell(door, "cannot open when already open", (t) => {
  t.send.open();
  t.expect.state((s) => s.status === "open");

  t.send.open(); // guard line returns early
  t.expect.state((s) => s.status === "open"); // still 'open'
});
```

### What `testCell` will not run: schedules and `own()`

`testCell` drives the composed reducer and executor directly. It owns no clock
and no resource table, so a `schedule.after/every/at/cron` effect and an `own()`
acquire/dispose have nowhere to go. They used to be dropped in silence —
`s.$do(schedule.after(…))` never fired, `own()` never disposed, and the test was
green. Now they **throw**, naming the harness that does run them:

```ts
testCell(poller, "arms the poll", async (t) => {
  t.send.start();
  await t.settle(); // Error: a schedule effect reached the root cell executor…
});
```

Test the reduce/method logic that EMITS the effect with `testCell`
(`t.expect.effects([...])` sees it without running it), and test the firing with
`bootCells` — it boots the standalone runtime, so `await h.advance(ms)` fires
what is due and `h.dispose()` disposes what was owned:

```ts
using h = await bootCells([poller]);
await poller.start();
await h.advance(30_000);
assertEquals(poller.ticks, 3);
```

## `bootCells(cells)` — several cells, no DOM

The multi-cell counterpart: methods dispatch for real, reactive reads work, and
`h.advance(ms)` fires due schedules. It runs the same boot refusals `aio.run()`
runs (see `docs/testing/prod-parity.md`), and shares `testCell`'s two rules
about failures:

- **`h.settle()` throws when it gives up**, naming the calls still in flight —
  "the app quiesced" and "I stopped waiting" must not be the same answer.
- **A failing method nobody awaited fails the test** at the next `settle()` or
  `dispose()`. Awaiting it (or `await assertRejects(() => cell.go())`) counts as
  observing it, and is not reported twice.

## TestContext API

| Method                       | Description                                                                                                                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t.init(seed?)`              | Reset to initial state, optionally SEEDED: `t.init({ scanning: true })` shallow-merges over the declared initial, so a test starts AT the state under test instead of driving the cell there through real methods. An unknown key throws, listing the real ones |
| `t.destroy()`                | Reset + set status to 'uninitialized'                                                                                                                                                                                                                           |
| `t.send.<action>(...args)`   | Dispatch an action — starts immediately, like production. Returns a promise; await it to wait for completion                                                                                                                                                    |
| `t.expect.state(fn)`         | Assert on cell state slice (incl. your `status` field)                                                                                                                                                                                                          |
| `t.expect.effects(['name'])` | Assert effect types from last action — use full `'cellName:effectKey'` format, e.g. `'counter:persist'`                                                                                                                                                         |
| `t.expect.effectCount(n)`    | Assert number of effects from last action                                                                                                                                                                                                                       |
| `t.expect.invariant(fn)`     | Assert a predicate holds                                                                                                                                                                                                                                        |
| `t.getState()`               | Get cell state slice                                                                                                                                                                                                                                            |
| `t.getEffects()`             | Get effects from last dispatched action                                                                                                                                                                                                                         |
| `t.randomActions(n)`         | Dispatch N random valid actions (property-based testing)                                                                                                                                                                                                        |
| `t.runEffects()`             | Execute pending effects manually (deprecated — `settle()` now auto-runs effects)                                                                                                                                                                                |
| `t.settle(ms?)`              | Run pending effects + wait for every call started so far. With ms: also wait out real timers.                                                                                                                                                                   |

## Testing inter-cell coordination

The preferred pattern is direct import + call — test it like any cell method:

```ts
import { cell } from "aio";
import { testCell } from "aio/testing";

const inventory = cell("inventory", {
  state: { reserved: [] as string[] },
  methods: {
    reserve(s, items: string[]) {
      s.reserved.push(...items);
    },
  },
});

testCell(inventory, "reserve: updates reserved list", async (t) => {
  t.send.reserve(["widget"]); // dispatches as normal action
  await t.settle();
  t.expect.state((s) => s.reserved.includes("widget"));
});
```

For testing `call()` with timeout/retry in isolation — call it in a Deno.test
after binding the app:

```ts
import { assertEquals } from "@std/assert";
import { aio, call } from "aio";
import { inventory } from "./cell/inventory/index.ts";

Deno.test("call resolves with return value", async () => {
  await aio.run({ appId: "my-app", cells: [inventory] });

  // Direct call — typed, no strings
  const stock = await inventory.checkStock("widget");
  assertEquals(stock, 10);

  // With timeout/retry
  const result = await call(
    { timeoutMs: 1000, retries: 2 },
    () => inventory.checkStock("widget"),
  );
  assertEquals(result, 10);
});
```

The string form `call('cell', 'method', ...)` was removed in v0.8 — use direct
import and calling for type safety.

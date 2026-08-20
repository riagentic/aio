# Methods — Sync, Async, and Selectors

> v2: methods is the one style — see
> [docs/upgrade/restructure.md](../upgrade/restructure.md) for migration from
> `actions:`/`reduce:`/`machine:`/`generators:`.

The one way to build aio cells. No action catalogs, no effect catalogs, no
switch/case. Just methods that mutate state.

## Quick example

```ts
import { aio, cell } from "aio";

const todo = cell("todo", {
  state: {
    items: [] as { text: string; done: boolean }[],
    filter: "all" as "all" | "active" | "done",
  },
  methods: {
    add(s, text: string) {
      s.items.push({ text, done: false });
    },
    toggle(s, idx: number) {
      s.items[idx].done = !s.items[idx].done;
    },
    setFilter(s, filter: "all" | "active" | "done") {
      s.filter = filter;
    },
    async sync(s) {
      await fetch("/api/todos", {
        method: "POST",
        body: JSON.stringify(s.items),
      });
    },
  },
  selectors: {
    filtered: (s) =>
      s.filter === "all"
        ? s.items
        : s.items.filter((i) => (s.filter === "done" ? i.done : !i.done)),
    remaining: (s) => s.items.filter((i) => !i.done).length,
  },
});

await aio.run({ cells: [todo] });
todo.add("buy milk");
todo.toggle(0);
const count = todo.remaining(); // → 0
```

After `aio.run()`, call methods and selectors directly on the cell — no
`dispatch()`, no passing state.

---

## Sync methods

Receive mutable state (Immer draft). Mutate in place:

```ts
methods: {
  increment(s, by = 1) {
    s.count += by
  },
  addItems(s, items: Item[]) {
    s.items.push(...items)
    s.total = s.items.reduce((sum, i) => sum + i.price, 0)
  },
}
```

All mutations within one method call = one atomic action. The method name
becomes the action type: `increment` → `counter:increment`.

**What you can do:** mutate any property, nested objects, array methods (`push`,
`splice`, `sort`), delete properties — anything Immer supports.

**What you cannot do:** async operations, access other cells' state.

### Returning a value

A sync method can **return a value**, and `await cell.method()` resolves with it
— no need to make the method `async` just to hand something back:

```ts
methods: {
  addItem(s, item: Item): string {
    const id = crypto.randomUUID()
    s.items.push({ ...item, id })
    return id                       // ← the new id
  },
}

const id = await cart.addItem({ name: "Book", price: 12 })
//    ^? string
```

- The type is inferred: `addItem` → `Promise<string>`, a void method →
  `Promise<void>`. Annotate the return (`: string`) when TS can't infer it.
- Effects go through `s.$do(...)`, never the return — so a method can schedule
  an effect **and** return a value in the same call. (Deprecated: returning a
  schedule/own effect still schedules it — `await` resolves `undefined` — with a
  one-time hint; `aiol --safe-fix` rewrites it.)
- Returning a slice of draft state (`return s.items[id]`) is safe — the value is
  snapshotted, so it survives past the method (no revoked-proxy surprises).
- **Return values cross the network bridge.** When a **browser or Electron
  client** calls a method that runs on the **server**, the return value is
  transported back in the action's ack frame — the client's `await` resolves
  with the real value (same as in-process callers get). Async methods work too:
  the value settles when the method _completes_, not when it starts.
  ```ts
  // In a browser component — resolves with the server method's return:
  const id = await cart.addItem({ name: "Book", price: 12 }); // ← "a1b2-…"
  ```
- **The value must be JSON-serializable to cross the wire.** Plain
  objects/arrays/primitives transport fine. In-process callers always get the
  raw value; only the network boundary requires JSON. (Reading the resulting
  **state reactively** remains the idiomatic choice when what you need is
  already synced to the client.) Two distinct failures, both loud:

  - **Cannot travel at all** — a bare function or symbol, a `BigInt` anywhere in
    the value, or a circular structure. The client `await` resolves `undefined`
    and the server warns.
  - **Travels, but CHANGED.** JSON silently rewrites more than it refuses, and
    the framework names every conversion by path (`value.due: Date → string`) in
    a warning rather than letting the caller receive a different value than the
    method returned:

    | Returned                               | The caller actually receives    |
    | -------------------------------------- | ------------------------------- |
    | `Date`                                 | ISO string                      |
    | `Map` / `Set` / `RegExp` / `Error`     | `{}`                            |
    | a class instance                       | a plain object (prototype gone) |
    | `Uint8Array`                           | `{"0":1,"1":2,…}`               |
    | `NaN` / `±Infinity`                    | `null`                          |
    | `-0`                                   | `0`                             |
    | `undefined` / function / symbol member | the key is absent               |
    | an object with `toJSON()`              | whatever `toJSON()` returned    |

  Return JSON-safe data across the wire (ISO strings for dates, arrays for
  `Map`/`Set`, plain objects for class instances).

- **`null` is a value, `undefined` is "nothing".** A method returning `null`
  resolves its caller with `null` — sync and async alike, in process and over
  the wire — so it works as a "not found" sentinel. Only `undefined` (or no
  `return` at all) resolves `undefined`.

### Running effects: `s.$do(effect, ...)`

Methods — sync **and** async — run schedule/own effects through the draft's
`$do` member. `return` is for **values**; `$do` is for **effects** — so one
method can do both:

```ts
methods: {
  startPolling(s) {
    s.polling = true
    s.$do(schedule.every('poll', 30_000, poller.refresh.action()))
  },
  stopPolling(s) {
    s.polling = false
    s.$do(schedule.cancel('poll'))
    return s.stoppedCount   // a VALUE — resolves the caller's await
  },
}
```

`$do` takes one or more effects (`schedule.*` / `own.*`) and throws loudly on
anything else. In a sync method the effects run with the commit; in an async
method they dispatch **immediately** (an `own.set` factory registers in the same
tick). Payloads may reference `s` freely — they are snapshotted to plain data at
capture.

> **Deprecated:** `return schedule.after(...)` (the pre-alpha52 effect channel)
> still works through beta and prints a one-time hint per method.
> `aiol --safe-fix` rewrites it to `s.$do(...)`.

### Referencing the cell inside its own methods: `self()`

When a method schedules an action on **its own cell**, naming the cell inside
its own initializer used to trip TypeScript's self-referential-inference guard
(TS7022/7023) and require a `: CellEffect` return annotation. `self()` removes
the self-reference entirely:

```ts
import { cell, schedule, self } from "aio";

const cycle = cell("cycle", {
  state: { phase: "work", n: 0 },
  methods: {
    tick(s) {
      s.n += 1;
    },
    skip(s) {
      // self("tick") resolves to THIS cell's tick action at capture — no
      // `cycle.` reference, no TS7022, no annotation.
      s.$do(schedule.after("cycle.next", 0, self("tick")));
    },
    maybeStop(s) {
      if (s.n > 3) s.$do(schedule.cancel("cycle.next"));
    },
    async poll(s) {
      await Promise.resolve();
      s.$do(schedule.after("cycle.retry", 500, self("tick")));
    },
  },
});
```

`self(method, ...args)` builds the `{ type, payload }` descriptor and is
resolved by the dispatching cell; an unknown method name throws at `cell()` when
statically present (`cancelOn: { search: [self("clear")] }`), else at dispatch —
loud both ways. Scheduling **another** cell's action keeps using
`otherCell.method.action(...)`.

(The `CellEffect` type is still exported for code on the deprecated
return-effects channel.)

---

## Async methods

Same signature as sync, but the state argument is a **live Proxy** that batches
mutations:

```ts
methods: {
  async checkout(s) {
    s.status = 'loading'                       // dispatches immediately
    const order = await placeOrder(s.items)    // s.items reads CURRENT state
    s.orderId = order.id                       // dispatches after await
    s.status = 'done'                          // dispatches after await
  },
}
```

**Writes are batched** — consecutive assignments in the same sync frame produce
one action. Each `await` boundary starts a new batch.

> ### Keep a method prompt — the one rule that decides UI feel
>
> A method body runs on the server's single dispatch path, so the time it spends
> is time **every** connected client's next action waits. Three cases:
>
> | The work is…                     | Do this                                                                       |
> | -------------------------------- | ----------------------------------------------------------------------------- |
> | fast (a few ms of state shaping) | just write it — this is the common case                                       |
> | I/O (fetch, file, DB)            | `async` + `await` — the runtime waits, your thread doesn't                    |
> | CPU-bound or a sync-only API     | `await schedule.blocking(id, fn, arg)` — a real worker thread                 |
> | every method here can be heavy   | `worker: true` on the cell — its own thread ([cell workers](cell-workers.md)) |
>
> Same idea for big arrays: `s.list.push(x)` emits one `add` patch, while
> `s.list = [...s.list, x]` re-ships the whole list on every commit
> ([delta](../persistence/delta.md#append-in-place-dont-replace)).
>
> `await` alone does **not** rescue CPU work: awaiting a function that computes
> for 200ms blocks the isolate for 200ms. In dev, aio holds a reduce to one
> frame (16ms) and tells you which action broke it. See
> [performance](../debugging/performance.md#move-it-off-thread).

> ### ⚠️ Every `await` is a commit + render point
>
> This is the one async-method behavior to internalize. When your method hits an
> `await`, aio **commits everything you've written so far** — it dispatches, the
> store updates, and the UI **re-renders** before the awaited promise resolves.
> That's what makes `s.loading = true; await fetch()` show a spinner _during_
> the fetch — genuinely useful, and deliberate.
>
> Two consequences to hold in your head:
>
> 1. **Partial state is visible mid-method.** Everything before an `await` is
>    live to the UI and to other cells while you're still awaiting. If three
>    fields must change together, write them all **in one frame** (no `await`
>    between them), or the UI can render a half-updated state.
> 2. **State is not frozen across an `await`.** Reads after an `await` return
>    the _current_ store (with your pending writes overlaid) — another action
>    may have landed while you were suspended. Don't assume `s.x` is unchanged
>    just because you didn't touch it; re-read it after the `await` if it
>    matters.
>
> Rule of thumb: **gather async results first, then do a contiguous block of
> writes at the end.** Every write lands (writes after any await commit fine —
> the framework guarantees this), but grouping them keeps the intermediate UI
> honest.

**Method-tagged actions** — async writes dispatch `__SetMethodName` actions
(e.g., `__SetCheckout`), so every batch in time-travel names the method that
produced it.

**Every read = fresh state + your pending writes** (read-your-writes). Reads
through `s` see the committed store with this method's unflushed writes
overlaid, so straight-line code behaves exactly like sync code:

```ts
async poll(s) {
  s.cpu = readCpu()
  s.history.push({ cpu: s.cpu })   // pushes the value set one line up
}
```

No stale copies after `await`, and no stale reads after your own writes — what
you read is exactly what commits.

### Nested writes and arrays

```ts
async updateProfile(s) {
  const profile = await fetchProfile()
  s.user.name = profile.name               // batched into one action
  s.user.settings.theme = profile.theme     // same batch
}

async loadItems(s) {
  const items = await fetchItems()
  s.items.push(...items)     // instrumented array methods work
  s.items.sort((a, b) => a.name.localeCompare(b.name))
}
```

Supported array mutators: `push`, `pop`, `shift`, `unshift`, `splice`, `sort`,
`reverse`, `fill`, `copyWithin`.

### Read patterns

The live proxy supports the read patterns you'd expect:

- **Direct property reads** — `s.user.name`, `s.items.length`
- **Spread on objects** — `{ ...s }` returns a plain object with fresh values
- **`Object.keys(s)` / `Object.entries(s)`** — returns plain key/value arrays
- **`JSON.stringify(s)`** — works (ownKeys + getOwnPropertyDescriptor give a
  plain snapshot)
- **Spread & iteration on arrays** — `[...s.items]`, `Array.from(s.items)`, and
  `for (const x of s.items)` all work; each element is the same live value as
  `s.items[i]` (a nested proxy for objects, so writes through it still batch).
- **Array read methods** — `s.items.map`, `.filter`, `.find`, `.findIndex`,
  `.some`, `.every`, `.reduce`, `.slice`, `.concat`, `.includes`, `.indexOf`,
  `.flat`, `.flatMap`, `.forEach`, `.entries`, `.keys`, `.values`, `.join`,
  `.toSorted`, `.toReversed`, `.toSpliced`. They see the **current** state plus
  your pending writes, fresh per call — re-read after an `await` and you get the
  new state.
- **Writing through an element** — every read method (`.find`, `.filter`,
  `.map`, `.forEach`, `.some`, `.every`, `.slice`, iteration, …) hands back the
  **live** element, so
  `s.items.filter((x) => x.done).forEach((it) => { it.q = 0 })` batches exactly
  like `s.items[i].q = 0` — the same as the sync (Immer draft) method. Only the
  stringifying methods (`.join`, `.toString`, `.toLocaleString`) run on a
  snapshot.

For anything that isn't covered (function-valued properties on the state,
unusual array methods), the live proxy throws:

```
[mycell:myMethod] doSomething() is not supported on live async state — snapshot first: const items = [...s.items]
```

The fix is to take a plain snapshot of what you need before calling the
unsupported op: `const items = [...s.items]`, `const config = { ...s.config }`,
then call the op on the snapshot.

### Pitfall: a captured reference does not survive overwriting its container

In a **sync** method, a captured reference keeps the old object — Immer draft
semantics:

```ts
respond(s, ok: boolean) {
  const req = s.pending   // the draft object
  s.pending = null
  use(req.sid)            // still the old sid — req IS the old object
}
```

In an **async** method `s` is a live **path view**: `req` above means "whatever
`s.pending` holds _now_". After `s.pending = null` that is null; after
`s.pending = other` it is the OTHER object. Both are silent wrong data, so the
proxy refuses instead — any use of a reference captured **before this method
overwrote its container** throws:

```
[cell:respond] stale reference: this value was captured from s.pending before the
method overwrote s.pending. …
```

The same applies to a captured array **element** after an index-moving mutator
(`sort`, `splice`, `shift`, `reverse`, …) — the path `s.items[0]` would suddenly
address a different element. (`push` never moves existing elements, so captured
elements stay valid.)

The fix is always the same — copy what you need **before** overwriting:

```ts
async respond(s, ok: boolean) {
  const sid = s.pending?.sid          // copy the primitive…
  // …or snapshot the object: const req = { ...s.pending }
  s.pending = null
  if (!sid) return
  const link = await import("./link.server.ts")
  link.answerApproval(sid, ok)
}
```

Fresh reads stay legal: `s.pending = {...}; s.pending.sid` re-fetches through
`s` and sees the new object — only references **held across** the overwrite trip
the check.

### Effects from async methods

`s.$do` works identically in async methods — and dispatches the effect
**immediately**, so a retry can be armed mid-method:

```ts
async fetchData(s) {
  try {
    s.data = await api.getData()
  } catch {
    s.retries += 1
    s.$do(schedule.after('fetch.retry', s.retries * 2000, self('fetchData')))
  }
}
```

The method's `return` stays a pure value channel: whatever it returns resolves
the caller's `await inventory.checkStock(...)`. (The deprecated return-an-effect
channel still works through beta, with a one-time hint; `aiol --safe-fix`
rewrites it.)

### Follow-up actions: don't reach for setTimeout

To trigger another action when a method finishes, **never** write
`setTimeout(() => cell.other(), 0)` — it escapes the action log, time-travel,
and cancellation. The sanctioned tools:

| You want…                           | Use                                                |
| ----------------------------------- | -------------------------------------------------- |
| "after this, dispatch X"            | `s.$do(schedule.next('id', self('other')))`        |
| a multi-step sequential workflow    | an [async method](#workflows-in-async-methods)     |
| debounce / retry / polling          | `schedule.after` / `schedule.every` (id = replace) |
| own a watcher / socket / subprocess | `s.$do(own.set('cell:id', factory))` (AIO-382)     |

### Owning native resources: `own.set` (AIO-382)

Methods are reducers — they have no place to keep a file watcher, socket, or
subprocess handle. Don't park disposers in module-scope variables; return an
`own.set` effect. It has the exact replace contract `schedule.after` has for
timers, extended to disposables:

```ts
import { cell, own } from "aio";
import { onChange, watchDir } from "./watcher.ts";

const workspace = cell("workspace", {
  state: { dir: "" },
  methods: {
    async setWorkspace(s, dir: string) {
      s.dir = dir;
      // Same id ⇒ the previous watcher's disposer runs first. All slots are
      // disposed on cell disable and on app shutdown — no manual teardown.
      s.$do(own.set("workspace:watcher", () => watchDir(dir, onChange)));
    },
    close(s) {
      s.$do(own.dispose("workspace:watcher"));
    },
  },
});
```

**Read `own.set` as "register, replacing and disposing anything already under
this key".** Re-using a key is not an error and not a no-op: the previous
resource's disposer runs first. That is what makes it safe to call on every
change — but if the disposer tears down something the new resource needs (one
app's `close()` stopped a server process, so re-registering after a crash
SIGTERMed the freshly started one), give each resource its own id. Dev warns,
once per key, when a `set` displaces a live resource.

**Getting a value back out of the factory** (a pid, a port, a handle the UI must
show): the factory's return value is the DISPOSER — it does not flow into state,
and it deliberately can't. An effect that wrote state directly would be a hole
in `(state, action) → (state, effects)`: the write would be invisible to the
reducer, untracked by patches, and unreplayable. The factory runs in the
runtime, so it calls a method with what it learned:

```ts
methods: {
  start(s: { pid: number | null }) {
    s.pid = null;
    s.$do(own.set("srv:proc", () => {
      const proc = spawnServer();
      srv.started(proc.pid); // ← a normal method call: tracked, patched, replayable
      return () => proc.kill();
    }));
  },
  started(s: { pid: number | null }, pid: number) {
    s.pid = pid;
  },
}
```

That keeps the handle in exactly one place (the `own` slot) and the _fact_ about
it in state, instead of splitting the two across a module-scope variable and an
effect.

The factory runs in the runtime (not in the reducer) and may return a disposer
function or a closeable object (`{ close() }` / `{ dispose() }`). The effect
itself is plain data — the factory travels out-of-band, so on time-travel replay
the runtime skips re-acquisition instead of resurrecting watchers. Prefix ids
with the cell name (`cell:resource`) — disable cleanup matches the cell name
itself and the `:` delimiter (`mycell` and `mycell:sock`, never `mycellOther`),
exactly like schedule ids.

**From a `worker: true` cell, `own` runs in the worker.** The factory is
executed, and its disposer is run, on the thread that owns the handle — which is
the only correct isolate: the factory closes over worker-local state, and a
subprocess or `Deno.dlopen` handle opened there cannot be closed from elsewhere.
Slots are disposed when the worker closes (app shutdown, or the cell being torn
down), right after its `onDestroy`.

Two consequences worth knowing:

- Ids are per-isolate. A worker cell's `own.set("dev:handle", …)` and a main
  cell's `own.set("dev:handle", …)` are **different slots** — they do not
  replace each other. Prefix with the cell name and this cannot bite.
- `schedule` effects still travel to the main isolate (the scheduler is one
  process-wide runtime); only `own` stays local.

(Before v1.0.0-alpha49 an `own` effect from a worker cell was posted to the main
isolate, where nothing handled it: the factory never ran, and nothing was
logged. If you have a worker cell that "never opened its device", this was why.)

### Error handling

> **Sync and async methods differ on `throw` — this is the one place they do.**
> A **sync** method is one Immer recipe: if it throws, the draft is discarded
> and **nothing it wrote is kept**. An **async** method commits incrementally,
> so everything it wrote — before _and_ after an `await` — is already state by
> the time it throws.
>
> ```ts
> refuse(s) {                       // SYNC
>   s.problems.push('too large')    // ← discarded by the throw below
>   throw new Error('too large')    // state: problems is still []
> }
>
> async refuse(s) {                 // ASYNC
>   s.problems.push('too large')    // ← kept
>   throw new Error('too large')    // state: problems has the entry
> }
> ```
>
> **So you cannot record why you refused _and_ throw from a sync method.** To
> tell a caller "no, and here is why", pick one:
>
> - **throw** — the caller's `await` rejects with your message. Use when the
>   caller can handle it. Nothing is written, which is usually what you want for
>   a guard.
> - **record and return** — write the reason to state and return normally. Use
>   when the reason belongs in the UI. Works in both forms.
> - **both** — make the method `async`; its writes survive the throw.

If an async method throws, mutations before the error are already dispatched.
The framework dispatches a `{Prefix}:__error` action (hidden from time-travel):

```ts
async riskyOp(s) {
  s.status = 'processing'    // dispatched
  await mightFail()          // throws!
  s.status = 'done'          // never reached
}
// Result: status is 'processing', error logged
```

Use try/catch for cleanup:

```ts
async riskyOp(s) {
  s.status = 'processing'
  try {
    await mightFail()
    s.status = 'done'
  } catch (e) {
    s.status = 'error'
    s.error = String(e)
  }
}
```

### How long may an async method run?

`effectTimeoutMs` (default `30000`, `0` = forever) is the ceiling, and it bounds
**both** sides of the same call: the framework stops tracking the effect, and
`await cell.method()` rejects.

For a method that is long-running **by nature**, say so on the cell:

```ts
cell("wallet", {
  long: ["refresh"], // ← checked against the method list at cell() time
  methods: { async refresh(s) {/* minutes; still cancellable */} },
});
```

`long:` is the spelling to reach for. The other one —
`perfBudget: { methods: { "wallet:refresh": { timeout: 300_000 } } }` — still
works and is the right tool for a specific NUMBER, but it is keyed by a string
in another file that no rename follows and nothing checks. `aiol` flags a
`perfBudget.methods[…].timeout` naming a local cell's method and names the
`long:` line that replaces it.

Neither side **cancels** anything — the method keeps running, and if it
finishes, its writes still commit. What you lose is the return value and the
framework's attention:

```
wallet:refresh: stopped waiting after 30000ms. The call gave up; the METHOD
did not — it may still be running, and if it finishes its writes will still
commit, without a return value reaching this caller.
```

That matters for what you do next: starting the work again on timeout can leave
two runs writing the same state. Either raise the ceiling for genuinely long
work, or make the method itself the guard (a `running` flag, `cancelOn` + a
`s.$signal` check) rather than treating the timeout as a cancellation.

If a method is routinely near the ceiling, it usually wants to be a job with a
progress field rather than a call somebody awaits.

---

## Workflows in async methods

Multi-step workflows are standard JavaScript: an async method plus three helpers
from `aio` — `until`, `race`, `sleep`.

| Helper               | Signature                                                     | Use                                                                                      |
| -------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `until(pred, opts?)` | `(() => boolean, { timeoutMs?, intervalMs?, msg?, signal? })` | Wait for a state condition — throws `UntilTimeoutError` (default 30s) instead of hanging |
| `race(branches)`     | `({ name: Promise \| ms }) → { winner, value }`               | First branch to settle wins; `timeout: ms` sugar adds a timeout branch                   |
| `sleep(ms)`          | `(ms) → Promise<void>`                                        | Plain observable pause                                                                   |

```ts
import { cell, race, until } from "aio";
import { api } from "./api.ts";

const checkout = cell("checkout", {
  state: { status: "idle", orderId: null as string | null, confirmed: false },
  methods: {
    async place(s, item: string) {
      s.status = "placing";
      const order = await api.placeOrder(item);
      const r = await race({ ok: until(() => s.confirmed), timeout: 30_000 });
      if (r.winner === "timeout") {
        s.status = "expired";
        return;
      }
      s.orderId = order.id;
      s.status = "placed";
    },
  },
});
```

Each `await` is a commit + render point (see above), so every step is visible in
the UI and in time-travel — no special workflow syntax needed.

### Patterns

**Retry with backoff** — either inline:

```ts
async fetchData(s, url: string) {
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      s.data = await fetch(url).then((r) => r.json());
      return;
    } catch {
      if (attempt === 3) { s.error = "failed after 4 attempts"; return; }
      await sleep(1000 * 2 ** attempt);
    }
  }
}
```

— or via the scheduler (survives across dispatches, replace-by-id):
[`schedule.backoff` / `schedule.poll`](scheduling.md).

**Polling** — don't `while (true)` inside a method; let the scheduler own the
loop and re-arm each tick:
[Backoff on rate-limit](scheduling.md#backoff-on-rate-limit-dynamic-polling).

**Wait for another cell** — watch state, not actions:

```ts
async settle(s) {
  await payment.charge(s.total);            // direct call, typed Promise
  await until(() => payment.chargeId !== null, { timeoutMs: 10_000 });
  s.status = "settled";
}
```

## Cancellation — `cancelOn` + `s.$signal`

Declare which foreign actions abort a running async method. The method observes
the abort through `s.$signal` (an `AbortSignal`) — annotate the draft with
`& Partial<MethodDraftMeta>` (from `aio`) to type it:

```ts
import { cell, type MethodDraftMeta } from "aio";
import { cart } from "./cell/cart/index.ts";

type CheckoutState = { status: string };
type Item = { id: string };
const url = "https://api.example.com/orders";

const checkout = cell("checkout", {
  state: { status: "idle" as string },
  cancelOn: { place: [cart.clear] }, // cart.clear aborts a running place()
  methods: {
    async place(s: CheckoutState & Partial<MethodDraftMeta>, item: Item) {
      s.status = "placing";
      const r = await fetch(url, { signal: s.$signal }); // abortable IO
      if (s.$signal!.aborted) {
        s.status = "cancelled";
        return;
      }
      s.status = "placed";
    },
  },
});
```

- `cancelOn: { methodKey: [triggers] }` — triggers are bound methods
  (`cart.clear`, preferred) or `.type` strings.
- `s.$signal` is always present at runtime in async methods; the annotation is
  `Partial` for TS variance reasons, so use `s.$signal?.aborted` or `!`.
- Pass it to every abortable API (`fetch`, `until({ signal })`) and check
  `aborted` after each `await` before writing terminal state.
- Naming a method that is missing or sync throws at `cell()` — a `cancelOn` that
  can never fire is a bug, not a no-op.

### `"self"` — newest wins

"A new navigation cancels the scan still running" is the most common async shape
in a browsing UI: search-as-you-type, folder scans, autocomplete, tile loads.
Write it as `"self"`:

```ts
const disk = cell("disk", {
  state: { path: null as string | null, entries: [] as string[] },
  cancelOn: { open: "self" }, // a new open() aborts the ones still running
  methods: {
    async open(s: DiskState & Partial<MethodDraftMeta>, path: string) {
      s.path = path;
      const entries = await scanFolders(path, s.$signal);
      if (s.$signal!.aborted) return; // superseded — drop the stale results
      s.entries = entries;
    },
  },
});
```

`"self"` can only ever abort calls that are **already running**, never the one
that triggers it: triggers fire while the action reduces, and the incoming call
is tracked one step later. Mix it with other triggers freely —
`cancelOn: { open: ["self", nav.leave] }`.

It also expresses what a self-reference cannot: inside a `cell()` literal the
cell's own bound methods do not exist yet, so `cancelOn: { open: [disk.open] }`
is unwritable.

## Long-running server work

Minutes-long work — a filesystem scan, a build, an import — is a normal method,
not a special construct. Four things make it behave:

| Need                   | Do this                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Raise the ceiling      | `long: ["open"]` on the cell (checked against its methods; see above)                 |
| A cancel path          | `cancelOn` (`"self"` for supersession, a `stop` method for an explicit cancel button) |
| A "still working" sign | Write a state field before the first `await` — clients see it on the next commit      |
| Don't clobber          | After every `await`, check `s.$signal!.aborted` **before** writing terminal state     |

The last row is the one that bites. A method that resumes after an `await` is
writing into state that other calls and other actions have moved on from, so a
late write from a superseded run can overwrite a fresh one. `cancelOn` +
`$signal` is the framework's answer; a `if (s.path !== path) return;` path guard
is the same idea written by hand, and is worth adding on top when the identity
of the work (which folder, which query) is what decides staleness.

Cancellation is cooperative — pass `s.$signal` into the work itself so it
actually stops. Subprocesses take it directly:

```ts
// disk.server.ts — a Deno-only module, dynamically imported by the method
export async function scanFolders(path: string, signal?: AbortSignal) {
  const cmd = new Deno.Command("du", { args: ["-sk", path], signal });
  const { stdout } = await cmd.output(); // signal kills the child process
  return parse(new TextDecoder().decode(stdout));
}
```

See [`examples/disk`](../../examples/disk/) for the whole shape — subprocesses
from a cell, supersession, cancel, and the `.server.ts` boundary — and
[imports](../build/imports.md) for why the Deno-only half lives in its own file.

For the desktop pattern "reveal in file manager" / "open in browser", don't
re-derive the per-OS launcher — `openExternal(target)` from `aio/server` covers
files, folders and URLs (`open`/`start`/`xdg-open`), and rejects loudly when the
desktop refuses. The other direction — "let the user CHOOSE a path" — is
`pickFile()` / `pickDirectory()`, and a child process you can stream, pause and
cancel as a tree is `spawn()`. Both are on `aio/server`; see
[desktop jobs](../clients/desktop-jobs.md).

## Guard lines — machine states without a machine

A status guard is one line of plain code, with the same guarantee the old
`machine:` config gave:

```ts
methods: {
  start(s) {
    if (s.status !== "idle") return;   // ignored in any other state
    s.status = "running";
  },
},
```

`status` is a state field you own — render it directly (`{cell.status}`), assert
it in tests with `t.expect.state((s) => s.status === "running")`.

---

## Selectors

Derived values from cell state:

```ts
const cart = cell("cart", {
  state: { items: [] as { price: number; qty: number }[] },
  methods: {/* ... */},
  selectors: {
    total: (s) => s.items.reduce((sum, i) => sum + i.price * i.qty, 0),
    itemCount: (s) => s.items.length,
    isEmpty: (s) => s.items.length === 0,
  },
});

// After aio.run():
const total = cart.total();
const empty = cart.isEmpty();
```

Selectors are scoped to the cell's state slice automatically. After `aio.run()`
binds the cell, selectors read current state implicitly.

### Keyed map with default

Map-shaped state (`Record<string, T>`) returns `undefined` for keys that haven't
been populated yet, so direct reads need a guard at every call site:

```tsx
<span>{balances.sol[pubKey] ?? 0}</span>; // ?? 0 sprinkled at every read
```

Declare the guarded read once as a plain accessor function next to the cell —
each call reads the reactive getter, so it stays auto-tracked in JSX:

```ts
export const sol = (pubKey: string) => balances.sol[pubKey] ?? 0;
```

```tsx
<span>{sol(item.pubKey)}</span>; // one guard, every read safe
```

---

## Direct calling

After `aio.run()`, methods and selectors are callable directly:

```ts
await aio.run({ cells: [counter] });

await counter.increment(5); // Promise resolves once the dispatch is applied
// (browser: resolves on server ack — state read on the next line is fresh)
counter.reset(); // dispatches counter:reset
counter.isPositive(); // reads state → true
counter.increment.type; // → 'counter:increment'
```

Before `aio.run()`, calling a method does **not** dispatch. In development it
throws immediately with
`[counter] increment() called before aio.run() — add
this cell to aio.run({ cells: [...] })`;
in production it logs the same message once and resolves with `void`. The
intent: surface "I clicked and nothing happened, no error anywhere" as an
immediate failure.

To get the raw action object pre-binding (composition, tests, time-travel), use
the internal catalog: `counter.__aio.actions.increment(5)` returns
`{ type: "counter:increment", payload: { args: [5] } }`.

---

## Common Pitfalls

### State in sync methods is a standard Immer draft

The `s` parameter is an Immer draft. Plain JavaScript reads, spreads,
`.map`/`.filter`, `Object.keys`, and `JSON.stringify` all work — they read the
current state of the draft, just like a plain object. The only thing to watch is
that **values you take out of the method** (return values, effect payloads,
`JSON.stringify` results) are snapshots; the live draft stays in the method
body.

```ts
methods: {
  toggle(s) {
    s.done = !s.done;                          // mutation — tracked by Immer
    const count = s.items.length;               // read — works
    const filtered = s.items.filter((x) => x.active); // read — works
    const copy = { ...s, updatedAt: Date.now() };     // read + extend — works
    return { count, filtered, copy };            // values out are snapshots
  },
}
```

**One thing to know:** `JSON.stringify(s)` works for reading, but the result is
a string snapshot at that moment. If you need an object snapshot to pass to a
reducer, use `structuredClone(s)` — Immer drafts aren't structured- cloneable,
so this throws; use the `[...s.items]` / `{...s}` patterns above for cloning.

### Spreading state back into itself works — in sync AND async methods

```ts
async build(s, onProgress) {
  await run("cmake", ["--build", "."], (p) => {
    s.job = { ...s.job, step: p.step };   // ✅ works, same as in a sync method
  });
}
```

In an async method `s` is a _live proxy_ (reads stay correct across awaits), and
spreading it copies nested objects as proxies — historically the store refused
that write. Recorded values are now materialized to plain data at write time, so
the idiom behaves identically to the sync Immer-draft path. The sync/async
equivalence is pinned by a randomized differential test
(`tests/proxy-differential.test.ts`).

Writing the fields directly needs no copy at all and is usually clearer:

```ts
s.job.step = p.step;
s.job.log.push(p.line);
```

### Mutations on returned snapshots are ignored

If you do:

```ts
methods: {
  leak(s) {
    const snap = { ...s };
    snap.x = 99; // no-op — snap is a fresh plain object, not tracked
    return snap;
  },
}
```

The mutation to `snap` is harmless (no state change) because `snap` is a fresh
plain object. aio dispatches the return value as-is, and the caller gets a plain
object with `x: 99` that has no reactive effect. The draft itself was not
mutated; if you wanted to mutate the draft, do it before spreading.

### Effects and state references

Sync methods can return schedule effects. Effect payloads can reference state
values directly — aio clones effects inside `produce()` before Immer revokes the
draft, so state references in effects work transparently:

```ts
methods: {
  snapshot(s) {
    return { type: "backup:save", payload: { items: s.items } } // ✅ works
  },
}
```

If an effect contains non-cloneable values (functions, symbols, circular refs),
aio logs a warning and keeps the original. Stick to plain serializable objects
in effect payloads for best results.

### Async batching and time-travel

Each `await` in an async method creates a new state snapshot:

```ts
async checkout(s) {
  s.status = "validating"  // snapshot 1: { status: "validating" }
  await validate()
  s.status = "charging"    // snapshot 2: { status: "charging" }
  await charge()
  s.status = "done"        // snapshot 3: { status: "done" }
}
```

Time-travel will show 3 separate entries: `__setCheckout` for each batch. This
is by design — each await returns control to the event loop, so the framework
captures state at each boundary.

---

## Generated actions

| Source             | Action type              | Time-travel |
| ------------------ | ------------------------ | ----------- |
| `increment(s, by)` | `counter:increment`      | Yes         |
| `async save(s)`    | `counter:save` (trigger) | Yes         |
| (async write)      | `counter:__setSave`      | Hidden      |
| (async error)      | `counter:__error`        | Hidden      |

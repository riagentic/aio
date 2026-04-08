# Generators API — GenCtx Reference

All methods are called with `yield*` (delegating yield) unless noted otherwise.

---

## `ctx.call(name, fn, opts?)`

Executes `fn`, dispatches a named action, returns the result.

```ts
const user = yield *
  ctx.call("loadUser", () => fetch(`/api/users/${id}`).then((r) => r.json()));
const hash = yield * ctx.call("computeHash", () => md5(data)); // sync works too

// With timeout
const data = yield * ctx.call("fetch", () => fetchData(), { timeout: 5000 });

// With retries (retries on throw, then gives up)
const result = yield * ctx.call("submit", () => submitOrder(), { retries: 3 });

// Both — 3 attempts, each with a 5s timeout
const res = yield *
  ctx.call("upload", () => upload(file), { timeout: 5000, retries: 2 });
```

Internally: dispatches `{cell}:__flow:{name}` → calls `fn()` → returns result.
If `fn` throws after all retries, dispatches `{cell}:__flow:error`.

---

## `ctx.mutate(name, fn)`

Updates cell state via Immer draft. Dispatches a named action.

```ts
yield * ctx.mutate("updateBalance", (s) => {
  s.balance += amount;
  s.lastUpdated = Date.now();
});
```

Applied immediately — subsequent calls see updated state. State is typed
automatically when generators are inside `cell()`.

---

## `ctx.done(fn?)`

Terminal success. Dispatches `{cell}:__flow:done`. Optional final mutation.

```ts
yield * ctx.done((s) => {
  s.status = "complete";
  s.completedAt = Date.now();
});
yield * ctx.done(); // without mutation
```

---

## `ctx.fail(reason)`

Terminal failure. Dispatches `{cell}:__flow:failed`. Stops the generator.

```ts
if (!valid) {
  yield * ctx.fail("validation failed");
  return; // for TypeScript — generator is already stopped
}
```

---

## `ctx.dispatch(action)`

Dispatches a regular action into the system. Fire-and-forget.

```ts
yield * ctx.dispatch(checkout.reset());
yield * ctx.dispatch(wallet.credit(100)); // cross-cell
yield * ctx.dispatch(checkout.start("widget")); // own cell
```

---

## `ctx.send(creatorOrType, payload?)`

Shorthand dispatch. Accepts bound method or type string:

```ts
yield * ctx.send(analytics.log, { msg: "order placed" }); // bound method
yield * ctx.send("analytics:log", { msg: "order placed" }); // type string
```

---

## `ctx.all(...generators)`

Parallel execution. Returns results as array or named object.

```ts
// Spread form
const [user, orders, prefs] = yield * ctx.all(
  ctx.call("loadUser", () => fetchUser(id)),
  ctx.call("loadOrders", () => fetchOrders(id)),
  ctx.call("loadPrefs", () => fetchPrefs(id)),
);

// Named form
const { user, orders } = yield * ctx.all({
  user: ctx.call("loadUser", () => fetchUser(id)),
  orders: ctx.call("loadOrders", () => fetchOrders(id)),
});
```

If any call throws, the flow errors. **Limitation:** only accepts single-step
generators (`ctx.call`, `ctx.sleep`).

---

## `ctx.race(entries)`

First to resolve wins. Result has only the winner's key.

```ts
const result = yield * ctx.race({
  data: ctx.call("fetch", () => fetchData(id)),
  timeout: ctx.sleep("timeout", 5000),
});
if (result.timeout !== undefined) {
  yield * ctx.fail("timed out");
  return;
}
yield * ctx.done((s) => {
  s.data = result.data;
});
```

Same single-step limitation as `ctx.all()`.

**Alternative:** `Promise.all` inside a single `ctx.call` when you don't need
per-call time-travel visibility.

---

## `ctx.getState()`

Returns current cell state. Always fresh. **Not a generator — call directly.**

```ts
yield * ctx.mutate("increment", (s) => {
  s.count++;
});
const s = ctx.getState();
if (s.count >= 10) {
  yield * ctx.done();
  return;
}
```

---

## `ctx.getFullState()`

Returns the full composed state tree (all cells). **Not a generator.**

```ts
const full = ctx.getFullState();
const auth = full.auth as { __aio_status: string; user: string | null };
if (auth.__aio_status !== "authenticated") {
  yield * ctx.fail("not authenticated");
  return;
}
```

Read-only — cross-cell mutation goes through `dispatch`.

---

## `ctx.when(predicate, opts?)`

Pauses until a state condition is true. Checks immediately first.

```ts
yield *
  ctx.when((s) =>
    (s.app as { __aio_status: string }).__aio_status === "running"
  );

// With timeout
try {
  yield * ctx.when(
    (s) =>
      (s.auth as { __aio_status: string }).__aio_status === "authenticated",
    { timeout: 10_000 },
  );
} catch {
  yield * ctx.fail("auth timeout");
  return;
}
```

**vs `waitFor`:** `waitFor` waits for a specific **action**. `when` waits for a
**state condition**, regardless of which action caused it:

```ts
// Fragile — breaks if a new auth path is added
yield *
  ctx.race({
    a: ctx.waitFor(auth.logout),
    b: ctx.waitFor(auth.sessionExpired),
  });

// Robust — doesn't care how the state was reached
yield *
  ctx.when((s) =>
    (s.auth as { __aio_status: string }).__aio_status === "guest"
  );
```

Works inside `ctx.race`. If predicate throws, treated as `false`.

---

## `ctx.waitFor(actionType, timeout?)`

Pauses until a matching action is dispatched. Returns the full action object.

```ts
const msg = yield * ctx.waitFor(payment.complete); // bound method — preferred
const { orderId } = msg.payload as { orderId: string };

// With timeout
try {
  const msg = yield * ctx.waitFor(payment.complete, 30_000);
  yield * ctx.done((s) => {
    s.orderId = (msg.payload as { orderId: string }).orderId;
  });
} catch {
  yield * ctx.fail("payment timeout");
}

// String form — when you only have the type string
const confirm = yield * ctx.waitFor("checkout:confirm");
```

---

## `ctx.sleep(name, ms)`

Observable pause. Dispatches a named action for time-travel visibility.

```ts
yield * ctx.sleep("cooldown", 3000);

// Retry with delay
for (let i = 0; i < 3; i++) {
  try {
    const result = yield * ctx.call("attempt", () => riskyFetch());
    yield * ctx.done((s) => {
      s.result = result;
    });
    return;
  } catch {
    if (i < 2) yield * ctx.sleep("retryDelay", 1000 * (i + 1));
  }
}
yield * ctx.fail("max retries exceeded");
```

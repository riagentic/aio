# Which Approach?

Pick the simplest style that fits your needs. You can always graduate later.

## Decision Tree

```
Start here
  │
  ├─ Do you need multi-step async with ordering guarantees?
  │    YES → Generators (L2)
  │    NO  ↓
  │
  ├─ Do you need time-travel debugging or action replay?
  │    YES → Actions/Reduce (L3)
  │    NO  ↓
  │
  └─ Methods (L1) — covers everything else
```

## Comparison

|                    | Methods (L1)                 | Generators (L2)           | Actions/Reduce (L3)                     |
| ------------------ | ---------------------------- | ------------------------- | --------------------------------------- |
| **Mental model**   | Call functions, mutate state | Write sequential steps    | Dispatch messages, pure reduce          |
| **Async**          | `async method()`             | `yield* ctx.call()`       | `execute()` handler                     |
| **Side effects**   | Inside async methods         | Inside `ctx.call()` steps | Separate `execute()`                    |
| **State mutation** | Direct (Immer proxy)         | `yield* ctx.mutate()`     | Inside `reduce()` (Immer)               |
| **State machines** | Optional `machine:`          | Optional `machine:`       | Optional `machine:`                     |
| **Testability**    | Good — `testCell`            | Great — step-by-step      | Great — pure reduce                     |
| **Time-travel**    | Automatic snapshots          | Automatic snapshots       | Full action replay                      |
| **Boilerplate**    | Minimal                      | Low                       | Higher (actions + reduce + execute)     |
| **When to use**    | Most cells                   | Multi-step workflows      | Audit trails, replay, strict separation |

## Examples

### Methods — Simple CRUD

```ts
const todos = cell("todos", {
  state: { items: [] as Todo[] },
  methods: {
    add(s, text: string) {
      s.items.push({ text, done: false });
    },
    toggle(s, i: number) {
      s.items[i].done = !s.items[i].done;
    },
    async sync(s) {
      await fetch("/api/sync", {
        method: "POST",
        body: JSON.stringify(s.items),
      });
    },
  },
});
```

### Generators — Sequential Checkout

```ts
const checkout = cell("checkout", {
  state: { step: "cart", orderId: "" },
  actions: { start: () => ({}) },
  generators: {
    *start(ctx) {
      yield* ctx.mutate("validate", (s) => {
        s.step = "validating";
      });
      const order = yield* ctx.call("create", () => api.createOrder());
      yield* ctx.mutate("confirm", (s) => {
        s.step = "confirmed";
        s.orderId = order.id;
      });
      yield* ctx.done();
    },
  },
});
```

### Actions/Reduce — Auditable Counter

```ts
const counter = cell("counter", {
  state: { count: 0 },
  actions: { increment: (by = 1) => ({ by }), save: () => ({}) },
  effects: { persist: (value: number) => ({ value }) },
  reduce: {
    increment(s, { by }) {
      s.count += by;
    },
  },
  execute: {
    async persist(app, { value }) {
      await db.save("counter", value);
    },
  },
});
```

## Graduating Between Styles

**Methods → Generators:** When you find yourself chaining multiple async methods
with ordering concerns, extract the flow into a generator. Methods and
generators coexist in the same cell.

**Methods → Actions/Reduce:** Rare. Reach for this when you need to replay
actions (debugging, audit logs) or enforce strict pure/impure separation.
Consider whether generators solve the same problem with less boilerplate.

## See Also

- [Methods](methods.md) — full L1 reference
- [Generators](generators.md) — full L2 reference
- [Actions & Reduce](actions-reduce.md) — full L3 reference
- [State Management](README.md) — tier overview

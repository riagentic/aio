# Cell Config Simplification — Design Spec

## Goal

Reduce cognitive load for new aio users without merging categories that have different semantics. One dead feature cut, documentation restructured into progressive tiers.

## Decision: No Merges (Except One Cut)

We evaluated merging 7 categories into their parents. Findings:

- **selectors → methods**: Immer conflict (returns replace state), performance regression (dispatch pipeline vs direct call), type inference breaks. **Not worth it.**
- **validate → methods**: Different return type (`true | string` vs `void | ScheduleEffect[]`), reserved name magic. **Fake simplification.**
- **onInit/onDestroy → methods**: Different signature (`ScopedApp` vs state), loses `getFullState()` capability. **Capability loss.**
- **cancelOn → generators.cancel**: Muddies generators type (mixed map of functions + config object). **Not worth one key.**
- **listensTo → machine.listensTo**: Same problem — muddies clean machine config for one key. **Not worth it.**

**Conclusion:** Merging trades visible simplicity for hidden complexity. The real problem is what devs see first, not the total key count.

## Change 1: Cut `dispatchTo`

Remove entirely. 3 test uses, bypassed by direct method calls, nobody uses it.

- Delete from `MethodsCellConfig` type
- Delete from `ActionsCellConfig` type
- Delete from `CellAio.crossDispatchPrefixes`
- Delete from cell-create.ts processing logic
- Delete from cell-compose.ts dependency resolution
- Remove from tests
- Remove from docs

**16 categories remain:** state, methods, selectors, actions, effects, reduce, execute, generators, cancelOn, machine, listensTo, persist, sync, validate, onInit, onDestroy.

## Change 2: Documentation Tiers

Restructure docs so developers encounter categories progressively. The tiers are guidelines for documentation ordering, not rigid barriers.

### L1 — Every App (90% of needs)

| Category | What | One-liner |
|----------|------|-----------|
| state | `{ items: [], total: 0 }` | Your data shape |
| methods | `addItem(s, item) { s.items.push(item) }` | Read and mutate state |
| selectors | `total: (s) => s.a + s.b` | Derived values |
| persist | `{ exclude: ['cache'] }` | Save to disk |

Quickstart, tutorials, and getting-started docs use ONLY these 4 categories. No references to L2/L3 concepts.

### L2 — Complex Apps (99% of needs)

| Category | What | One-liner |
|----------|------|-----------|
| generators | `*checkout(ctx) { yield* ctx.call(...) }` | Sequential async workflows |
| machine | `{ initial: "idle", states: { ... } }` | State machine transitions |
| cancelOn | `{ checkout: [cart.clear] }` | Cancel running generators |
| validate | `(s) => s.age >= 0 \|\| "invalid"` | Post-mutation guardrail |
| onInit | `(app) => { ... }` | Startup lifecycle |
| onDestroy | `(app) => { ... }` | Cleanup lifecycle |

Each L2 doc page opens with: "You probably don't need this. Here's when you do: [specific scenario]."

### L3 — Explicit Pipeline (Power Users)

| Category | What | One-liner |
|----------|------|-----------|
| actions | `addItem: (item) => ({ item })` | Typed event creators |
| reduce | `addItem(state, { item }) { ... }` | Pure state handlers |
| effects | `notify: (msg) => ({ msg })` | Side-effect event creators |
| execute | `notify(app, { msg }) { ... }` | Side-effect runners |
| listensTo | `[inventory.reserve]` | Foreign action subscriptions |
| sync | `{ merge: { items: "lww" } }` | CRDT peer synchronization |

L3 docs explain: "Methods do everything actions+reduce+execute+effects do, in one place. Use L3 when you need time-travel debugging, action replay, or strict pure/impure separation."

## Doc Structure Changes

```
docs/basics/quickstart.md        <- L1 only
docs/state/methods.md            <- L1
docs/state/selectors.md          <- L1 (new: extracted from features.md)
docs/state/generators.md         <- L2 gateway: "when methods aren't enough"
docs/state/machines.md           <- L2
docs/state/lifecycle.md          <- L2 (onInit, onDestroy, validate)
docs/state/actions-reduce.md     <- L3 gateway: "the explicit pipeline"
```

Each tier's landing content starts with what it adds and WHY you'd want it.

## What This Does NOT Change

- No API changes (except dispatchTo removal)
- No type changes (except dispatchTo removal)
- No runtime behavior changes
- No new concepts or abstractions
- All 16 remaining categories work exactly as before

## Migration

- `dispatchTo` users: remove the key. If you relied on the dispatch guard, use TypeScript's type system or code review instead.
- Docs: restructure existing content into tiers. No content deleted, just reordered.

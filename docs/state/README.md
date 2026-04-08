# State Management

Defining cells, managing state, and coordinating workflows.

**Not sure which style to use?** See [Which Approach?](which-approach.md) for a
decision tree.

## L1 — Every App

Start here. Covers 90% of what you need.

- [Cells](cells.md) — cell() anatomy and config reference
- [Methods](methods.md) — sync/async methods, selectors, Immer

## L2 — Complex Apps

Add when you need sequential workflows, state machines, or lifecycle hooks.

- [Generators](generators.md) — sequential async workflows
- [Generators API](generators-api.md) — GenCtx method reference
- [State Machines](machines.md) — guards and transitions
- [Lifecycle](lifecycle.md) — onInit, onDestroy, validate
- [Composition](composition.md) — cross-cell communication
- [Scheduling](scheduling.md) — timers, intervals, cron

## L3 — Advanced: Explicit Pipeline

> Most apps never need this tier. Methods + generators cover the same ground
> with less boilerplate. Reach for L3 only when you need action replay, audit
> trails, or strict pure/impure separation for compliance reasons.

- [Actions & Reduce](actions-reduce.md) — explicit action/reduce/execute/effects
  style

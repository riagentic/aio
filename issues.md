# aio Framework Issues

## ISSUE-1: `init` and `destroy` are reserved action names in actions-style features

**Found**: 2026-03-18

**What**: `feature()` with actions-style config that defines an `init` action collides with aio's internal lifecycle. The `rootReduce` in `feature-compose.ts:268` intercepts `${prefix}:init` as a lifecycle action — initializes state but **skips the feature's reducer entirely**. Effects returned from reduce for `init` never fire.

**Fixed in aio**: Lifecycle actions renamed to `${prefix}:__init` / `${prefix}:__destroy` in `feature-create.ts`. User code can now safely use `init` as an action name.

**Impact was**: Bybit exchange feature's `init` effect never fired → `initBybitAuth()` never called → `waitForAuth()` hung forever → all 189 fleet members stuck in warmup.

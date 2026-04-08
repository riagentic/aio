# Upgrade from v1.0.0-alpha3 to v1.0.0-alpha4

> **Note:** `feature()` was renamed to `cell()` in alpha11. See
> [upgrade guide](from-alpha10-to-alpha11.md).

### Breaking changes

**`effectTimeout` behavior change — warn → hard-cancel**

```ts
// BEFORE (alpha3): timed-out effects logged a warning but continued running
// The effect could still resolve/reject after timeout — double-report possible

// AFTER (alpha4): timed-out effects are abandoned
// The framework considers the effect failed after timeout
// Late rejections are suppressed (no double-report)
// Timed-out effects count toward circuit breaker threshold
```

If you rely on effects completing after timeout (e.g., fire-and-forget with a
generous timeout), this is a behavior change. Effects that exceed
`effectTimeoutMs` are now killed and counted as failures.

### Non-breaking additions

- **Vital signs** — three probes (loop, render, transport) + hint engine for
  detecting and diagnosing UI freezes. Enabled by default. Kill switch:
  `vitals: false`. See [vitals.md](vitals.md)
- **DiagReporter** — structured console diagnostics with `onDiagnostic` hook for
  telemetry. See [diagnostics.md](diagnostics.md)
- **PressureMonitor** — payload size and broadcast rate warnings. Kill switch:
  `vitals: { pressure: false }`
- **Subscription stability (AIO-3/4)** — `useAio()` no longer re-subscribes on
  every render. 300ms grace period prevents teardown during page switches
- **Diagnostic bus & health overlay** — unified event channel for 18
  previously-silent failure points, visible via green/yellow/red dot overlay
- **Flow cross-feature access** — `ctx.getFullState()` and `ctx.when(predicate)`
  in generators. See [generators.md](generators.md)
- **Reduce phase breakdown** — `PerfMetric.breakdown` field with phase timing
- **Graph validator** — validates feature dependency graph at startup
- **`structuredClone` dispatch fix** — reports `EFFECT_ERROR` instead of
  silently continuing with revoked Immer drafts

### Upgrade steps

1. Update `deno.json`: `"aio": "jsr:@riagentic/aio@1.0.0-alpha4"`
2. Review any code that depends on effects completing after timeout — they are
   now hard-cancelled
3. Vitals and diagnostics are on by default — add `vitals: false` to `aio.run()`
   if you need to disable them
4. Run `deno install && deno task dev`

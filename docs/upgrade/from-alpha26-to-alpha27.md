# Upgrade: 1.0.0-alpha26 → 1.0.0-alpha27

alpha27 is the start of the restructure — **the largest breaking change in aio's
history**: `cell({ state, methods })` is the ONE style; the redux-era
`actions:`/`reduce:`/`execute:`/`machine:`/`generators:` layer and middleware
are gone, and multiple apps can share one process.

The complete recipes live in
**[The aio restructure (alpha27+)](restructure.md)** (sections B1 and B2) —
every removed key has a before → after there, and `deno task lint` (aiol)
statically detects removed config keys in your app and prints the per-cell
migration mapping.

Quick orientation:

| you have                | you write now                                           |
| ----------------------- | ------------------------------------------------------- |
| `actions:` + `reduce:`  | one method: `increment(s, by) { s.count += by }`        |
| `execute:` effects      | do the work inside an async method                      |
| `machine:` guards       | a guard line: `if (s.status !== "idle") return;`        |
| `generators:` workflows | plain async methods + `until()` / `race()` / `sleep()`  |
| generator cancellation  | `cancelOn: { method: [triggers] }` + `s.$signal`        |
| middleware              | built-ins (logger, vitals, storm detector, cell checks) |

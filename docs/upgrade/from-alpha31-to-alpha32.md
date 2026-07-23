# Upgrade: 1.0.0-alpha31 → 1.0.0-alpha32

A feature release — the headline is **aui**, a visual app manager (new example),
plus a few transparent framework fixes. **Most apps upgrade with no code
changes.** No wire-protocol change: alpha31 and alpha32 interoperate.

## New: aui, the aio app manager

A visual manager for every aio app on your machine — the GUI counterpart to the
`am` CLI. Discover apps (running or on disk), inspect each (cells, live state,
metrics, config, errors, schedules), browse its source tree, run its tasks, and
start/stop/restart it. It's an example, so nothing in your app changes — try it:

```sh
cd amui && deno task dev
```

See [`docs/clients/amui.md`](../../docs/clients/amui.md).

## Framework changes (no action needed)

- **New trojan `cells` route.** The localhost control plane now exposes each
  cell's public method names (internal `__set*`/`__error`/`__effects` keys
  filtered out) so a manager UI can list and invoke methods. Additive.
- **The phantom ~64KB "KV limit" is gone.** aio has been SQLite-only for a
  while, but a stale KV-era size guard survived and could degrade or refuse
  large cell state. Removed at the source — large cell state (hundreds of KB+)
  now persists without complaint. If you worked around the old limit by
  splitting state across cells, you no longer need to (but nothing forces you to
  change).
- **Shutdown now resets cell state cleanly.** `close()` still rejects late
  client input before the final persist, but framework teardown (a
  System-sourced `:__destroy`, dispatched afterward from `onStop`) is lifecycle,
  not input, so it's no longer dropped. This removes a spurious
  `dispatch after close() —
  '<cell>:__destroy' ignored` warning some apps saw
  on every shutdown, and guarantees cell state is reset on stop.
- **Electron `deno task dev` just works.** The shell auto-installs the runtime
  on first run. The generated `main.cjs` now installs a main-process crash
  guard: an uncaught exception is logged to stderr and the app exits clean
  instead of popping the intrusive native "A JavaScript error occurred" dialog.

## Do I need to change anything?

No. There are no removed exports, renamed config, or wire changes. Bump the
dependency and you're done.

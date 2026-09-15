# Upgrading from 1.0.1-beta to 1.0.2-beta

**Nothing breaks.** Additive fixes and clearer tooling — there is no migration
step to perform.

```sh
am pin --latest
```

1.0.2-beta tightens the test harness so it matches the real window, names the
`CellState` / `type`-alias rule at the cause, makes Electron honour a changed
`ui.width`/`ui.height`, and steers agents toward **check → run → test**. The
full account is `CHANGELOG.md`.

## What you may notice

| behaviour                                                                     | what to do if you hit it                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `testUI` no longer submits a form when Enter's keydown was `preventDefault`'d | expected — matches the browser; remove a test that relied on the old harness |
| aiol ERROR on `state: {…} as SomeInterface`                                   | `type SomeState = {…}` instead of `interface`                                |
| window opens at the new `ui.width`/`ui.height` after you changed them         | expected; delete `window-state.json` only if you also want a fresh position  |
| `FORCE_COLOR=0` leaves logs uncoloured                                        | expected                                                                     |

## Retire

| workaround                                                                                                  | fixed in                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| deleting `window-state.json` on every launch so `ui.width` would apply                                      | 1.0.2-beta                                                                               |
| rewriting a scaffold `tests/cell.test.ts` before the app had ever run, only to keep `deno task check` green | 1.0.2-beta (delete or rewrite the starter when you replace the cell; check → run → test) |
| casting an `interface` state through `as Record<string, unknown>` so `deno check` would pass                | 1.0.2-beta (`type` alias + named `CellState`)                                            |

## Testing lanes (additive)

Nothing required of apps. Maintainers: `deno task test:fast` (edit loop) and
`deno task test:seam` (harness≠wire / hunter seeds) — see
`docs/testing/lanes.md`. Full `deno task test` remains the release gate.

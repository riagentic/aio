# Upgrade: alpha42 → alpha43

**No code changes required.** Nothing was removed, no option was renamed, and
every API is additive. Most of this release is bugs that were losing or
corrupting data without saying so — you get those by upgrading.

Two things are worth a deliberate decision, and one test-harness change may make
an existing test fail loudly where it used to pass quietly. Read those three.

## Decide: turn on integrity checking

New, off by default:

```ts
await aio.run({ checkIntegrityOnBoot: true });
```

On boot the app database is scanned (`PRAGMA quick_check`). A sound file costs
one cheap scan and says nothing. A damaged one is **quarantined** — renamed
beside itself with a timestamp, never deleted — and if a `<db>.snapshot` sits
next to it the app boots on that instead, reporting exactly what the restore
lost. With no snapshot it starts **empty** and says so, rather than booting on a
file SQLite cannot read.

Take the snapshots it restores from:

```ts
await app.db.snapshot(`${dir}/state.db.snapshot`); // VACUUM INTO — safe while live
```

Turn it on if your app holds data a user would miss. Leave it off for a cache.

## Decide: build for other operating systems

`deno task build` gained a platform axis beside the target axis:

```sh
deno task build --platforms=host,windows,macos-arm64
```

```jsonc
"build": { "targets": ["server"], "platforms": ["host", "windows"] }
```

The default is unchanged — just this machine — so an existing build behaves
exactly as before, and the host artifact keeps its plain name. Cross-built
artifacts are labelled (`myapp-windows.exe`) and recorded in
`dist/manifest.json` with their triple. `server`, `browser`, `cli` and
`cli-client` cross-compile; Electron and Android package with per-OS tooling and
are refused with a reason rather than silently producing a host binary under a
foreign name.

A cross-built binary is built and checked here, not run here. Smoke-test it on
the target OS before shipping.

## Heads-up: your tests may now fail where they used to pass

The harness got stricter in three ways. Each one turns a silent hole into a
visible failure, so a test that starts failing was covering less than it looked.

**A failure nobody awaited now surfaces.** `t.send.thing()` without an `await`,
where `thing()` throws, used to pass. It now raises at the next `t.settle()` —
or at the end of the test if `settle()` is never called. Observe it and the
harness stays quiet:

```ts
await assertRejects(() => t.send.thing(), Error, "…"); // handled here
await t.settle(); // …so this does not raise it again
```

**A sync method's throw now REJECTS instead of throwing.** Production always
rejected; the harness threw synchronously, which forced `assertThrows` in tests
covering code that uses `assertRejects`. Swap them:

```ts
// before
assertThrows(() => t.send.create({ name: "" }));
// after
await assertRejects(
  () => t.send.create({ name: "" }),
  Error,
  "name is required",
);
```

**`expectCell` on a cell that is not booted now fails.** It used to read the
cell's declared initial state and pass — a green assertion against nothing. If
this fires, the cell was missing from the mount: import it, or pass it in
`{ cells: [...] }`.

Related, and in your favour: a `testCell` no longer empties the cell registry,
so a `testUI` later in the same file boots its cells as it should. Some tests
that needed an explicit `{ cells }` workaround no longer do.

## Also in this release, no action needed

- **Sync correctness.** A dispatch failure no longer acks and broadcasts an op
  the server never applied; an ack can no longer double-apply an op a snapshot
  already contained; a client with a cursor but no HLC watermark is no longer
  told it is caught up after a compaction removed ops it never saw. `sync-ack`
  gained an optional `serverTs` and `sync_meta` a `compacted_ts` column — both
  applied automatically, both backwards compatible with an older peer.
- **Persistence.** State that JSON cannot round-trip (`undefined`, `NaN`,
  `Date`, `Map`, `Set`) is reported at write time, with the exact path, instead
  of coming back wrong on the next boot. Store epoch-ms or `.toISOString()`.
- **`db.close()`** no longer terminates the worker under writes queued behind
  the writer lock.
- **Auth.** The per-account lockout can no longer be outrun by sending guesses
  concurrently; TOTP codes are one-time-use; `/totp/setup` refuses while TOTP is
  enabled; `password` and `totp/disable` respect the per-IP budget; a session
  token no longer authenticates from `?token=` on ordinary HTTP requests (the
  share link, the CLI and the `/ws` handshake are unaffected).
- **Renderer.** An `ErrorBoundary` or `Suspense` with siblings after it keeps
  its position when it swaps content; `useEffect` (compat) survives a re-render
  with unchanged deps; `<Transition>` no longer re-animates on every render;
  `useDimensions` follows a replaced element.
- **Scheduler.** A repeating schedule survives a failed tick instead of
  cancelling itself — the failure handler had never actually been reachable.
- **`cancelOn: { method: "self" }`** — newest-wins supersession for
  search-as-you-type, folder scans and autocomplete, without hand-rolling a
  guard.

## New examples

- `examples/contacts` — end-to-end CRUD: a SQLite-backed list, validation,
  create/edit/delete, no transport code.
- `examples/disk` — subprocesses and the filesystem from a cell, with cancel and
  supersession across the `.server.ts` boundary.

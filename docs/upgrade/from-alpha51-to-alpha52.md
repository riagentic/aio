# Upgrade: alpha51 → alpha52

**The last-call release.** Every approved break from the API audit lands here,
in one version — and **every old spelling keeps working through beta**:
deprecated, with a loud one-time hint at the old spelling, and a mechanical
rewrite where one is possible (`aiol --safe-fix` for code, `am fix` /
`am fix --migrate-tasks` for config and tasks). Run:

```sh
deno run -A jsr:@riagentic/aio/aiol --safe-fix   # code rewrites
am fix                                           # config repair (add-only)
```

The sections: methods & effects (1–7), visibility & auth (8–10), the public
surface (11–12), the one vocabulary for config/CLI/tasks (13), and behavior
changes that need no action (14).

## 1. Effects move off the return channel: `s.$do(effect, ...)`

`return` is for **values**; effects go through the draft's `$do` member — so a
method can finally do both in one call:

```ts
// before                                        // after
arm(s) {                                         arm(s) {
  return schedule.after("t", 1000, A.tick());      s.$do(schedule.after("t", 1000, self("tick")));
}                                                }
```

- Works in sync AND async methods. Async `$do` dispatches **immediately** — an
  `own.set` factory registers in the same tick.
- An unannotated `s` carries `$do` contextually; a hand-annotated one intersects
  `MethodDraftServed` (exported from `"aio"`):
  `tick(s: State & MethodDraftServed)`. The safe-fix does this for you, prunes
  the now-orphaned effect type import, and drops the dead `return;` at tail
  position — its output passes `deno check` AND `deno lint` (pinned by
  regression tests that run both gates).
- Payloads may reference `s` freely (snapshotted to plain data at capture — they
  used to be dropped at the structuredClone seam).
- **Deprecated, works through beta:** returning schedule/own effects. One-time
  hint per method; `aiol --safe-fix` rewrites the provable cases.

## 2. `self(method, ...args)` — self-referencing actions without TS7022

`self("tick")` builds an action descriptor the dispatching cell resolves to its
own method — no cell self-reference, so the `: CellEffect` return annotation
(and the TS7022 dance) is unnecessary. Unknown method names throw at `cell()`
when statically present (`cancelOn: { search: [self("clear")] }`), else at
dispatch. `CellEffect` stays exported for old code.

## 3. `transaction: true` is the async default ← the big one

Async methods now run at **snapshot isolation with atomic commit** (the alpha44
`transaction: true` semantics): reads pinned at entry, writes buffered and
committed all-or-nothing at return, conflicts detected, a throw or cancellation
discards the write-set.

- **Spinner idiom:** `s.busy = true; s.$commit();` (mid-method publish).
- **Live waits:** `await until(() => s.$live.ready)` — a pinned `s` read never
  changes across awaits.
- **Opt out** with `transaction: false` — live reads + incremental commits,
  byte-identical to alpha51. Streaming methods (chunk loops ended by
  `s.$signal`) usually want this.
- **Migration:** `aiol` reports every async cell with no `transaction` key;
  `--safe-fix` inserts `transaction: false,` — behaviour-preserving. Cells
  already using `$commit`/`$live`/`$do` are not flagged.

## 4. Reserved state keys

State keys starting with `$` (the `$signal`/`$commit`/`$live`/`$do`
meta-namespace) and the reserved names `state`/`fx`/`__aio` now throw at
`cell()`. Dead `A`/`E` are no longer reserved.

## 5. `listensTo` array form dies (deprecated)

The array form routes an action without running any code — almost never what was
meant. The object form is the form, and its values now accept **arrays of
sources**:

```ts
listensTo: {
  onChange: [a.set, b.remove];
}
```

Array form keeps working through beta with a one-time hint; `aiol` reports every
site.

## 6. Selector deps arrive as a tuple

```ts
// before                                  // after — parameterized + deps compose
{ deps: ["prices"], fn: (s, prices) => }   { deps: ["prices"], fn: (s, [prices], id) => }
```

Old spread signature detected by shape, served through beta with a one-time
hint; `aiol --safe-fix` wraps untyped dep params into the tuple.

## 7. Schedule fixes

- `schedule.backoff(id, attempt, action, opts)` /
  `schedule.poll(id, attempt,
  action, opts)` — the action is the 3rd argument,
  like after/every. The old `(opts, action)` order is detected by shape and
  accepted with a hint.
- `poll`'s `backoff` option key → `factor` (old key accepted + hint;
  `--safe-fix` renames it).
- `blocking` is also exported **top-level** from `"aio"` (`schedule.blocking`
  stays — same function).
- `skipIfRunning` is typed on the `every` form only (it never did anything
  elsewhere).
- `schedule.next` arms a true **0 ms** timer (`schedule.after` accepts 0 now;
  the 1 ms sentinel is gone).

## 8. Cell `ui:` → `visible:`

`access` gates calls, **`visible`** gates reads — the read-side key now says so:

```ts
// before                       // after
ui: {
  exclude: ["secret"];
}
visible: {
  exclude: ["secret"];
}
cellDefaults: {
  ui: "none";
}
cellDefaults: {
  visible: "none";
}
```

`ui:` keeps working through beta with a one-time hint (both set = hard error);
`aiol --safe-fix` renames the key in cell literals and `cellDefaults`. App-level
`aio.run({ ui: {...} })` (window config) is a DIFFERENT key and is unchanged.
`cellDefaults.visible` now takes the full `CellVisibility` vocabulary —
`forUser`/`publicFields` are settable as app-wide defaults.

## 9. Exposed apps get a key by default

`--expose` with no per-user auth (`users`/`resolveUser`/`auth`) and no `key`
decision now behaves as `key: true`: a generated shared key, persisted 0600,
carried by the share link (pair devices by PIN). Loopback apps are untouched.
`key: false` is the explicit opt-out (stays OPEN, with a loud boot warning) —
`aiol --safe-fix` inserts it for an app that relied on being open.

## 10. `access` without `visible` refuses to boot when it matters

On an **exposed or multi-user** app, a cell that declares `access` (the CALL
side) but no `visible` (the READ side) now refuses to boot — with no `visible`,
the whole cell broadcasts to every connected client, contradicting the author's
own restriction. One-word acknowledgement: `visible: "all"`. Loopback
single-user apps keep the warning. `aiol` reports it pre-boot.

## 11. Entry diet

- **`aio/db` is types + pure helpers.** The runtime values — `createDB`,
  `DEFAULT_PRAGMAS`, `initSchema`, `loadTables`, `syncTables`, `reactiveDB` —
  live on **`aio/server`**; the `aio/db` re-exports are deprecated through beta
  (`aiol --safe-fix` rewrites the imports now, the graph split lands at
  beta-end).
- **`aio/schedule` and `aio/selectors` are DELETED.** `schedule`, `ScheduleDef`,
  `ScheduleEffect`, `createSelector`, `Selector` live on `aio`;
  `isScheduleEffect` and `createSliceSelector` on `aio/extras`.
  `aiol --safe-fix` re-routes the imports per symbol.
- **`@internal` sweep**: `aio/sync` keeps the config/observation surface
  (`SyncConfig`, `MergeStrategy`, `SyncStatus`, `SyncStats`, `SyncConflict`,
  `HLC`, `compareHLC`, `SYNC_DEFAULTS`); `aio/state-core` keeps the
  custom-transport set (`getStateSignal`, `getCellSignal`, `send`,
  `setTransport`, `Transport`, `ready`, `handleMessage`). Engine internals stay
  importable but are `@internal` — off the snapshot, free to move.
- **Removed** (deprecated for multiple alphas, each fails loud):
  `call({ timeout })` → `timeoutMs` (call() throws on the old key; `--safe-fix`
  renames), and `useCell` → direct cell access (`counter.count`; `--safe-fix`
  rewrites the mechanical `useCell(c).state.x` form).

## 12. Renames (aliases kept through beta)

| old                             | new          |
| ------------------------------- | ------------ |
| extras `lint`                   | `checkCells` |
| air `Action` (the `use` prop)   | `NodeAction` |
| testing `testgen`               | `testGen`    |
| `ExtractState`                  | `StateOf`    |
| `CellAccess` / `ServerFnAccess` | one `Access` |

Also: `AioUser` opens (`& Record<string, unknown>` — your `resolveUser` fields
are readable without casts), `visible.forUser`'s `user` param is
`AioUser | undefined`, cell `scope` accepts an explicit `"server"`, and
`aio.run<S>(...)` is an optional typed overload (`app.state` typed; untyped
calls keep the `any` default). One edge: a config closure that references the
resulting `app` variable (`routes: { "/x": route(() => app.…) }`) may now need
an explicit return-type annotation on the helper it calls — overload resolution
reads the argument types, so TS asks you to break the circle (TS7022/7023 names
the exact spot).

## 13. One vocabulary: config, CLI, tasks

The headless role is spelled **`server`** everywhere, and "target" means only
the build axis:

- **deno.json `target` → `client`.** Same value, renamed so it can't be confused
  with `build.targets` (two meanings of "target" in one file). The old key still
  resolves with a one-time boot hint; `client` wins when both are present.
  `am fix` rewrites it.
- **`am create --target=service` → `--target=server`.** The old value is
  accepted with a hint and scaffolds a server app.
- **The task diet.** The scaffold's 30-task `dev:*`/`compile:*` matrix is
  replaced by one of each: `dev` (flags pass through —
  `deno task dev --client=electron`, `--expose`), `build` (every target in
  deno.json `build.targets` → dist/), `compile` (build narrowed to the default
  target). Existing apps keep working untouched; **`am fix --migrate-tasks`**
  (opt-in — it deletes tasks) converts a pristine old-scaffold task set to the
  new one, renames `service` → `server` in kept tasks, and NEVER touches a task
  you customized (reported instead).
- **Bare `--server-url` → `--connect`** (a flag that read like it needed a value
  and did something else without one). The old spelling still works with a
  warning; the VALUED form `--server-url=<url>` keeps its name.

## 14. Behavior changes that need no action

- **`PRAGMA user_version` is yours again.** aio once stamped it on open,
  silently defeating the standard app-side "have I migrated" idiom. aio now
  reads and writes `user_version` NOWHERE — its own schema era lives in a
  private `aio_schema` table (legacy files are upgraded and stamped on boot,
  once).
- **Big-data guardrails.** A cell over ~1 MB warns once per cell at persist
  (naming the right tier — see `docs/persistence/big-data.md`); over ~16 MB it
  errors on every flush — and the data is still persisted (loud + written beats
  quiet + lost). Full-state broadcast frames over ~1 MB warn once, naming the
  cell(s).
- **`app.blobs` — the binary tier.** A content-addressed byte store
  (`put`/`stream`/`info`/`url`/`remove`) under the app's data dir; bytes never
  enter cell state or the wire — clients fetch `/__aio/blobs/<id>` over HTTP
  (Range-capable, immutably cacheable), behind the app's auth gate. Store the
  `id` in state, not the bytes.

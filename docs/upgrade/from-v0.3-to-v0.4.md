# Upgrade from v0.3 to v0.4

### New features

- **Zero-config HTTPS** — `--expose` now auto-generates a self-signed ECDSA
  P-256 cert (cached in `.aio-tls/`). Traffic is encrypted by default. Use
  `--cert=path.pem --key=path.pem` to bring your own CA-signed cert. Electron
  windows accept self-signed localhost certs automatically
- **`am watch [dir]`** — hot-restart on `.ts`/`.tsx` changes in `src/` (or
  custom dir). 300ms debounce, same as `am restart`. Usage: `deno task am watch`
  or `deno task am watch src/`
- **`am logs --follow` / `-f`** — stream log output live (like `tail -f`).
  Usage: `deno task am logs -f` or `deno task am logs --follow [filter]`
- **`am status` exit codes** — now explicit: `0`=started, `1`=stopped,
  `2`=transitional (starting/stopping). Useful for scripts and CI
- **`persistMode:'multi'`** — store each top-level state key as a separate
  Deno.Kv entry, bypassing the 65KB/key limit. Set `persistMode: 'multi'` in
  config
- **ORM additions** — `table.whereOr(filters[])` for OR-joined WHERE,
  `table.upsert(row)` for INSERT OR REPLACE, `QueryOpts` with `orderBy`,
  `limit`, `offset` on `all(opts?)` and `where(filter, opts?)`

### Bug fixes

- **`_computeDelta` threshold** — fixed denominator to
  `Math.max(newKeys, oldKeys)` — previously undercounted when state keys were
  removed, causing unnecessary full-state broadcasts
- **`scheduleReload` symlink** — resolves real path via `Deno.realPathSync`
  before cache lookup — fixes hot-reload on macOS (`/var` → `/private/var`
  symlink)
- **`syncTables` full scan** — eliminated `SELECT * FROM table` on every sync
  cycle; now diffs state vs previous in memory. Zero DB reads per sync

### Breaking changes

None. All v0.3 code runs unchanged on v0.4.

### Upgrade steps

1. Replace `dep/aio/` with the v0.4 folder
2. Run `deno install`
3. Run `deno task dev` — no changes required

### Optional improvements

```sh
# Hot-restart on file changes
deno task am watch

# Stream logs live
deno task am logs -f

# Check if app is running (exit code 0=yes, 1=no, 2=transitional)
deno task am status; echo $?
```

```ts
// Bypass 65KB KV limit for large state
await aio.run(state, {
  reduce,
  execute,
  persistMode: "multi",
});
```

```ts
// ORM: OR queries, upsert, pagination
const adults = table.whereOr([{ role: "admin" }, { role: "mod" }]);
table.upsert({ id: 1, name: "alice" });
const page = table.all({ orderBy: "name", limit: 20, offset: 40 });
```

```sh
# Expose with auto-HTTPS (zero config)
deno task dev --expose

# Expose with your own cert
deno task dev --expose --cert=/etc/ssl/myapp.pem --key=/etc/ssl/myapp.key
```

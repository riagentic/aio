# Upgrade from v1.0.0-alpha1 to v1.0.0-alpha2

> **Note:** `feature()` was renamed to `cell()` in alpha11. See
> [upgrade guide](from-alpha10-to-alpha11.md).

### Breaking changes

**Config renames — all field names updated**

```ts
// BEFORE (alpha1)
await aio.run({
  persistDebounce: 500,
  effectTimeout: 30_000,
  deltaThreshold: 256,
  perfMode: "strict",
  singleton: "takeover",
  ui: { electron: false, keepAlive: true, transport: "uds", syncRate: 50 },
  headless: true,
});

// AFTER (alpha2)
await aio.run({
  persistDebounceMs: 500,
  effectTimeoutMs: 30_000,
  fullStateThreshold: 256,
  perfCheck: "on",
  singleton: true,
  killExisting: true,
  client: "browser",
  keepServer: true,
  transport: "uds",
  syncIntervalMs: 50,
});
```

**CLI flag changes**

```sh
# BEFORE (alpha1)
deno task dev --no-electron
deno task dev --headless
deno task dev --keep-alive
deno task dev --url=http://server:8000

# AFTER (alpha2)
deno task dev --client=browser
deno task dev --client=server-only
deno task dev --keep-server
deno task dev --server-url=http://server:8000
```

**Behavior changes (errors instead of silent fallbacks)**

- Electron not installed + `client: 'electron'` → throws error (was: silent
  browser fallback)
- TLS cert fails + `--expose` → throws error (was: silent HTTP fallback)
- KV open fails + `persist: true` → throws error (was: silent no-persistence)
- `$HOME` missing + persistence → throws error (was: /tmp fallback)

**`appVersion` now mandatory**

```ts
// BEFORE — optional, defaulted to '0.1.0 (default)'
await aio.run({ features: [...] })

// AFTER — required
await aio.run({ appVersion: '1.0.0', features: [...] })
```

### Upgrade steps

1. Rename config keys: `persistDebounce` → `persistDebounceMs`, `effectTimeout`
   → `effectTimeoutMs`, `deltaThreshold` → `fullStateThreshold`, `perfMode` →
   `perfCheck`
2. Replace `perfMode: 'strict'` → `perfCheck: 'on'`, `perfMode: 'soft'` →
   `perfCheck: 'off'`
3. Move `ui.electron`, `ui.keepAlive`, `ui.transport` out of `ui:{}` to
   top-level `client`, `keepServer`, `transport`
4. Move `ui.syncRate` → top-level `syncIntervalMs`
5. Replace `singleton: 'takeover'` → `singleton: true, killExisting: true`
6. Replace `--no-electron` → `--client=browser`, `--headless` →
   `--client=server-only`
7. Replace `--keep-alive` → `--keep-server`, `--url=` → `--server-url=`
8. Add `appVersion: '<your version>'` to `aio.run()` config

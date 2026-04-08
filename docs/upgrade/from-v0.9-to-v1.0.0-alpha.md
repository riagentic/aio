# Upgrade from v0.9 to v1.0.0-alpha

> **Note:** `feature()` was renamed to `cell()` in alpha11. See
> [upgrade guide](from-alpha10-to-alpha11.md).

### Breaking changes

**`appId` mandatory in `aio.run()`**

`appId` is no longer read from `deno.json` — it must be passed directly.
Compiled builds don't have `deno.json` at runtime.

```ts
// BEFORE (v0.9) — appId read from deno.json
await aio.run({ features: [counter] });

// AFTER (v1.0) — appId required in code
await aio.run({ appId: "my-app", features: [counter] });
```

The linter (`aiol`) now warns if `appId` is in `deno.json` (with auto-fix to
remove it) and errors if missing from `aio.run()`.

**`dispatch()` returns Promise**

All bound feature methods now return `Promise<void>` (sync) or `Promise<T>`
(async). Resolves after reduce + sync effects complete. Fire-and-forget calls
work unchanged — the returned Promise is simply ignored.

```ts
// BEFORE (v0.9) — fire-and-forget only
counter.increment(5);

// AFTER (v1.0) — returns Promise, await if needed
await counter.increment(5); // resolves after reduce + sync
counter.increment(5); // still works fire-and-forget (backward compatible)
```

### New in v1.0.0-alpha

**Browser import DX — three-layer defense**

- esbuild plugin intercepts `@std/*` and `node:*` in prod builds — returns
  throwing proxy modules with clear error messages
- Dynamic import map: npm packages in `deno.json` automatically aliased for
  browser via esm.sh
- `aiol` lint: 4 new checks — server-only imports in feature files, bare
  specifier validation, transitive detection (2 levels), static dynamic import
  detection
- No breaking change — only affects code paths that were already broken in
  browsers

**Reliable live reload**

- UDS wiring, event filter, health monitor, CSS selector, cache normalization,
  diagnostics

### Upgrade steps

1. Update `deno.json` — replace `"aio": "jsr:@riagentic/aio@^0.9"` with
   `"aio": "jsr:@riagentic/aio@1.0.0-alpha3"` (and same for task commands
   referencing `@^0.9`)
2. Add `appId` to your `aio.run()` call:
   `aio.run({ appId: 'my-app', features: [...] })`
3. Remove `appId` / `title` from `deno.json` if present (linter will flag it)
4. Run `aiol` to check for browser-unsafe imports:
   `deno run -A jsr:@riagentic/aio@1.0.0-alpha3/aiol`
5. Run `deno install && deno task dev`

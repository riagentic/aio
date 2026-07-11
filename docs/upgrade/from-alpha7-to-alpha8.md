# Upgrade from v1.0.0-alpha7 to v1.0.0-alpha8

### Breaking changes

None. This release is fully backward compatible with alpha7.

### Non-breaking additions

- **Dynamic user resolution (`resolveUser`)** — async hook for JWT, OAuth, or
  database-backed auth. Add `resolveUser` to your `aio.run()` config for dynamic
  auth instead of static `users` map. See [auth.md](../auth/auth.md)
- **`ResolveUserFn` type** — exported from `mod.ts` for typed resolver
  definitions
- **Patch compaction** — broadcast protocol compacts redundant patches, reducing
  wire overhead
- **Broadcast size guard** — oversized patches auto-fallback to full-state
- **58 bug fixes** across 23 files from 13-round nuclear audit (AIO-57..236)

### Upgrade steps

1. Update `deno.json`: `"aio": "jsr:@riagentic/aio@1.0.0-alpha8"`
2. Update task commands:
   `"am": "deno run -A jsr:@riagentic/aio@1.0.0-alpha8/src/am"`
3. If you use static `users` auth and want to migrate to dynamic auth, add
   `resolveUser` to your config (see [auth.md](../auth/auth.md)). Static `users`
   still works unchanged.
4. Run `deno install && deno task dev`

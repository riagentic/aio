# Upgrading from alpha12 to alpha13

## Breaking: None

alpha13 is a hardening release — no breaking changes. All alpha12 code works
unchanged. Bump the version in `deno.json` and you're done.

```diff
-    "aio": "jsr:@riagentic/aio@^1.0.0-alpha12",
+    "aio": "jsr:@riagentic/aio@^1.0.0-alpha13",
```

## What changed

### Nuclear audit waves 6-11 (64+ fixes)

Bugs fixed across sync protocol, CRDT, security, SVG rendering, file watcher,
logger, signals, rate limiter, and op buffer. No API changes.

### Key fixes

- **Sync cursor** now advances correctly (was stuck processing same ops)
- **Concurrent HLC drop** fixed (was dropping ops on concurrent tick)
- **SVG namespace** handled correctly by AIR renderer
- **Signal listener leak** — effect cleanup properly disposes listeners
- **Op buffer TTL eviction** respects per-op TTL now

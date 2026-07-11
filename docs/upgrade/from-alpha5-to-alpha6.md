# Upgrade from v1.0.0-alpha5 to v1.0.0-alpha6

### Breaking changes

None. This release is fully backward compatible with alpha5.

### Non-breaking additions

- **AIR native renderer (~8KB)** — signal-based VDOM engine with JSX, keyed
  reconciliation, auto-memo, SSR/hydration, lifecycle, context, portals,
  suspense, forms (`useForm`), animation (`useSpring`, `useTransition`), virtual
  scrolling (`useVirtualList`), devtools. See [renderer.md](../ui/README.md)
- **Adapter architecture** — `state-core.ts` as framework-agnostic foundation.
  React and AIR adapters are thin consumers. New export paths: `aio/state-core`,
  `aio/adapters/react`, `aio/adapters/air`, `aio/jsx-runtime`. See
  [api.md](../basics/api-reference.md)
- **Delta protocol hardening (AIO-26..34)** — Electron replay fix, UDS
  per-client subscriptions, `$f` filtered merge protocol, `unflattenPatch`
  empty→identity array fix, periodic resync every ~5s, update-after-send,
  ref-equality removal. See [changelog.md](../../CHANGELOG.md)

### Upgrade steps

1. Update `deno.json`: `"aio": "jsr:@riagentic/aio@1.0.0-alpha6"`
2. Update task commands:
   `"am": "deno run -A jsr:@riagentic/aio@1.0.0-alpha6/src/am"`
3. To use AIR renderer instead of React: set `jsxImportSource` to
   `@riagentic/aio` in `compilerOptions` and import from `aio/adapters/air`.
   React apps need no changes — existing imports continue to work.
4. Run `deno install && deno task dev`

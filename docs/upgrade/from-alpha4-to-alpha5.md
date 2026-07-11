# Upgrade from v1.0.0-alpha4 to v1.0.0-alpha5

### Breaking changes

None. This release is fully backward compatible with alpha4.

### Non-breaking additions

- **Identity-keyed array delta compression (AIO-12)** — arrays with `id` fields
  are sent as per-element patches (`$arr`/`$id:`/`$rm` wire format). Typical
  savings: 120KB → 7.5KB for 160-element arrays. Automatic — no code changes
  needed. See [traffic.md](../build/scaling.md)
- **4-layer wasted render prevention (AIO-11)** — `useProjection(fn, deps)` for
  derived state with structural sharing, `memo(Component)` with per-prop
  `_shallowEqual`, `aiol` lint rule, runtime dev warning. See
  [ui.md](../ui/README.md)
- **Deep proxy-tracked subscriptions** — `useAio()` auto-tracks accessed state
  paths; server filters broadcasts to only include paths the client reads
- **UDS ghost socket elimination (AIO-24/25)** — no more ghost sockets after
  client disconnect. IPC keepalive ping every 60s for passive viewing. See
  [electron.md](../clients/electron.md)
- **10 framework reliability fixes (AIO-14..23)** — dispatch, flow, server, and
  electron edge cases
- **JSR 100% documentation score** — JSDoc on all public exports, all
  transitively-referenced types re-exported

### Upgrade steps

1. Update `deno.json`: `"aio": "jsr:@riagentic/aio@1.0.0-alpha5"`
2. Update task commands:
   `"am": "deno run -A jsr:@riagentic/aio@1.0.0-alpha5/src/am"`
3. Consider adopting `useProjection()` + `memo()` for list-heavy UIs —
   significant render reduction. See [ui.md](../ui/README.md)
4. Run `deno install && deno task dev`

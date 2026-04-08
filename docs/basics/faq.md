# FAQ

Common questions about what aio does, doesn't do, and why.

---

### When NOT to use aio

aio is designed for **state-centric tools** — dashboards, trading desks, control
panels, internal tools, local-first apps. If your project needs something
fundamentally different, use the right tool:

| If you need...                               | Use instead                           |
| -------------------------------------------- | ------------------------------------- |
| Server-side rendering (SSR)                  | Fresh, Next.js, Astro                 |
| Server components / streaming HTML           | Next.js, Remix                        |
| Native mobile performance                    | React Native, Flutter                 |
| Multi-region distributed state               | ElectricSQL, CRDTs, custom clustering |
| Static site generation                       | Astro, Hugo, 11ty                     |
| High-traffic public APIs (millions of req/s) | Hono, Fastify, bare Deno.serve        |
| Complex form-heavy CRUD apps                 | Rails, Django, Laravel                |

**aio is great when:** state is the product, every client sees the same thing in
real-time, and you want one codebase for server + desktop + CLI + browser.

**aio is wrong when:** you need SEO/SSR, horizontal scaling across regions, or
your app is primarily request/response with no shared state.

---

### Why no nested machine substates (like XState)?

aio machines guard top-level status transitions:
`{ idle: { start: 'running' } }`. For substates, use state fields:

```ts
{ status: 'running', paused: true }
```

The machine enforces that `pause` can only fire when `status === 'running'`. The
`paused` boolean is just state — no special machinery needed. For complex
sequential workflows with branching, use [generators](../state/generators.md).

Building hierarchical statecharts (entry/exit actions, history states, parallel
regions) would mean building a worse XState inside aio. If you genuinely need
statecharts, use XState for that cell's internal logic and expose results
through an aio cell.

---

### Why no `ctx.retry()` or `ctx.withTimeout()`?

`ctx.call()` already accepts `{ timeout?, retries? }`:

```ts
yield * ctx.call("submit", () => submitOrder(), { timeout: 5000, retries: 2 });
```

For custom timeout behavior, use `ctx.race` + `ctx.sleep`:

```ts
const result = yield * ctx.race({
  data: ctx.call("fetch", () => fetchData()),
  timeout: ctx.sleep("timeout", 5000),
});
if (result.timeout !== undefined) yield * ctx.fail("timed out");
```

No extra API surface needed.

---

### Why no streaming / chunked payloads?

aio state is a single JSON object broadcast to all clients via WebSocket.
Pushing 50MB through that pipe would destroy every connected browser tab.

Large data processing is a **side effect**, not state. Process it server-side in
methods or generators, then update state with the result:

```ts
*importFile(ctx, path: string) {
  yield* ctx.mutate('start', s => { s.importing = true })
  const count = yield* ctx.call('process', () => processLargeFile(path))
  yield* ctx.done(s => { s.importing = false; s.rowCount = count })
}
```

For actual file upload/download, use direct HTTP endpoints alongside aio. The
state channel is for state — heavy I/O happens outside it.

---

### Why AIR and React — what about Vue / Svelte / Solid?

aio ships two renderers: **AIR** (built-in, signal-based, ~8KB) and a **React
adapter**. AIR is the recommended default for new projects — zero dependencies,
automatic memoization, built-in forms/animation/SSR. The React adapter exists
for teams with existing React codebases or React-specific library dependencies.

The core is framework-agnostic. `client` gives you direct access to state,
actions, and routing — wire it into Svelte, Vue, Solid, or anything else in ~20
lines. See [../ui.md](../ui.md#bring-your-own-framework) for examples.

The `client` API is stable and supported — custom adapters built on it are your
responsibility. See [../renderer.md](../renderer.md) for the full comparison.

---

### Why no built-in form validation hook?

Validation is state mutation — errors need to be in state so the UI can render
them. Methods handle this naturally:

```ts
methods: {
  submit(s) {
    const errors: Record<string, string> = {}
    if (!s.email) errors.email = 'required'
    if (Object.keys(errors).length) { s.errors = errors; return }
    s.errors = {}
    s.submitting = true
  }
}
```

No `cell({ validate })` needed — it would just be another place to look. See
[../howto.md](../howto.md#pattern-form-state-with-validation) for the full
pattern.

---

### Why no multi-server / horizontal scaling?

aio's core contract is one state object, one process, serialized mutations,
broadcast to all clients. That's what makes it simple — no consensus, no
conflict resolution, no eventual consistency.

Adding a pub/sub adapter between instances would require conflict resolution
(CRDTs? last-write-wins?), state merge logic, distributed machine guards, and
cross-instance generator coordination. That's a fundamentally different product.

**What actually scales:** aio handles thousands of WebSocket connections on a
single server. For multi-tenant apps, partition by workspace — each instance
owns its own state, a reverse proxy routes by tenant ID. No shared state adapter
needed.

If you need multi-server shared state, look at Phoenix LiveView, Elixir
clustering, or a custom CRDT layer. See [../scaling.md](../scaling.md) for
capacity guidance.

---

### Why no Deno Deploy / cloud hosting?

aio is a stateful server — it holds state in memory, persists to SQLite, and
broadcasts via WebSocket. Deno Deploy is a stateless edge runtime with no
persistent filesystem, no SQLite, and no long-lived WebSocket connections.
They're architecturally incompatible.

**How to deploy aio:** `deno compile` produces a single binary. Copy it to any
VPS (DigitalOcean, Hetzner, Fly.io with persistent volumes), run it. One file,
one process. See [../builds.md](../builds.md) for all compile targets.

---

### Why not support Node.js / Bun?

Deno is the value proposition, not an implementation detail. `deno compile`
(single binary), `Deno.Kv` (zero-config persistence), `deno task dev` (no build
toolchain), JSR publishing — these are why aio can be "all in one." A Node port
would mean maintaining two persistence backends, two server APIs, and losing
single-binary compilation entirely. The result would be a worse aio.

If your team requires Node, aio isn't the right fit — use Next.js, Express +
Zustand, or Convex.

---

### Why aren't generator step names validated?

Step names in `ctx.call('fetchPrice', fn)` are debug labels for time-travel
visibility. They show up as `checkout:__flow:fetchPrice` in the action log.
Enforcing naming rules (lint, template literal types) would add friction to the
fast path for a cosmetic concern. Name them descriptively — your future self
will thank you.

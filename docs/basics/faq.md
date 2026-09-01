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

### Why no state machines (like XState)?

v2 removed the `machine:` config — a status guard is one line of plain code:

```ts
{ status: 'running', paused: true }

methods: {
  pause(s) {
    if (s.status !== 'running') return  // the whole guard
    s.paused = true
  },
}
```

`status` and `paused` are just state — no special machinery needed. See
[guard lines](../state/methods.md#guard-lines--machine-states-without-a-machine).

Building hierarchical statecharts (entry/exit actions, history states, parallel
regions) would mean building a worse XState inside aio. If you genuinely need
statecharts, use XState for that cell's internal logic and expose results
through an aio cell.

---

### Why no `retry()` or `withTimeout()` helpers?

`call()` already accepts `{ timeoutMs?, retries? }`:

```ts
import { call } from "aio";
import { submitOrder } from "./api.ts";

const r = await call({ timeoutMs: 5000, retries: 2 }, () => submitOrder());
```

For custom timeout behavior, use `race` (its `timeout: ms` sugar is built in):

```ts
import { race } from "aio";
import { fetchData } from "./api.ts";

const result = await race({ data: fetchData(), timeout: 5000 });
if (result.winner === "timeout") console.log("timed out"); // e.g. set s.status
```

No extra API surface needed.

---

### Why no streaming / chunked payloads?

aio state is a single JSON object broadcast to all clients via WebSocket.
Pushing 50MB through that pipe would destroy every connected browser tab.

Large data processing is a **side effect**, not state. Process it server-side in
an async method, then update state with the result:

```ts
async importFile(s, path: string) {
  s.importing = true
  const count = await processLargeFile(path)
  s.importing = false
  s.rowCount = count
}
```

For actual file upload/download, use direct HTTP endpoints alongside aio. The
state channel is for state — heavy I/O happens outside it.

---

### Why only AIR — what about Vue / Svelte / Solid?

aio ships **AIR** — a built-in, signal-based renderer (60 KB gzipped with the
full client runtime — protocol, offline queue and sync included). Zero
dependencies, automatic memoization, built-in forms/animation/SSR. AIR provides
React-style compat hooks (`useState`, `useEffect`, `useMemo`, `useCallback`) for
easy migration from React codebases.

The core is framework-agnostic. `client` gives you direct access to state,
actions, and routing — wire it into Svelte, Vue, Solid, or anything else in ~20
lines. See [AIR Setup](../ui/air-setup.md#architecture-overview) for the client
API.

The `client` API is stable and supported — custom adapters built on it are your
responsibility.

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

No dedicated form-validation hook needed — it would just be another place to
look. (The cell-level `validate` config guards state invariants, not form UX.)
See [Methods](../state/methods.md) for form state patterns.

---

### Why no multi-server / horizontal scaling?

aio's core contract is one state object, one process, serialized mutations,
broadcast to all clients. That's what makes it simple — no consensus, no
conflict resolution, no eventual consistency.

Adding a pub/sub adapter between instances would require conflict resolution
(CRDTs? last-write-wins?), state merge logic, and cross-instance workflow
coordination. That's a fundamentally different product.

**What actually scales:** aio handles thousands of WebSocket connections on a
single server. For multi-tenant apps, partition by workspace — each instance
owns its own state, a reverse proxy routes by tenant ID. No shared state adapter
needed.

If you need multi-server shared state, look at Phoenix LiveView, Elixir
clustering, or a custom CRDT layer. See [Scaling](../build/scaling.md) for
capacity guidance.

---

### Why no Deno Deploy / cloud hosting?

aio is a stateful server — it holds state in memory, persists to SQLite, and
broadcasts via WebSocket. Deno Deploy is a stateless edge runtime with no
persistent filesystem, no SQLite, and no long-lived WebSocket connections.
They're architecturally incompatible.

**How to deploy aio:** `deno compile` produces a single binary. Copy it to any
VPS (DigitalOcean, Hetzner, Fly.io with persistent volumes), run it. One file,
one process. See [Build Targets](../build/targets.md) for all compile targets.

---

### Why not support Node.js / Bun?

Deno is the value proposition, not an implementation detail. `deno compile`
(single binary), embedded SQLite (zero-config persistence), `deno task dev` (no
build toolchain), JSR publishing — these are why aio can be "all in one." A Node
port would mean maintaining two persistence backends, two server APIs, and
losing single-binary compilation entirely. The result would be a worse aio.

If your team requires Node, aio isn't the right fit — use Next.js, Express +
Zustand, or Convex.

---

### Why aren't schedule/own effect ids validated beyond the pattern?

Ids like `schedule.after('prices:refresh', …)` and
`own.set('workspace:watcher',
…)` are keyed replace slots plus debug labels.
They must match `/^[\w\-:.]+$/`; beyond that, enforcing naming rules (lint,
template literal types) would add friction to the fast path for a cosmetic
concern. Prefix them with the cell name — your future self will thank you.

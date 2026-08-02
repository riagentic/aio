# Cell workers (`worker: true`)

A cell can run its methods in **its own Deno worker** — a separate isolate on a
separate OS thread. Work that blocks (a parse, a crunch, an FFI call, a
sync-only API) then stalls **only that cell**. Every other cell, every other
client, and the socket loop that acks them keep running.

```ts
export const reports = cell("reports", {
  worker: true, // ← the entire opt-in
  state: { status: "idle", rows: [] as Row[] },
  methods: {
    async build(s, raw: number[]) {
      s.status = "building"; // commits + reaches clients immediately
      s.rows = crunch(raw); // seconds of CPU — on its own thread
      s.status = "done";
    },
  },
});
```

`crunch` is a normal import. Unlike
[`schedule.blocking`](../debugging/performance.md#move-it-off-thread) — which
moves a single self-contained function by serializing it — a worker cell loads
your app's real module graph, so closures, imports and helpers work exactly as
they do on the main isolate.

## What it changes, and what it doesn't

|    |                                                                                                                                                                                                    |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ | A method that blocks 10s delays **only this cell**. Measured: with the flag, five round trips to another cell during a 1.5s burn finish in milliseconds; without it, 1403ms.                       |
| ✅ | State stays authoritative on the main isolate — the worker streams its Immer patches home, so **persistence, broadcast, `ui`/`persist` filters, time-travel and the wire protocol are unchanged**. |
| ✅ | Writes before an `await` still reach clients immediately (the spinner pattern works).                                                                                                              |
| ✅ | `serverUser()` / `serverRequest()` answer inside the worker — the ambient context is forwarded with every call.                                                                                    |
| ✅ | Per-cell FIFO ordering is preserved; return values and thrown errors cross back to the caller.                                                                                                     |
| ✅ | Shutdown terminates the thread instead of waiting for it — a wedged method can't hold the app hostage.                                                                                             |
| ⚠️ | Args and return values must be **structured-cloneable** (plain data).                                                                                                                              |
| ⚠️ | Module singletons are **per worker** — a module-scope DB connection or FFI handle gets its own instance in that thread.                                                                            |
| ⚠️ | A postMessage + clone per dispatch: noise next to heavy work, ~10× a direct call for a trivial one.                                                                                                |
| ❌ | It does **not** make the slow method faster. The caller waits exactly as long; everyone else stops waiting with them.                                                                              |

## When to use it

Flag the cell that does **dangerous** work — where a method's duration depends
on its input and could be seconds: report building, image/document processing,
parsing untrusted payloads, FFI, crypto loops.

**Don't flag a counter.** For a cell doing microseconds of state shaping you pay
marshalling on every action to isolate something that can't block. That
asymmetry is why this is per-cell opt-in rather than a default.

The intended loop is **observe → flip**: aio reports a reduce that blows its
budget by cell and action name (dev holds a reduce to one frame). When a cell
keeps showing up, give it `worker: true`.

## The idiom: one designated heavy cell

The pattern that emerged in the field: rather than flagging several
interconnected cells, give the app **one self-contained cell that owns the
dangerous work** — plain args in, cloneable values out, no peer reads.

```ts
// heavy.ts — the app's designated thread
export const heavy = cell("heavy", {
  worker: true,
  state: { busy: false },
  methods: {
    async encrypt(s, plaintext: string, password: string) {/* 600k PBKDF2 */},
    async signWithDevice(s, payload: Uint8Array) {/* blocking USB ioctls */},
  },
});
```

Interconnected state-shaping cells (`accounts`, `network`, `ui`) stay on the
main isolate and _call_ the heavy cell, passing what it needs. That keeps their
cheap cross-cell reads exactly as they are, and confines the thread boundary to
the one place that benefits from it. In the reporting app this turned 2-second
freezes into a flat ~58ms loop with a hardware wallet chattering on its own
thread.

## Peer cells are not readable from a worker

A worker holds **only its own slice**. Reading another cell's field inside a
worker cell's method throws, naming the cell and the way out:

```
[aio] cell "heavy" runs in a worker and cannot read "accounts.list" — a worker
cell has ONLY its own state, so this read would silently return accounts'
declared default forever. Pass the value in as a method argument, do the read on
the main isolate and hand the result over, or keep the heavy work in one
self-contained cell (the designated-thread idiom).
```

Before this it returned the peer's _declared default_ forever — never-updated
data with no error, which is exactly the failure mode this framework refuses to
have. Calling a peer's method already threw (the unbound-runtime guard).

## What a worker cell cannot use

These fail loudly at boot, with the reason and the fix — none of them can be
honoured across a thread boundary:

| Config            | Why                                                                     | Instead                                      |
| ----------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| `scope: "client"` | a client cell runs in the browser                                       | drop `worker: true`                          |
| `sync: true`      | CRDT sync replays ops through the cell on the main isolate — two owners | pick one                                     |
| `listensTo`       | foreign-action fan-out runs inside the main reduce                      | have the other cell call this one's method   |
| `machine`         | transitions are evaluated in the main reduce                            | model states in plain fields                 |
| `selectors`       | computed against the main isolate's state                               | read fields directly, or compute in a method |

## Where it silently stays in-isolate

Both cases log once, and behavior is identical — only the isolation is missing:

- **`libraryMode`** (tests, embedded hosts): the entry module is a test file,
  not your app, so there is nothing to host a worker from. `testCell` and
  `testServer` therefore exercise the same method bodies in-process — fast and
  debuggable.
- **Compiled binaries**: the entry isn't a local module a worker can import yet.

## How it works

1. `aio.run()` spawns one worker per flagged cell, with the **app's own entry**
   as the worker's module and `aio-cell:<name>` as its worker name.
2. That entry runs `aio.run()` again inside the worker, which recognises the
   name and binds only the hosted cell — no server, no persistence, no client.
3. The main isolate seeds the worker with the authoritative slice (after
   persistence and migrations), then routes that cell's actions to it — **never
   through the main dispatch queue**, which is what makes the isolation real.
4. Each commit's patches stream home and are applied through the normal dispatch
   path, so everything downstream sees an ordinary state change.
5. Effects that belong to the runtime (schedules, cross-cell dispatches) are
   executed on the main isolate; the cell's own async-method machinery runs in
   the worker.

See also: [performance](../debugging/performance.md),
[methods](methods.md#async-methods).

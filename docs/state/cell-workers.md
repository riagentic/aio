# Cell workers (`worker: true`)

A cell can run its methods in **its own Deno worker** — a separate isolate on a
separate OS thread. Work that blocks (a parse, a crunch, an FFI call, a
sync-only API) then stalls **only that cell**. Every other cell, every other
client, and the socket loop that acks them keep running.

```ts
import { cell } from "aio";
import { crunch, type Row } from "./crunch.ts";

export const reports = cell("reports", {
  worker: true, // ← the entire opt-in
  state: { status: "idle", rows: [] as Row[] },
  methods: {
    async build(s, raw: number[]) {
      s.status = "building";
      await Promise.resolve(); // an await commits — "building" reaches clients now
      s.rows = crunch(raw); // seconds of CPU — on its own thread
      s.status = "done";
    },
  },
});
```

`crunch` is a normal import. Unlike
[`blocking`](../debugging/performance.md#move-it-off-thread) — which moves a
single self-contained function by serializing it — a worker cell loads your
app's real module graph, so closures, imports and helpers work exactly as they
do on the main isolate.

## What it changes, and what it doesn't

|    |                                                                                                                                                                                                                                     |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ | A method that blocks 10s delays **only this cell**. Measured: with the flag, five round trips to another cell during a 1.5s burn finish in milliseconds; without it, 1403ms.                                                        |
| ✅ | State stays authoritative on the main isolate — the worker streams its Immer patches home, so **persistence, the journal, broadcast, `visible`/`persist` filters, time-travel, `am timeline` and the wire protocol are unchanged**. |
| ✅ | Writes before an `await` still reach clients immediately (the spinner pattern works). Without an `await` between them, the write and the burn are one commit: `"building"` is never seen.                                           |
| ✅ | `serverUser()` / `serverRequest()` answer inside the worker exactly as in-isolate: the caller's full user object rides the call (a server-origin call is anonymous), and the request context is forwarded with it.                  |
| ✅ | Per-cell FIFO ordering is preserved; return values and thrown errors cross back to the caller — an error keeps its `message`, `name` and string `code`.                                                                             |
| ✅ | Shutdown terminates the thread instead of waiting for it — a wedged method can't hold the app hostage.                                                                                                                              |
| ⚠️ | Args, return values and the caller's user object (what `resolveUser` returns) must be **structured-cloneable** (plain data).                                                                                                        |
| ⚠️ | Module singletons are **per worker** — a module-scope DB connection or FFI handle gets its own instance in that thread.                                                                                                             |
| ⚠️ | A postMessage + clone per dispatch: noise next to heavy work, ~10× a direct call for a trivial one.                                                                                                                                 |
| ❌ | It does **not** make the slow method faster. The caller waits exactly as long; everyone else stops waiting with them.                                                                                                               |

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

A worker holds **only its own slice** — and reads it live: `heavy.rows` inside
`heavy`'s own method (a helper, or after an `await`) is the current value, as it
is in-isolate. Reading another cell's field inside a worker cell's method
throws, naming the cell and the way out:

```
[aio] cell "heavy" runs in a worker and cannot read "accounts.list" — a worker
cell has ONLY its own state, so this read would silently return accounts'
declared default forever. Pass the value in as a method argument, do the read on
the main isolate and hand the result over, or keep the heavy work in one
self-contained cell (the designated-thread idiom).
```

Before this it returned the peer's _declared default_ forever — never-updated
data with no error, which is exactly the failure mode this framework refuses to
have. Calling a cell's method — a peer's or its own — throws too (the
unbound-runtime guard): nothing is bound inside a worker.

Every harness refuses both, with the same words, even though it runs the cell
in-isolate (`testCell`, `bootCells`, `testUI`, `testServer`): while a worker
cell's method runs — its async body included — a read of another cell's state or
a call to any cell's method throws exactly as the real thread does. Test code
around the call, and a component that re-renders because of the method's commit,
are main-isolate code and read freely.

`cell.$pending("method")` on the main isolate counts a worker cell's async call
for as long as the worker runs it — the same number an in-isolate run reports. A
call the worker answers from another call (a `concurrency: "first"` adopter, a
`ttl` hit) is not counted, as in-isolate; the worker says so one thread hop
after the call is posted, so only a read in the same synchronous turn still sees
it.

A worker cell's errors reach the app's `onError` like any other cell's —
`INIT_ERROR` from its `onInit`, `EFFECT_ASYNC_ERROR` from a method — with the
same code and message.

## What a worker cell cannot use

These fail loudly at boot, with the reason and the fix — none of them can be
honoured across a thread boundary. Every test harness (`testCell`, `bootCells`,
`testUI`, `testServer`) refuses them too, before the test body runs:

| Config            | Why                                                                     | Instead                                      |
| ----------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| `scope: "client"` | a client cell runs in the browser                                       | drop `worker: true`                          |
| `sync: true`      | CRDT sync replays ops through the cell on the main isolate — two owners | pick one                                     |
| `listensTo`       | foreign-action fan-out runs inside the main reduce                      | have the other cell call this one's method   |
| `machine`         | transitions are evaluated in the main reduce                            | model states in plain fields                 |
| `selectors`       | computed against the main isolate's state                               | read fields directly, or compute in a method |

## Where it stays in-isolate — and how to ask for the real thing

**`libraryMode`** (tests, embedded hosts): the entry module is a test file, not
your app, so there is nothing to host a worker from. `testCell` and `testServer`
therefore exercise the same method bodies in-process — fast and debuggable. It
logs once.

The **serialization** boundary is still reproduced there — in `testServer`,
`bootCells`, `testUI` and `testCell` alike: arguments and return values (sync
and async methods) are structured-cloned for exactly the cells that would have
been hosted, so a function fails in the test rather than in production, and a
class instance comes back a plain object in both. What is missing is
**isolation** — in-isolate, the cell shares the test's module graph, so a
module-scope cache, counter or handle is one instance where production has two.

When that difference is the thing under test, name a real entry and get real
workers:

```ts
await using srv = await testServer({
  cells: [reports],
  workers: "real",
  workerEntry: import.meta.resolve("./reports-app.ts"),
});
```

Full recipe, and the client-call half of the same problem, in
[testing/prod-parity.md](../testing/prod-parity.md).

**Compiled binaries** are NOT a case: Deno embeds the entry and reports it as a
`file://` URL, so a compiled app hosts its worker cells for real. Measured, not
assumed — `tests/build-e2e.test.ts` runs a compiled binary and checks the main
isolate keeps ticking while a worker cell burns its thread.

## When the worker crashes

An uncaught error in the worker thread (a stray rejection, a throwing timer or
FFI callback) kills it. Every call in flight rejects with the crash, and
`/__aio/health` reports `cell-worker:<name>` degraded. What happens next is the
cell's choice:

|                                     | After a crash                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `worker: true`                      | The cell is dead: every later call is refused with the crash, by name, until the app restarts.     |
| `worker: true, workerRespawn: true` | A fresh worker is started at once and serves the next call. Health recovers when it reports ready. |

```ts
export const reports = cell("reports", {
  worker: true,
  workerRespawn: true, // start a crashed worker again
  // …
});
```

`workerRespawn` without `worker: true` is refused when the cell is declared.

A respawn is a new isolate, not a resumed one — know what it keeps:

- **State**: the last COMMITTED state. The main isolate holds every patch the
  dead worker streamed home, and seeds the new one with it. A write the method
  had not committed yet (no `await` after it) is gone.
- **Calls in flight** at the crash are not retried: they reject, exactly as with
  `worker: true`. Retrying is the caller's decision — the method may have
  half-run.
- **`onInit` runs again**, once, in the new worker — it is where the cell opens
  what its methods need, and all of that died with the old thread. It runs
  against the committed state, not the declared defaults, so write it to be
  repeatable. `onDestroy` did NOT run in the thread that died.
- **Module state** (caches, connections, handles) starts empty.
- **A crash loop ends**: a third crash within 60 s is not respawned. The cell
  then stays dead as with `worker: true`, and the error — in the log, in health
  and in every refused call — says `crash 3 in 60s` and that respawn stopped. A
  worker that crashes before it was ever ready is a boot failure, never
  respawned.

**Native resources.** aio ends a worker thread without knowing what native work
it has pending: at once on a crash, and on shutdown after a 1 s close deadline
(the worker aborts its methods' `s.$signal`, gets 800 ms to finish writing, then
runs `onDestroy`) whether or not anything is still running. The isolate's memory
is freed while the OS or a native library may still complete into it — an async
FFI call, a `Deno.UnsafeCallback`, a device transfer filling a JS `ArrayBuffer`
— which can take down the whole process, not just the cell. So a worker cell
that holds FFI or device handles should: abort and drain its native I/O when
`s.$signal` aborts and in `onDestroy` (the clean path); keep buffers a native
call can still write to in native (C) memory that outlives the isolate, never in
a JS buffer (the crash path — no hook runs there); and expect that a handle the
dead thread held was never released — with `workerRespawn`, `onInit` must cope
with a device that is still claimed.

Prove the app's side of it with `crashWorker` from `aio/testing`:

```ts
import { assertRejects } from "@std/assert";
import { bootCells, crashWorker } from "aio/testing";
import { reports } from "./reports.ts";

await using _h = await bootCells([reports]);
const build = reports.build([1, 2, 3]);
crashWorker(reports); // as an uncaught error in its thread
await assertRejects(() => build, Error, "crashed");
await reports.build([4]); // workerRespawn: served again · without: rejects, by name
```

Under `testServer({ workers: "real" })` it terminates the real thread, and a
`workerRespawn` cell gets a real new isolate (`onInit` and all). Under
`testCell`, `bootCells` and `testUI` the cell runs in process, where there is no
thread to end: calls are answered as above and the crash-loop cap counts the
same, but a method body already running runs on (what it writes later still
commits), module state survives and `onInit` does not run again — use real
workers when that is what the test is about. In-isolate `testServer` refuses
`crashWorker`, naming the option.

## How it works

1. `aio.run()` spawns one worker per flagged cell, with the **app's own entry**
   as the worker's module and `aio-cell:<name>@<appId>` as its worker name (the
   appId rides along so the worker never re-derives the app's identity from its
   working directory).
2. That entry runs `aio.run()` again inside the worker, which recognises the
   name and binds only the hosted cell — no server, no persistence, no client.
3. The main isolate seeds the worker with the authoritative slice (after
   persistence and migrations), then routes that cell's actions to it — **never
   through the main dispatch queue**, which is what makes the isolation real.
   The cell's `onInit` runs in the worker **once per boot**, alongside the main
   cells' `onInit`s — not again when time travel or a snapshot load re-seeds it.
   A call in flight when the re-seed happens behaves as if it ran just BEFORE
   it: its promise resolves with the method's value, and what it wrote is
   replaced by the loaded state on both sides (a streaming method's writes after
   the re-seed land on the loaded state, on both sides). An `onInit` that throws
   or rejects is an `INIT_ERROR` (to `onError`, as on the main isolate); the
   cell keeps serving calls. A worker that CRASHES is not respawned unless the
   cell asks ([below](#when-the-worker-crashes)): the cell answers every later
   call with the crash, by name, until the app restarts, and `/__aio/health`
   reports it degraded (`cell-worker:<name>`) — and a restart (including dev's
   automatic one when a cell file changes) is a new boot, so `onInit` runs
   again, once. When the entry is not a local module no worker can be spawned:
   the cell runs on the main isolate with a warning, and its `onInit` runs
   there. `app.cells.disable` (or a `circuitBreaker` trip) runs the cell's
   `onDestroy` and state reset in its worker, and `app.cells.enable` its
   `onInit` — as for a main-isolate cell
   ([lifecycle](lifecycle.md#runtime-control)).
4. Each commit's patches stream home and are applied through the normal dispatch
   path, so everything downstream sees an ordinary state change. With
   `journal: true` each batch is journalled (and shown by `am timeline`) as
   `__aioWorkerPatch`, attributed to the cell as `<cell>:__worker` — the batch
   carries no method name, so a cell with any `redactActions` pattern has the
   batch's values withheld. The `dispatchStorm` guard counts the batches per
   cell under the same name and never drops them — they are writes the worker
   already made.
5. Effects that belong to the runtime (schedules, cross-cell dispatches) are
   executed on the main isolate; the cell's own async-method machinery runs in
   the worker. A schedule's timer lives on the main isolate, but its tick is
   routed like any other call: a tick naming a worker cell's method runs in that
   cell's worker.

See also: [performance](../debugging/performance.md),
[methods](methods.md#async-methods).

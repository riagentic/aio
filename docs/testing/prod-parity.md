# Prod parity — what the harness reproduces, and what it fakes

A test that is more permissive than production manufactures a green suite and a
broken app. This page is the honest list: where an aio harness runs your code on
the same path production does, where it does not, and which option closes the
difference when you need it closed.

Three boundaries separate a test from a running app.

| Boundary                      | In the harness by default                 | Option                                         |
| ----------------------------- | ----------------------------------------- | ---------------------------------------------- |
| Worker **serialization**      | reproduced — always                       | none needed                                    |
| Worker **isolation**          | not reproduced — the cell runs in-isolate | `testServer({ workers: "real", workerEntry })` |
| A **client** calling a method | not reproduced — the call is in-process   | `client.call(cell, method, …)`                 |

## The worker serialization boundary — always on

A `worker: true` cell is reached by `postMessage`, so every argument and every
return value is structured-cloned. The harness clones across that boundary too,
for exactly the cells that would have been hosted:

```ts
await using srv = await testServer({ cells: [heavy] });
await heavy.take({ onDone: () => {} }); // throws, naming heavy and the boundary
```

A function, a class instance, a live cell proxy, or an object holding one is
perfectly fine passed by reference and impossible to clone — so without this a
test passed and production threw. Nothing to turn on; a non-worker cell pays
nothing.

Under `workers: "real"` the stand-in is not used and is not needed — the real
`postMessage` refuses the value — and the failure reads the same either way: a
**rejection** naming the cell and the boundary. (`postMessage` itself throws
synchronously; a cell method always returns a promise, so the runtime converts
it rather than letting one mistake have two shapes.)

## Worker isolation — `workers: "real"`

Isolation is the other half, and it is opt-in because it costs a worker spawn
per cell.

By default a worker cell's methods run on the test's own isolate. Under
`libraryMode` the entry module is the TEST file, and a worker spawned on it
would re-run the whole test in another thread — so there is nothing to host
from, and the boot log says so.

That means **module-level state is shared in a test and separate in
production**:

```ts
let cacheHits = 0; // module scope

export const heavy = cell("heavy", {
  worker: true,
  state: { hits: 0 },
  methods: {
    hit(s: { hits: number }) {
      s.hits = ++cacheHits;
    },
  },
});
```

In-isolate, `cacheHits` is the same binding your test can read. In a real worker
it is a different one — a fresh module graph, a fresh heap. A cache, a counter,
a connection pool, a `let` at module scope: all of them behave one way in every
test and another way in production.

To measure it instead of assuming it, name a real app entry:

```ts
// heavy-app.ts — a real entry, imported by the test AND by the worker
import { aio, cell, isCellWorker } from "aio";

export const heavy = cell("heavy", { worker: true /* … */ });

if (isCellWorker()) {
  await aio.run({ cells: [heavy], libraryMode: true, persist: false });
}
```

```ts
// heavy.test.ts
await using srv = await testServer({
  cells: [heavy],
  workers: "real",
  workerEntry: import.meta.resolve("./heavy-app.ts"),
});
await heavy.hit(); // runs on a real Deno worker
```

- `workers` is `"in-isolate"` (the default) or `"real"`.
- `workerEntry` is **required** with `"real"`, and cannot be inferred — under a
  test `Deno.mainModule` is the test file.
- The entry must define the same cells and reach `aio.run()` when
  `isCellWorker()`. Guard the rest of its top-level work with `!isCellWorker()`:
  the worker re-imports the entry, and slow setup stalls the ready handshake.

Every misuse throws at the `testServer()` call, naming the fix — a missing
entry, an entry that is not a local file, an entry that does not exist, or
`workers: "real"` on an app with no worker cell. An option that silently did
nothing would be the same failure this page exists to prevent.

Strictness travels with the thread: the worker is armed with the same `__aioDev`
flag as the isolate that spawned it, so frozen-state enforcement, the readonly
hint and the hidden-field read guard fire in there too.

`tests/prod-parity-real-workers.test.ts` measures both halves — the module graph
is separate, and the main isolate keeps ticking while the cell burns its thread
(the same property `tests/build-e2e.test.ts` measures against a compiled
binary).

## A client calling a method — `client.call()`

Every test you write calls a cell method **in-process**:

```ts
await todos.add("milk"); // a server-side call
```

A browser tab, an Electron window and `am` do not. They put an action frame on a
socket, and four things change on the way:

1. the **argument** is JSON, not a reference — a `Date` arrives as a string, a
   `Map` as `{}`, an `undefined` member simply vanishes;
2. the **return value** is JSON-vetted (`serializeReturn`) — a function is
   dropped, a `Set` flattens, and a value JSON cannot carry at all resolves as
   `undefined`;
3. a **throw** comes back as a message: an `Error` with no server stack and no
   identity;
4. `access: false` and per-user rules refuse the **client** and not the
   server-side caller.

For an async method the CLI client already had that path
(`connectCli().bind(cell)`). For a plain non-async method it did not, so those
four differences were invisible to an entire suite. `testMultiClient` gives you
the real one:

```ts
await using m = await testMultiClient({ cells: [todos] }, 1);

await todos.add("milk"); // in-process — the server-side path
await m.clients[0].call("todos", "add", "milk"); // over the wire — the client path
```

`call(cell, method, ...args)` sends the frame a browser sends, over a real
WebSocket, to a real `aio.run()`, and resolves with the server's acked return
value — or **rejects** with the server's refusal. An unknown cell or method
rejects immediately, naming what does exist: the server ignores an unknown
action type and acks OK, so a typo would otherwise resolve with `undefined` and
pass.

`tests/prod-parity-client-sync-call.test.ts` asserts each of the four
differences with the in-process result and the wire result side by side.

## Boot refusals — the harness refuses what production refuses

`aio.run()` refuses to start on a handful of composition-time defects: a field
whose NAME is an unambiguous credential (`apiKey`, `password`, `privateKey`, …)
left visible to the UI, a `sync: true` cell that also hides state, an `access`
rule escalated around through `listensTo`, a selector depending on a cell that
is not booted.

`testUI` and `bootCells` do not boot through `aio.run()` — they compose on the
standalone runtime — so none of those ran under them. A cell holding an `apiKey`
booted **green** in the harness and was refused the moment the app actually
started, in dev and in prod alike. A whole app could be built green against the
harness the docs push hardest and then not start.

Both harnesses now run the same refusal list, before they boot anything:

```ts
export const config = cell("config", {
  state: { apiKey: "sk-live-…", theme: "dark" },
  methods: {/* … */},
});

await bootCells([config]);
// Error: [aio] SECURITY — refusing to start. [config] field ["apiKey"] is a
// credential exposed to the UI … Hide it: visible: { exclude: ["apiKey"] }
```

The same message, from the same code, in the harness and at boot. Client-scoped
cells are skipped in both places — they never reach a broadcast, so the server
does not check them either.

`tests/harness-strictness-parity.test.ts` pins it: the credential case is
refused by `composeCellsWiring` (which _is_ `aio.run()`'s boot path), by
`bootCells`, and by `testUI`, with the same wording.

## What still is not reproduced

- **The browser's own renderer.** `testUI` mounts the client runtime in-process
  with happy-dom. A real-renderer bug needs `testBrowser()` or the
  `tests/e2e-sync-browser.test.ts` path.
- **A second process.** `testMultiClient` clients share the test's process, so a
  crash, a signal or an OS-level limit is not modelled.

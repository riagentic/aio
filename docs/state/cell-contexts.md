# Cell contexts — which code runs where

One definition, several places it runs: server, client replay, worker, tests.
This page is the map: the contexts, what each cell option means in each, and the
combinations aio refuses at `cell()` or boot time.

## The contexts

| context           | what runs there                                                                                                                                                       | how you get there                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **server**        | every method (sync and async), effects, persistence, broadcast — the authority                                                                                        | `aio.run({ cells })`; a browser call travels the wire and runs here |
| **client replay** | the **sync** methods of a `sync`/`localFirst` cell, re-run in the browser as an optimistic preview; the same op then runs on the server and the server's answer wins  | `sync: true` on the cell, or `aio.run({ localFirst: true })`        |
| **client-only**   | the sync methods of a `scope: "client"` cell, against a per-tab signal — no server ever sees it                                                                       | `scope: "client"`                                                   |
| **worker**        | the whole cell — its methods and async machinery — on its own Deno thread; patches stream home to the main isolate, which stays the authority                         | `worker: true`                                                      |
| **testCell**      | the server context, in-process, on the raw (unfiltered) state; effects are collected and run by `settle()`/an awaited send                                            | `testCell(cell, name, fn)`                                          |
| **testUI**        | the standalone dispatch loop (the runtime the Android target ships): methods run in-process, server-authoritative; the component reads through the **client** surface | `testUI(App, name, fn)`                                             |

Two reading surfaces exist, and every context uses exactly one:

- **Server read** — the raw state. Server code (methods, effects, `routes`,
  `serverFns`), `testCell`'s `t.expect.state`, and `ui.serverState()` /
  `ui.fullState()` in `testUI`.
- **Client read** — the `visible`-filtered slice. A component in the browser, in
  Electron, in `testUI`. Reading a hidden field on it **throws — in every
  context, dev and prod alike** (`src/state/cell-reactive.ts`): the error names
  the field, the cell, and the two fixes (publish a non-secret fact field, or
  read it in a server-side/async method). It used to return `undefined` with a
  warning in prod, and client code branched on that `undefined` as data.

Tests are the strictest environment: `testCell` and `testUI` run dev-strict, so
anything that throws in dev throws in the test too.

## What each option means, per context

| option                        | server                                                                                   | client replay / client-only                                                                                                                 | worker                                                           | testCell                                                        | testUI                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `visible` (`ui`) `/ .exclude` | filters the broadcast; server code still reads everything                                | the hidden field is absent — a read throws (dev) / `undefined` (prod). `scope: "client"` cells are exempt: their state never leaves the tab | filter applied on the main isolate as patches arrive — unchanged | not applied — `t.expect.state` is raw                           | applied to component reads; `ui.serverState()` is raw                         |
| `persist` `/ .exclude`        | snapshot to `state.db`; excluded fields are dropped on the way to disk                   | never — a browser persists nothing server-side; `scope: "client"` is never persisted at all                                                 | on the main isolate, after the patches land                      | not applied (in-memory)                                         | off by default (`persist: true` opts in, localStorage)                        |
| `sync`                        | re-runs each op through normal dispatch; guards/`access`/`validate` decide               | this is what creates client replay: sync methods replay locally, async methods do not (their outcome arrives from the server)               | **refused** with `worker: true`                                  | no engine — plain dispatch                                      | no engine — plain dispatch (the CRDT path needs a wire: use the e2e tests)    |
| `transaction` / `.serialize`  | async methods see a snapshot across awaits; `serialize` runs them one at a time per cell | never — replay is sync-only, and a client-only cell has no async methods                                                                    | same as server, inside the thread                                | same as server                                                  | same as server                                                                |
| `worker`                      | spawns a thread with the app's own entry; routes the cell's actions there                | n/a                                                                                                                                         | —                                                                | stays in-isolate (`libraryMode`), logged once; `testServer` too | stays in-isolate, logged once                                                 |
| `long: [...]`                 | removes the call ceiling for those async methods                                         | mirrored so the browser waits as long as the server does                                                                                    | honoured — the host adds no second ceiling                       | honoured (`await job.colorize()` just waits)                    | honoured                                                                      |
| `scope: "client"`             | never registered — skipped at compose time, logged at debug                              | the cell's whole life: sync methods on a per-tab signal                                                                                     | **refused** with `worker: true`                                  | runs the sync methods locally                                   | runs on its own signal; its slice is skipped by the standalone loop's commits |

Effects are a server concern: during a client replay `s.$do` swallows everything
— the effects already ran on the server, and firing them again here would double
them.

## Combinations that are refused

At `cell()` time (`src/state/cell-create.ts`, `cell-methods-factory.ts`):

| combination                                                                              | verdict                                                                                             |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `scope: "client"` + an async method                                                      | **throws** — no server round-trip exists; do the async work in the component and call a sync method |
| `long: ["m"]` / `cancelOn: { m }` where `m` is sync or missing                           | **throws** — only async methods have a ceiling or anything in flight                                |
| `listensTo: { m: … }` where `m` is async or missing, or one action mapped to two methods | **throws** — reactions run inside the reduce, exactly one per action                                |
| `onMigrate` without `version >= 1`                                                       | **throws** — the hook would never fire                                                              |
| a state key that starts with `$`, or collides with a method/selector                     | **throws**                                                                                          |
| an unknown option key                                                                    | **throws**, with the nearest valid spelling                                                         |

At boot (`src/server/aio-composition.ts`, `cell-worker-pool.ts`):

| combination                                                | verdict                                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `sync` (or adopted by `localFirst`) + any `visible` filter | **refuses to start** — CRDT ops reach every peer verbatim, so the hidden data would arrive anyway. Move the secret to a server-only cell |
| a field that looks like a secret with no `visible` filter  | dev **refuses to start**, prod logs loud; `visible: { publicFields: [...] }` declares it public on purpose                               |
| `worker: true` + `scope: "client"`                         | **throws** — a Deno worker does not exist in the browser                                                                                 |
| `worker: true` + `sync`                                    | **throws** — sync replays ops on the main isolate; two owners                                                                            |
| `worker: true` + `listensTo` / `machine` / `selectors`     | **throws** — all three are evaluated in the main reduce                                                                                  |
| a worker cell reading a peer cell's state                  | **throws** on the read, naming the cell — a worker has only its own state; pass the value as an argument                                 |
| `visible`/`persist` key that is not a top-level field      | **warns** — the filter would silently do nothing (use a dot-path `exclude` for nested fields)                                            |

## The canonical pattern: fetch outside, commit with a sync reducer

The one shape that behaves identically in every context above — server, replay,
worker, both harnesses:

```ts
export const prices = cell("prices", {
  state: { quote: null as number | null, error: "" },
  methods: {
    // a sync reducer: pure, replayable, deterministic — the only thing a
    // client replay or a worker ever needs to agree on
    setQuote(s, quote: number) {
      s.quote = quote;
      s.error = "";
    },
    fail(s, error: string) {
      s.error = error;
    },
    // the async method does the I/O and commits through the reducer — a
    // direct call on the bound cell (after aio.run(); throws before it)
    async refresh() {
      try {
        const r = await fetch("https://api.example/quote");
        await prices.setQuote((await r.json()).price);
      } catch (e) {
        await prices.fail(String(e));
      }
    },
  },
});
```

Inside `refresh` the draft `s` is never touched after the `await`, so the method
writes nothing of its own; `prices.setQuote` is the one commit.

Why this shape, rather than writing `s.quote = …` after the `await`:

- **Replay** only ever sees `setQuote`, a sync method — the preview is exact and
  the server commit is the same op.
- **Worker** — the reducer's patches are the whole story that crosses the
  thread; the fetch happens in the thread, its outcome is one commit.
- **Tests** — `testCell` dispatches `setQuote(42)` directly and asserts, no
  network; `refresh` is tested once, with the fetch stubbed.
- **Transactions** are unnecessary: the read-modify-write is already a single
  sync step.

The async-method rules this sidesteps — read-after-await, captured references,
the call ceiling — are in [Methods](methods.md).

## See also

- [Cell Visibility](cell-visibility.md) — `visible`/`persist` filters,
  `forUser`, `publicFields`
- [Cell workers](cell-workers.md) — the designated-thread idiom, what a worker
  cell cannot use
- [CRDT sync](../persistence/crdt.md) — `sync`, `localFirst`, what replays
- [Transactional methods](transactional-methods.md) — `transaction`,
  `serialize`, `conflict`
- [The bridge](the-bridge.md) — what crosses client↔server
- [Cell testing](../testing/cell-testing.md) ·
  [UI testing](../testing/ui-testing.md)

# Testing two apps at once — `testApps`

aio documents two architectures. One app serving many surfaces is covered by
[`testMultiClient`](ui-testing.md#two-surfaces-at-once-testmulticlient): one
server, N clients over it. The other shape — **a service plus rich clients**,
where the client is itself an aio app with its own cells, its own store and its
own identity, and merely _connects to_ someone else's service — needs more than
one app booted before any of its properties are even expressible:

- two apps do not share an appId, a lock, a port or a data directory
- a cell definition bound to app A cannot be bound to app B (D2 exclusivity)
- a client of app A, running inside app B, sees A's state — not B's
- closing B leaves A running

`testApps` boots N independent apps for one test. Everything is real: N
`aio.run()` instances, real WebSockets, real broadcast. Nothing about the second
app is simulated, because the second app is the thing under test.

```ts
import { assert, assertEquals } from "@std/assert";
import { cell } from "aio";
import { testApps } from "aio/testing";

// A FACTORY, not a singleton — see "One definition, two bindings" below.
const makeLedger = () =>
  cell("ledger", {
    state: { balance: 0 },
    methods: {
      credit(s: { balance: number }, n: number) {
        s.balance += n;
      },
    },
  });

const prefs = cell("prefs", {
  state: { theme: "light" },
  methods: {
    setTheme(s: { theme: string }, t: string) {
      s.theme = t;
    },
  },
});

Deno.test("the desk app talks to the service over a real socket", async () => {
  await using world = await testApps({
    service: { cells: [makeLedger()] },
    desk: { cells: [prefs] },
  });

  const remoteLedger = makeLedger();
  const link = world.connect("service");
  link.bind(remoteLedger);
  await link.ready;

  await remoteLedger.credit(5);

  assertEquals(
    world.get<{ ledger: { balance: number } }>("service").state().ledger
      .balance,
    5,
  );
  // The desk never saw the action and never grew the service's cell.
  assert(!("ledger" in world.get<Record<string, unknown>>("desk").state()));
});
```

## Signature

```ts
// snippet: fragment
testApps(specs: Record<string, CellsConfig>): Promise<TestApps>
```

The keys are the names you will refer to the apps by; each value is a normal
`CellsConfig` — the same object `aio.run()` takes, so `persist: true`, `routes`,
`users`, `auth` all work per app.

Each app gets its own free port, its own throwaway data directory and its own
appId (`test-<name>-<random>` — distinguishable, so an assertion about "which
app wrote this" is readable, and still unique per run because two test files may
boot the same name at the same moment).

An empty object throws (`testApps() needs at least one app`) rather than handing
back an inert world.

## The handle

| Member                  | What it gives you                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `apps`                  | `TestServer[]` — the booted apps, in declaration order                             |
| `get<S>(name)`          | one app as a `TestServer<S>` (`url`, `port`, `app`, `fetch`, `state()`, `close()`) |
| `connect<S>(name, opt)` | a client connection TO that app — a `CliApp<S>`; `opt` takes `{ token }`           |
| `close()`               | closes every link, then every app, in reverse order of creation                    |

`TestApps` is `await using`-ready: the `Symbol.asyncDispose` runs the same
`close()`. Links are closed **before** the servers, deliberately — a client
whose server vanished mid-test reconnects on a backoff timer, and that timer
outlives the test as a leaked op.

`get()` with a name that was never declared throws and **names the apps that do
exist**, so a typo reads as a typo rather than as "the app failed to boot".

## One definition, two bindings

`cell()` binds a definition to exactly one app (perfect-aio D2). Handing the
same object to two apps throws, and `testApps` does not soften that.

In production this never comes up: the service process and the client process
each import the module and each get their own instance. In one test process it
has to be said out loud — so write any cell a client will bind as a **factory**:

```ts
// snippet: fragment
const makeLedger = () => cell("ledger", { state: { balance: 0 }, methods: {} });
```

The service binds one instance; `link.bind(makeLedger())` binds another. A
client that only wants to _read_ another app's cell binds it on the `connect()`
link, which is exactly what a rich client does in production.

## What stays per app in one process

Two apps in one process share every module — the logger, the diagnostic bus, the
`degraded()` registry are each one object. Each `aio.run()` runs **as its app**,
and everything its boot starts (routes, sockets, timers armed in `onStart` or in
a method, the control listener) carries that app with it, so these facts stay
the app's own:

| Fact                           | Per app                                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Log files                      | each app's lines land in its own `logs/` — including route handlers, timers, and lines logged before its logger existed; closing one app leaves the other's |
| Budgets                        | one budget ledger per app: B's `budgets: { cellState }` never turns A's `/health` degraded                                                                  |
| `/health` uptime               | measured from that app's own boot, not the last one                                                                                                         |
| `/health` degraded rows        | trackers tripped by that app's code, and failures its own clients reported — also through the plain-HTTP control listener under TLS                         |
| Feedback reports               | the feedback and updates cells are bound per app; auto-capture files only that app's errors                                                                 |
| Dev `diag` frames              | a socket receives its own app's diagnostics, never another app's                                                                                            |
| Control credential, rate limit | closing one app leaves the other's credential armed; the trojan rate limit is counted per app                                                               |

Code that runs outside **any** app — a module's top level, a test calling `log`
directly — has no app to belong to: its log lines go to the most recently booted
app that is still running, and a diagnostic or `degraded()` failure it records
is visible to every app.

`feedback` and `updates` are off under `libraryMode`, which `testApps` sets —
the per-app feedback guarantees are pinned in a child process
(`tests/two-apps-concurrent-isolation.test.ts`). The rest:
`tests/two-apps-app-scope.test.ts`,
`tests/two-apps-one-process-singletons.test.ts`,
`tests/two-apps-diag-relay.test.ts`,
`tests/tls-control-listener-app-scope.test.ts`.

## Which harness

| Harness                     | Boots      | Use it for                                      |
| --------------------------- | ---------- | ----------------------------------------------- |
| `testCell(cell, name, fn)`  | no server  | one cell's reducer, in isolation                |
| `testUI(App, name, fn)`     | in-process | a component against its cells                   |
| `testServer(config)`        | one app    | routes, auth, persistence, a server-side method |
| `testMultiClient(config,n)` | one app, N | broadcast, convergence, received patches        |
| `testApps(specs)`           | N apps     | isolation between apps, and a client of another |

## Related

- [UI Testing](ui-testing.md) — the semantic UI surface, `testServer`,
  `testMultiClient`
- [Cell Testing](cell-testing.md) — `testCell`
- [App architectures](../basics/app-architectures.md) — the two shapes this
  harness exists for
- [Cassettes](cassettes.md) — record/replay for I/O neither harness can fake

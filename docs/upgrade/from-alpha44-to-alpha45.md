# Upgrade: alpha44 → alpha45

Everything here came out of one field report — two apps in one repository, a
headless relay and an Electron client — plus the bugs found while verifying it.
The theme is the **network boundary**: everything inside one process was already
solid, and every serious problem was on a seam an app author cannot see through.

**Most apps need no changes.** Three behaviors change observably; read those
three, then skim the additions.

## 1. A per-user filter now really filters (privacy — act on this)

If any cell declares `ui: { forUser }` **without** an `include`/`exclude` beside
it, that cell was broadcasting **unfiltered** state to every client. `forUser`
guarded the initial full-state frame only; every delta after it was computed
from raw server state and narrowed by nothing but subscriptions.

```ts
cell("orders", {
  state: { items: [] },
  methods: {/* … */},
  // No include/exclude beside it → was leaking on every delta
  ui: { forUser: (s, user) => viewFor(s, user) },
});
```

It also corrupted the client's view: raw patches carry raw array indices, and
the client's array had already been shortened by `forUser`, so rows landed at
the wrong position — the "one field reflected the filter, another was stale"
symptom.

`forUser` now implies the `full` broadcast strategy, which is what
`docs/state/cell-visibility.md` has always documented. **No code change
required.** Two consequences worth knowing:

- Affected cells send full per-client state instead of patches, so they use more
  bandwidth. That was always the cost of a per-user view; the cells that already
  paired `forUser` with `include` have been paying it all along.
- If you added a structural filter _purely_ to force this classification (the
  workaround the report describes), you can drop it — keep it if it also narrows
  what `forUser` can see, which is still a good idea.

If you never used `forUser`, nothing changes.

## 2. A refused CLI call now rejects instead of resolving

`connectCli().bind(cell)` used to **resolve** a bound call even when the
server-side method threw — the ack frame carries `ok` and `error`, and the
client read neither. Return values were dropped the same way.

```ts
try {
  const order = await orders.place("sku-1"); // ← now yields the return value
} catch (e) {
  console.error(e.message); // ← now the server's own reason
}
```

**What to check in your app:** anywhere you call a bound method over
`connectCli`/`connectCliUDS` without a `try`/`catch` (or `.catch()`), a
server-side refusal that used to pass silently will now surface — an unawaited
call becomes an unhandled rejection. That is the point: the alternative was an
app that could not tell "applied" from "refused". If you built a parallel error
channel to work around this, you can delete it.

Two related fixes come with it, both pure gains:

- **Async bound methods worked at all.** `await cell.asyncMethod()` over
  `connectCli` used to wait out the full call ceiling and then reject with
  "stopped waiting" — 30 seconds after a method that had already succeeded.
  Success and failure alike. They now settle on their ack.
- **A dropped connection rejects outstanding calls** instead of resolving them.
  Closing a client does not make an unconfirmed action succeed. The error says
  the action may or may not have been applied; `state` remains the truth, and
  nothing is resent automatically.

New option: `connectCli(url, { ackTimeoutMs })` bounds one call (0 = wait
indefinitely). A CLI client has no page shell, so the server's per-method
budgets cannot be bridged to it — raise this for methods that legitimately run
for minutes.

## 3. Every app loses an ~8px white border

The HTML shell now ships a two-rule baseline — `box-sizing: border-box` and
`body { margin: 0 }` — on every target, **before** your `style.css`, so any of
it can be overridden with a single rule.

Until now no template and no example shipped a stylesheet, so every aio app
inherited the browser default `body { margin: 8px }` and rendered inside a white
frame nobody asked for. If your CSS already zeroes the body margin, nothing
changes. If your layout somehow depended on that 8px, set it explicitly:

```css
body {
  margin: 8px;
}
```

## New, additive

- **`expose` is a config key** — `await aio.run({ expose: true })`. A compiled
  binary can now decide to expose from code instead of needing `--expose` baked
  into its build command. `--expose` still wins over config.
- **`--expose --no-tls`** serves plain HTTP on the LAN, with a loud warning. For
  a payload that is already end-to-end encrypted, TLS was coupling you could not
  opt out of. It is CLI-only on purpose: shipping without transport encryption
  is an operator's decision at run time, not a default an author bakes into a
  binary.
- **Per-target build entry** — one repository, two apps:
  ```jsonc
  "build": {
    "targets": {
      "server":   { "entry": "src/relay/app.ts", "name": "relay" },
      "electron": { "entry": "src/app.ts" }
    }
  }
  ```
  The array form (`"targets": ["server", "electron"]`) is unchanged.
- **`t.as(user, fn)`** in `testCell`/`testUI` — test a method that reads
  `serverUser()` without importing framework internals.
- **`dbWorkerInclude()`** is exported from `aio/build`, for a repo that compiles
  an entry itself.

## Sharper edges

- A self-signed `--expose` cert now carries a **per-app** common name. Every aio
  cert used to be `CN=aio-local`, so a stale or sibling-app cert could shadow
  the right one and fail the handshake with a misleading `BadSignature`.
  Existing certs on disk are reused untouched.
- The self-signed boot warning names **non-browser clients** (`curl`, `fetch`,
  the aio CLI client) — they refuse outright where a browser offers
  click-through — and points at `am profile` / `DENO_CERT`.
- `am` **mutating** commands (`dispatch`, `sql`, `shutdown`, …) now verify they
  are talking to the app they think they are. Only reads were checked before, so
  a mutation could retarget whatever app happened to hold the port.
- `am stop --port=N` identifies the app from that port instead of the current
  directory, and says what actually went wrong ("port speaks TLS", "nothing is
  listening") instead of a bare "app not running". The no-lock message names the
  lock directory and `AIO_APPS_DIR`.
- A compiled binary that is missing the embedded SQLite worker says so and names
  `--include`, instead of advising a permissions fix that cannot help.
- `appVersion` reports `unknown (…)` when it genuinely cannot be resolved,
  rather than a confident `0.0.0`.
- An effect-budget violation names `perfBudget.methods` — the per-method escape
  hatch — so one slow method no longer pushes you to raise the budget globally
  and blind every other one.
- A **sync** method that throws still discards everything it wrote (Immer),
  while an **async** method keeps it. That asymmetry is now documented, with the
  three ways to refuse with a reason.

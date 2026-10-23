# Cross-app — one aio app using another

An orchestrator that drives several apps, a service another app calls, an AI
agent working an app: each is one program using another aio app. aio already has
every piece this needs. This page says which piece to use for what, and which
shortcuts to avoid.

## The map

| You want to…                                            | Use                                                                                            | Not                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------ |
| reuse another app's **code** (functions, types)         | a local import: Deno workspace or an import-map path                                           | copy-paste, a registry you do not need     |
| call another app's **running instance**, with no source | **`peer(appId)`** + `call` / `describe` ([below](#peer--by-appid-no-source-needed))            | the trojan API, the other app's `state.db` |
| call another app's running instance, sharing its code   | `connectCli` + `bind` (or `connectCliUDS` on one machine)                                      | the trojan API, the other app's `state.db` |
| reach "power" features beyond its UI's methods          | a role-gated **ops cell** in that app                                                          | opening the trojan API, a second RPC door  |
| be called by a **non-Deno** program (curl, Python)      | [`routes`](../examples/05-integrations.md#custom-http-routes) — plain HTTP behind aio's auth   | exposing cells over a hand-rolled protocol |
| get a result in pieces (chat tokens, progress)          | `peer().stream()` + `emitChunk` in the method ([below](#results-in-pieces--stream--emitchunk)) | pushing every piece through cell state     |
| move files / binary data between apps                   | `peer().upload()` / `peer().blob(id)` — the blob store ([below](#bytes--upload--blob))         | bytes inside a call's arguments or result  |
| a continuous binary feed (frames, samples)              | your own WebSocket route ([binary streams](../clients/binary-streams.md))                      | pushing frames through cell state          |
| let an **AI agent** work an app                         | dev: `am` · prod: the same client door as any program                                          | a prod agent backdoor                      |

Two layers, kept apart: **code** is reused by importing it; a **running app** is
used as a client, under that app's own rules.

## Layer 1 — reuse the code (no running app)

An app's pure modules — functions, types, cell definitions — are ordinary
TypeScript. Import them locally; nothing is published.

**One parent folder** — a Deno workspace:

```jsonc
// root/deno.json
{ "workspace": ["./billing", "./crm", "./orchestrator"] }

// billing/deno.json
{ "name": "@local/billing", "exports": { ".": "./mod.ts" } }
```

```ts
// orchestrator code
import { billing, priceOf } from "@local/billing";
```

**Separate folders** — a path in the import map:

```jsonc
// orchestrator/deno.json
{ "imports": { "billing/": "../billing/src/" } }
```

- **One aio version.** A workspace shares one; a path import resolves the
  imported files' `aio` through the **importer's** import map. Keep every app on
  the same exact aio pin.
- **Import modules, never the entry.** `main.ts` calls `aio.run()`; importing it
  boots that app inside yours. Export a `mod.ts` with the pure parts.
- Several runnable parts in ONE repo are already a first-class shape —
  `build.targets` with per-target entries, and `am start` runs them all
  ([app architectures](app-architectures.md#2-service--rich-clients),
  [components](../clients/app-manager.md#a-project-that-is-more-than-one-app-components)).

## Layer 2 — use the running instance

### `peer` — by appId, no source needed

The usual case: your app needs a service another aio app offers (a model server,
a billing service, a sync hub). You have its **appId**, not its code.

```ts
import { peer } from "aio/server";

const p = await peer("billing"); // null → not running on this machine
if (p) {
  const total = await p.call("ledger", "credit", 42); // runs IN billing
  console.log(total, await p.describe()); // { app, version, aio, cells: { ledger: { methods: { credit: { args: 1, async: false } } } } }
  p.close();
}
```

- **Finds it** among the running instances (lock files — no fixed port): the
  address it bound (a wildcard bind on loopback), `https` when it serves TLS
  (its certificate must be trusted), or its local socket. Two running instances
  of one appId (two data homes) → it throws and names them; stop one, or pass
  the one you mean as a URL (`peer("http://127.0.0.1:8123")`).
- **`call(cell, method, ...args)`** sends exactly the frame a bound method
  sends: same ack, same return value, same `access` gate. An unknown method, a
  denial or a throw rejects with the other app's reason.
- **`describe()`** asks the running app, over your own connection, which cells
  and methods **you** may call — filtered by its `access` rules for your
  identity. A method whose rule needs the call's arguments to decide is left
  out. It lists no state and no source. It runs each `access` predicate once per
  method, with no arguments — keep predicates pure (no logging, counting or I/O
  in them). The `am` (trojan) door does not answer it; use `am surface` /
  `am state` there.
- **Typed, still without source:** `p.cell<Ledger>("ledger").credit(42)` —
  `Ledger` is any interface of methods. The other app publishes its types with
  `aio.run({ peerTypes })` (the file's text:
  `import types from "./contract.ts" with { type: "text" }`); `describe()`
  carries them, and `am peer <appId> --types=src/peers/<appId>.ts` saves them as
  a file you import. Or `typeof` its cell, when you do share code.
- **Offline = fail, by default.** A call made while the other app is down
  rejects at once and is **never sent later**: a service answer (a translation,
  a price) is worth having now or not at all. `peer(id, { offline: "queue" })`
  keeps `connectCli`'s hold-and-replay for user intent.
- `token` (its auth), `readyTimeoutMs` (default 5 s — a wrong token or address
  throws, never hangs), `ackTimeoutMs` (`0` for long jobs) as `connectCli`.
- **`onStatus(up => …)`** fires `true` when the connection delivers the other
  app's state, `false` when it drops (never for your own `close()`) — the moment
  to re-register with a service that restarted on the same address. One that
  comes back on a NEW port is not followed: open a new `peer()`.
- `state`, `subscribe`, `connected`, `close()` (or `using p = …`).

#### Results in pieces — `stream` + `emitChunk`

A method can send its caller the result while it works — chat tokens, a render's
progress — and still return the full answer at the end:

```ts
// snippet: fragment
// the service — a method like any other
import { emitChunk } from "aio/server";
methods: {
  async ask(s, prompt: string) {
    let all = "";
    for await (const t of model(prompt)) { emitChunk(t); all += t; }
    return all;
  },
}

// the caller
const reply = p.stream<string, string>("chat", "ask", "Hi");
for await (const token of reply) show(token);
const full = await reply.result;
```

- Each piece reaches **only the call that asked for it** — two streamed calls on
  one connection never see each other's pieces.
- `emitChunk` answers `false` when nobody streams the call (a plain `call()`,
  the app's own UI, a timer), so one method serves every caller. A piece sent
  after the method returned is not sent.
- Everything the method starts **while it runs** streams to the same caller — a
  method it calls (delegation works), a timer, a promise — until the method
  returns.
- A caller that shares another call's run gets the result and no pieces:
  `concurrency: "first"` joining a run already going, or a `ttl` cache hit.
- `false` also when the caller reads too slowly: a piece is dropped, never
  queued without bound. The result is never dropped.
- A failure ends the `for await` with the method's error; `result` rejects with
  it.
- One JSON frame per piece, at most 1 MiB: `emitChunk` throws past it, for every
  caller (a plain `call()` too). Bytes go through blobs.
- Not from a cell running in a worker (`worker: true`): `emitChunk` is `false`
  there.

#### Bytes — `upload` + `blob`

Files never ride a call: they go through the other app's blob store (`app.blobs`
— streamed, content-addressed, `Range`-capable;
[big data](../persistence/big-data.md#tier-3--binaries-appblobs)), and the call
carries the id.

```ts
// snippet: fragment
const { id } = await p.upload(
  await Deno.open("talk.wav").then((f) => f.readable),
);
const text = await p.call("speech", "transcribe", id); // reads app.blobs.stream(id)
const img = await p.call<string>("image", "render", "a cat"); // returns a blob id
await (await p.blob(img)).pipeTo((await Deno.create("cat.png")).writable);
```

- `blob(id, { start, end })` reads bytes `[start, end)` — resumable downloads.
  Integers, `0 ≤ start ≤ end`; an `end` past the blob is clamped; anything else,
  or a `start` past the end, throws — never the whole blob instead. An empty
  range (`start === end`) answers empty without asking.
- `upload` is for a **proven** peer only: the other app sets `resolvePeer`
  (below), and any user it returns may upload — with no size cap, and an id no
  call ever uses stays stored. Refuse peers you would not let fill your disk in
  `resolvePeer`. An empty upload is refused (400). Anyone else uploads through a
  route the app wrote
  ([the recipe](../persistence/big-data.md#tier-3--binaries-appblobs)); reads
  follow the app's own auth.
- Over HTTP on the same port — not for an app reached over its local socket
  alone.

#### Which app is calling — `resolvePeer`

A service often needs to know **which app** called: per-app limits, freeing what
a caller held when it goes away, showing each app only its own data. No token
setup: `peer()` proves its own appId, and the service opts in.

```ts
// the service
await aio.run({
  cells,
  resolvePeer: (p) => ({ id: p.app, role: "app" }), // p = { app, pid }
  onDisconnect: (user) => releaseLeasesOf(user?.id),
});
```

From then on that connection IS that user: `access` rules, `visible.forUser` and
`onConnect`/`onDisconnect` see it, exactly as for a token login.

- **The proof:** an HMAC under the CALLER's local control credential (per boot,
  owner-only, deleted at shutdown) over caller appId and pid and the
  **callee's** appId and pid. The credential never crosses the wire; the callee
  reads it from disk to check the proof — which only the same OS user on the
  same machine can. Another local user, a remote client and a proxied request
  cannot make one. A proof is re-signed for every (re)connect, names the
  callee's current boot, and is not sent at all once the callee's lock is gone —
  so it cannot be replayed to a third app, or to the callee's next boot by
  whatever held its port in between. A caller that restarts proves itself
  afresh.
- **Opt-in.** Without `resolvePeer` the proof is ignored and every caller is
  what it was before. `resolvePeer` returning `null` = no identity; the normal
  auth decides. A proof that is presented and WRONG is refused — 401, or 429
  once the auth budget is spent; charged to it either way — never quietly served
  as anonymous.
- **Who sends it:** `peer(appId)` from inside a running aio app, as that app
  (two apps in one process: `{ as: "<appId>" }`). A URL target, a plain script
  and `am` send none. With a `token`, none is sent either: the token decides.
- **Loopback TCP only:** an app reached over its local socket alone, or bound to
  a non-loopback address, sees no identity. Ask for one there with `{ as }` and
  `peer()` throws, saying why — it is never dropped quietly.
- Same-OS-user code is trusted by construction (it can read the app's data
  directly); this proves which app is calling, it does not wall one of your own
  programs off from another.

The rest of this section is the lower layer `peer` is built on — use it when you
share the other app's cell definitions.

### `connectCli` + `bind` — sharing the code

The calling program is **a client of the other app, exactly like a browser
tab**: same wire, same server entry, same auth, same `access`/`visible` rules.
It gets live state, method calls that resolve with the method's return value,
reconnect, and an offline queue.

```ts
import { connectCli } from "aio/server";
import { instances } from "aio/extras";
import { billing } from "@local/billing"; // the other app's cell definition

// Find the running app by its appId (lock files; no fixed port).
const live = instances("billing").find((i) => i.alive && i.port > 0);
if (!live) throw new Error("billing is not running");

const app = connectCli(`http://127.0.0.1:${live.port}`, {
  token: Deno.env.get("BILLING_TOKEN"), // when billing has auth
  readyTimeoutMs: 5_000, // a wrong address/token fails loud, not hangs
});
app.bind(billing);
await app.ready;

const id = await billing.createInvoice(42); // runs IN billing, returns its value
billing.total; // live, reactive copy of billing's (visible) state
app.subscribe((s) => {/* react to billing's changes */});
```

- A UDS app reports `port: 0` and a `socketPath` — use
  `connectCliUDS(live.socketPath)`. It carries no token, so role checks need
  `connectCli`.
- Calls made while disconnected are queued and sent on reconnect (`peer` rejects
  them at once instead, and never sends them); set `ackTimeoutMs` for methods
  that run long (default 30 s).
- One cell definition binds to ONE client at a time; `close()` releases it.

### What the caller may do — the other app decides

Defaults are **open**: with no rules, every connected client may read all state
and call every method. You restrict, cell by cell:

| Rule       | Gates                    | Closed   | Allowlist                                  |
| ---------- | ------------------------ | -------- | ------------------------------------------ |
| `visible:` | what state a client sees | `"none"` | `{ include: [...] }`                       |
| `access:`  | which methods it calls   | `false`  | `(user, method) => [...].includes(method)` |

- `cellDefaults: { visible: "none" }` in `aio.run` closes state app-wide; a
  cell's own `visible` replaces it
  ([cell visibility](../state/cell-visibility.md)). There is no app-wide default
  for `access`.
- `access` and `visible` are independent: hiding state stops no call.
- Your own UI is a client too — what you hide from the orchestrator you hide
  from it, unless the rules tell them apart by **role**.

**Telling the orchestrator apart.** Give it its own identity with per-user
tokens ([multi-user auth](../auth/auth.md#multi-user-auth)) and gate on its
role:

```ts
const users = {
  [Deno.env.get("ORCH_TOKEN")!]: { id: "orchestrator", role: "orchestrator" },
  // … your human users
};
await aio.run({ cells, users });
```

### Power access — the ops cell

When the orchestrator needs more than the UI's methods — a reindex, a bulk
export, an internal query — the app exposes it **deliberately**, as one cell no
one else can see or call:

```ts
export const ops = cell("ops", {
  state: {},
  visible: "none", // nothing to broadcast
  access: "orchestrator", // only that role may call
  methods: {
    async exportAll() {/* anything server code can do: SQL, files, cells */},
    async reindex(scope: string) {/* … */},
  },
});
```

A method can run any server code, so "not reachable through methods" does not
exist — the app chooses what to open, and the role keeps it closed to everyone
else. Calls land in the timeline like any other.

`serverFns` are the stateless version of this (no state, no timeline, never
queued), gated the same way
([serverFn access](../auth/auth.md#serverfn-access)). `connectCli` has no
`serverFn` call today, so from another program use the ops cell; serverFns serve
the app's own UI.

## Who can connect at all

Before any rule, the door decides:

| The app runs                                          | Who can connect                               |
| ----------------------------------------------------- | --------------------------------------------- |
| default                                               | processes on this machine (binds `127.0.0.1`) |
| `--expose`                                            | the network, with the key or a token          |
| dev, local socket (Electron)                          | any process of the same OS user               |
| **prod Electron on its local socket**                 | **only the window it spawned** — sealed       |
| prod Electron + `electron: { allowLocalPeers: true }` | any process of the same OS user               |
| prod Electron + `--port=N`                            | processes on this machine, over TCP           |

A sealed prod Electron app can **call** other apps; it cannot **be called**. An
app meant to be orchestrated is a server/service target, or opens its door on
purpose
([local-peer lockdown](../auth/auth.md#local-peer-lockdown-production-desktop-apps)).

## AI agents

- **Dev:** `am` is the agent's interface — `am agent` (the brief), `am state`,
  `am dispatch`, `am surface` / `am trigger` (drive the UI by meaning, as
  `testUI` does), `am timeline`. It runs on the dev-only trojan API: full power,
  this machine only ([app manager](../clients/app-manager.md)).
- **Prod:** there is no agent door, by design. An agent is a program like any
  other — `connectCli` with its own token and role, under the app's rules.

## Avoid

- **The trojan API as an integration path.** It is dev-only — never mounted in
  prod — and all-or-nothing: SQL, whole-state replace, time travel.
- **Sharing a `state.db`.** Each app owns its data; another app goes through its
  methods, where `access`, validation and broadcast happen.
- **A second RPC door into the cells** (a hand-rolled socket, an RPC library).
  Its handler calls cells as SERVER code, which bypasses `access` — every caller
  gets everything — and it skips the key, the token and the local-peer lockdown.
  Keep such tools for what aio does not cover (a stdio child you spawn), on a
  socket in an owner-only directory.
- **Open methods under per-user auth.** With `users`/`auth: true`, any logged-in
  user can call every method and serverFn that has no `access` rule. Gate the
  privileged ones.
- **Value-importing another app's entry.** It boots that app inside yours.

## Testing

`testApps` runs several apps in one test process, each with its own state and
port — drive one from the other with `connectCli`
([testing two apps](../testing/multi-app.md)).

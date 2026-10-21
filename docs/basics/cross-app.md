# Cross-app — one aio app using another

An orchestrator that drives several apps, a service another app calls, an AI
agent working an app: each is one program using another aio app. aio already has
every piece this needs. This page says which piece to use for what, and which
shortcuts to avoid.

## The map

| You want to…                                             | Use                                                                                          | Not                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| reuse another app's **code** (functions, types)          | a local import: Deno workspace or an import-map path                                         | copy-paste, a registry you do not need     |
| call another app's **running instance** (state, methods) | `connectCli` + `bind` (or `connectCliUDS` on one machine)                                    | the trojan API, the other app's `state.db` |
| reach "power" features beyond its UI's methods           | a role-gated **ops cell** in that app                                                        | opening the trojan API, a second RPC door  |
| be called by a **non-Deno** program (curl, Python)       | [`routes`](../examples/05-integrations.md#custom-http-routes) — plain HTTP behind aio's auth | exposing cells over a hand-rolled protocol |
| stream bulk/binary data                                  | your own WebSocket route ([binary streams](../clients/binary-streams.md))                    | pushing frames through cell state          |
| let an **AI agent** work an app                          | dev: `am` · prod: the same client door as any program                                        | a prod agent backdoor                      |

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
- Calls made while disconnected are queued and sent on reconnect; set
  `ackTimeoutMs` for methods that run long (default 30 s).
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

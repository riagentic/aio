# App architectures — the two canonical shapes

Almost every aio deployment is one of two shapes. Both are first-class; the
difference is **where cells run**, and every build/auth/testing decision follows
from that one fact.

|                   | **1. One app, many surfaces**                                                                       | **2. Service + rich clients**                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| What it is        | ONE aio app; the server owns all cells; browser/Electron/Android are thin remote **surfaces** of it | TWO (or more) aio apps in one repo: a headless **service**, plus client apps with their **own local cells + UI** that use the service's API |
| Cells run         | on the server, once                                                                                 | in each app — the client is a full aio app; the service is another                                                                          |
| Clients hold      | a live view (state broadcast + dispatch over WS)                                                    | their own state; they **call** the service (`connectCli`) for the shared part                                                               |
| Reference example | an eshop: one catalog/cart/orders server, shoppers on browser/Android/Electron                      | a messenger: a relay service, self-sufficient desktop/CLI clients that encrypt locally and route through the relay                          |
| Config center     | `build.targets` with `server` + `*-client`                                                          | `build.targets` object form with a per-target `entry`                                                                                       |

Rule of thumb: if the client is useful **only while connected**, it is a surface
— architecture 1. If the client must **work on its own** (local data, local
features, offline) and merely _uses_ the server, it is a rich client —
architecture 2.

---

## 1. One app, many surfaces

One codebase, one `cell()` set, one server. Every client renders the same server
state and dispatches into it. This is aio's default story, and the scaffold
already carries the whole task matrix (`dev:remote:*`, `compile:remote:*`).

### Build

```jsonc
// deno.json
"build": {
  // server = the exposed --remote binary (+ systemd unit). The *-client
  // targets are thin artifacts that DIAL it. browser/electron/android
  // WITHOUT -client are LOCAL app binaries — a different thing.
  "targets": ["server", "electron-client", "android-client"],
  "server": "203.0.113.7:8000",   // where those clients will connect
  "out": "dist"
}
```

- `deno task build` builds the fleet; `dist/manifest.json` records which
  artifact is which and the server address clients dial.
- A fleet that declares `*-client` targets but **no `server` target and no
  `build.server`** warns loudly at build time — clients with nothing to dial
  build fine and ship broken.
- Cross-platform: `"platforms": ["host", "windows", "macos-arm64"]`.

### Connecting the clients

- **Electron client**: `--server-url=…` (the launcher passes it; the AppImage
  remembers it).
- **Android client**: the APK opens a connect page — a bare address for an open
  LAN server, or the **full share link** (the `?token=…` URL the server prints
  at boot / `am pair`) for a keyed one.
- **Two different gates, don't mix them up**: `auth: true` is per-user accounts
  (cookie sessions — the login UI, roles, TOTP); `--expose` with `key:` is the
  shared-key transport gate (share links, pairing PINs). An app has one or the
  other; see [auth](../auth/auth.md).

### What to get right (all documented, all tested)

- Per-user visibility: `access` gates who may **call**, `ui: { forUser }` gates
  who may **see** — a multi-user app needs both ([auth](../auth/auth.md)).
- TLS under `--expose`: browsers accept the generated self-signed cert with a
  click-through; non-browser clients need the real cert
  (`--tls-cert`/`--tls-key`) or the app's generated CA — the boot warning names
  the limitation.
- Testing: `testUI({ user })` for role-dependent screens, `testServer` for real
  auth round-trips, `am surface`/`trigger` against the live app. The off-box
  remote pass is the [validation runbook](../build/validation-runbook.md).

---

## 2. Service + rich clients

Two apps, one repository, one shared core. The service is a headless aio app
(`client: "server-only"`); each client is a _complete_ aio app — its own cells,
its own UI, its own persistence — that talks to the service over `connectCli`.

### Layout — one tree, import discipline

```
repo/
  src/app.ts            ← client entry (electron/browser app)
  src/client/…          ← client cells + UI
  src/relay/app.ts      ← service entry (headless)
  src/relay/…           ← service cells
  src/core/…            ← shared pure modules (types, protocol, crypto)
```

- Shared modules stay **pure** (no Deno APIs); server-only helpers get the
  `.server.ts` suffix and a dynamic import ([imports](../build/imports.md)).
- The client may import the service's cell **type-only**
  (`import type { relay } from "../relay/cell.ts"`) — a value import would drag
  the service into the client bundle.
- If the client entry lives outside the shared code's directory, map it for dev
  with `serveDirs: { "/shared": "src/core" }` — no copy scripts.

### Build — per-target entries, one command

```jsonc
// deno.json — the object form of build.targets carries a per-target entry
"build": {
  "targets": {
    "server":   { "entry": "src/relay/app.ts", "name": "relay" },
    "electron": { "entry": "src/app.ts" }
  },
  "out": "dist"
}
```

`deno task build` compiles both apps into one `dist/` with a manifest naming
each artifact. No custom build script: the SQLite worker `--include` is applied
automatically, staging prevents the electron build's `dist/` clean from eating
the relay binary, and `--platforms=` applies per target.

### The service

```ts
// src/relay/app.ts
await aio.run({
  cells: [relay],
  appId: "dm-relay", // its OWN id — data dirs and locks are per-app
  client: "server-only",
  expose: true, // config key — a compiled binary needs no argv
});
```

- `expose: true` in config replaces baking `--expose` into compiled argv.
- Lifecycle without `am`: `readLock(appId)` from `aio/extras` reads the live
  lock (pid, port, status) — `--status`/`--stop` flags are ~10 lines.
- `am` targets one app per invocation — set `"am": "… --app=dm-relay"` in tasks,
  or pass `--app=` per call.

### The client ↔ service link

```ts
// src/client/link.ts
const { connectCli } = await import("aio/server"); // lazy: browser-safe
const cli = connectCli<RelayState>(SERVER_URL, {
  // Expiring tokens: a FUNCTION is resolved before every (re)connect —
  // a static string 401s forever after its window on a silent reconnect.
  token: () => mintAssertion(),
});
cli.bind(relay); // typed calls: await relay.send(msg)
```

- `bind()` survives reconnects, rejects on refusal with the server's message,
  resolves with the method's return value, and `close()` releases the cells for
  rebinding (a test can run service + client in one process).
- A refused call **rejects** — no parallel error channel needed.
- Payload ceilings (`wsLimits`) are config when the defaults (1 MB frame) are
  too small for your payloads — raise them on the service, loudly, not by
  chunking in secret.

### Testing the pair

```ts
// tests/duo.test.ts — service + client app, one process, no mocks
const relayApp = await aio.run({
  cells: [relay],
  appId: `t-relay-${port}`,
  libraryMode: true,
  persist: false,
  port,
  client: "server-only",
  baseDir: dir,
});
const clientApp = await aio.run({
  cells: [local],
  appId: `t-client-${port2}`,
  libraryMode: true,
  persist: false,
  port: port2,
  baseDir: dir2,
});
const cli = connectCli(`http://127.0.0.1:${port}`);
cli.bind(relay); // drive the service exactly as the client does
// … assert on both apps' state; cli.close() releases the binding.
```

`freePort()`, `t.as(user, fn)` (caller identity in cell tests) and `totpCode`
(2FA round trips) are all on `aio/testing` — no internal imports.

---

## Naming the shapes

When a field report, an issue or a doc needs to refer to these: **"one app, many
surfaces"** (architecture 1) and **"service + rich clients"** (architecture 2).
If you're unsure which you're building, start with 1 — it is one app and no
protocol of your own; move a client to 2 only when it needs a life of its own.

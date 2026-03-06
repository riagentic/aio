```
  _v_
 (o>o)  aio
  )/   
 /|    
```

**Full-stack Deno framework — one state, propagated everywhere.** · `v0.4.0`

The state you define is the single source of truth. It persists. It syncs to all connected clients. It drives the UI. You don't move data — you declare it once, and the framework ensures every layer sees the same state: reducer, storage, WebSocket, React, every browser tab, every Electron window. No glue code, no serialization handlers, no sync logic to maintain. Write your business logic. The data plumbing is solved.

- 🟢 **One call boots everything** — server, WebSocket, React, persistence
- 🟢 **State syncs everywhere** — real-time delta patches, offline queue, replay on reconnect
- 🟢 **Ship anywhere** — binary, Electron, Android, service — same code
- 🟢 **Dev experience** — hot reload, time-travel, Redux DevTools, performance budgets
- 🟢 **Production ready** — SQLite auto-sync, auth tokens, state freeze, error overlay

- 🎯 **Use for:** desktop apps, mobile apps (Android), CLI tools, backend services, internal tools, prototypes
- ⚠️ **Not for:** public websites (SSR), large teams, battle-tested ecosystem

- 📖 [Quickstart](dep/aio/quickstart.md) — start from scratch in 5 minutes
- 📖 [Manual](dep/aio/manual.md) — full API reference
- 📖 [Migration](dep/aio/migration.md) — adopt into existing app
- 📖 [Upgrade](dep/aio/upgrade.md) — version upgrades
- 📖 [A4](dep/aio/a4.md) — architecture overview

## Build targets

One codebase → 10 targets:

| | **local** | **remote** |
|---|:---:|:---:|
| **browser** | standalone binary | exposed server + systemd |
| **Electron** | AppImage | thin client AppImage |
| **CLI** | headless server + client | client-only binary |
| **Android** | APK with server | client APK |
| **service** | 127.0.0.1 + systemd | 0.0.0.0 + auth + systemd |

```sh
deno task dev              # development (hot reload)
deno task compile          # standalone binary
deno task compile:electron # desktop AppImage
deno task compile:android  # APK
```

MIT
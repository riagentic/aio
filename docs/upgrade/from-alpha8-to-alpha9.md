# Upgrade from v1.0.0-alpha8 to v1.0.0-alpha9

> **Note:** `feature()` was renamed to `cell()` in alpha11. See
> [upgrade guide](from-alpha10-to-alpha11.md).

### Breaking changes

**`_status` → `__aio_status` (machine state internal key)**

The internal machine state field is renamed. If you were reading it directly
(which the docs warned against), update all references:

```ts
// BEFORE (alpha8)
const raw = app.getState().myFeature as { _status: string };
if (raw._status === "idle") { ... }

// AFTER (alpha9) — preferred: don't read internal key directly
const { status } = useFeature(myFeature);   // UI — stable, never changes
const s = registry.status("myFeature");     // server/test — stable

// If you must read the raw state (advanced/testing):
const raw = app.getState().myFeature as { __aio_status: string };
if (raw.__aio_status === "idle") { ... }
```

Also in `ctx.when()` and `ctx.getFullState()` inside generators — all `_status`
references must become `__aio_status`:

```ts
// BEFORE
yield * ctx.when((s) => (s.auth as { _status: string })._status === "guest");

// AFTER
yield *
  ctx.when((s) =>
    (s.auth as { __aio_status: string }).__aio_status === "guest"
  );
```

**Reserved-key guard now throws (was warn)**

If any feature has a state field named `_status` or prefixed `__aio_`, the
framework now throws at startup instead of logging a warning. Rename the field
before upgrading:

```ts
// BEFORE — feature with _status field (only warned in alpha8)
feature("myFeature", { state: { _status: "ok", count: 0 }, ... })

// AFTER — rename the field
feature("myFeature", { state: { connectionStatus: "ok", count: 0 }, ... })
```

### New APIs

**`bindFeature(feature, dispatch, getState)`**

Wire a feature to a custom dispatch bus without `aio.run()`. Useful for custom
host environments, micro-frontend composition, or unit testing with a real
reducer but no full server stack.

```ts
import { bindFeature, feature } from "aio";

const myFeature = feature("my", {
  state: { x: 0 },
  methods: {
    increment(s) {
      s.x++;
    },
  },
});

bindFeature(myFeature, customDispatch, customGetState);
await myFeature.increment();
```

Throws if the feature is already bound. Use `testFeature()` for test harnesses.

**`src/boot/` — structured startup helpers**

New module for apps that need fine-grained boot control:

```ts
import { bootIdentity, bootLock, handleCliExit, parseCli } from "aio/boot";

const cli = parseCli();
handleCliExit(cli); // handles --help / --version

const identity = await bootIdentity({
  appId: "my-app",
  configPort: 8080,
  cliPort: cli.port,
  cliTitle: cli.title,
  log,
});

const { appLock } = await bootLock({
  appId: identity.appId,
  singletonMode: true,
  killExisting: cli.killExisting ?? false,
  port: identity.port,
  log,
});
```

Electron helpers (`toSlug`, `escapeForExecuteJavaScript`,
`requireElectronVersion`, `buildWillNavigateHandler`, `buildCertificateHandler`,
`buildKeyboardShortcuts`, `WINDOW_STATE_HELPERS`) are also exported from
`aio/boot`.

### Other changes (no action required)

- Signal equality now uses `Object.is` — `NaN === NaN` in signals, cross-realm
  objects compare by duck-typing. No behavioral change for normal values.
- Persistence snapshots use `structuredClone` before KV write — prevents
  mutations after snapshot from corrupting persisted state.
- JSON fallback in dispatch now logs a warning when `structuredClone` fails —
  watch for `[aio:dispatch] effect clone fallback` in logs.
- `disable()` now rolls back if cleanup throws — the feature stays enabled
  rather than becoming permanently stuck in a disabled-but-broken state.

### Upgrade steps

1. Search for `_status` in your codebase: `grep -r "_status" src/`
2. Replace direct reads with `useFeature().status` (UI) or `registry.status()`
   (server). If you must read raw state, rename to `__aio_status`.
3. Rename any feature state field called `_status` to something else.
4. Run `deno task test` — the reserved-key guard throws at startup so you'll
   catch violations immediately.

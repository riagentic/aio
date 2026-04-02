# AIO Quickstart

Start a new aio app from scratch.

## Option A: Scaffolder (fastest)

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/init.sh)" -- my-app
```

Installs Deno if missing, then shows an interactive menu for app type and
template selection. Creates project directory, downloads framework, installs
dependencies. You get the full toolchain: dev server, build system, app manager,
all compile targets.

Skip the menus with flags:

```sh
sh -c "$(curl -fsSL ...)" -- my-app --type=electron --template=minimal
```

App types: `browser`, `electron`, `android`, `cli`, `service`, `remote-browser`,
`remote-service`, `remote-electron`, `remote-cli`, `remote-android`. Templates:
`empty`, `minimal`, `medium`, `large`.

## Option B: JSR (manual setup)

```sh
deno add jsr:@riagentic/aio
```

Then import:

```ts
import { aio, feature } from "aio";
```

Use the `deno.json` from the [README](../README.md#get-started) — it includes
all imports, compiler options, and compile tasks for every target.

> **Note:** JSR gives you the full library + build toolchain via
> `jsr:@riagentic/aio/src/am` and `jsr:@riagentic/aio/src/build`. The scaffolder
> (Option A) additionally provides interactive project creation and template
> selection.

## Manual setup

### Prerequisites

- [Deno 2.6+](https://deno.land)
- Electron (optional — for desktop window): `deno task install:electron`

After creating `deno.json` and writing files, install dependencies:

```sh
deno install
```

### deno.json

```json
{
  "title": "My App",
  "nodeModulesDir": "auto",
  "unstable": ["kv"],
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "aio"
  },
  "imports": {
    "aio": "jsr:@riagentic/aio@1.0.0-alpha8",
    "aio/air": "jsr:@riagentic/aio@1.0.0-alpha8/air",
    "esbuild": "npm:esbuild@^0.24"
  },
  "tasks": {
    "dev": "deno run -A src/app.ts",
    "am": "deno run -A jsr:@riagentic/aio@1.0.0-alpha8/src/am",
    "test": "deno test -A --unstable-kv tests/",
    "compile:browser": "deno run -A jsr:@riagentic/aio@1.0.0-alpha8/src/build --compile",
    "compile:electron": "deno run -A jsr:@riagentic/aio@1.0.0-alpha8/src/build --compile --electron",
    "compile:electron:remote": "deno run -A jsr:@riagentic/aio@1.0.0-alpha8/src/build --client",
    "compile:cli": "deno run -A jsr:@riagentic/aio@1.0.0-alpha8/src/build --compile --cli",
    "compile:service": "deno run -A jsr:@riagentic/aio@1.0.0-alpha8/src/build --compile --service --headless",
    "compile:android": "deno run -A jsr:@riagentic/aio@1.0.0-alpha8/src/build --android"
  }
}
```

- `"jsxImportSource": "aio"` — uses air, the built-in renderer (~8KB, zero
  dependencies). No React needed.
- `"title"` — app name, used as default window title and binary name (lowercased
  slug) when compiling. Optional, falls back to `"AIO App"`.
- `"esbuild"` — required for dev mode transpilation and bundle step. Excluded
  from compiled binary automatically.
- `immer`, `@std/path` — internal framework deps, resolved automatically via
  JSR. Do **not** add them to your import map.

### File structure

```
deno.json
src/
  app.ts                       ← aio.run({ features }) — boot only
  App.tsx                      ← root UI — layout + routing only
  features/counter/index.ts    ← feature() — state, methods, machine
  style.css                    ← (optional)
```

### features/counter/index.ts

```ts
import { feature } from "aio";

export const counter = feature("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
    decrement(s, by = 1) {
      s.count -= by;
    },
    reset(s) {
      s.count = 0;
    },
  },
});
```

### Choosing a programming style

aio offers three styles — pick the simplest that fits your use case:

| Use this...            | When...                                                      | Examples                                       |
| ---------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| **`methods`**          | State changes are direct, async is independent               | Counter, form fields, toggles, simple CRUD     |
| **`generators`**       | Steps must run in order, need timeout/retry/race             | API fetch sequences, multi-step flows, polling |
| **`actions + reduce`** | Need strict state machine transitions, multiple entry points | Checkout wizard, auth flows, complex gating    |

**Start with `methods`.** You need `generators` when:

- Two async calls must happen in sequence
- You need `.timeout()` or `.retries()` on a call
- You need `.race()` between two operations

**You need `actions + reduce` when:**

- The same state change can be triggered from multiple places
- You need strict state machine guards (idle → loading → done/error)

```ts
// methods — for simple state updates
export const counter = feature("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
  },
});

// generators — for sequential workflows with timeout/retry
export const fetcher = feature("fetcher", {
  state: { data: null, loading: false },
  *fetch(ctx, url: string) {
    ctx.mutate("loading", (s) => {
      s.loading = true;
    });
    const result = yield* ctx.call("fetch", () => fetch(url), {
      timeout: 5000,
    });
    ctx.mutate("done", (s) => {
      s.data = result;
      s.loading = false;
    });
  },
});

// actions + reduce — for state machine control
export const checkout = feature("checkout", {
  state: { step: "idle" as "idle" | "processing" | "done" },
  actions: {
    start: () => ({}),
    complete: () => ({}),
  },
  reduce: {
    start(state) {
      state.step = "processing";
    },
    complete(state) {
      state.step = "done";
    },
  },
});
```

### App.tsx

```tsx
import { useFeature } from "aio/air";
import { counter } from "./features/counter/index.ts";

export default function App() {
  const { state, send, status } = useFeature(counter);
  if (!state) return <div>Connecting...</div>;

  return (
    <div>
      <h1>{state.count}</h1>
      <p>Status: {status}</p>
      <button onClick={() => send.decrement()}>-</button>
      <button onClick={() => send.reset()}>Reset</button>
      <button onClick={() => send.increment()}>+</button>
    </div>
  );
}
```

### app.ts

```ts
import { aio } from "aio";
import { counter } from "./features/counter/index.ts";

await aio.run({
  appId: "my-app", // required — unique per deployment
  appVersion: "1.0.0", // required — for version tracking, crash reports, KV schema migration
  features: [counter],
});
```

### Run

```sh
deno task dev
```

That's it. Electron window opens, state persists across restarts, multiple
browser tabs stay in sync.

> **No Electron?** Add `--client=browser` to open in your browser instead:
> `deno task dev --client=browser`

`aio.run()` returns an app object with runtime feature control — see
[core.md](core.md#return-value--appfeatures) for `app.features.health()`,
`enable()`, `disable()`, and more.

### Window size

Set default Electron window dimensions in your `aio.run()` config:

```ts
await aio.run({
  appId: "my-app",
  features: [counter],
  ui: { title: "My App", width: 1200, height: 800 },
});
```

Or via CLI: `deno task dev --width=1200 --height=800`. Window bounds persist
across runs automatically.

### Adding middleware & versioning

```ts
await aio.run({
  appId: "my-app",
  appVersion: "1.0.0", // required in v1.0
  features: [counter],
  middleware: [aio.middleware.logger(), aio.middleware.validate()],
});
```

### Testing

```ts
import { testFeature } from "aio";
import { counter } from "./features/counter/index.ts";

// Sync tests
testFeature(counter, "increment from idle", (t) => {
  t.init();
  t.send.increment(5);
  t.expect.state((s) => s.count === 5);
  t.expect.status("idle");
});

// Async tests
testFeature(backup, "runs backup", async (t) => {
  t.init();
  t.send.run();
  t.runEffects(); // execute pending effects
  await t.settle(); // wait for async completion
  t.expect.state((s) => s.lastBackup !== null);
});
```

### Async methods and call()

Async methods have the same `(state, ...args)` signature as sync methods — a
live Proxy replaces the state draft:

```ts
import { call, feature } from "aio";

export const api = feature("api", {
  state: { data: null as string | null },
  methods: {
    // Sync and async — same signature
    clear(s) {
      s.data = null;
    },

    async fetch(s, url: string) {
      const res = await fetch(url);
      s.data = await res.text();
    },

    // Direct cross-feature calling — import and call directly (typed)
    async saveAndNotify(s) {
      await notifications.send("Data saved!"); // or: await call({ timeout: 3000 }, () => notifications.send('Data saved!'))
      s.lastNotified = Date.now();
    },
  },
});
```

### Immer proxy restrictions

State in `methods` is a live Immer draft. Some patterns break the proxy chain
and will throw a `PROXY_ERROR`:

```
DON'T:  s.items.map(x => ...)       // creates new array — breaks proxy
DON'T:  s.items.filter(x => ...)    // creates new array — breaks proxy
DON'T:  s.items.splice(...)         // mutates in-place but returns new — breaks proxy
DON'T:  const x = {...s}            // spread to plain object — loses reactivity
DON'T:  Object.keys(s)              // returns own keys, not tracked paths
DON'T:  for (const k in s)          // enumerates, not reliable for proxy tracking
```

```
DO:     s.items.forEach(x => ...)   // OK — iterates without replacement
DO:     s.items.length              // OK — direct property access
DO:     s.items[0]                 // OK — direct index access
DO:     const arr = [...s.items]    // OK — snapshot to NEW array first
DO:     for (const item of s.items) // OK — iteration
DO:     s.nested.value             // OK — direct path access
```

If you need array operations, snapshot first: `const items = [...s.items];` then
operate on the snapshot — Immer will apply the changes to the draft.

### Awaiting methods

Async methods return `Promise<void>` (or `Promise<T>` if they return a value).
All method calls can be fire-and-forget or awaited:

```ts
// Fire-and-forget — OK when order doesn't matter
counter.increment();
counter.fetch("/data.json");

// With await — when order matters
await counter.increment();
await counter.fetch("/data.json"); // waits for fetch + state sync before continuing

// With await + return value
const result = await counter.fetch("/data.json"); // returns method's return value
```

Use `await` when subsequent code depends on the state change being applied.

### Advanced / explicit control — actions + reduce

> **Don't start here.** Use `methods` first. Reach for `actions + reduce` only
> when you need complex reactive logic, multiple entry points to the same state
> change, or strict machine gating that methods can't express.

When you need fine-grained control over state transitions:

```ts
import { feature } from "aio";

export const checkout = feature("checkout", {
  state: { step: "idle" as "idle" | "processing" | "done" },
  actions: {
    start: () => ({}),
    complete: () => ({}),
  },
  reduce: {
    start(state) {
      state.step = "processing";
    },
    complete(state) {
      state.step = "done";
    },
  },
});
```

---

## Using React instead of air

air is the default renderer — zero dependencies, ~8KB. If you prefer React
(existing codebase, React ecosystem libraries), add React to your project:

**deno.json changes:**

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "jsxImportSourceTypes": "@types/react"
  },
  "imports": {
    "aio": "jsr:@riagentic/aio@1.0.0-alpha8",
    "aio/react": "jsr:@riagentic/aio@1.0.0-alpha8/react",
    "@types/react": "npm:@types/react@^18",
    "react": "npm:react@^18",
    "react-dom": "npm:react-dom@^18",
    "esbuild": "npm:esbuild@^0.24"
  }
}
```

**App.tsx** — import from `aio/react` instead of `aio/air`:

```tsx
import { useFeature } from "aio/react";
import { counter } from "./features/counter/index.ts";

export default function App() {
  const { state, send, status } = useFeature(counter);
  if (!state) return <div>Connecting...</div>;

  return (
    <div>
      <h1>{state.count}</h1>
      <button onClick={() => send.increment()}>+</button>
    </div>
  );
}
```

Everything else (features, server, build, testing) is identical. Only the import
path and `deno.json` compiler options change. See [renderer.md](renderer.md) for
a detailed comparison.

---

## Troubleshooting

**"Electron not found" or app window doesn't open** Run
`deno task install:electron` first, or use `deno task dev -- --client=browser`
to open in your browser instead.

**"Module not found: aio"** Run `deno install` to download dependencies. Make
sure your `deno.json` has the `"aio"` import mapped to
`jsr:@riagentic/aio@1.0.0-alpha8`.

**State resets on every restart** This is normal in dev if you changed your
state shape. aio auto-persists to Deno.Kv — if the shape changed, the old state
is merged with new defaults via `deepMerge`. Delete `data.kv/` to start fresh.

**Port 8000 already in use** Another aio instance (or another app) is using the
default port. Use `deno task am stop` to stop a running instance, or run with a
different port: `deno task dev -- --port=9000`.

**Hot reload not working** Make sure `prod: false` (the default in dev). Only
files in `src/` with standard extensions (`.ts`, `.tsx`, `.js`, `.css`) trigger
reload.

---

## Next steps

- [core.md](core.md) — feature API reference, actions/reduce, flows
- [features.md](features.md) — inter-feature communication patterns
- [generators.md](generators.md) — sequential async workflows with generators
- [structure.md](structure.md) — file & directory organization guide
- [migration.md](migration.md) — adopting aio into an existing app
- [upgrade.md](upgrade.md) — version upgrade guide

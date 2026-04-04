# AIO Quickstart

Start a new aio app from scratch.

## Option A: Scaffolder (fastest)

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/init.sh)" -- my-app
```

Installs Deno if missing, then shows an interactive menu for app type and
template selection. Skip the menus with flags:

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

## Prerequisites

- [Deno 2.6+](https://deno.land)
- Electron (optional): `deno task install:electron`

## deno.json

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
    "compile:cli": "deno run -A jsr:@riagentic/aio@1.0.0-alpha8/src/build --compile --cli",
    "compile:service": "deno run -A jsr:@riagentic/aio@1.0.0-alpha8/src/build --compile --service --headless",
    "compile:android": "deno run -A jsr:@riagentic/aio@1.0.0-alpha8/src/build --android"
  }
}
```

- `"jsxImportSource": "aio"` — uses air, the built-in renderer (~8KB, zero deps)
- `"title"` — app name, used as window title and binary name
- `immer`, `@std/path` — internal deps, resolved automatically via JSR

## File structure

```
deno.json
src/
  app.ts                       <- aio.run({ features }) -- boot only
  App.tsx                      <- root UI -- layout + routing only
  features/counter/index.ts    <- feature() -- state, methods, machine
  style.css                    <- (optional)
```

## Define a feature

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

## Choosing a programming style

| Use this...            | When...                                     | Examples                                    |
| ---------------------- | ------------------------------------------- | ------------------------------------------- |
| **`methods`**          | Direct state changes, independent async     | Counter, forms, toggles, CRUD               |
| **`generators`**       | Sequential steps, timeout/retry/race        | API fetch sequences, polling, multi-step    |
| **`actions + reduce`** | Strict state machine, multiple entry points | Checkout wizard, auth flows, complex gating |

**Start with `methods`.** Reach for `generators` when you need sequential async
with timeout/retry, or `actions + reduce` for strict machine gating.

```ts
// generators -- for sequential workflows with timeout/retry
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
```

## Create the UI

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

## Boot the app

```ts
import { aio } from "aio";
import { counter } from "./features/counter/index.ts";

await aio.run({
  appId: "my-app",
  appVersion: "1.0.0",
  features: [counter],
});
```

## Run

```sh
deno task dev
```

Electron window opens, state persists across restarts, multiple browser tabs
stay in sync. No Electron? Use `deno task dev --client=browser`.

## Window size

```ts
await aio.run({
  appId: "my-app",
  features: [counter],
  ui: { title: "My App", width: 1200, height: 800 },
});
```

Or via CLI: `deno task dev --width=1200 --height=800`.

## Testing

```ts
import { testFeature } from "aio";
import { counter } from "./features/counter/index.ts";

testFeature(counter, "increment from idle", (t) => {
  t.init();
  t.send.increment(5);
  t.expect.state((s) => s.count === 5);
  t.expect.status("idle");
});

testFeature(backup, "runs backup", async (t) => {
  t.init();
  t.send.run();
  t.runEffects();
  await t.settle();
  t.expect.state((s) => s.lastBackup !== null);
});
```

## Async methods

```ts
import { call, feature } from "aio";

export const api = feature("api", {
  state: { data: null as string | null },
  methods: {
    clear(s) {
      s.data = null;
    },
    async fetch(s, url: string) {
      const res = await fetch(url);
      s.data = await res.text();
    },
  },
});
```

Methods return `Promise<void>` (or `Promise<T>`). Use `await` when subsequent
code depends on the state change being applied.

## Immer proxy restrictions

State in `methods` is a live Immer draft. These patterns break the proxy:

```
DON'T:  s.items.map(x => ...)       // creates new array -- breaks proxy
DON'T:  s.items.filter(x => ...)    // creates new array -- breaks proxy
DON'T:  const x = {...s}            // spread to plain object -- loses reactivity

DO:     s.items.forEach(x => ...)   // OK -- iterates without replacement
DO:     s.items[0]                  // OK -- direct index access
DO:     const arr = [...s.items]    // OK -- snapshot to NEW array first
```

## Using React instead of air

Change `deno.json` to `"jsxImportSource": "react"`, add React imports, then
import from `aio/react` instead of `aio/air`. Everything else is identical. See
[../renderer.md](../renderer.md) for details.

## Troubleshooting

- **"Electron not found"** -- Run `deno task install:electron`, or use
  `--client=browser`
- **"Module not found: aio"** -- Run `deno install`, check import map
- **State resets on restart** -- Normal if state shape changed. Delete
  `data.kv/` to start fresh
- **Port 8000 in use** -- Use `deno task am stop` or `--port=9000`
- **Hot reload not working** -- Ensure `prod: false` (default in dev)

## Next steps

- [concepts.md](concepts.md) -- mental model and framework rules
- [project-structure.md](project-structure.md) -- file organization
- [api-reference.md](api-reference.md) -- all exports
- [migration.md](migration.md) -- adopting aio into an existing app

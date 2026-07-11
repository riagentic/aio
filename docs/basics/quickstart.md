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

Add `--vendored` to git-clone the framework into `dep/aio/` (instead of the
default tarball snapshot) — keeps `.git` so `git -C dep/aio pull` updates it.
The generated `deno.json` already declares the vendored import map (`aio`,
`immer`, `@std/path`), so no manual wiring is needed either way.

## Option B: JSR (manual setup)

> **During the alpha/beta, use Option A.** The JSR package
> ([`@riagentic/aio`](https://jsr.io/@riagentic/aio)) currently trails the
> tagged releases (latest on JSR is an alpha), so a `deno add` may resolve an
> older version than this repo. The scaffolder (Option A) and `--vendored`
> install always match the current framework.

Once the version you want is on JSR:

```sh
deno add jsr:@riagentic/aio
```

Then import:

```ts
import { aio, cell } from "aio";
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
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "lib": ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
    "jsx": "react-jsx",
    "jsxImportSource": "aio"
  },
  "imports": {
    "aio": "jsr:@riagentic/aio@^1.0.0-alpha17",
    "aio/air": "jsr:@riagentic/aio@^1.0.0-alpha17/air",
    "aio/jsx-runtime": "jsr:@riagentic/aio@^1.0.0-alpha17/jsx-runtime",
    "esbuild": "npm:esbuild@^0.24",
    "electron": "npm:electron"
  },
  "tasks": {
    "dev": "deno run -A src/app.ts",
    "install:electron": "deno install --allow-scripts=npm:electron",
    "am": "deno run -A jsr:@riagentic/aio/am",
    "test": "deno test -A --unstable-kv tests/",
    "compile:browser": "deno run -A jsr:@riagentic/aio/build --compile",
    "compile:electron": "deno run -A jsr:@riagentic/aio/build --compile --electron",
    "compile:cli": "deno run -A jsr:@riagentic/aio/build --compile --cli",
    "compile:service": "deno run -A jsr:@riagentic/aio/build --compile --service --headless",
    "compile:android": "deno run -A jsr:@riagentic/aio/build --android"
  }
}
```

- `"jsxImportSource": "aio"` — uses air, the built-in renderer (~8KB, zero deps)
- `"aio/jsx-runtime"` entry is required so the JSX compiler can resolve the
  runtime when it rewrites `<div/>` into `jsx()` calls
- `"title"` — app name, used as window title and binary name
- Internal deps (`immer`, `@std/path`, …) are fetched transitively by JSR — no
  consumer entries needed

### Vendored variant (`dep/aio/`)

When aio is checked out as a sibling repo at `dep/aio/` (local development,
air-gapped builds, or pinning to an untagged commit), the import map points at
local files and must also declare aio's internal bare-specifier deps (Deno can't
fetch them transitively without a JSR manifest):

```json
{
  "title": "My App",
  "nodeModulesDir": "auto",
  "unstable": ["kv"],
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "lib": ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
    "jsx": "react-jsx",
    "jsxImportSource": "aio"
  },
  "imports": {
    "aio": "./dep/aio/mod.ts",
    "aio/air": "./dep/aio/src/air.ts",
    "aio/jsx-runtime": "./dep/aio/src/jsx-runtime.ts",
    "immer": "npm:immer@10.2.0",
    "@std/path": "jsr:@std/path@1.1.3",
    "esbuild": "npm:esbuild@^0.24",
    "electron": "npm:electron"
  },
  "tasks": {
    "dev": "deno run -A src/app.ts",
    "install:electron": "deno install --allow-scripts=npm:electron",
    "am": "deno run -A ./dep/aio/src/am.ts",
    "test": "deno test -A --unstable-kv tests/",
    "compile:browser": "deno run -A ./dep/aio/src/build.ts --compile",
    "compile:electron": "deno run -A ./dep/aio/src/build.ts --compile --electron",
    "compile:cli": "deno run -A ./dep/aio/src/build.ts --compile --cli",
    "compile:service": "deno run -A ./dep/aio/src/build.ts --compile --service --headless",
    "compile:android": "deno run -A ./dep/aio/src/build.ts --android"
  }
}
```

Clone aio into `dep/aio/` and you're set:

```sh
mkdir -p dep && git clone https://github.com/riagentic/aio dep/aio
```

Or let the scaffolder do both (clone + correct deno.json) in one step:

```sh
sh -c "$(curl -fsSL ...)" -- my-app --vendored
```

The rest of the project (`import { cell } from "aio"`) is unchanged — the import
map abstracts the source.

## File structure

```
deno.json
src/
  app.ts                       <- aio.run() -- boot only
  App.tsx                      <- root UI -- layout + routing only (convention; override with ui.entry)
  cell/counter/index.ts    <- cell() -- state + methods (or generators)
  style.css                    <- (optional)
```

## Define a cell

```ts
import { cell } from "aio";

export const counter = cell("counter", {
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

## Programming style

**Start with `methods`.** They handle state changes, async work, and side
effects in one place. This covers the vast majority of apps.

When you outgrow methods, aio has generators for sequential async workflows and
an explicit actions/reduce pipeline for strict state machines — see the
[State Management](../state/README.md) guide for L2 and L3 patterns.

## Create the UI

```tsx
import { counter } from "./cell/counter/index.ts";

export default function App() {
  return (
    <div>
      <h1>{counter.count}</h1>
      <button type="button" onClick={() => counter.decrement()}>-</button>
      <button type="button" onClick={() => counter.reset()}>Reset</button>
      <button type="button" onClick={() => counter.increment()}>+</button>
    </div>
  );
}
```

## Boot the app

```ts
import "./cell/counter/index.ts"; // defines + registers the cell
import { aio } from "aio";

await aio.run(); // zero config
```

Everything is inferred: `appId`/`title` from `deno.json` (or the entry's
directory name), `version` from `deno.json`, cells from the registry (every
imported `cell()` self-registers), `baseDir` from the entry module. Pass config
only to override.

## Run

```sh
deno task dev
```

Electron window opens, state persists across restarts, multiple browser tabs
stay in sync. No Electron? Use `deno task dev --client=browser`.

## Window size

```ts
await aio.run({
  ui: { width: 1200, height: 800 },
});
```

Or via CLI: `deno task dev --width=1200 --height=800`.

## Testing

```ts
import { testCell } from "aio";
import { counter } from "./cell/counter/index.ts";

testCell(counter, "increment from idle", (t) => {
  t.init();
  t.send.increment(5);
  t.expect.state((s) => s.count === 5);
  t.expect.status("idle");
});

testCell(counter, "async settle", async (t) => {
  t.init();
  t.send.increment(1);
  await t.settle();
  t.expect.state((s) => s.count === 1);
});
```

## Async methods

```ts
import { call, cell } from "aio";

export const api = cell("api", {
  state: { data: null as string | null },
  methods: {
    clear(s) {
      s.data = null;
    },
    async fetch(s, url: string) {
      // `call` adds timeout/retry around any async work
      const text = await call(
        { timeout: 5000, retries: 2 },
        async () => (await fetch(url)).text(),
      );
      s.data = text;
    },
  },
});
```

Methods return `Promise<void>` (or `Promise<T>`). Use `await` when subsequent
code depends on the state change being applied.

## State in methods is a standard Immer draft

State in `methods` is an Immer draft. Plain reads, spreads, `.map`/`.filter`,
`Object.keys`, and `JSON.stringify` all work — the only rule is that **values
you take OUT of a method** (effect payloads, return values, logs) are snapshots.
aio clones them for you; the live draft stays in the method body.

```ts
methods: {
  toggle(s) {
    s.done = !s.done;                          // mutation — tracked
    const count = s.items.length;               // read — works
    const filtered = s.items.filter((x) => x.active); // read — works
    const copy = { ...s, updatedAt: Date.now() };     // read + extend — works
    return { itemCount: count, active: filtered, snapshot: copy };
  },
}
```

Mutations to the draft are batched and produce a state diff. Reads on the draft
see the current (mutated) state. Values returned or passed to
`return [cell.fx.persist(s)]` are snapshots of the current draft — they are not
reactive.

For the live-proxy read semantics inside `async` methods (where you `await`
something and re-read state), see
[Methods — async live proxy](../state/methods.md).

## Troubleshooting

- **First step, always:** `deno task doctor` — emitted by every scaffold (or
  `deno run -A dep/aio/src/server/doctor.ts` vendored,
  `jsr:@riagentic/aio@1.0.0-alpha19/doctor`). Validates the magic deno.json
  lines (jsx, jsxImportSource, import map entries, kv, electron nodeModulesDir,
  Deno version) with a one-line fix per failure.

- **"Electron not found"** -- Run `deno task install:electron`, or use
  `--client=browser`
- **"Module not found: aio"** -- Run `deno install`, check import map
- **State resets on restart** -- Persistence is ON by default; a reset means the
  state shape changed (old keys deep-merge with new defaults — see
  [cell versioning](../state/cells.md)) or `data.kv/` was deleted
- **Port 8000 in use** -- Use `deno task am stop` or `--port=9000`
- **Hot reload not working** -- Ensure `prod: false` (default in dev)

## Next steps

- [concepts.md](concepts.md) -- mental model and framework rules
- [project-structure.md](project-structure.md) -- file organization
- [api-reference.md](api-reference.md) -- all exports
- [migration.md](migration.md) -- adopting aio into an existing app

# AIO Quickstart

Start a new aio app from scratch.

## Install `am`, then create (the one path)

```sh
# installs Deno if missing, clones the framework, puts `am` (the aio manager) on your PATH
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/riagentic/aio/main/install.ps1 | iex
```

Then scaffold and run — a full app in two commands:

```sh
am create my-app                 # counter (default) · --template=todo · --template=cli
cd my-app
deno task dev                    # prints the app's URL (pass --open to open a browser)
```

`dev` picks a free port and prints the app's URL — a line like
`open http://localhost:<port> in your browser (or pass --open)` — then waits
(`am open` opens that URL later; `am instances` lists every running app's port).
A browser tab is not opened for you: a tab handed to a running browser belongs
to that browser, so aio cannot close it when the app exits. Pass `--open` if you
want one anyway. An Electron window is a child process aio owns, so
`deno task dev --client=electron` does open by itself.

## What you got

```
deno.json                        <- config + tasks + the aio pin
.gitignore
src/app.ts                       <- aio.run() -- boot only
src/cell.ts                      <- cell() -- state + methods
src/App.tsx                      <- root UI (convention; override with ui.entry)
src/client.ts                    <- thin CLI client (the cli-client build target)
tests/cell.test.ts               <- a passing starter test
README.md
dep/aio                          <- symlink to the pinned framework (gitignored)
```

The project is git-initialized, `deno task test` passes as scaffolded, and it
builds with two tasks — `deno task compile` (a binary for the app's default
target) and `deno task build --targets=electron|android` (any other target;
`--list` prints them). `deno task doctor`, `deno task lint` and `deno task ship`
are scaffolded too.

It is also **pinned to an exact aio version**, recorded in its own `deno.json`
(`"aioVersion": "v1.0.0-alphaNN"`) and committed with your code. So the app you
push is the app your colleague builds:

```sh
git clone <your-app> && cd <your-app>
am fix            # provisions exactly that aio version and links it
deno task dev
```

`am pin` shows what an app uses; `am pin <version>` switches it; `am pin main`
follows the branch tip. `am create --aio-version=…` picks the version up front.
See
[app manager](../clients/app-manager.md#which-aio-version-an-app-builds-against).

Keep `am` current with `am upgrade`; remove it with `am uninstall` (your apps
are left untouched).

Something wrong? `deno task doctor` first, then
[Troubleshooting](#troubleshooting) below.

## Next steps

- [concepts.md](concepts.md) -- mental model and framework rules
- [project-structure.md](project-structure.md) -- file organization
- [api-reference.md](api-reference.md) -- all exports
- [migration.md](migration.md) -- adopting aio into an existing app

---

## Reference

You do not need any of this if you used `am create` — it is what the scaffold
already wrote, spelled out for hand-wiring and for looking things up.

### Prerequisites

- [Deno 2.9+](https://deno.land) (aio tracks the latest stable Deno)
- Electron: nothing — dev auto-installs it, a compiled binary fetches it once
  (`deno task install:electron` only pre-downloads for a checkout)

### Installing `am` without `curl | sh`

The installer is not a JSR install. It clones this repository to `$AIO_HOME`
(default `~/.local/lib/aio`) and installs `am` **from that clone**, so `am` and
the framework it scaffolds against are the same tree:

```sh
git clone https://github.com/riagentic/aio ~/.local/lib/aio
deno install -gAf --config ~/.local/lib/aio/deno.json -n am ~/.local/lib/aio/src/am.ts
```

Do **not** install from a `jsr:@riagentic/aio@^1.0.0-alpha` range.
`1.0.0-alphaN` prereleases sort lexically, so that range resolves to `alpha9`
(`'9' > '2'`) and Deno caches the mis-resolution — the reason JSR stopped being
the default (CHANGELOG, "Why JSR is no longer the default"). If you use JSR at
all, pin an exact version: `jsr:@riagentic/aio@1.0.0-alpha68`.

### deno.json (what `am create` generates)

`am create` defaults to **source mode**: the app imports aio through a `dep/aio`
symlink to the pinned checkout, so the import map stays relative and portable.
This is the file it writes for `am create my-app` (browser target):

```json
{
  "title": "my-app",
  "version": "0.1.0",
  "client": "browser",
  "build": {
    "targets": ["browser"],
    "platforms": ["host"],
    "out": "dist"
  },
  "fmt": {
    "exclude": [".katana/", "feedback/", "dist/", "node_modules/"]
  },
  "nodeModulesDir": "auto",
  "compilerOptions": {
    "lib": ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
    "jsx": "react-jsx",
    "jsxImportSource": "aio"
  },
  "imports": {
    "aio": "./dep/aio/mod.ts",
    "aio/air": "./dep/aio/src/air.ts",
    "aio/air/compat": "./dep/aio/src/air-compat.ts",
    "aio/ui": "./dep/aio/src/ui/mod.ts",
    "aio/jsx-runtime": "./dep/aio/src/jsx-runtime.ts",
    "aio/server": "./dep/aio/src/server-entry.ts",
    "aio/state-core": "./dep/aio/src/state-core.ts",
    "aio/db": "./dep/aio/src/db/mod.ts",
    "aio/extras": "./dep/aio/src/extras/mod.ts",
    "aio/sync": "./dep/aio/src/sync/mod.ts",
    "aio/testing": "./dep/aio/src/cell-test.ts",
    "aio/updates": "./dep/aio/src/updates.ts",
    "aio/feedback": "./dep/aio/src/feedback.ts",
    "aio/build": "./dep/aio/src/build.ts",
    "esbuild": "npm:esbuild@^0.24",
    "immer": "npm:immer@^10",
    "happy-dom": "npm:happy-dom@^17",
    "@std/path": "jsr:@std/path@^1",
    "@std/assert": "jsr:@std/assert@^1",
    "electron": "npm:electron"
  },
  "tasks": {
    "dev": "deno run -A src/app.ts",
    "build": "deno run -A ./dep/aio/src/build-all.ts --build-spec=./dep/aio/src/build.ts",
    "compile": "deno run -A ./dep/aio/src/build-all.ts --build-spec=./dep/aio/src/build.ts --targets=browser",
    "ship": "deno run -A ./dep/aio/src/build/ship.ts",
    "test": "deno test -A",
    "check": "deno check src/",
    "fmt": "deno fmt",
    "lint": "deno run -A ./dep/aio/aiol/mod.ts",
    "doctor": "deno run -A ./dep/aio/src/server/doctor.ts",
    "am": "deno run -A ./dep/aio/src/am.ts"
  }
}
```

- `"jsxImportSource": "aio"` — uses air, the built-in renderer (63 KB gzipped
  with the client runtime, zero deps)
- `"aio/jsx-runtime"` entry is required so the JSX compiler can resolve the
  runtime when it rewrites `<div/>` into `jsx()` calls
- `"title"` — app name, used as window title and binary name
- Every public entry is mapped, not just the ones the template uses — a
  specifier the app cannot resolve is the "docs lie" class of failure
- Source mode must also map aio's own bare deps (`esbuild`, `immer`,
  `happy-dom`, `@std/*`); JSR would resolve those transitively
- `install:electron` is scaffolded only for an electron app, `install:android`
  only for an android one
- The `dep/aio` symlink is gitignored — a clone repairs it with `am fix`

Wiring by hand? Clone aio into `dep/aio/` and the map above works as written:

```sh
mkdir -p dep && git clone https://github.com/riagentic/aio dep/aio
```

#### JSR variant (`am create --jsr`)

`--jsr` swaps every `./dep/aio/…` specifier for an **exact** pin
(`jsr:@riagentic/aio@1.0.0-alpha68`, `…@1.0.0-alpha68/air`, …) and drops the
bare-dep entries, which JSR resolves transitively. Tasks change the same way —
`"doctor": "deno run -A jsr:@riagentic/aio@1.0.0-alpha68/doctor"`. Never a
range; see the note above.

The rest of the project (`import { cell } from "aio"`) is unchanged — the import
map abstracts the source.

### Define a cell

`src/cell.ts`:

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

### Programming style

**Methods are the one style.** They handle state changes, async work, and side
effects in one place — multi-step workflows are async methods with
`until`/`race`/`sleep`, cancellation is `cancelOn` + `s.$signal`. See the
[State Management](../state/README.md) guide.

### Create the UI

`src/App.tsx`:

```tsx
import { counter } from "./cell.ts";

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

### Boot the app

`src/app.ts`:

```ts
import "./cell.ts"; // defines + registers the cell
import { aio } from "aio";

await aio.run(); // zero config
```

Everything is inferred: `appId`/`title` from `deno.json` (or the entry's
directory name), `version` from `deno.json`, cells from the registry (every
imported `cell()` self-registers), `baseDir` from the entry module. Pass config
only to override.

### Run

```sh
deno task dev
```

The URL is printed, state persists across restarts, and multiple tabs stay in
sync. Want the desktop shell instead? `deno task dev --client=electron`.

It renders with the browser's own defaults — aio styles nothing you did not ask
it to. For a finished look without writing CSS, opt in with
`aio.run({ ui: { theme: "auto" } })` ([the default theme](../ui/theme.md)); it
steps aside the moment you write your own `style.css`.

### Window size

```ts
import { aio } from "aio";

await aio.run({
  ui: { width: 1200, height: 800 },
});
```

Or via CLI: `deno task dev --width=1200 --height=800`.

### Testing

`tests/cell.test.ts`:

```ts
import { testCell } from "aio/testing";
import { counter } from "../src/cell.ts";

testCell(counter, "increment from idle", (t) => {
  t.init();
  t.send.increment(5);
  t.expect.state((s) => s.count === 5);
});

testCell(counter, "async settle", async (t) => {
  t.init();
  t.send.increment(1);
  await t.settle();
  t.expect.state((s) => s.count === 1);
});
```

### Async methods

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
        { timeoutMs: 5000, retries: 2 },
        async () => (await fetch(url)).text(),
      );
      s.data = text;
    },
  },
});
```

Methods return `Promise<void>` (or `Promise<T>`). Use `await` when subsequent
code depends on the state change being applied.

### State in methods is a standard Immer draft

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
see the current (mutated) state. Values returned (or put into a returned
schedule/own effect) are snapshots of the current draft — they are not reactive.

For the live-proxy read semantics inside `async` methods (where you `await`
something and re-read state), see
[Methods — async live proxy](../state/methods.md).

### Troubleshooting

- **First step, always:** `deno task doctor` — emitted by every scaffold (or
  `deno run -A dep/aio/src/server/doctor.ts` for a hand-wired app). Validates
  the magic deno.json lines (jsx, jsxImportSource, import map entries, electron
  nodeModulesDir, Deno version) with a one-line fix per failure.

- **"Electron … could not be fetched"** -- the machine cannot reach
  github.com/electron releases (or npm, in dev). Fix the network, point
  `$ELECTRON_PATH` at an Electron you have, or use `--client=browser`
- **"Module not found: aio"** -- Run `am fix` (source mode: the `dep/aio`
  symlink is gitignored), or check the import map
- **State resets on restart** -- Persistence is ON by default; a reset means the
  state shape changed (old keys deep-merge with new defaults — see
  [cell versioning](../state/cells.md)) or `state.db` was deleted
- **Port 8000 in use** -- Use `deno task am stop` or `--port=9000`
- **Hot reload not working** -- Ensure `prod: false` (default in dev)

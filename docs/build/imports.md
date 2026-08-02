# Import Rules: Server vs Browser Bundle

aio apps have **two separate bundles** running simultaneously — code must
respect the boundary between them.

```
┌─────────┬──────────────────────────────────┬──────────────────────────────────────┐
│         │ Deno binary (server)             │ esbuild bundle (browser/Electron)    │
├─────────┼──────────────────────────────────┼──────────────────────────────────────┤
│ Entry   │ src/app.ts                       │ src/App.tsx (auto-detected)           │
│ Bundler │ deno compile                     │ esbuild                              │
│ Can use │ Deno APIs, @std/*, fs, processes │ Only browser-safe code               │
└─────────┴──────────────────────────────────┴──────────────────────────────────────┘
```

## The rules

**1. Cell `index.ts` must be browser-safe.**

The cell index is imported by both worlds — `app.ts` (server) and UI components
like `App.tsx` (browser). It must not contain Deno APIs or `@std/*` imports.

```ts
// cell/notes/index.ts
// Safe — no Deno APIs, no @std/*
import { cell } from 'aio'
export const notes = cell('notes', { ... })
```

**2. Server-only code: name it `*.server.ts` and dynamic-import it.**

The `.server.ts` suffix is the first-class convention for server-only helper
modules (Deno APIs, `@std/*`, filesystem, processes). The build marks
`*.server.ts` **dynamic imports** as external — they never enter the browser
bundle, no tricks required:

```ts
// helpers.server.ts — Deno APIs are fine here
import { basename } from "@std/path";
export const readNotes = (p: string) => Deno.readTextFile(p);

// cell file — plain dynamic import, browser-safe
methods: {
  async open(s, path: string) {
    const io = await import("./helpers.server.ts"); // dead code in the browser
    s.text = await io.readNotes(path);
  },
}
```

Cell methods run server-side, so the import only ever executes on the server.
The linter (`aiol`) recognizes the suffix and stays quiet; `@std/*` and `node:*`
imports reached any other way are stubbed by the build with a clear "is
server-only" runtime error instead of a cryptic bundling failure.

**2b. Server-only _symbols_ live on `"aio/server"`.**

`createDB` / `DEFAULT_PRAGMAS` (SQLite in a Worker) and `connectCli` /
`connectCliUDS` (CLI/UDS transport) are **not on the `"aio"` entry** — as of
alpha37 they are only on `"aio/server"`.

They used to be re-exported from `"aio"` for convenience, which made the blank
screen a one-character mistake: a _static_ `import { createDB } from "aio"` in a
cell (or any module a cell pulls in) link-failed the whole client bundle at boot
— a message naming the symbol but not your file, passing every server-side check
(`deno check` / `deno test` / `deno lint`) because the split doesn't exist until
a real browser links the graph. Importing from `aio/server` makes the boundary
explicit, and `aiol --safe-fix` rewrites the old form for you.

(The TYPES — `DB`, `DBOpts`, `QueryResult`, `Tx`, `CliApp` — stay on `"aio"`.
They are erased at build time, so they cannot poison a bundle, and keeping them
spares every `DB`-typed signature an import change.)

Load them lazily in a server-only path instead — cell methods run on the server:

```ts
// ✅ server-only path — dynamic import, browser bundle never sees createDB
let _db: import("aio").DB | null = null;
async function db() {
  if (!_db) {
    const { createDB } = await import("aio/server");
    _db = createDB(".aio/cache.sqlite");
  }
  return _db;
}
// pure schema helpers ARE browser-safe — import them statically:
import { pk, table, text } from "aio";
```

`deno task lint:aio` flags a static server-only symbol in a cell file with the
exact `file:line` + fix, and the dev blank-screen guard now prints a teachable
hint for the runtime error. (For a cleaner boundary, keep DB code in a
`*.server.ts` module per rule 2.)

For a file you can't rename, the fallback is a dynamic import with the path
broken by a variable — esbuild statically resolves even plain dynamic imports,
so only an opaque specifier keeps it out:

```ts
// Fallback — esbuild can't resolve this, skips it
const _hp = "./helpers";
const loadHelpers = () => import(`${_hp}.ts`);

// Breaks browser bundle — esbuild pulls in @std/path
import { basename } from "@std/path";

// Still breaks — esbuild resolves plain dynamic imports too
const loadHelpers = () => import("./helpers.ts");
```

**3. Dynamic-imported files must also be statically imported in `app.ts`.**

`deno compile` only embeds files it can see in the static import graph. Without
a static import, the file won't exist in the compiled binary.

```ts
// app.ts
import "./cell/notes/helpers.ts"; // embed for deno compile
// The dynamic import in index.ts finds it at runtime
```

> **This rule fails late and silently.** Dev mode reads the file from disk, so
> forgetting the static import breaks only in the **compiled binary** — the
> slowest feedback loop there is. When you add a new server-only helper module,
> add its `app.ts` import in the same commit, and smoke-test the compiled
> artifact before shipping.

**4. `import type` is always safe.**

Type imports are erased at compile time — they cross both worlds freely.

```ts
// Fine everywhere — erased at compile time
import type { MdviewState } from "./helpers.ts";
```

## Quick reference

| What                                  | Rule                                                        |
| ------------------------------------- | ----------------------------------------------------------- |
| Cell `index.ts`                       | Browser-safe only — shared between server and UI            |
| Server-only code (`@std/*`, `Deno.*`) | `*.server.ts` + dynamic import (string-concat as fallback)  |
| Files loaded via dynamic import       | Must also have static import in `app.ts` for `deno compile` |
| `import type`                         | Always safe — erased at compile time                        |

## Auto-aliasing npm packages (dev mode)

AIO automatically makes npm packages from `deno.json` available in the browser
during dev mode.

1. Add the package to `deno.json` imports: `"xterm": "npm:xterm@5.3.0"`
2. AIO generates a browser import map that maps `"xterm"` ->
   `https://esm.sh/xterm@5.3.0`
3. Browser imports resolve automatically — no extra configuration

**Prod builds** bundle everything via esbuild — npm packages are resolved from
`node_modules/` as usual.

## Browser import validation

AIO checks for common import mistakes at four levels:

1. **Lint time** (`aiol`): Flags `@std/*`, `node:*`, `Deno.*` in cell files and
   `.tsx` files. Flags bare specifiers not in `deno.json`. Flags plain dynamic
   imports of server-only files — and recognizes `*.server.ts` as safe.
2. **Graph validation** (dev server + `deno task check:graph`): walks the module
   graph from your UI entry, severity split by certainty of breakage:
   - **Blocking** (diagnostic page in dev, non-zero exit in `check:graph`) — a
     _guaranteed_ client break: a static `node:` builtin or an omitted `aio`
     server symbol (`createDB`, `connectCli`, …) reachable from the UI entry.
     aio's Electron renderer is a sandboxed browser (`nodeIntegration:false`),
     so these can't resolve → a blank screen every boot. Fail loud + attributed
     (`file:line` + fix) beats a silent white void, and `deno task compile`
     fails the same imports (dev==prod). Fix: move the module behind
     `await import(...)` in a server-only path, or a `*.server.ts` file.
   - **Warning** — a _conditional_ break: `Deno.*` usage (only fails if that
     path runs client-side) or a maybe-safe `@std/*` module.

   `check:graph` is the CI-friendly one-shot — add it to your test gate so a
   boundary break can't reach a running server:

   ```jsonc
   // deno.json → tasks
   "check:graph": "deno run -A jsr:@ria/aio/scripts/check-graph.ts"
   ```
3. **Build time**: esbuild plugin marks `*.server.ts` dynamic imports external
   and intercepts `@std/*` and `node:*` — clear error messages instead of
   cryptic failures.
4. **Runtime**: Error overlay shows fix suggestions (e.g., "Add X to deno.json
   imports").

## CSS in builds

If `src/style.css` exists, it's automatically:

- **Dev:** served from `src/` and injected as `<link>` in HTML
- **Compile:** copied to `dist/style.css` and included in the binary

## How exclusion works

The build script temporarily removes dev-only symlinks from `node_modules/` and
passes `--exclude` flags to `deno compile` for the big directories (electron
~254MB, esbuild ~11MB, react ~5MB). Symlinks are restored after compile, even on
failure.

## `aio/server` — the explicit server-only surface

Server-only symbols (SQLite `createDB`/`DEFAULT_PRAGMAS`, CLI/UDS `connectCli`/
`connectCliUDS`, `aio ship` signing) live behind **`aio/server`**. The whole
entry is server-only, so importing from it in an isomorphic module (a cell, or a
lib a cell pulls in) is the boundary violation — `aiol` flags a static
`aio/server` import in a cell-shared file as an error, and a client build can
map the entry to a stub.

- **Right:** `import { createDB } from "aio/server"` in a `*.server.ts` module,
  or `const { createDB } = await import("aio/server")` behind a server guard.
- **Wrong:** a static `import { createDB } from "aio/server"` (or from `"aio"`)
  in a file that also defines a `cell()` — it poisons the client graph and
  blank-screens the app at boot.

As of **alpha37 this is the only path** — the convenience re-exports on `"aio"`
are gone, so the boundary can't be crossed by accident. `aiol --safe-fix`
rewrites `import { createDB } from "aio"` to `"aio/server"`.

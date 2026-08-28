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
The linter (`aiol`) recognizes the suffix and stays quiet.

**The escape hatch is exactly this: a dynamic import of a `*.server.ts` module**
(or of `aio/server` / `aio/build`). Those are the only imports the bundler marks
external. A dynamic import of any _other_ module is **followed** by esbuild —
`await import("./helpers.ts")` puts `helpers.ts` in the bundle, and a static
`import { join } from "@std/path"` inside it is in the bundle too, one hop past
the `import()` that looked like a boundary. That is a refused build, and — since
alpha70 — a refused dev boot, with the chain named:

```
✗ server-only module(s) reached by the BROWSER bundle:
       helpers.ts — "@std/path" is server-only and statically imported by the BROWSER bundle
         via App.tsx → helpers.ts
```

A _dynamic_ `await import("node:fs")` / `import("@std/path")` written directly
inside a method body is fine: it is stubbed, and dead code in the browser.

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
import type { AppState } from "./helpers.ts";
```

## Browser-reachable imports may not leave `baseDir`

In **dev**, the browser fetches modules over HTTP, and `baseDir` (your entry's
directory) is the HTTP root. A relative import that climbs out of it —
`../../core/lib/sse.ts` — type-checks and runs fine on the server, then 404s in
the browser and blanks the page:

```
WARN client BLANK SCREEN (boot): Failed to fetch dynamically imported module
```

A symlink into `baseDir` does not help either; escaping symlinks are refused by
design. **Prod is unaffected** — the bundler follows relative imports at build
time.

For two apps in one repository that must share pure modules, map the shared
directory to a URL prefix instead of copying it:

```ts
// repo/
//   client/src/App.tsx   ← this app
//   core/lib/sse.ts      ← shared by both apps
await aio.run({
  baseDir: "client/src",
  serveDirs: { "/shared": "core/lib" }, // dev-only, read-only
});
```

Then `import { parseSSE } from "/shared/sse.ts"` resolves in both worlds.

**Both paths resolve the same way** — against the process's working directory,
exactly like `baseDir` — so write them from the same vantage point. A root that
does not exist is reported on first use, naming the resolved path, rather than
404ing every file under it.

Each mapped root gets exactly the guards `baseDir` has — no traversal, no
escaping symlink, no dotfiles, no server-only paths — and the option has no
effect in production, where the bundle is already self-contained.

## Browser-reachable WASM (wasm-bindgen)

Two rules, both needed — the dev server serves each module raw (per-file esbuild
transform, never a full bundle), so bundler-flavoured output blanks the app (a
field report lost a session to this):

1. **Build with `wasm-bindgen --target web`, not `--target bundler`.** The
   bundler target emits an ES-module `.wasm` import only a bundler resolves; the
   web target fetches its `.wasm` at runtime via
   `new URL("pkg_bg.wasm", import.meta.url)`, which works in a plain browser,
   Deno and Electron alike. Its API needs one `await init()` before the first
   call. (Deno tests pass either way — Deno's own loader resolves `.wasm`
   imports — so the blank screen is a dev-server-only surprise.)
2. **Map the wasm directory with `serveDirs`** when it lives outside `baseDir`
   (for code shared between apps in one repo, declare it once as
   `"share": ["../shared"]` in deno.json instead — dev serving and the bundler
   resolve the same `/shared/…` prefix; see project-structure.md):
   `serveDirs: { "/crypto": "./crypto" }` — otherwise even the JS bindings 404
   in dev. Prod bundling follows the relative import and needs no mapping;
   compiled binaries embed `.wasm` files as data assets automatically.

## Quick reference

| What                                  | Rule                                                            |
| ------------------------------------- | --------------------------------------------------------------- |
| Browser-reachable import              | Must resolve inside `baseDir` (dev) — or map it via `serveDirs` |
| Cell `index.ts`                       | Browser-safe only — shared between server and UI                |
| Server-only code (`@std/*`, `Deno.*`) | `*.server.ts` + dynamic import (string-concat as fallback)      |
| Files loaded via dynamic import       | Must also have static import in `app.ts` for `deno compile`     |
| `import type`                         | Always safe — erased at compile time                            |

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
2. **Graph validation** (dev server + `deno task check:graph`) — two halves,
   both blocking (diagnostic page in dev, non-zero exit in `check:graph`):
   - **The walk**: the module graph from your UI entry, as written. A missing
     file, a typo'd path, a static `*.server.ts` import, a static `node:`
     builtin or an omitted `aio` server symbol (`createDB`, `connectCli`, …) in
     an eagerly-linked module — attributed `file:line` + fix. `Deno.*` usage and
     maybe-safe `@std/*` stay warnings (a _conditional_ break).
   - **The prod graph**: the browser bundle is then built **in memory with the
     build's own esbuild invocation**, audited and evaluated — see
     [Dev mode → Dev evaluates the prod graph](dev-mode.md#dev-evaluates-the-prod-graph).
     Whatever `deno task build` refuses, this refuses, from the same decider
     (`src/build/graph-audit.ts`), with the same words: a server-only module the
     _resolved_ graph reaches (including past a dynamic import of a plain
     module), a Node global (`Buffer`, `process`, `global`, `__dirname`,
     `__filename`, `require`, `module`) referenced at module scope, or a bundle
     whose top level throws when it is actually run.

   `check:graph` is the CI-friendly one-shot — add it to your test gate so a
   boundary break can't reach a running server:

   ```jsonc
   // deno.json → tasks
   "check:graph": "deno run -A jsr:@ria/aio/scripts/check-graph.ts"
   ```
3. **Build time**: the same bundle, written to disk, judged by the same decider,
   then **evaluated** before it can become an artifact
   (`[build] ✓ bundle audited + evaluated`). A bundle that cannot load never
   reaches `deno compile`, an APK or an installer.
4. **Runtime**: Error overlay shows fix suggestions (e.g., "Add X to deno.json
   imports").

### Node globals — aio does not polyfill

esbuild's `platform: "browser"` supplies no `Buffer`, `process`, `global`,
`__dirname`, `__filename`, `require` or `module` (the one exception is
`process.env.NODE_ENV`, which esbuild defines to a string). An npm dependency
that touches one at module scope — a crypto or wallet SDK built for Node is the
usual case — blank-screens the whole app at load with
`ReferenceError: Buffer is not defined`, and every test stays green because
tests render server-side where `Buffer` exists. Fix: keep that dependency
server-side (a `*.server.ts` module, dynamic-imported from a cell method), or
provide the global from a module imported _before_ it if it truly must run in
the browser. There is no `build.polyfills` option — say what you mean in the
code.

**The evaluation decides; the scan explains.** The bundle is run with the Node
globals deleted:

- it **loads** → not refused, and each module-scope touch is printed as a note
  (`… touches \`Buffer\` at module scope and the bundle still loads — something
  defines it first`). That is the "provide the global before it" fix working:
  the scan cannot see a shim two imports earlier, so the scan alone must not
  refuse.
- it **throws** → refused, with the scan's `file:line` and the import chain as
  the attribution for `ReferenceError: Buffer is not defined` (and the
  evaluation catches what the scan misses — a static class field, a top-level
  call).

`require` and `module` in a CommonJS input are the exception the scan skips
outright: esbuild wraps every CJS file as `__commonJS((exports, module) => …)`
and rewrites bare `require` to its own `__require`, so the bundle supplies both.
`module.exports = x` is how the file is spelled, not a browser break.

A server-only leak is judged differently, on the audit alone: a key in
`dist/app.js` is shipped whether or not the page paints, and no evaluation can
see it.

The static scan is a heuristic about _scope_ (brace depth, arrow bodies), and a
heuristic can be wrong. Acknowledge one line with
`// aio-ok: node-global <reason>` on the line or the line above:

```ts
const toHex = (b) => Buffer.from(b).toString("hex"); // aio-ok: node-global — arrow body, runs server-side
```

That silences the **static scan only**. The evaluation still runs the bundle, so
a line that really does execute at load is still refused — a wrong
acknowledgement cannot ship a blank page.

## CSS in builds

If `style.css` exists next to your entry file (the app dir — `src/style.css` in
a scaffolded app), it's automatically:

- **Dev:** served from the app dir and injected as `<link>` in HTML
- **Compile:** copied to `dist/style.css` and included in the binary

Dev and compile resolve it with the same rule (the entry's directory), so a
stylesheet you see in dev is always in the prod build — and a `src/style.css`
that the rule does NOT cover fails the build loudly instead of shipping a prod
app that looks different from dev.

## How exclusion works

The build script temporarily removes dev-only symlinks from `node_modules/` and
passes `--exclude` flags to `deno compile` for the big directories (electron
~254MB, esbuild ~11MB, react ~5MB). Symlinks are restored after compile, even on
failure.

## `aio/server` — the explicit server-only surface

Server-only symbols (SQLite `createDB`/`DEFAULT_PRAGMAS`, CLI/UDS `connectCli`/
`connectCliUDS`, `deno task ship` signing) live behind **`aio/server`**. The
whole entry is server-only, so importing from it in an isomorphic module (a
cell, or a lib a cell pulls in) is the boundary violation — `aiol` flags a
static `aio/server` import in a cell-shared file as an error, and a client build
can map the entry to a stub.

- **Right:** `import { createDB } from "aio/server"` in a `*.server.ts` module,
  or `const { createDB } = await import("aio/server")` behind a server guard.
- **Wrong:** a static `import { createDB } from "aio/server"` (or from `"aio"`)
  in a file that also defines a `cell()` — it poisons the client graph and
  blank-screens the app at boot.

As of **alpha37 this is the only path** — the convenience re-exports on `"aio"`
are gone, so the boundary can't be crossed by accident. `aiol --safe-fix`
rewrites `import { createDB } from "aio"` to `"aio/server"`.

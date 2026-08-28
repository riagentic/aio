# aiol — AIO Project Linter

Static analysis tool for aio projects. Scans your source files and reports
errors, warnings, and optimization hints — no runtime needed.

## Usage

Scaffolded apps already ship a `lint` task — just run `deno task lint`. Wire it
into CI to catch antipatterns on every change. (Definite bugs — an illegal
in-place state mutation — already throw loudly at runtime in dev, prod, and
tests; the linter surfaces the _maybe-wrong_ style/coupling/perf patterns.)

```sh
# Scaffolded app
deno task lint

# From your project root
deno run -A jsr:@riagentic/aio@^1.0.0-alpha/aiol

# Or point at a specific directory
deno run -A aiol/mod.ts /path/to/my-app

# JSON output (for CI or tooling)
deno run -A aiol/mod.ts --json

# Add as a task in deno.json
{
  "tasks": {
    "lint:aio": "deno run -A jsr:@riagentic/aio@^1.0.0-alpha/aiol"
  }
}
```

Exit code 1 if errors found, 0 otherwise. Useful in CI gates.

## Auto-fix

```sh
# Apply all safe fixes
deno run -A aiol/mod.ts --safe-fix
```

Safe fixes are guaranteed harmless — they add missing config or remove dead
code. They never change app behavior, never delete data, never modify logic.
Issues that can be auto-fixed are marked `[fixable]` in the output.

### What `--safe-fix` can fix

**deno.json config additions:**

| Fix                                | What it adds                                   |
| ---------------------------------- | ---------------------------------------------- |
| Remove `appId` from deno.json      | appId belongs in aio.run(), not deno.json      |
| Add `appId` to aio.run()           | Derives from deno.json appId or directory name |
| Add `nodeModulesDir: "auto"`       | npm package resolution                         |
| Add `@types/react` import          | JSX type checking (intrinsic element types)    |
| Add `esbuild` import               | Dev mode transpilation                         |
| Add `compilerOptions` (jsx config) | JSX transform settings                         |
| Add `dev` task                     | `deno run -A src/app.ts`                       |
| Add `test` task                    | `deno test -A tests/`                          |

**Source file cleanup:**

| Fix                   | What it does                                                                 |
| --------------------- | ---------------------------------------------------------------------------- |
| Remove `import React` | Unnecessary with `jsx: "react-jsx"` — the transform injects it automatically |

**Upgrade rewrites** (spellings aio removed — every row is a fact in
`src/state/removals.ts`, and the finding prints that row's message: the
migration AND the `am pin` escape hatch; see
[semver policy](../basics/semver-policy.md)):

| Fix                                                                                                                | What it does                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `call({ timeout })` → `timeoutMs`                                                                                  | Only inside a `call(...)` options object; your own fields untouched                                                                                   |
| `--cert=` / `--key=` → `--tls-cert=` / `--tls-key=`                                                                | In `deno.json` tasks — the bare names collided with the auth `key` concept                                                                            |
| `--headless` → `--client=server-only`                                                                              | Only on a task that RUNS the app; a build task keeps `--headless`                                                                                     |
| `import { createDB } from "aio/db"` → `"aio/server"`                                                               | alpha70: the statement is SPLIT — runtime values move, `type DB` stays on `aio/db`; declined (`[manual]`) in a `.tsx`, where the fix is a cell method |
| `aio/build` ship family → `aio/ship`                                                                               | alpha70: `shipApp`, `buildShipManifest`, `verifyShipManifest`, `generateSigningKey`, `ShipManifest`                                                   |
| `aio/testing` `appDirs`/`AppDirs` → `aio/server`                                                                   | alpha70: the resolver's one home (`ensureAppDirs`/`registerAppDirs` stay)                                                                             |
| `aio/testing` updates runtime → `aio/updates`                                                                      | alpha70: `installUpdatesRuntime`, `UpdatesRuntime`, `ApplyOptions`, `CheckOptions`, `CheckResult`                                                     |
| `aio/air` `testComponent`/`setDocument` → `aio/testing`                                                            | alpha70: next to `testCell` and `testUI`                                                                                                              |
| `import { testCell } from "aio"` → `"aio/testing"`                                                                 | alpha70: `testCell`, `TestContext`                                                                                                                    |
| `import { lint } from "aio/extras"` → `checkCells as lint`                                                         | alpha70: the alias is gone; the LOCAL name survives, so no call site changes                                                                          |
| `import { testgen }` → `testGen as testgen`                                                                        | alpha70: same trick — behaviour-identical by construction                                                                                             |
| `CellAccess` / `ServerFnAccess` → `Access`, `ExtractState` → `StateOf`, `connectDevTools` → `connectReduxDevTools` | alpha70: a word-for-word rewrite of CODE only (strings and comments untouched); duplicate import specifiers it creates are collapsed                  |
| `import { type Action } from "aio/air"` → `type NodeAction as Action`                                              | alpha70: `Action` is a word apps use for their own types, so only the import changes                                                                  |
| `schedule.blocking(` → `blocking(`                                                                                 | alpha70: `blocking` is added to the file's `aio` import (`schedule` is left — an unused import is harmless where a missing one is not)                |
| cell `ui:` → `visible:`, `{ every, backoff }` → `factor`                                                           | alpha52 spellings, removed in alpha70 — reported at the exact line, once                                                                              |

Run `--safe-fix`, then re-run without it to see remaining issues that need
manual attention.

## Severity Levels

| Level     | Icon | Meaning                                      |
| --------- | ---- | -------------------------------------------- |
| **error** | `✗`  | Will break at runtime — must fix             |
| **warn**  | `⚠`  | Likely bug or performance issue — should fix |
| **hint**  | `·`  | Sub-optimal but works — consider fixing      |

## What It Checks

### 1. Project Config

Validates `deno.json` for common mistakes:

- `appId` in deno.json (should be in `aio.run()`)
- Missing `appId` in `aio.run()`
- Missing required imports (`aio`, `esbuild`)
- Missing `compilerOptions.jsx` for JSX
- Missing `nodeModulesDir`
- No `dev`, `test`, or `compile:*` tasks

### 2. File Structure

- Missing entry point (`src/app.ts`)
- Missing `App.tsx` for UI targets
- Unused `App.tsx` in headless mode
- Cell files scattered outside `src/cell/`
- No test directory or test files

### 3. Cell Definitions

Static analysis of `cell()` calls:

- Duplicate cell names across files
- Empty state objects
- Reserved state keys (`$p`, `$d`, `_status`, `__proto__`) — these collide with
  aio internals
- Mixing methods and actions styles in one cell
- Cell with no methods and no actions (can't change state)
- Non-standard naming (convention: lowercase with hyphens)
- **Sync method / selector reading a `visible`-hidden field** (error) — sync
  methods of a `sync`/`localFirst`/`scope: "client"` cell replay on the client,
  and selectors of every cell run there, over the filtered slice; the read is
  `undefined` (dev throws). Both member forms are scanned — block bodies and
  expression-bodied arrows (`seedLen: (s) => s.seed.length`). Fix: read it in a
  server-side/async method, or publish a non-secret fact field
  (`hasVault: boolean`) and read that

### 4. Performance

- `useAio()` in non-root components (use direct cell access for selective
  re-renders)
- Sync I/O (`Deno.readTextFileSync`, etc.) blocking the event loop
- `setTimeout`/`setInterval` in cell code (use `schedule.after`/`every`)
- Large collections in state that should be in SQLite
- Missing cell-level `ui` config with many state keys
- `console.log` instead of structured `log` from aio

### 5. Security

- Hardcoded tokens, passwords, secrets, API keys in source
- **Credential-named state field visible to clients** (error) — the static twin
  of `aio.run()`'s boot refusal (`password`, `mnemonic`, `privateKey`, `apiKey`,
  …), reported with both fixes in one line: `visible: { exclude: [...] }` or, if
  it is genuinely public, `visible: { publicFields: [...] }`
- `--expose` without user auth configuration
- `.env` files that might not be in `.gitignore`

### 6. Persistence & Database

- `version` set without `migrations` array
- Direct `Deno.Kv` usage (legacy API — aio persistence is SQLite-only)
- `persist: false` warning (state won't survive restarts)
- `db` config without table schema definitions

### 7. UI / Browser

- Non-browser imports in `.tsx` files (won't resolve in dev mode)
- `createRoot` in user code (framework handles mounting)
- Unnecessary `import React` (automatic with jsx transform)
- Cell access without connection check

### 8. Testing

- Cells without matching test files
- Test files that don't use `testCell()` harness
- Missing `test` task in `deno.json`

### 9. Code Patterns

- `any` usage (prefer `unknown` + narrowing)
- Thrown exceptions in cell code (prefer error states)
- Legacy `../dep/aio/` import paths
- Node.js APIs (`require`, `process.env`, `__dirname`)
- **The live draft escapes the method** (error). `s` is a live proxy, valid only
  while the method runs; the runtime cannot see it leave, so the linter is the
  guard. Exact criterion: inside a cell method with draft parameter `P`, (a) `P`
  itself is assigned or pushed into a MODULE-LEVEL binding of the file
  (`let`/`var`/`const` at column 0, or `globalThis`) — `X = P`, `X.y = P`,
  `X.push(P)`, `X.set(k, P)`, `X.add(P)`; or (b) a function literal whose text
  references `P` is assigned to, or `push`/`set`/`add`/`on`/`once`/
  `subscribe`/`addEventListener`/`addListener`-ed on, such a binding. Not a hit:
  a local `const`, `own.set`, `s.$do`, `schedule.*`, or a callback that copies
  plain data (`{ ...P }`, `P.items.slice()`).
- **I/O in a sync method** (error). A sync method IS the reducer. Exact
  criterion: a non-`async` member of `methods:` whose body — with every nested
  function literal blanked, so a callback handed to `own.set`/`s.$do` is not the
  method's own body — calls `fetch(` or `Deno.<io>(` (file, process, network, KV
  operations and their `Sync` twins; `Deno.env`/`cwd`/`build`/ `inspect` are not
  I/O). Fix: make it `async`, or hand the I/O to `s.$do`.
- **`own.set` keyed by a constant while the resource varies** (warn). `own`
  REPLACES on re-set, so a family keyed by one string keeps one member. Exact
  criterion: `own.set(KEY, …)` where KEY is a plain string literal (no `${}`),
  lexically inside a function/method with a parameter whose name is resource-id
  shaped (ends in `id`/`key`/`name`/`path`/`url`/`uri`/`host`/
  `port`/`file`/`dir`/`handle`/`addr`/`address`, case-insensitive), AND that
  parameter appears in the call's remaining arguments (the factory). Fix:
  ``own.set(`KEY:${id}`, …)`` — or `// aiol-ok: one KEY at a time` when
  replacing is the intent.

### 10. Build Readiness

- esbuild not installed (required for dev mode)
- Electron package incomplete (`dist/` missing)

### 11. Inter-Cell Patterns

- Direct state access across cells (use selectors)

### 12. Scheduling

- Invalid schedule IDs (must be alphanumeric + hyphens/colons/dots)

### 13. Memo & Structural Sharing

- `import { memo } from "react"` in `.tsx` — use
  `import { memo } from "aio/air"` (AIR auto-memos all components; `memo()` is a
  no-op for migration compat)
- `.map()` rendering `memo()` components without `useProjection()` — derived
  arrays create new refs every render, defeating memo. Wrap in `useProjection()`

### 14. Upgrade (removed spellings)

Every finding here reads its text from `src/state/removals.ts`, the one record
of what aio removed and when. The line names the release, the migration and the
version that still runs the code unchanged (`am pin <tag> && am fix`).

- alpha70 — one import path per symbol (`aio/db` values, the `aio/build` ship
  family, `aio/testing`'s `appDirs`/updates runtime, `aio/air`'s
  `testComponent`, `aio`'s `testCell`); the retired aliases `lint`/`testgen`;
  the retired `CellAccess`/`ServerFnAccess`/`ExtractState`/`Action` (alpha70);
  the retired `connectDevTools`/`schedule.blocking` (alpha70); and
  `memory.gcStressRatio` (accepted, never read — boot refuses it by name too).
  All `[fixable]` except the config key and a `.tsx` importing a database (both
  `[manual]`, with the reason).

- `call({ timeout })` — renamed to `timeoutMs`
- `--cert` / `--key` in a task — renamed to `--tls-cert` / `--tls-key`
- `--headless` on a task that runs the app — it is a BUILD flag; at runtime it
  is ignored with a warning and the app still starts a client. Use
  `--client=server-only` (this is the bug that made a generated systemd unit
  crash-loop)

All three are `[fixable]` — `--safe-fix` performs the rename. aio never removes
a renamed option inside a major version, so these are ergonomics, not
emergencies.

## Example Output

```
aiol v1.0.0-beta1 — scanning project

  ✓ appId: my-app
  ✓ entry: src/app.ts
  ✓ UI: App.tsx
  ✓ 3 cell(s): cart, inventory, payment
  ✓ all 3 cells have tests
  ✓ cell ui filters configured
  ✓ localhost-only (no --expose)

  ⚠ WARN   [perf] src/cell/cart/index.ts: sync I/O (Deno.readTextFileSync)
  ⚠ WARN   [security] src/config.ts:12 — possible hardcoded token

  · HINT   [perf] src/components/Dashboard.tsx: uses useAio() — prefer direct cell access
  · HINT   [testing] no "test" task in deno.json [fixable]

────────────────────────────────────────────────────────────
  Files: 12  Cells: 3  Tests: 3
  2 warnings · 2 hints
  1 auto-fixable — run with --safe-fix to apply
```

## JSON Output

```sh
deno run -A aiol/mod.ts --json
```

Returns structured data for CI integration:

```json
{
  "version": "0.1.0",
  "stats": { "filesScanned": 12, "cellsFound": 3, "testsFound": 3 },
  "passed": ["appId: my-app", "3 cell(s): cart, inventory, payment"],
  "issues": [
    {
      "severity": "warn",
      "area": "perf",
      "message": "sync I/O blocks the event loop",
      "file": "src/cell/cart/index.ts",
      "line": 18
    }
  ],
  "summary": { "errors": 0, "warnings": 1, "hints": 1 }
}
```

## CI Integration

Add to your GitHub Actions workflow:

```yaml
- name: Lint aio project
  run: deno run -A aiol/mod.ts
```

The linter exits with code 1 on errors, so the build fails if there are breaking
issues. Warnings and hints don't fail the build.

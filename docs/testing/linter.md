# aiol — AIO Project Linter

Static analysis tool for aio projects. Scans your source files and reports
errors, warnings, and optimization hints — no runtime needed.

## Usage

```sh
# From your project root
deno run -A jsr:@riagentic/aio@^1.0.0-alpha13/aiol/mod.ts

# Or point at a specific directory
deno run -A aiol/mod.ts /path/to/my-app

# JSON output (for CI or tooling)
deno run -A aiol/mod.ts --json

# Add as a task in deno.json
{
  "tasks": {
    "lint:aio": "deno run -A jsr:@riagentic/aio@^1.0.0-alpha13/aiol/mod.ts"
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
| Add `unstable: ["kv"]`             | Required for state persistence                 |
| Add `nodeModulesDir: "auto"`       | npm package resolution                         |
| Add `@types/react` import          | JSX type checking (intrinsic element types)    |
| Add `esbuild` import               | Dev mode transpilation                         |
| Add `compilerOptions` (jsx config) | JSX transform settings                         |
| Add `dev` task                     | `deno run -A src/app.ts`                       |
| Add `test` task                    | `deno test -A --unstable-kv tests/`            |

**Source file cleanup:**

| Fix                   | What it does                                                                 |
| --------------------- | ---------------------------------------------------------------------------- |
| Remove `import React` | Unnecessary with `jsx: "react-jsx"` — the transform injects it automatically |

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
- Missing `unstable: ["kv"]` for persistence
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
- `--expose` without user auth configuration
- `.env` files that might not be in `.gitignore`

### 6. Persistence & Database

- `version` set without `migrations` array
- Direct `Deno.Kv` usage (aio handles persistence)
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

## Example Output

```
aiol v1.0.0-alpha13 — scanning project

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

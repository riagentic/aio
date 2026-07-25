# Upgrade: 1.0.0-alpha36 → 1.0.0-alpha37

**One mechanical change required** if your app imports `createDB`,
`DEFAULT_PRAGMAS`, `connectCli` or `connectCliUDS` from `"aio"` — one command
fixes it. The wire protocol is unchanged (alpha36 and alpha37 interoperate).

## 0. Move server-only imports (BREAKING)

```sh
deno run -A aiol/mod.ts --safe-fix     # rewrites the imports for you
```

```ts
// before
import { cell, createDB } from "aio";

// after — the boundary is the import path
import { cell } from "aio";
import { createDB } from "aio/server";
```

Why: those symbols pull in SQLite (a Worker) or CLI/UDS transport and don't
exist in a browser bundle. A static import of one from `"aio"` inside a cell (or
anything a cell imports) link-failed the entire client bundle at boot — a blank
screen naming the symbol but not your file, which every `deno check` /
`deno test` passes because the split only exists once a real browser links the
graph. The re-export made that mistake one character away from correct code.

The **types** (`DB`, `DBOpts`, `QueryResult`, `Tx`, `CliApp`) stay on `"aio"` —
they're erased at build time, so no signature needs touching.

If your app's `deno.json` predates alpha36 it may not map `aio/server` at all;
`aiol --safe-fix` adds the mapping too.

## 1. Bump the pin

```jsonc
// deno.json
{
  "imports": {
    "aio": "https://raw.githubusercontent.com/riagentic/aio/v1.0.0-alpha37/mod.ts"
  }
}
```

## 2. What you may now see that you didn't before

If an app has a `worker: true` cell whose methods read another cell,
`aio doctor` (and `aiol`) now report it as an **error**, with `file:line`:

```
✗ ERROR [cells] src/heavy.ts:12 — cell "heavy" has worker: true and reads
  "accounts.active" …
```

This is not new breakage: that read already threw at runtime in alpha36 — a
worker cell holds only its own slice, so it could never see the peer's live
value. What changed is _when you find out_: at boot, instead of whenever that
line happens to run.

The fix is structural, and it's the idiom the field settled on — pass the value
in as a method argument, or keep the heavy work in one self-contained cell:

```ts
// ❌ the worker can't see this
run(s) { s.out = accounts.active; }

// ✅ the caller hands it over
run(s, active: string) { s.out = active; }
```

See [state/cell-workers](../state/cell-workers.md).

## 3. One fewer false alarm

The boot linter no longer comments on `*.test.ts` / `*.test.tsx` files — they
never reach a browser bundle, so its browser-import advice about them was noise.

# Upgrade: 1.0.0-alpha27 → 1.0.0-alpha28

alpha28 completes the restructure (B3–B5). If you are coming from anything OLDER
than alpha27, read [The aio restructure (alpha27+)](restructure.md) first — it
covers the big one (methods-only cells). From alpha27, this upgrade is small.

## The one breaking change: `aio/extras`

Periphery symbols moved off the main entry (nothing was deleted):

```ts
// before
import { deepFreeze, instances, parseCli } from "aio";
// after
import { deepFreeze, instances, parseCli } from "aio/extras";
```

Moved: `lint`, `parseCli`, `draft`, `matchEffect`, `deepFreeze`, `markAsync`,
`instances`, `resolveAppId`, `connectCliUDS`, `createSliceSelector`,
`DEFAULT_PRAGMAS`, `UnionOf` + deep diagnostic/vitals detail types and the
low-level action/reduce plumbing types.

**Don't hunt by hand** — run `deno task lint`: aiol flags every old import with
the exact fix
([details](restructure.md#b4c--core-diet-periphery-moved-to-aioextras)).

## Automatic (no code changes)

- **Persistence is SQLite-only.** Your persisted state migrates from Deno.Kv
  into `data.db` automatically on first boot (old store left untouched). You can
  delete `"unstable": ["kv"]` from deno.json.
  [details](restructure.md#b4a--sqlite-only-persistence-denokv-removed)
- **Compiled binaries** now embed the SQLite worker — rebuild with
  `deno task compile*` (binaries compiled against alpha28 sources need no flags;
  the pipeline handles it).

## New, additive

- `sync.onRejected` — the server's reason for refusing an op reaches your UI.
- `serverFns` / `serverFn` — typed server/client seam in `*.server.ts`.
- `useRoute<{ id: string }>("/users/:id")` — typed route params.
- `deno task validate:matrix` — one-command all-target validation.

## Checklist

1. `deno task lint` → fix any `aio/extras` import findings.
2. Boot once → confirm the `persist: migrated N entries` log (if you had
   persisted state), then remove the unstable-kv flag.
3. Rebuild any compiled binaries.

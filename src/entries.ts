// entries.ts — ONE answer to "what can you import from aio, and from where".
//
// THE PROBLEM this collapses. The set of `aio/*` entry points was written down
// four times: `deno.json`'s `exports` map (the published truth), `deno.json`'s
// own `imports` map (this repo's self-alias), `frameworkSpecs()` in
// `src/am/am-cmd-create.ts` (the import map every scaffolded app gets), and
// `AIO_ENTRIES` in `aiol/checks.ts` (what the linter believes exists). Three of
// them were stale in different ways, and the failure they produced was the worst
// kind: `docs/persistence/sqlite.md` and `docs/build/targets.md` both say
// `import { dbWorkerInclude } from "aio/build"` — a real, published entry — and
// an app that followed them got "aio/build is not an aio entry point" from
// aiol, no mapping from the scaffold, and no fix from either. The tool told the
// author the documented entry did not exist.
//
// So the list lives HERE, once, and everything that needs it imports it.
// `deno.json`'s `exports` map stays the manifest; `tests/entry-surface-parity.
// test.ts` fails the moment this module and that manifest disagree, in either
// direction — adding an export without classifying it here is a red gate, not a
// silent half-published entry.

/** Every entry `deno.json` publishes: import specifier → path from the package
 *  root. The bare `aio` specifier is included — an app's import map needs it
 *  too, and the JSR subpath is derived by stripping the `aio` prefix. */
export const AIO_ENTRY_PATHS: Readonly<Record<string, string>> = {
  "aio": "mod.ts",
  "aio/air": "src/air.ts",
  "aio/air/compat": "src/air-compat.ts",
  "aio/ui": "src/ui/mod.ts",
  "aio/jsx-runtime": "src/jsx-runtime.ts",
  "aio/server": "src/server-entry.ts",
  "aio/state-core": "src/state-core.ts",
  "aio/db": "src/db/mod.ts",
  "aio/extras": "src/extras/mod.ts",
  "aio/sync": "src/sync/mod.ts",
  "aio/testing": "src/cell-test.ts",
  // The built-in updates cell. Its own entry because `cell()` self-registers:
  // re-exporting it from `mod.ts` would register it in every app ever written,
  // including the ones that never update themselves. Importing it IS opting in.
  "aio/updates": "src/updates.ts",
  // Same opt-in rule as aio/updates: a self-registering cell behind its own
  // entry, so an app that never reports problems carries no feedback state.
  "aio/feedback": "src/feedback.ts",
  // `aio/schedule` and `aio/selectors` were DELETED in alpha52 (entry diet):
  // everything they carried lives on `aio` (schedule, createSelector) or
  // `aio/extras` (isScheduleEffect, createSliceSelector). aiol reports the
  // dead specifiers and `--safe-fix` rewrites the imports.
  "aio/build": "src/build.ts",
  // `aio ship` — run-only: it is a CLI that turns a built artifact into a
  // signed, channel-bound release. Without an entry it was reachable only from
  // inside this repo, which made the published release story unusable.
  "aio/ship": "src/build/ship.ts",
  "aio/build-all": "src/build-all.ts",
  "aio/dev-android": "src/dev-android.ts",
  // The other half of dev-android: a finished APK onto a connected phone
  // (`deno task install:android`). Run-only, like every CLI here.
  "aio/android-install": "src/android-install.ts",
  "aio/am": "src/am.ts",
  "aio/amui": "amui/src/app.ts",
  "aio/doctor": "src/server/doctor.ts",
  "aio/aiol": "aiol/mod.ts",
};

/** Entries reached with `deno run`, never `import` — they appear in an app's
 *  `tasks`, not in its import map, and their modules are CLI programs.
 *
 *  `aio/build` is deliberately NOT here: it is runnable AND importable
 *  (`import { assetIncludes, compileArgs, dbWorkerInclude } from "aio/build"` —
 *  docs/build/targets.md, docs/persistence/sqlite.md), so it must be mapped. */
export const AIO_RUN_ONLY_ENTRIES: ReadonlySet<string> = new Set([
  "aio/ship",
  "aio/build-all",
  "aio/dev-android",
  "aio/android-install",
  "aio/am",
  "aio/amui",
  "aio/doctor",
  "aio/aiol",
]);

/** The entries an app IMPORTS — so exactly the ones its `deno.json` import map
 *  must carry. A specifier missing from that map cannot resolve, and Deno's
 *  error ("not a dependency and not in import map") never says the mapping is
 *  simply absent, so the author reads it as "that entry doesn't exist". */
export const AIO_LIBRARY_ENTRIES: Readonly<Record<string, string>> = Object
  .fromEntries(
    Object.entries(AIO_ENTRY_PATHS).filter(([spec]) =>
      !AIO_RUN_ONLY_ENTRIES.has(spec)
    ),
  );

/** The JSR subpath for a specifier: `aio` → `""`, `aio/air/compat` →
 *  `"/air/compat"`. Mirrors the key shape of `deno.json`'s `exports`. */
export function entrySubpath(spec: string): string {
  return spec === "aio" ? "" : spec.slice("aio".length);
}

/** The `exports`-map key for a specifier: `aio` → `"."`, `aio/db` → `"./db"`. */
export function entryExportKey(spec: string): string {
  return spec === "aio" ? "." : `.${entrySubpath(spec)}`;
}

/** Server-only SYMBOLS exported from the isomorphic `aio`/`aio/db` entries.
 *  The browser build OMITS them, so a static import into a client-reachable
 *  module is an eager ES link failure — a blank screen every boot (AIO-424).
 *  Pure schema helpers (table/pk/text/…) are browser-safe and stay out.
 *
 *  THE one decider (alpha52): `src/server/graph-validator.ts` (the dev-server
 *  diagnostic) and `aiol` (checks + safe-fixes) both import THIS set — they
 *  used to carry hand-synced copies with a "keep in sync" comment and no
 *  gate. `initSchema`/`loadTables`/`syncTables`/`reactiveDB` joined in
 *  alpha52 when `aio/db` went types+pure-helpers (their values moved to
 *  `aio/server`; the `aio/db` re-exports are deprecated through beta). */
export const SERVER_ONLY_AIO_SYMBOLS: ReadonlySet<string> = new Set([
  "createDB",
  "DEFAULT_PRAGMAS",
  "connectCli",
  "connectCliUDS",
  "initSchema",
  "loadTables",
  "syncTables",
  "reactiveDB",
]);

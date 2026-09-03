// removals.ts — the ONE record of what aio removed within 1.x, and when.
//
// WHY A REGISTRY. The same fact — "`machine:` died in alpha27, here is the
// migration, here is the last version that ran it" — was stated in three places
// that could drift apart: the runtime throw in cell-create.ts, the static check
// in aiol, and the upgrade guide. Three deciders on one fact is exactly how a
// message goes stale and hands a user a recipe that no longer applies. This
// file is the decider; the others read it.
//
// THE 1.x CONTRACT this serves, in two layers:
//
//   FLOOR — an app commits the framework version it was built against
//   (`aioVersion` in its deno.json). A removal therefore never reaches an
//   existing app: it keeps building against its own pinned worktree, forever.
//   Nothing in this file is a compatibility shim, because none is needed.
//
//   LADDER — moving an app forward (`am update`) is allowed to be work, but is
//   never allowed to be a surprise. These rows are what turn "your app explodes
//   at boot on the new version" into a preflight list read off the app's own
//   source, before the pin moves.
//
// ADDING A ROW IS MANDATORY for any future 1.x removal:
// `tests/removals-registry.test.ts` fails if a removal is announced anywhere in
// `src/` or `aiol/` by a message that did not come from here.
import { codeText } from "../diagnostics/code-mask.ts";

import {
  ALPHA70,
  ALPHA76,
  CORE_REMOVALS,
  type Removal,
  RESTRUCTURE,
} from "./removals-core.ts";

// The runtime half — types, the rows a running app can trip, and the message
// every surface prints — lives in removals-core.ts so a browser bundle can
// reach it without the tooling table (see that file's header). Re-exported
// here so THIS module stays the one import path every tool already uses.
export * from "./removals-core.ts";

/** The rows only TOOLING reads: `am` verbs, deno.json keys, and the import
 *  moves `aiol --safe-fix` rewrites. Nothing a page can reach looks these up,
 *  which is what keeps them out of the browser bundle. */
const TOOLING_REMOVALS: readonly Removal[] = [
  {
    key: "aio.run(initialState, config)",
    kind: "api",
    hint:
      "define cells with cell() and call aio.run({ cells: [...] }) — or zero-config aio.run()",
    ...RESTRUCTURE,
  },
  // alpha52 — the surface diet: two aliases deprecated for multiple alphas
  // went out with loud throws (call) / a compile error (useCell).
  {
    key: "useCell()",
    kind: "api",
    removedIn: "alpha52",
    lastGood: "v1.0.0-alpha51",
    hint:
      "read the cell directly — counter.count (reactive) / counter.increment(); " +
      "aiol --safe-fix rewrites useCell(c).state.x",
    guide: "docs/upgrade/from-alpha51-to-alpha52.md",
  },
  // alpha70 — the LAST breaking release: every alpha52-era alias that had been
  // "through beta" goes out together. One spelling per fact from here on.
  {
    key: "CellAccess",
    kind: "api",
    now: "Access",
    hint:
      "rename the type: CellAccess → Access (one vocabulary for cells and serverFns)",
    pattern: /\bCellAccess\b/,
    ...ALPHA70,
  },
  {
    key: "ServerFnAccess",
    kind: "api",
    now: "Access",
    hint:
      "rename the type: ServerFnAccess → Access (one vocabulary for cells and serverFns)",
    pattern: /\bServerFnAccess\b/,
    ...ALPHA70,
  },
  {
    key: "ExtractState",
    kind: "api",
    now: "StateOf",
    hint: "rename the type: ExtractState<typeof c> → StateOf<typeof c>",
    pattern: /\bExtractState\b/,
    ...ALPHA70,
  },
  {
    key: "Action (aio/air)",
    kind: "api",
    now: "NodeAction",
    hint:
      "rename the `use`-prop type: Action → NodeAction (the bare name collided with the dispatch vocabulary)",
    // The import form only (`type Action,` / `type Action }`) — an app's own
    // `type Action = …` is its own business.
    pattern: /\btype\s+Action\s*[,}]/,
    ...ALPHA70,
  },
  {
    key: "aio.run({ appVersion })",
    kind: "api",
    now: 'deno.json "version"',
    hint:
      'delete appVersion from aio.run() — the version lives in deno.json `version` ("major.minor"; aio numbers builds from commits, docs/build/versioning.md)',
    pattern: /\bappVersion\s*:/,
    ...ALPHA70,
  },
  {
    key: "target",
    kind: "deno-json",
    now: "client",
    hint:
      'rename the deno.json key: "target" → "client" (same value) — `am fix` does it',
    ...ALPHA70,
  },
  {
    key: "schedule.blocking",
    kind: "api",
    now: "blocking",
    hint:
      'import { blocking } from "aio" and call blocking(id, fn, arg) — same function, its own top-level name',
    pattern: /\bschedule\.blocking\b/,
    ...ALPHA70,
  },
  {
    key: "connectDevTools()",
    kind: "api",
    now: "connectReduxDevTools()",
    hint:
      "rename: connectDevTools → connectReduxDevTools, disconnectDevTools → disconnectReduxDevTools (the Redux bridge; connectAioDevTools is aio's own)",
    pattern: /\b(?:dis)?connectDevTools\b/,
    ...ALPHA70,
  },
  {
    key: "new",
    kind: "am-verb",
    now: "add",
    hint: "spell it `am add` (same arguments)",
    ...ALPHA70,
  },
  {
    key: "update",
    kind: "am-verb",
    now: "upgrade",
    hint:
      "spell it `am upgrade` (bare: am itself; <app>: that app; <checkout>: a dev am)",
    ...ALPHA70,
  },
  {
    key: "ls",
    kind: "am-verb",
    now: "instances",
    hint: "spell it `am instances` (same output)",
    ...ALPHA70,
  },
  {
    key: "log",
    kind: "am-verb",
    now: "logs",
    hint: "spell it `am logs` (same flags)",
    ...ALPHA70,
  },
  {
    key: "tt",
    kind: "am-verb",
    now: "timetravel",
    hint: "spell it `am timetravel` (same subcommands)",
    ...ALPHA70,
  },
  {
    key: "release",
    kind: "am-verb",
    now: "publish",
    hint: "spell it `am publish` (same flags)",
    ...ALPHA70,
  },
  {
    key: 'import { createDB } from "aio/db"',
    kind: "api",
    now: 'import { createDB } from "aio/server"',
    hint:
      'import the DB runtime values (createDB, DEFAULT_PRAGMAS, initSchema, loadTables, syncTables, reactiveDB) from "aio/server" — aio/db is types-only; aiol --safe-fix moves them',
    ...ALPHA70,
  },
  {
    key: 'import { shipApp } from "aio/build"',
    kind: "api",
    now: 'import { shipApp } from "aio/ship"',
    hint:
      'import the ship family (buildShipManifest, generateSigningKey, shipApp, verifyShipManifest, ShipManifest) from "aio/ship" — aiol --safe-fix moves them',
    ...ALPHA70,
  },
  {
    key: 'import { appDirs } from "aio/testing"',
    kind: "api",
    now: 'import { appDirs } from "aio/server"',
    hint:
      'import appDirs/AppDirs from "aio/server" (ensureAppDirs, registerAppDirs, _resetAppDirs stay on aio/testing) — aiol --safe-fix moves them',
    ...ALPHA70,
  },
  {
    key: 'import { installUpdatesRuntime } from "aio/testing"',
    kind: "api",
    now: 'import { installUpdatesRuntime } from "aio/updates"',
    hint:
      'import the updates runtime seam (installUpdatesRuntime, UpdatesRuntime, ApplyOptions, CheckOptions, CheckResult) from "aio/updates" — aiol --safe-fix moves them',
    ...ALPHA70,
  },
  {
    key: 'import { testComponent } from "aio/air"',
    kind: "api",
    now: 'import { testComponent } from "aio/testing"',
    hint:
      'import testComponent/setDocument (+ TestComponentHandle, TestComponentOptions) from "aio/testing", next to testCell and testUI — aiol --safe-fix moves them',
    ...ALPHA70,
  },
  {
    key: 'import { testCell } from "aio"',
    kind: "api",
    now: 'import { testCell } from "aio/testing"',
    hint:
      'import testCell/TestContext from "aio/testing" — aiol --safe-fix moves them',
    ...ALPHA70,
  },
  {
    key: 'lint() from "aio/extras"',
    kind: "api",
    now: "checkCells",
    hint:
      "rename: checkCells(cells) (the alias collided with aiol's project linter) — aiol --safe-fix keeps the local name: import { checkCells as lint }",
    ...ALPHA70,
  },
  // alpha76 — the pre-beta sweep. Four runtime flags and one `aio.run()` key
  // that had been "accepted aliases" with no removal date; beta freezes the
  // surface, so an alias carried into it is permanent. The flags are refused
  // by `parseCli` (aio-cli.ts), which is why they carry no source `pattern`:
  // a flag lives in a shell line or a deno.json task, not in TypeScript.
  {
    key: "--kill-existing",
    kind: "cli-flag",
    now: "--takeover",
    hint: "spell it `--takeover` (same behaviour), and the aio.run() key too",
    ...ALPHA76,
  },
  {
    key: "--server-url",
    kind: "cli-flag",
    now: "--connect",
    hint:
      "the BARE flag opens the connect page, so it is spelled `--connect`; the valued form `--server-url=<url>` is unchanged",
    ...ALPHA76,
  },
  {
    key: "--zero-port",
    kind: "cli-flag",
    hint:
      "delete the flag — zero TCP ports is already the default for a local electron app; `--port=N` is the opt-OUT",
    ...ALPHA76,
  },
  {
    key: "--backup-logs",
    kind: "cli-flag",
    hint:
      "delete the flag — keeping previous logs is the default; `--no-backup-logs` is the one that changes anything",
    ...ALPHA76,
  },
  {
    key: "aio.run({ killExisting })",
    kind: "api",
    now: "aio.run({ takeover })",
    hint:
      "rename the config key: killExisting: true → takeover: true — one word for the key and the `--takeover` flag, so a compiled service binary can write the current spelling",
    pattern: /\bkillExisting\s*:/,
    ...ALPHA76,
  },
  {
    key: "testgen()",
    kind: "api",
    now: "testGen",
    hint:
      "rename: testGen (camelCase, like testUI/testCell) — aiol --safe-fix keeps the local name: import { testGen as testgen }",
    ...ALPHA70,
  },
] as const;

/**
 * Every removal in 1.x — THE record. The runtime rows first (removals-core.ts,
 * which a page can reach), then the tooling-only ones.
 */
export const REMOVALS: readonly Removal[] = [
  ...CORE_REMOVALS,
  ...TOOLING_REMOVALS,
];

/** Look a key up across the WHOLE record. Overrides the core-only lookup this
 *  module re-exports: `aiol` and `am` ask about tooling rows too. */
export function removalFor(key: string): Removal | null {
  return REMOVALS.find((r) => r.key === key) ?? null;
}

/** Look up a key the caller KNOWS was removed — a missing row is a bug in this
 *  file, and a guard that quietly stops guarding is the failure this codebase
 *  refuses, so it throws rather than returning null. */
export function removalOf(key: string): Removal {
  const r = removalFor(key);
  if (!r) {
    throw new Error(
      `removals.ts has no row for '${key}' — a surface announces this removal ` +
        `but the registry does not record it. Add the row.`,
    );
  }
  return r;
}

/** A removed key found in source, with the line it sits on (1-based) and
 *  that line's text (trimmed) — a refusal that names `src/x.ts:61` without
 *  showing what matched sends the reader to open the file to learn it was a
 *  real config key and not a word in a comment. */
export interface RemovalHit {
  readonly removal: Removal;
  readonly line: number;
  readonly text: string;
}

/** Is this source path a test/fixture path — where a removed spelling is a
 *  FIXTURE (an app's own upgrade test, a self-test that feeds the old shape
 *  on purpose) rather than a config the app boots with? `am pin` WARNS on
 *  these and REFUSES on the rest. `path` is relative to the app root. */
export function isFixturePath(path: string): boolean {
  const p = "/" + path.replaceAll("\\", "/");
  return /\/tests?\//.test(p) || /\/testing\//.test(p) ||
    /\.test\./.test(p) || p.includes("/fixtures/") ||
    p.includes("/util/selftest");
}

/**
 * Find removed cell-config keys in a chunk of source.
 *
 * The registry owns DETECTION as well as the facts — otherwise the linter and
 * the upgrade preflight each grow their own scanner and disagree about what
 * counts as a hit, which is the same drift this file exists to end.
 *
 * Textual, but on CODE only: the source is passed through `codeText` (THE
 * "is this offset real code?" decider, shared with aiol) first, so a key
 * spelled inside a string, a template literal (`${…}` included), a comment
 * or a regex literal is not a hit. A field report: an app's own upgrade-test
 * fixture carried `execute:` in a template string, and `am pin` refused to
 * move an app whose real config was already migrated. Offsets and line breaks
 * survive the mask, so the line number — and the quoted line — are the ones
 * the reader sees in the file.
 *
 * Still deliberately generous within code: callers narrow the input (aiol
 * passes one cell's config block; `am pin` passes whole files that call
 * `cell(`). A false positive costs a warning a human can overrule; a miss costs
 * an app that explodes at boot on a version it was told was safe.
 */
export function removalsInSource(text: string): RemovalHit[] {
  const hits: RemovalHit[] = [];
  const raw = text.split("\n");
  const lines = codeText(text).split("\n");
  for (const r of REMOVALS) {
    const re = r.kind === "cell-config"
      ? new RegExp(`(^|[{,\\s])${r.key}\\s*:`)
      : r.pattern; // an API shape names its own pattern, or is not textual
    if (!re) continue;
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) hits.push({ removal: r, line: i + 1, text: raw[i]!.trim() });
  }
  return hits.sort((a, b) => a.line - b.line);
}

/** Removed top-level `deno.json` keys this config still carries. */
export function removalsInDenoJson(
  denoJson: Record<string, unknown> | undefined,
): readonly Removal[] {
  if (!denoJson) return [];
  return REMOVALS.filter((r) =>
    r.kind === "deno-json" && denoJson[r.key] !== undefined
  );
}

/** The removal row for an `am` verb that no longer exists, or null. */
export function removedAmVerb(verb: string): Removal | null {
  return REMOVALS.find((r) => r.kind === "am-verb" && r.key === verb) ?? null;
}

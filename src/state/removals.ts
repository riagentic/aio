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
import { log } from "../diagnostics/logger-api.ts";

/** What kind of thing was removed — decides how the message reads. */
export type RemovalKind =
  /** A `cell({ … })` config key. `key` is the bare name, no colon. */
  | "cell-config"
  /** A top-level `deno.json` key. `key` is the bare name. */
  | "deno-json"
  /** An `am` verb. `key` is the verb as typed (`"new"`). */
  | "am-verb"
  /** Any other public API shape. `key` is the call as a user would write it. */
  | "api";

/** One removed API, and everything a user needs to act on it. */
export interface Removal {
  /** `"machine"` for a config key; `"aio.run(initialState, config)"` for an API. */
  readonly key: string;
  readonly kind: RemovalKind;
  /** Release that removed it — the bare series name, e.g. `"alpha27"`. */
  readonly removedIn: string;
  /** Last tag that still accepted it — a pin that runs the app unchanged. */
  readonly lastGood: string;
  /** The migration, in one line. Present tense, imperative, copy-pasteable. */
  readonly hint: string;
  /** Guide with the full recipe, relative to the repo root. */
  readonly guide: string;
  /** How the removed spelling is found in an app's SOURCE (code only — see
   *  `removalsInSource`). A cell-config key needs none (`key:` is the
   *  pattern); an API shape names its own. Absent = not textually findable
   *  (the type-checker or the CLI refuses it instead). */
  readonly pattern?: RegExp;
  /** The spelling that replaced it — set when the removal is a RENAME, so a
   *  surface can say "spelled `x` now" in five words. */
  readonly now?: string;
}

const RESTRUCTURE = {
  removedIn: "alpha27",
  lastGood: "v1.0.0-alpha26",
  guide: "docs/upgrade/restructure.md",
} as const;

const ALPHA70 = {
  removedIn: "alpha70",
  lastGood: "v1.0.0-alpha69",
  guide: "docs/upgrade/from-alpha69-to-alpha70.md",
} as const;

/**
 * Every removal in 1.x, oldest release first.
 *
 * perfect-aio D1/D9: `methods` is the ONE style, so the Style-B layer
 * (actions/reduce/execute/machine/generators) and the 2-arg `aio.run` overload
 * went out together in alpha27.
 */
export const REMOVALS: readonly Removal[] = [
  {
    key: "aio.run(initialState, config)",
    kind: "api",
    hint:
      "define cells with cell() and call aio.run({ cells: [...] }) — or zero-config aio.run()",
    ...RESTRUCTURE,
  },
  {
    key: "actions",
    kind: "cell-config",
    hint:
      "actions+reduce pairs are one method — `increment(s, by) { s.count += by }`",
    ...RESTRUCTURE,
  },
  {
    key: "reduce",
    kind: "cell-config",
    hint: "reduce: handlers are method bodies now — mutate `s` in the method",
    ...RESTRUCTURE,
  },
  {
    key: "execute",
    kind: "cell-config",
    hint: "side-effects run inside the (async) method itself",
    ...RESTRUCTURE,
  },
  {
    key: "machine",
    kind: "cell-config",
    hint: 'guards are a guard line — `if (s.status !== "idle") return;`',
    ...RESTRUCTURE,
  },
  {
    key: "generators",
    kind: "cell-config",
    hint:
      "generators are plain async methods — use until()/race()/sleep() from aio, " +
      "cancelOn + s.$signal for cancellation",
    ...RESTRUCTURE,
  },
  // alpha52 — the surface diet: two aliases deprecated for multiple alphas
  // went out with loud throws (call) / a compile error (useCell).
  {
    key: "call({ timeout })",
    kind: "api",
    removedIn: "alpha52",
    lastGood: "v1.0.0-alpha51",
    hint:
      "rename the option: call({ timeoutMs: 5000 }, fn) — aiol --safe-fix does it",
    guide: "docs/upgrade/from-alpha51-to-alpha52.md",
  },
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
    key: "schedule.poll({ backoff })",
    kind: "api",
    now: "factor",
    hint:
      "rename the option key: { every, backoff: 2 } → { every, factor: 2 } (same meaning)",
    pattern: /\bevery\s*:[^}]*\bbackoff\s*:/,
    ...ALPHA70,
  },
  {
    key: "schedule.backoff/poll(id, attempt, opts, action)",
    kind: "api",
    now: "schedule.backoff(id, attempt, action, opts)",
    hint:
      "swap the last two arguments: the action is 3rd and the options 4th, like after/every",
    pattern: /schedule\.(?:backoff|poll)\([^,()]+,[^,()]+,\s*\{/,
    ...ALPHA70,
  },
  {
    key: "cell({ ui })",
    kind: "api",
    now: "visible",
    hint:
      "rename the cell config key: ui: → visible: (access gates calls, visible gates reads) — aiol --safe-fix does it",
    // A CELL's `ui:` takes "all"/"none" or a filter object; the app-level
    // `aio.run({ ui: { width } })` window config never takes a string and
    // never those filter keys — so this matches the cell key alone.
    pattern:
      /(?:^|[{,\s])ui\s*:\s*(?:["']|\{\s*(?:include|exclude|forUser|publicFields)\b)/,
    ...ALPHA70,
  },
  {
    key: "cellDefaults.ui",
    kind: "api",
    now: "cellDefaults.visible",
    hint:
      "rename the app-level default: cellDefaults: { ui } → cellDefaults: { visible }",
    pattern: /\bcellDefaults\s*:\s*\{[^}]*\bui\s*:/,
    ...ALPHA70,
  },
  {
    key: "listensTo: [...]",
    kind: "api",
    now: "listensTo: { handler: other.method }",
    hint:
      "use the object form, which names the sync method that reacts: listensTo: { onThing: other.method }",
    pattern: /\blistensTo\s*:\s*\[/,
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
  {
    key: "testgen()",
    kind: "api",
    now: "testGen",
    hint:
      "rename: testGen (camelCase, like testUI/testCell) — aiol --safe-fix keeps the local name: import { testGen as testgen }",
    ...ALPHA70,
  },
  {
    key: "memory.gcStressRatio",
    kind: "api",
    hint:
      "delete the key — it was accepted and never read; heap pressure is reported by warnThreshold, criticalThreshold, machineWarnFraction and growthReportRatio",
    ...ALPHA70,
  },
] as const;

/** Look a key up. Returns null for anything still supported. */
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

/** The config keys a cell may no longer declare. */
export const REMOVED_CELL_KEYS: readonly string[] = REMOVALS
  .filter((r) => r.kind === "cell-config")
  .map((r) => r.key);

/** Which removed keys does this cell config use? Order follows REMOVALS. */
export function removalsUsedBy(
  config: Record<string, unknown>,
): readonly Removal[] {
  return REMOVALS.filter((r) =>
    r.kind === "cell-config" && config[r.key] !== undefined
  );
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

/** The one-line refusal a dropped spelling answers with: "`x` is spelled `y`
 *  now" first, the full removal message after. Never silent, never a
 *  silent forward. */
export function retiredSpellingLine(r: Removal, subject?: string): string {
  const what = r.kind === "am-verb" ? `\`am ${r.key}\`` : `\`${r.key}\``;
  const now = r.now
    ? `${what} is spelled \`${
      r.kind === "am-verb" ? `am ${r.now}` : r.now
    }\` now — `
    : "";
  return `${now}${removalMessage(r, subject)}`;
}

/** THE dev/prod split for a removed spelling that is READ FROM CONFIG and so
 *  cannot simply cease to exist (`cell({ ui })`, `cellDefaults.ui`,
 *  `listensTo: […]`, deno.json `target`): dev (`__aioDev`) THROWS with the
 *  registry message — a test or a dev boot is where the app's author is —
 *  and prod logs the same line at error level and honours the old spelling,
 *  because a running app that silently DROPPED its visibility filter would
 *  be a data leak dressed as a cleanup. Category (b) of the dev==prod rule:
 *  dev stricter, never a silent divergence. */
export function refuseRetired(r: Removal, subject?: string): void {
  const line = retiredSpellingLine(r, subject);
  if ((globalThis as Record<string, unknown>).__aioDev === true) {
    throw new Error(line);
  }
  log.error("removals", line);
}

/**
 * The message every surface prints for a removal.
 *
 * It carries BOTH exits, because a user who hits this has two legitimate ones
 * and the framework does not get to pick: migrate the code, or pin the
 * framework the code was written for and keep shipping. `subject` names where
 * it was found (a cell name) when the surface knows it.
 */
export function removalMessage(r: Removal, subject?: string): string {
  const where = subject ? `[${subject}] ` : "";
  const what = r.kind === "cell-config"
    ? `cell config key '${r.key}:'`
    : r.kind === "deno-json"
    ? `deno.json key "${r.key}"`
    : r.kind === "am-verb"
    ? `\`am ${r.key}\``
    : r.key;
  return `${where}${what} was removed in ${r.removedIn} — ${r.hint}. ` +
    `Migrate: ${r.guide} — or run it unchanged on the version it was written ` +
    `for: \`am pin ${r.lastGood} && am fix\`.`;
}

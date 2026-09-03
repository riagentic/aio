// removals-core.ts — the removal rows a RUNNING APP can trip, and the message
// every surface prints for one.
//
// Split out of removals.ts for one measured reason: the browser bundle. Three
// browser-reachable modules (cell-impl, schedule, cell-methods-factory, plus
// cell-create/cell-helpers/memory-monitor) look a removal up by key, which
// pulled the WHOLE registry into every page — 36 rows of `am publish` and
// deno.json migration prose, ~7 KB raw / 2.3 KB gzipped that a page can never
// use, on every page load. Splitting the table is not enough on its own: what
// makes it tree-shakeable is that the browser graph never imports the tooling
// half at all. So the rows a running app can hit live HERE, and the rows only
// `am`, `aiol` and the build ever read stay in removals.ts, which imports this
// file and re-exports it — every tooling import line is unchanged.
//
// ADDING A ROW: it belongs here only if a RUNTIME path looks it up
// (`removalOf`/`removalFor`/`removalsUsedBy`/`retiredCellConfigKeys` from a
// module a page can reach). Everything else goes in removals.ts.
// `tests/removals-registry.test.ts` sees both halves through `REMOVALS`.
import { log } from "../diagnostics/logger-api.ts";

/** What kind of thing was removed — decides how the message reads. */
export type RemovalKind =
  /** A `cell({ … })` config key. `key` is the bare name, no colon. */
  | "cell-config"
  /** A top-level `deno.json` key. `key` is the bare name. */
  | "deno-json"
  /** An `am` verb. `key` is the verb as typed (`"new"`). */
  | "am-verb"
  /** A runtime CLI flag. `key` is the flag as typed (`"--zero-port"`). */
  | "cli-flag"
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

/** Shared release facts, exported so the tooling half of the registry
 *  (removals.ts) spells them once too. @internal */
export const RESTRUCTURE = {
  removedIn: "alpha27",
  lastGood: "v1.0.0-alpha26",
  guide: "docs/upgrade/restructure.md",
} as const;

/** @internal — see {@link RESTRUCTURE}. */
export const ALPHA70 = {
  removedIn: "alpha70",
  lastGood: "v1.0.0-alpha69",
  guide: "docs/upgrade/from-alpha69-to-alpha70.md",
} as const;

/** @internal — see {@link RESTRUCTURE}. The pre-beta sweep: the six spellings
 *  still marked "deprecated through beta" with no removal date. Beta freezes
 *  the public surface, so a deprecation carried into it is permanent. */
export const ALPHA76 = {
  removedIn: "alpha76",
  lastGood: "v1.0.0-alpha75",
  guide: "docs/upgrade/from-alpha75-to-alpha76.md",
} as const;

/** The removals a RUNNING app can trip — see the header. `REMOVALS` in
 *  removals.ts is this list plus the tooling-only rows, and is THE record. */
export const CORE_REMOVALS: readonly Removal[] = [
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
  // alpha76 — the pre-beta sweep: every "deprecated through beta" spelling that
  // would otherwise become permanent public surface at beta1.
  {
    key: "return effect(s) from a method",
    kind: "api",
    now: "s.$do(effect)",
    hint:
      "call s.$do(schedule.after(...)) inside the method and keep `return` for " +
      "values — a returned effect resolved the caller with undefined, so the " +
      "two meanings could never share the channel; aiol --safe-fix rewrites it",
    pattern: /\breturn\s+(?:schedule|own)\.\w+\s*\(/,
    ...ALPHA76,
  },
  {
    key: "selector deps as a spread",
    kind: "api",
    now: "fn: (s, [dep1, dep2], ...args)",
    hint:
      'take the dep slices as ONE tuple parameter: { deps: ["prices"], fn: (s, [prices], id) => … } — ' +
      "so a parameterized selector can still take its own args; aiol --safe-fix rewrites it",
    // A NON-EMPTY deps list (zero deps is never the spread form) whose `fn`
    // takes a second parameter that is not the tuple: `fn: (s, prices)` is
    // legacy, `fn: (s, [prices])` is current, and `fn: (s)` ignores its deps
    // and is neither. The lookahead swallows the whitespace ITSELF: `,\s*`
    // followed by `(?!\[)` backtracks to zero spaces and passes on `, [p]`.
    pattern:
      /\bdeps\s*:\s*\[\s*[^\]\s][^\]]*\]\s*,\s*fn\s*:\s*(?:async\s*)?\(\s*\w+[^,)]*,(?!\s*\[)/,
    ...ALPHA76,
  },
  {
    key: "memory.gcStressRatio",
    kind: "api",
    hint:
      "delete the key — it was accepted and never read; heap pressure is reported by warnThreshold, criticalThreshold, machineWarnFraction and growthReportRatio",
    ...ALPHA70,
  },
] as const;

/** Look a key up among the rows a running app can trip. Returns null for
 *  anything still supported — and for a TOOLING-only row, which no runtime
 *  path asks about; removals.ts overrides this with the full-table version
 *  for `am`, `aiol` and the build. */
export function removalFor(key: string): Removal | null {
  return CORE_REMOVALS.find((r) => r.key === key) ?? null;
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

/** Which removed keys does this cell config use? Order follows REMOVALS. */
export function removalsUsedBy(
  config: Record<string, unknown>,
): readonly Removal[] {
  return CORE_REMOVALS.filter((r) =>
    r.kind === "cell-config" && config[r.key] !== undefined
  );
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

/** Retired spellings a `cell()` CONFIG OBJECT is carrying.
 *
 *  `removalsUsedBy` answers the same question for `kind: "cell-config"` rows —
 *  keys whose removal is total. This answers it for the `kind: "api"` rows
 *  whose key IS a config key written as a call shape (`cell({ ui })`), which
 *  the source scanner matches by pattern and which nothing checked at runtime.
 *  `cell({ ui })` therefore passed `cell()` silently for eight releases while
 *  the TYPE had already dropped it — the app worked and its types died.
 *
 *  Keyed off the row's own `key`, so adding a row is all it takes to enforce
 *  one: no second list to keep in step. */
export function retiredCellConfigKeys(
  config: Record<string, unknown>,
): readonly Removal[] {
  return CORE_REMOVALS.filter((r) => {
    const m = /^cell\(\{\s*(\w+)\s*\}\)$/.exec(r.key);
    return m !== null && config[m[1]!] !== undefined;
  });
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
  if (removalsAreFatal()) throw new Error(line);
  log.error("removals", line);
}

/** Does a retired spelling THROW here (dev/test), or log and degrade (prod)?
 *
 *  THE gate `refuseRetired` branches on, exported rather than re-read, so a
 *  caller on a HOT path — a method return, refused once per call rather than
 *  once at boot — can throttle its PROD log against the same branch that
 *  emits it. Second-guessing the gate is how a dev throw quietly became
 *  once-per-process, which is a coin flip, not a refusal. */
export function removalsAreFatal(): boolean {
  return (globalThis as Record<string, unknown>).__aioDev === true;
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
    : r.kind === "cli-flag"
    ? `\`${r.key}\``
    : r.key;
  return `${where}${what} was removed in ${r.removedIn} — ${r.hint}. ` +
    `Migrate: ${r.guide} — or run it unchanged on the version it was written ` +
    `for: \`am pin ${r.lastGood} && am fix\`.`;
}

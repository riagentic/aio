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

/** What kind of thing was removed — decides how the message reads. */
export type RemovalKind =
  /** A `cell({ … })` config key. `key` is the bare name, no colon. */
  | "cell-config"
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
}

const RESTRUCTURE = {
  removedIn: "alpha27",
  lastGood: "v1.0.0-alpha26",
  guide: "docs/upgrade/restructure.md",
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

/** A removed key found in source, with the line it sits on (1-based). */
export interface RemovalHit {
  readonly removal: Removal;
  readonly line: number;
}

/**
 * Find removed cell-config keys in a chunk of source.
 *
 * The registry owns DETECTION as well as the facts — otherwise the linter and
 * the upgrade preflight each grow their own scanner and disagree about what
 * counts as a hit, which is the same drift this file exists to end.
 *
 * Deliberately textual and deliberately generous: callers narrow the input
 * (aiol passes one cell's config block; `am pin` passes whole files that call
 * `cell(`). A false positive costs a warning a human can overrule; a miss costs
 * an app that explodes at boot on a version it was told was safe.
 */
export function removalsInSource(text: string): RemovalHit[] {
  const hits: RemovalHit[] = [];
  const lines = text.split("\n");
  for (const r of REMOVALS) {
    if (r.kind !== "cell-config") continue; // an API shape is not textual
    const re = new RegExp(`(^|[{,\\s])${r.key}\\s*:`);
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) hits.push({ removal: r, line: i + 1 });
  }
  return hits.sort((a, b) => a.line - b.line);
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
  const what = r.kind === "cell-config" ? `cell config key '${r.key}:'` : r.key;
  return `${where}${what} was removed in ${r.removedIn} — ${r.hint}. ` +
    `Migrate: ${r.guide} — or run it unchanged on the version it was written ` +
    `for: \`am pin ${r.lastGood} && am fix\`.`;
}

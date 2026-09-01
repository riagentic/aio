// cell-create.ts — cell() dispatcher + public API re-exports
//
// Decomposed into focused modules:
//   cell-config-types.ts    — MethodsCellConfig
//   cell-helpers.ts         — normalization, scopeSelectors, detectForeignActions
//   cell-methods-factory.ts — createCellFromMethods (the ONE style — methods)

import type {
  CellDef,
  DirectCalling,
  MethodsToCreators,
} from "./cell-types.ts";
import { isAsyncFunction, type Method } from "./cell-impl.ts";
import { createCellFromMethods } from "./cell-methods-factory.ts";
import { registerCell } from "./cell-reactive.ts";
import {
  removalMessage,
  removalsUsedBy,
  retiredCellConfigKeys,
} from "./removals.ts";
import { nearestOf } from "./cell-helpers.ts";
import type {
  MethodsCellConfig,
  SelectorAccessors,
  SelectorDef,
} from "./cell-config-types.ts";

export type { MethodsCellConfig };

/** Every key `cell()` reads. Kept beside the type it mirrors
 *  ({@linkcode MethodsCellConfig}) — `tests/cell-config-keys.test.ts` fails the
 *  moment the two disagree, so this cannot rot into a stale allow-list. */
const VALID_CELL_KEYS: ReadonlySet<string> = new Set([
  "state",
  "methods",
  "selectors",
  "sync",
  "persist",
  "visible",
  "access",
  "scope",
  "long",
  "cancelOn",
  "listensTo",
  "transaction",
  "validate",
  "version",
  "onMigrate",
  "onInit",
  "onDestroy",
  "onRestore",
  "worker",
]);

/** The closest valid key, when a typo is one edit away from a real one. */
function nearestKey(bad: string): string | null {
  return nearestOf(bad, VALID_CELL_KEYS);
}

// ── cell() ──────────────────────────────────────────────────────

/** The ONE wording for "a persist filter on a sync cell" — thrown by `cell()`
 *  for the cell's own `persist`, and by composition for a `cellDefaults`
 *  filter that would land on a sync cell. */
export function persistFilterOnSyncCellMessage(
  name: string,
  persist: unknown,
  via?: string,
): string {
  const p = persist as "none" | { include?: string[]; exclude?: string[] };
  const fields = p === "none"
    ? 'every field (`persist: "none"`)'
    : p.exclude
    ? `exclude: ${p.exclude.join(", ")}`
    : `include: ${(p.include ?? []).join(", ")}`;
  return `[cell:${name}] sync: true + a persist filter (${fields}${
    via ? `, from ${via}` : ""
  }) is refused. ` +
    `The op-log is the durable home of a sync cell and every op is a method ` +
    `call's payload written raw, so a persist filter cannot apply to it — ` +
    `the field would be on disk anyway. Pick one:\n` +
    `  • remove the persist filter from "${name}" (persist: "all"), or\n` +
    `  • turn sync off for "${name}" (server-authoritative, filter honoured), or\n` +
    `  • keep the transient data in a separate non-sync cell.`;
}

/** Define a cell — state + methods (+ selectors, sync, cancelOn, listensTo).
 *  ONE style: methods mutate a draft; async methods batch writes and carry a
 *  cancellation signal (`s.$signal`). See docs/state/cells.md. */
export function cell<
  N extends string,
  S extends Record<string, unknown>,
  M extends Record<string, Method<S>>,
  States extends string = string,
  // Captured from config.selectors (inside MethodsCellConfig — NOT an
  // intersection, which would disrupt method `s` inference) so bound selector
  // accessors surface on the return type instead of being inert config.
  // Default MUST be an empty record, not Record<string, …>: that default put
  // a string INDEX SIGNATURE on every selector-less cell's type, which widened
  // `keyof cellRef` to `string` and collapsed every mapped type over the cell
  // ref (e.g. testCell's typed send surface) to {}.
  Sel extends Record<string, SelectorDef<S>> = Record<never, SelectorDef<S>>,
>(
  name: N,
  config: MethodsCellConfig<N, S, M, States, Sel>,
  // Actions carry a concrete creators map derived from the methods (not `any`)
  // so downstream tooling — notably testCell's `t.send` — recovers typed,
  // non-optional method senders instead of an index signature. (Capturing
  // generators/mixed actions here too was tried but degraded method `s`
  // inference, so the typed surface stays scoped to methods.) `Sel` is captured
  // from `config.selectors` so bound selector accessors (`cell.total()`) are
  // type-accessible instead of inert config.
): // deno-lint-ignore no-explicit-any
& CellDef<N, MethodsToCreators<M>, any, S>
& DirectCalling<N, M>
& SelectorAccessors<Sel>
& Readonly<S>;
/** Implementation — validates, rejects removed Style-B keys, builds the cell. */
// deno-lint-ignore no-explicit-any
export function cell(name: string, config: any): any {
  // Validate name at definition time — it becomes the cell id, action prefix
  // (`${name}:action`), KV key prefix, and SQLite table key. An empty,
  // non-string, or identifier-unsafe name would corrupt the registry, the
  // wire protocol, and persistence with a cryptic error at first dispatch.
  // Allows word chars + hyphens (matching existing cell names like
  // "stub-empty", "flc-counter", "uitest-list") but rejects the prototype-
  // pollution trinity explicitly.
  const BANNED_NAMES = new Set(["__proto__", "constructor", "prototype"]);
  if (
    !name || typeof name !== "string" ||
    !/^[A-Za-z_][\w\-]*$/.test(name) ||
    BANNED_NAMES.has(name)
  ) {
    throw new Error(
      `cell(): invalid name '${JSON.stringify(name)}' — must be a non-empty ` +
        `string matching /^[A-Za-z_][\\w\\-]*$/ (identifier-safe, hyphens ok). ` +
        `The name becomes the cell id, action prefix, and persistence key — ` +
        `reserved words (__proto__, constructor, prototype) are rejected.`,
    );
  }
  // Validate state shape at definition time — state must be a plain object so
  // Immer can draft it and reducers can mutate fields. A primitive, null, or
  // array would crash inside produce() at first dispatch with a cryptic error.
  if (
    config.state != null &&
    (typeof config.state !== "object" || Array.isArray(config.state))
  ) {
    throw new Error(
      `[${name}] cell state must be a plain object, got ${
        Array.isArray(config.state) ? "array" : typeof config.state
      } — reducers rely on Immer drafting an object shape.`,
    );
  }

  // perfect-aio D1: methods is the ONE style. Every removed key fails loudly
  // with the migration recipe AND the pin that runs the app unchanged — both
  // sourced from the removal registry, never restated here (src/state/removals.ts).
  for (const r of removalsUsedBy(config as Record<string, unknown>)) {
    throw new Error(removalMessage(r, name));
  }

  // A RETIRED spelling that is READ FROM CONFIG is refused in exactly one
  // place — `resolveVisibility` below throws in dev and logs-and-honours in
  // prod (alpha70's `cell({ ui })` row). What was missing is only this: the
  // unknown-option check must not ALSO report it. Without the exclusion,
  // taking `"ui"` out of VALID_CELL_KEYS turns prod's "logged and honoured"
  // into a hard refusal — the one path that must keep running.
  //
  // Adding a second `refuseRetired` call here instead was the obvious move and
  // the wrong one: prod then logged the same removal twice, which
  // `tests/alpha70-retirements.test.ts` refused by asserting "prod: one error
  // line". One fact, one home.
  const retiredKeys = new Set(
    retiredCellConfigKeys(config as Record<string, unknown>).map((r) =>
      /^cell\(\{\s*(\w+)\s*\}\)$/.exec(r.key)?.[1] ?? ""
    ),
  );

  // An unknown key is a typo, and a typo that is accepted is a feature that
  // silently does not exist. `aio.run()` has refused a misspelled key across
  // 156 of them for releases; the OTHER half of an app's configuration —
  // where `sync`, `access`, `persist` and `version` live — validated nothing,
  // so `method:` for `methods:` produced a cell with no methods, `presist:`
  // persisted anyway, and `sync: { mrege: … }` silently resolved every
  // conflict last-write-wins instead of the strategy the app declared.
  const unknown = Object.keys(config as Record<string, unknown>)
    .filter((k) => !VALID_CELL_KEYS.has(k) && !retiredKeys.has(k));
  if (unknown.length > 0) {
    const hints = unknown.map((k) => {
      const near = nearestKey(k);
      return near ? `"${k}" (did you mean "${near}"?)` : `"${k}"`;
    });
    throw new Error(
      `[${name}] cell(): unknown option ${hints.join(", ")}. Valid keys: ` +
        `${[...VALID_CELL_KEYS].sort().join(", ")}. ` +
        `A key aio does not read does nothing — silently, until you notice ` +
        `the behaviour you configured never happened.`,
    );
  }

  // field report §3.1: `sync` + a `persist` filter is REFUSED at definition.
  // A sync cell's durable home is the op-log, and an op is the method call's
  // payload — raw. No filter can apply to it: an excluded field's every value
  // that passed through a method payload is on disk regardless, and `"none"`
  // would restore an empty cell. The filter used to be honoured on the
  // compaction snapshot only and warned about — a promise kept in one of two
  // write paths is a promise the framework cannot keep, so the combination is
  // now impossible. `cellDefaults.persist` reaching a sync cell is refused
  // at compose time by the same rule (aio-composition `refuseFilteredSyncCells`).
  if (config.sync && config.persist !== undefined && config.persist !== "all") {
    throw new Error(persistFilterOnSyncCellMessage(name, config.persist));
  }

  // AIO-5.1: client-scoped cells — browser-local state, sync methods only.
  // Validation happens at cell() time so misuse fails at definition, not at runtime.
  if (config.scope === "client") {
    for (
      const [key, fn] of Object.entries(
        (config.methods ?? {}) as Record<string, unknown>,
      )
    ) {
      // ONE decider for "is this method async". This used to test
      // `constructor.name === "AsyncFunction"` inline, which is only HALF of
      // what `isAsyncFunction` answers: a method marked with `markAsync` (a
      // transpiled async body whose constructor is a plain Function) passed
      // this guard on the server while the browser cell stub — which does use
      // `isAsyncFunction` — threw at MODULE LOAD. The app booted fine and the
      // page was blank, which is the worst possible split for a rule whose
      // whole job is to refuse the configuration early.
      if (isAsyncFunction(fn as (...a: unknown[]) => unknown)) {
        throw new Error(
          `[${name}] client-scoped cells support sync methods only (no server ` +
            `round-trip exists); do async work in the component and call sync ` +
            `methods with results — '${key}' is async`,
        );
      }
    }
    const def = createCellFromMethods(
      name,
      config as MethodsCellConfig<string, Record<string, unknown>>,
      "client",
    );
    // Raw sync methods — bindCellReactive runs these locally against the cell signal.
    def.__aio.clientMethods = config.methods as Record<
      string,
      (s: Record<string, unknown>, ...args: unknown[]) => unknown
    >;
    registerCell(def);
    return def;
  }

  // Methods style — the one style. An empty or omitted methods map is valid:
  // state-only cells (thin-client stubs).
  const def = createCellFromMethods(
    name,
    config as MethodsCellConfig<string, Record<string, unknown>>,
  );
  registerCell(def);
  return def;
}

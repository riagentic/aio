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
import type { Method } from "./cell-impl.ts";
import { createCellFromMethods } from "./cell-methods-factory.ts";
import { registerCell } from "./cell-reactive.ts";
import { removalMessage, removalsUsedBy } from "./removals.ts";
import type {
  MethodsCellConfig,
  SelectorAccessors,
  SelectorDef,
} from "./cell-config-types.ts";

export type { MethodsCellConfig };

// ── cell() ──────────────────────────────────────────────────────

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

  // AIO-5.1: client-scoped cells — browser-local state, sync methods only.
  // Validation happens at cell() time so misuse fails at definition, not at runtime.
  if (config.scope === "client") {
    for (
      const [key, fn] of Object.entries(
        (config.methods ?? {}) as Record<string, unknown>,
      )
    ) {
      if (
        (fn as { constructor: { name: string } }).constructor.name ===
          "AsyncFunction"
      ) {
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
    );
    def.__aio.scope = "client";
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

// cell-helpers.ts — shared cell-creation helpers: normalization, selectors, foreign actions

import type {
  CellFieldFilter,
  CellVisibility,
  FilterUser,
  MachineConfig,
} from "./cell-types.ts";

// ── Normalization helpers ────────────────────────────────────────────

/** Normalize persist config into CellFieldFilter for CellAio internals */
export function normalizePersistFilter(
  persist: CellFieldFilter | undefined,
): CellFieldFilter | undefined {
  if (!persist) return undefined;
  return persist;
}

/** Extract forUser from CellVisibility if present */
export function extractForUser(
  // `any` S: forUser's param is contravariant, so a concrete-state
  // CellVisibility<K, S> is only assignable when exposed accepts anything.
  // deno-lint-ignore no-explicit-any
  ui: CellVisibility<string, any> | undefined,
):
  | ((
    exposed: Record<string, unknown>,
    user?: FilterUser,
  ) => Record<string, unknown>)
  | undefined {
  if (!ui || ui === "all" || ui === "none") return undefined;
  if ("forUser" in ui) return ui.forUser;
  return undefined;
}

/**
 * Validate `ui`/`persist` field-filter keys against the declared state, at cell
 * creation. A filter key that matches NO state field silently does nothing — a
 * secret you meant to `exclude` stays exposed, with no error. That silent leak
 * is the worst failure mode, so we make it loud: a non-matching key, or a
 * nested path in `include` (unsupported), throws here instead.
 *
 * Nested `exclude` (dot-paths like `"accounts.encSecKey"`) IS supported — only
 * the head field is validated (deeper segments may be dynamic / array items).
 */
export function validateFieldFilters(
  name: string,
  state: Record<string, unknown> | undefined,
  // deno-lint-ignore no-explicit-any
  ui: CellVisibility<string, any> | undefined,
  persist: CellFieldFilter | undefined,
): void {
  const stateKeys = new Set(Object.keys(state ?? {}));
  const check = (kind: "ui" | "persist", filter: unknown): void => {
    if (!filter || typeof filter !== "object") return;
    const f = filter as Record<string, unknown>;
    for (const mode of ["include", "exclude"] as const) {
      const keys = f[mode];
      if (!Array.isArray(keys)) continue;
      for (const key of keys) {
        if (typeof key !== "string") continue;
        const nested = key.includes(".");
        if (nested && mode === "include") {
          throw new Error(
            `[cell:${name}] ${kind}.include does not support nested paths ("${key}"). ` +
              `Include the top-level key "${
                key.split(".")[0]
              }", or use exclude for nested fields.`,
          );
        }
        const head = nested ? key.split(".")[0]! : key;
        // Framework-internal fields (__aio_*) are always allowed.
        if (head.startsWith("__aio")) continue;
        if (!stateKeys.has(head)) {
          throw new Error(
            `[cell:${name}] ${kind} ${mode} names "${key}", but "${head}" is not a ` +
              `state field of this cell — so it filters nothing, silently exposing ` +
              `what you meant to hide. Declared state: ${
                [...stateKeys].join(", ") || "(none)"
              }. Check the spelling.`,
          );
        }
      }
    }
  };
  check("ui", ui);
  check("persist", persist);
  // publicFields must name real fields too — a typo'd opt-out silently fails to
  // opt out (the secret warning keeps firing, or worse, masks a rename).
  for (const key of extractPublicFields(ui) ?? []) {
    if (!stateKeys.has(key) && !key.startsWith("__aio")) {
      throw new Error(
        `[cell:${name}] ui.publicFields names "${key}", but it is not a state ` +
          `field of this cell. Declared state: ${
            [...stateKeys].join(", ") || "(none)"
          }. Check the spelling.`,
      );
    }
  }
}

/** Extract `publicFields` from a ui config — the explicit "these look secret
 *  but are public" acknowledgement (silences the secret-exposure heuristic). */
export function extractPublicFields(
  // deno-lint-ignore no-explicit-any
  ui: CellVisibility<string, any> | undefined,
): string[] | undefined {
  if (!ui || ui === "all" || ui === "none") return undefined;
  const pf = (ui as { publicFields?: unknown }).publicFields;
  return Array.isArray(pf)
    ? pf.filter((k): k is string => typeof k === "string")
    : undefined;
}

/** Normalize ui config into CellFieldFilter (strip forUser) */
export function normalizeUiFilter(
  // deno-lint-ignore no-explicit-any
  ui: CellVisibility<string, any> | undefined,
): CellFieldFilter | undefined {
  if (!ui) return undefined;
  if (ui === "all" || ui === "none") return ui;
  if ("include" in ui && Array.isArray(ui.include)) {
    return { include: ui.include };
  }
  if ("exclude" in ui && Array.isArray(ui.exclude)) {
    return { exclude: ui.exclude };
  }
  return undefined;
}

// ── Selector helpers ──────────────────────────────────────────────────

import type { SelectorDef } from "./cell-config-types.ts";

/** Auto-scope selectors: user writes (s: S) => ..., we wrap.
 *  Plain form: receive own slice only. Deps form: receive own slice + listed
 *  dep cell slices (looked up by name in the full state).
 *  The `_cellName` param is preserved for backward compatibility with
 *  factories that pass it; it is currently unused now that plain selectors
 *  receive the own slice directly from the bind wrapper. */
export function scopeSelectors<S>(
  _cellName: string,
  selectors: Record<string, SelectorDef<S>> | undefined,
): Record<string, (state: unknown, fullState?: unknown) => unknown> {
  const scoped: Record<
    string,
    (state: unknown, fullState?: unknown) => unknown
  > = {};
  if (!selectors) return scoped;
  for (const [key, def] of Object.entries(selectors)) {
    if (typeof def === "function") {
      // Plain form. Extra args pass through, so a PARAMETERIZED selector
      // (`byId: (s, id) => …`) receives them: `cell.byId(id)` → def(slice, id).
      // A zero-extra-arg selector called `cell.count()` gets fullState as arg 2
      // (harmlessly ignored, or used by an `(s, fullState)` cross-cell plain
      // selector). realitio Bad#1.
      scoped[key] = (ownSlice: unknown, ...rest: unknown[]) =>
        (def as (s: S, ...a: unknown[]) => unknown)(ownSlice as S, ...rest);
      continue;
    }
    // Deps form — receive full state, return own slice + each dep slice in order.
    const { deps, fn } = def;
    scoped[key] = (ownSlice: unknown, fullState: unknown) => {
      const full = fullState as Record<string, unknown> | undefined;
      const depSlices = deps.map((d) =>
        full ? full[d] : (ownSlice as Record<string, unknown>)[d]
      );
      return (fn as (s: S, ...deps: unknown[]) => unknown)(
        ownSlice as S,
        ...depSlices,
      );
    };
  }
  return scoped;
}

// ── Foreign action detection ──────────────────────────────────────────

/** Detect foreign action types from machine transitions (types containing ':' from other cells) */
export function detectForeignActions(
  machine: MachineConfig | false,
  prefix: string,
): string[] {
  if (machine === false) return [];
  const foreignSet = new Set<string>();
  for (const sc of Object.values(machine.states)) {
    for (const key of Object.keys(sc)) {
      if (key.includes(":") && !key.startsWith(prefix + ":")) {
        foreignSet.add(key);
      }
    }
  }
  return [...foreignSet];
}

// ── Flow builder ──────────────────────────────────────────────────────

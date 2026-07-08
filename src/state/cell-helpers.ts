// cell-helpers.ts — shared cell-creation helpers: normalization, selectors, flows, foreign actions

import type { FlowDef } from "./flow.ts";
import type {
  CellFieldFilter,
  CellVisibility,
  FilterUser,
  MachineConfig,
} from "./cell-types.ts";
import type { GeneratorEntry } from "./cell-config-types.ts";

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
  ui: CellVisibility | undefined,
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

/** Normalize ui config into CellFieldFilter (strip forUser) */
export function normalizeUiFilter(
  ui: CellVisibility | undefined,
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
      // Plain form — unchanged from the original contract.
      scoped[key] = (ownSlice: unknown) =>
        (def as (s: S) => unknown)(ownSlice as S);
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

/** Build flow definitions from generator entries */
export function buildFlows(
  rawGenerators: Record<string, GeneratorEntry>,
  actionKeySet: Set<string>,
  name: string,
  config: { cancelOn?: Record<string, (string | { type: string })[]> },
  argsStyle: "spread" | "payload",
): { flows: Record<string, FlowDef>; flowTriggers: Map<string, string> } {
  const flows: Record<string, FlowDef> = {};
  const flowTriggers = new Map<string, string>();
  for (const [key, fn] of Object.entries(rawGenerators)) {
    if (argsStyle === "payload" && !actionKeySet.has(key)) {
      throw new Error(
        `[cell:${name}] generator '${key}' must match an action key`,
      );
    }
    const triggers = config.cancelOn?.[key] ?? fn.cancelOn;
    const cancelOnStrings = triggers?.map((t: string | { type: string }) =>
      typeof t === "string" ? t : t.type
    );
    flows[key] = {
      trigger: key,
      generator: fn,
      _stepNames: [],
      cancelOn: cancelOnStrings,
      argsStyle,
    };
    flowTriggers.set(key, key);
  }
  return { flows, flowTriggers };
}

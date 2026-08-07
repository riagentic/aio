// cell-helpers.ts — shared cell-creation helpers: normalization, selectors, foreign actions

import type {
  AccessUser,
  CellFieldFilter,
  CellVisibility,
  MachineConfig,
} from "./cell-types.ts";

/** Does a method or selector already own this name on the cell object?
 *
 *  Answered from the DESCRIPTOR, never by reading the property. Every one of
 *  the three binding paths used to probe `typeof obj[key] === "function"`,
 *  which INVOKES whatever accessor is installed — and by the second bind of a
 *  cell the accessor is the reactive state getter from the first. So the
 *  framework read the app's own state to ask a question about its own shape:
 *  it subscribed the current reactive context as a side effect, and once a
 *  `ui.exclude`d field started throwing on client reads (as it must), aio
 *  tripped its own guard and reported it as the app leaking a secret. It took
 *  an app's entire UI suite offline, and the error named the wrong culprit.
 *
 *  A method is assigned as a data property; a state getter is an accessor. The
 *  descriptor tells them apart without touching a value. */
export function nameIsTaken(obj: object, key: string): boolean {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return !!d && typeof d.value === "function";
}

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
    user?: AccessUser,
  ) => Record<string, unknown>)
  | undefined {
  if (!ui || ui === "all" || ui === "none") return undefined;
  if ("forUser" in ui) return ui.forUser;
  return undefined;
}

/**
 * Validate `visible`/`persist` field-filter keys against the declared state, at cell
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
  const check = (kind: "visible" | "persist", filter: unknown): void => {
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
  check("visible", ui);
  check("persist", persist);
  // publicFields must name real fields too — a typo'd opt-out silently fails to
  // opt out (the secret warning keeps firing, or worse, masks a rename).
  for (const key of extractPublicFields(ui) ?? []) {
    if (!stateKeys.has(key) && !key.startsWith("__aio")) {
      throw new Error(
        `[cell:${name}] visible.publicFields names "${key}", but it is not a state ` +
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

/** Normalize a visibility config into CellFieldFilter (strip forUser) */
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

// ── `visible:` / deprecated `ui:` resolution (alpha52) ────────────────

/** One-time-per-cell hint for the deprecated `ui:` spelling.
 *  console.warn, not the diagnostics logger — same browser-graph constraint
 *  as `_selectorHinted` above (protocol-cell imports these helpers). */
const _visibleHinted = new Set<string>();
/** @internal test seam. */
export function _resetVisibleHints(): void {
  _visibleHinted.clear();
}

/** THE decider for a cell's declared visibility: `visible:` (alpha52), with
 *  `ui:` as the deprecated alias through beta (one-time hint per cell). Both
 *  set is a hard error — two spellings of one decision must never race.
 *  Used by the server cell factory AND the browser cell stub, so the alias
 *  can never mean different things per runtime. */
export function resolveVisibility(
  name: string,
  config: {
    // deno-lint-ignore no-explicit-any
    visible?: CellVisibility<string, any>;
    // deno-lint-ignore no-explicit-any
    ui?: CellVisibility<string, any>;
  },
  // deno-lint-ignore no-explicit-any
): CellVisibility<string, any> | undefined {
  if (config.visible !== undefined && config.ui !== undefined) {
    throw new Error(
      `[cell:${name}] both \`visible\` and \`ui\` are set — \`ui\` is the ` +
        `deprecated alias of \`visible\` (alpha52), so this is one decision ` +
        `written twice. Keep \`visible\` and delete \`ui\`.`,
    );
  }
  if (config.ui !== undefined && !_visibleHinted.has(name)) {
    _visibleHinted.add(name);
    console.warn(
      `[cell:${name}] config key \`ui:\` was renamed \`visible:\` (alpha52 — ` +
        `access gates calls, visible gates reads). The alias works through ` +
        `beta; rename it (aiol --safe-fix does it). App-level ` +
        `aio.run({ ui: {...} }) window config is a different key and is ` +
        `unchanged. (hinted once per cell)`,
    );
  }
  return config.visible ?? config.ui;
}

// ── Selector helpers ──────────────────────────────────────────────────

import type { SelectorDef } from "./cell-config-types.ts";

/** One-time-per-selector hints for the deprecated spread deps signature.
 *  console.warn, not the diagnostics logger: this module is in the BROWSER
 *  graph (protocol-cell imports scopeSelectors), and the logger's rotation
 *  pulls @std/path into it (browser-deps gate). */
const _selectorHinted = new Set<string>();
/** @internal test seam. */
export function _resetSelectorHints(): void {
  _selectorHinted.clear();
}

/** Does the fn's SECOND declared parameter destructure an array (`[a, b]`)?
 *  That is the alpha52 tuple form's shape — the one thing the old spread form
 *  can never look like. */
function secondParamIsTuple(fn: (...a: never[]) => unknown): boolean {
  const src = String(fn);
  const open = src.indexOf("(");
  if (open === -1) return false; // `s => …` single-param arrow — no 2nd param
  let depth = 0;
  let params = "";
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        params = src.slice(open + 1, i);
        break;
      }
    }
  }
  // Split at top-level commas; check the 2nd param's first character.
  let d = 0;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < params.length; i++) {
    const ch = params[i]!;
    if (ch === "(" || ch === "[" || ch === "{") d++;
    else if (ch === ")" || ch === "]" || ch === "}") d--;
    else if (ch === "," && d === 0) {
      parts.push(params.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(params.slice(start));
  return (parts[1] ?? "").trim().startsWith("[");
}

/** Auto-scope selectors: user writes (s: S) => ..., we wrap.
 *  Plain form: receive own slice only. Deps form (alpha52): receive own slice
 *  + a TUPLE of the listed dep cell slices + any accessor args —
 *  `{ deps: ["prices"], fn: (s, [prices], id) => … }` — so parameterized
 *  selectors and deps compose. The old spread signature `(s, ...depSlices)` is
 *  detected by shape (no destructured 2nd param + arity covering every dep)
 *  and still served through beta, with a one-time hint. */
export function scopeSelectors<S>(
  cellName: string,
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
      // selector). a field report Bad#1.
      scoped[key] = (ownSlice: unknown, ...rest: unknown[]) =>
        (def as (s: S, ...a: unknown[]) => unknown)(ownSlice as S, ...rest);
      continue;
    }
    // Deps form — receive full state, hand the fn the own slice + dep slices.
    const { deps, fn } = def;
    // Legacy spread form: not the tuple shape, and an arity that spans every
    // dep (`(s, a, b)` for two deps). A new-form fn over 2+ deps can never
    // reach that arity without destructuring, so only the 1-dep case is
    // ambiguous — resolved toward legacy (old code keeps working; the hint
    // teaches the tuple).
    const legacy = deps.length > 0 && !secondParamIsTuple(fn) &&
      fn.length >= 1 + deps.length;
    if (legacy) {
      const hk = `${cellName}:${key}`;
      if (!_selectorHinted.has(hk)) {
        _selectorHinted.add(hk);
        console.warn(
          `[aio:cell:${cellName}] selector '${key}': the (s, ...depSlices) ` +
            `signature is deprecated — deps now arrive as a tuple: ` +
            `fn: (s, [${deps.join(", ")}], ...args) => …. ` +
            `aiol --safe-fix rewrites this. (hinted once per selector)`,
        );
      }
    }
    scoped[key] = (
      ownSlice: unknown,
      fullState: unknown,
      ...args: unknown[]
    ) => {
      const full = fullState as Record<string, unknown> | undefined;
      const depSlices = deps.map((d) =>
        full ? full[d] : (ownSlice as Record<string, unknown>)[d]
      );
      return legacy
        ? (fn as unknown as (s: S, ...deps: unknown[]) => unknown)(
          ownSlice as S,
          ...depSlices,
        )
        : (fn as (s: S, deps: unknown[], ...a: unknown[]) => unknown)(
          ownSlice as S,
          depSlices,
          ...args,
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

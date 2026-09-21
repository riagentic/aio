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
/** How a dispatched action names its cell and method: `cell:method`, and
 *  `cell.method` as the alternate spelling every control surface accepts.
 *
 *  ONE regex, because two homes had already drifted: the trojan route
 *  normalises with `/[:.]/` (its comment names the dot form explicitly) while
 *  `am dispatch`'s payload shaper tested only `:` — so `am dispatch
 *  counter.setTitle a=b` was a cell method everywhere EXCEPT where the payload
 *  is shaped. The method got `undefined`, the key was DELETED from state, `am`
 *  answered `{"ok":true}`, and the app's own `PERSIST_ERROR` about it never
 *  reached the caller. */
export const CELL_METHOD_SEP = /[:.]/;

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

/** The closest candidate, when a typo is one or two edits away from a real
 *  name. ONE spelling of "did you mean" — for option keys, and for the state
 *  fields a `persist` / `visible` filter names. */
export function nearestOf(
  bad: string,
  candidates: Iterable<string>,
  /** Reject anything this many edits away or more — default 3. A longer
   *  vocabulary of longer words (CLI flags: `--safe-fix` vs `--safefix`)
   *  wants a looser bound; the caller says so rather than keeping a second
   *  copy of the algorithm with a different constant, which is what aiol did. */
  maxDistance = 3,
): string | null {
  const dist = (a: string, b: string): number => {
    const d: number[][] = Array.from(
      { length: a.length + 1 },
      (_, i) => [i, ...Array(b.length).fill(0)],
    );
    for (let j = 0; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i]![j] = Math.min(
          d[i - 1]![j]! + 1,
          d[i]![j - 1]! + 1,
          d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
    }
    return d[a.length]![b.length]!;
  };
  let best: string | null = null, bestD = maxDistance;
  for (const k of candidates) {
    const dd = dist(bad.toLowerCase(), k.toLowerCase());
    if (dd < bestD) [best, bestD] = [k, dd];
  }
  return best;
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
/** `{ include: [...], exclude: [...] }` on ONE filter — `include` wins and
 *  `exclude` is dropped on the floor (see `normalizeUiFilter` below and
 *  `state-filter.ts`, which both answer `"include" in filter` first).
 *
 *  THE decider for that question, asked from two layers: `cell()`'s own filters
 *  go through {@link validateFieldFilters} (a throw — `normalizeUiFilter`
 *  destroys the evidence before boot, so nothing downstream could see it), and
 *  `aio.run({ cellDefaults })` goes through `configConflicts`
 *  (`src/server/config.ts`, a config error). Same fact, one implementation. */
export function hasBothFilterModes(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return Array.isArray(f.include) && Array.isArray(f.exclude);
}

/** A `persist:` OBJECT that names neither `include` nor `exclude` — a filter
 *  that filters nothing, and the three readers of it do not agree on what
 *  that means.
 *
 *  `CellFieldFilter` has no such member, so it arrives from JS, from a
 *  `cellDefaults` built at runtime, or from `onPersist`/`onRestore` written
 *  INSIDE `persist:` instead of beside it. The startup report and the trojan
 *  `fields` route both resolve it as `"all"` (`renderFilter`,
 *  `fieldIncluded`), the store's own projection resolves it as `"none"`
 *  (`applyCellFieldFilter` falls through to `undefined`, and
 *  `buildDBStateGetter` skips the cell), and journal replay read
 *  `filter.exclude` as iterable. Measured on one cell: the boot report said
 *  `persist=all`, the database held `{}` after every flush, each restart came
 *  back empty — and the first boot after a CRASH threw an uncaught
 *  `TypeError: filter.exclude is not iterable` before the server started, so
 *  the app never booted again.
 *
 *  Refused where the intent is still visible — `persist: "none"` is the
 *  spelling for "store nothing", and `"all"` for "store it all". THE decider
 *  for that question, asked from two layers, exactly like
 *  {@link hasBothFilterModes}: `cell()`'s own filter goes through
 *  {@link validateFieldFilters}, and `aio.run({ cellDefaults })` through
 *  `configConflicts` (`src/server/config.ts`).
 *
 *  `visible:` is deliberately NOT covered: `CellVisibility` allows
 *  `{ forUser }` / `{ publicFields }` with no include/exclude, and
 *  `normalizeUiFilter` already resolves that to "all". */
export function namesNoFilterMode(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return !("include" in v) && !("exclude" in v);
}

/** A filter whose `include`/`exclude` CANNOT BE APPLIED — it is not a list of
 *  field names. Returns the offending mode and what was written, or null.
 *
 *  `CellFieldFilter` types both as arrays, so this arrives from JS, from a
 *  `cellDefaults` built at runtime, or from JSON config. MEASURED, and it is
 *  the worst of the three shapes this file refuses: `normalizeUiFilter` keeps
 *  only an ARRAY, so `visible: { exclude: "secret" }` was dropped on the
 *  floor, the cell resolved to `visible: "all"`, and every field the
 *  declaration named went to every client — with the startup report saying
 *  `visible=all` and no warning anywhere. The same spelling under `persist:`
 *  writes the whole slice to disk. A declaration that cannot be applied must
 *  never quietly become "apply nothing".
 *
 *  A LIST holding a non-string already stopped the boot, from inside the
 *  walker (`key.includes is not a function`) — loud, and naming neither the
 *  cell nor the fix. Same refusal, so the message is the same quality.
 *
 *  Asked from two layers, exactly like {@link hasBothFilterModes} and
 *  {@link namesNoFilterMode}: `cell()` goes through
 *  {@link validateFieldFilters}, `aio.run({ cellDefaults })` through
 *  `configConflicts` (`src/server/config.ts`). */
export function unusableFilterList(
  v: unknown,
): {
  mode: "include" | "exclude";
  /** What was written, for the message. */
  got: string;
  /** The list it most likely meant — the same names, spelled as an array. */
  suggest: string;
} | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const f = v as Record<string, unknown>;
  for (const mode of ["include", "exclude"] as const) {
    if (!(mode in f) || f[mode] === undefined) continue;
    const list = f[mode];
    if (!Array.isArray(list)) {
      // A single field name is the mistake this catches most often, so the
      // fix is that name in a list — not a placeholder the reader has to
      // translate back.
      return {
        mode,
        got: typeof list === "string"
          ? JSON.stringify(list)
          : `${list === null ? "null" : typeof list}`,
        suggest: typeof list === "string"
          ? `[${JSON.stringify(list)}]`
          : `["field"]`,
      };
    }
    const bad = list.findIndex((k) => typeof k !== "string");
    if (bad >= 0) {
      return {
        mode,
        got: `the entry ${JSON.stringify(list[bad]) ?? String(list[bad])}`,
        suggest: `[${
          list.map((k) => typeof k === "string" ? JSON.stringify(k) : `"…"`)
            .join(", ")
        }]`,
      };
    }
  }
  return null;
}

/** What a filter that never runs costs, said for the side it was written on. */
export function unusableFilterConsequence(
  kind: "visible" | "ui" | "persist",
): string {
  return kind === "persist"
    ? `the filter is discarded and the WHOLE slice is written to the ` +
      `database — every field you named among it`
    : `the filter is discarded and the cell resolves to \`visible: "all"\` — ` +
      `every field you named is sent to every client, with the startup ` +
      `report saying \`visible=all\``;
}

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
    // BOTH lists is not a filter — it is two filters, and only the first one
    // runs. Every reader (`state-filter.ts`, `normalizeUiFilter`) answers
    // `"include" in filter` first and returns, so the `exclude` list is
    // discarded without a word: `visible: { include: ["a","b"], exclude:
    // ["b.secret"] }` sends `b.secret` to every client. `normalizeUiFilter`
    // then drops the key entirely, so nothing downstream can even see that it
    // was written. Refuse here, where the evidence still exists.
    if (hasBothFilterModes(f)) {
      throw new Error(
        `[cell:${name}] ${kind} sets BOTH \`include\` and \`exclude\` — they ` +
          `are two different filters and only \`include\` is applied, so ` +
          `\`exclude\` (${
            (f.exclude as unknown[]).map((k) => JSON.stringify(k)).join(", ")
          }) is silently discarded${
            kind === "visible"
              ? " and every field it names is sent to clients anyway"
              : " and every field it names is written to the database anyway"
          }. FIX: pick one — \`include\` to allow-list the fields, or ` +
          `\`exclude\` to deny-list them (\`exclude\` accepts nested paths ` +
          `like "a.secret", \`include\` does not).`,
      );
    }
    // A list that is not a list of field names — see `unusableFilterList`.
    // Checked BEFORE the per-key loop, which skips a non-array outright and so
    // let the one shape that silently exposes everything through.
    const unusable = unusableFilterList(f);
    if (unusable) {
      throw new Error(
        `[cell:${name}] ${kind}.${unusable.mode} is ${unusable.got}, not a ` +
          `list of field names, so ${unusableFilterConsequence(kind)}. FIX: ` +
          `${kind}: { ${unusable.mode}: ${unusable.suggest} } — an array, one ` +
          `string per field${
            unusable.mode === "exclude"
              ? ` (a nested path like "row.secret" is one string too)`
              : ""
          }.`,
      );
    }
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
          // The CONSEQUENCE, said correctly for the filter that was written.
          // One sentence used to cover all four combinations — "silently
          // exposing what you meant to hide" — which is true of
          // `visible.exclude` and false of the other three. A `persist.include`
          // typo exposes nothing: it drops the field from persistence, so the
          // setting simply does not survive a restart, and being told to look
          // for a leak sends the reader hunting the wrong thing. A field report
          // hit exactly that case (`persist.include`, a field added to the
          // state and not to the list).
          const consequence = kind === "persist"
            ? (mode === "include"
              ? "so this field is NOT persisted — the value silently does not survive a restart"
              : "so it excludes nothing — a field you meant to keep out of the database is written to it")
            : (mode === "include"
              ? "so this field is NOT sent to clients — the UI silently never sees it"
              : "so it filters nothing, silently exposing what you meant to hide");
          const near = nearestOf(head, stateKeys);
          throw new Error(
            `[cell:${name}] ${kind} ${mode} names "${key}", but "${head}" is not a ` +
              `state field of this cell${
                near ? ` — did you mean "${near}"?` : ""
              } — ${consequence}. Declared state: ${
                [...stateKeys].join(", ") || "(none)"
              }. Check the spelling.`,
          );
        }
      }
    }
  };
  check("visible", ui);
  check("persist", persist);
  // A `persist:` object that names neither list — see `namesNoFilterMode`.
  if (namesNoFilterMode(persist)) {
    const keys = Object.keys(persist as Record<string, unknown>);
    throw new Error(
      `[cell:${name}] persist names neither \`include\` nor \`exclude\`${
        keys.length ? ` (it has ${keys.map((k) => `\`${k}\``).join(", ")})` : ""
      } — it is not a filter, and nothing of this cell reaches the database: ` +
        `the boot report says \`persist=all\`, every flush writes an empty ` +
        `document for it, and each restart comes back at the declared ` +
        `defaults. FIX: \`persist: "all"\` (the default — store the whole ` +
        `slice) or \`persist: "none"\` (store nothing), or name the fields ` +
        `with \`include\`/\`exclude\`. \`onPersist\`/\`onRestore\` are cell ` +
        `options of their own — they go BESIDE \`persist:\`, not inside it.`,
    );
  }
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

/** Warn about `sync: { merge }` / `sync: { identity }` keys that name no field
 *  of the cell's declared state — the CRDT half of {@link
 *  validateFieldFilters}.
 *
 *  Both maps are keyed by TOP-LEVEL state field: the engine's `conflictWork`
 *  walks `Object.keys(after)` — the cell's own state — and looks each field up
 *  in `merge` (and, for the set strategies, in `identity`). A key that matches
 *  no field is therefore never read: the field it meant to configure resolves
 *  last-write-wins, which is the exact outcome `normalizeSyncConfig` REFUSES a
 *  typo'd strategy for ("lost data, later, on someone else's machine"),
 *  reached through the other half of the same entry. A nested path
 *  (`"profile.tags"`) is the same miss with a different cause — nothing walks
 *  into a field, so only the head could ever match.
 *
 *  WARNED rather than thrown, and the difference from the filter check above
 *  is not timidity: a method may introduce a top-level field the declared
 *  state does not list, so a refusal could be wrong about a cell that works,
 *  and this runs for every app that already ships a sync cell. Same warning in
 *  dev and in prod — nothing branches on it.
 *
 *  Pure apart from the log call: same cell, same state, same message. */
export function warnUnmatchedSyncFields(
  name: string,
  state: Record<string, unknown> | undefined,
  sync:
    | { merge?: Record<string, unknown>; identity?: Record<string, unknown> }
    | undefined,
  warn: (msg: string) => void,
): void {
  if (!sync) return;
  const stateKeys = new Set(Object.keys(state ?? {}));
  for (const which of ["merge", "identity"] as const) {
    const map = sync[which];
    if (!map || typeof map !== "object") continue;
    for (const key of Object.keys(map)) {
      if (stateKeys.has(key) || key.startsWith("__aio")) continue;
      // What is LOST, said for the map that was written. A `merge` key that
      // never matches leaves the field on the default strategy; an `identity`
      // key that never matches leaves the set strategies on `"id"`.
      const consequence = which === "merge"
        ? `so the strategy never runs and that field resolves ` +
          `last-write-wins instead — the symptom is lost data, later, on ` +
          `someone else's machine`
        : `so nothing reads it — set-add/set-remove keep matching items by ` +
          `"id"`;
      const head = key.includes(".") ? key.split(".")[0]! : "";
      const near = head ? null : nearestOf(key, stateKeys);
      const why = head
        ? `${which} is keyed by TOP-LEVEL state field and a nested path ` +
          `never matches${
            stateKeys.has(head)
              ? ""
              : `, and "${head}" is not a state field of this cell either`
          }`
        : `it is not a field of this cell's declared state${
          near ? ` — did you mean "${near}"?` : ""
        }`;
      const fix = head && stateKeys.has(head)
        ? ` FIX: configure "${head}" itself, or lift the field to the top level.`
        : "";
      warn(
        `${name}: sync.${which}["${key}"] names no state field — ${why}, ` +
          `${consequence}.${fix} Declared state: ${
            [...stateKeys].join(", ") || "(none)"
          }.`,
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

// ── `visible:` resolution (alpha52; the `ui:` alias retired in alpha70) ──

/** THE decider for a cell's declared visibility: `visible:`. The pre-alpha52
 *  spelling `ui:` is a REMOVED key that is still read from config, so it takes
 *  the registry's dev/prod split (`refuseRetired`): a dev boot or a test
 *  throws with the migration + the escape-hatch pin; a prod boot logs the
 *  same line and HONOURS the old key — dropping a visibility filter at
 *  runtime would leak state, which is worse than any stale spelling. Both
 *  set is a hard error everywhere — two spellings of one decision must never
 *  race. Used by the server cell factory AND the browser cell stub, so the
 *  key can never mean different things per runtime. `name` is the cell, or
 *  `"cellDefaults"` for the app-level default (its own registry row). */
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
        `removed spelling of \`visible\`, so this is one decision written ` +
        `twice. Keep \`visible\` and delete \`ui\`.`,
    );
  }
  if (config.ui !== undefined) {
    refuseRetired(
      removalOf(name === "cellDefaults" ? "cellDefaults.ui" : "cell({ ui })"),
      name === "cellDefaults" ? "cellDefaults" : `cell:${name}`,
    );
  }
  return config.visible ?? config.ui;
}

// ── Selector helpers ──────────────────────────────────────────────────

import type { SelectorDef } from "./cell-config-types.ts";
import { refuseRetired, removalOf, removalsAreFatal } from "./removals-core.ts";

/** One-time-per-selector PROD refusal for the retired spread deps signature.
 *  Dev throws every time; prod logs the registry line once, through
 *  `refuseRetired` — this module is in the BROWSER graph, so the log has to
 *  come from removals-core (which the page already reaches) rather than from a
 *  second logger import here. */
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
 *  and REFUSED (alpha76): dev throws, prod logs the registry line once and
 *  still spreads, so no app renders the wrong number in silence. */
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
    // AMBIGUOUS, IRREDUCIBLY, for exactly one dep with an UNDESTRUCTURED
    // second parameter. `(s, prices)` is the retired spread form and
    // `(s, deps) => deps[0]` is the current one written with a named
    // parameter, and at runtime they are the same function: one argument after
    // the slice, no `[` to read. With two or more deps the arity separates
    // them, which is why only this case needs saying.
    //
    // It resolves toward LEGACY — spreading the slice — so a selector written
    // the new way with a named parameter receives the slice where it expects a
    // tuple and `deps[0]` is `undefined`. Correct-looking code, wrong number,
    // no error: measured, not reasoned about.
    //
    // The behaviour is unchanged (prod must keep degrading the same way); what
    // changes is that the message now names BOTH readings, because the author
    // of the second one is told they used a form they have never heard of.
    const ambiguous = legacy && deps.length === 1;
    if (legacy) {
      // Retired in alpha76. Dev throws (scopeSelectors runs at cell creation,
      // so a test or a dev boot fails at the definition); prod logs the
      // registry line once and still spreads, because a selector silently
      // handed a TUPLE where it expected a slice renders wrong data rather
      // than failing — a silent divergence is the one thing this may not do.
      const hk = `${cellName}:${key}`;
      if (removalsAreFatal() || !_selectorHinted.has(hk)) {
        _selectorHinted.add(hk);
        refuseRetired(
          removalOf("selector deps as a spread"),
          `${cellName}.${key}`,
          ambiguous
            ? `Read two ways, and they are the same function here: ` +
              `\`(s, prices)\` is the retired SPREAD form, and ` +
              `\`(s, deps) => deps[0]\` is the CURRENT form written with a ` +
              `named parameter. With one dep nothing at runtime tells them ` +
              `apart, so this resolves to the spread — your parameter gets ` +
              `the slice, not a tuple, and \`deps[0]\` is undefined. ` +
              `DESTRUCTURE it and both problems go: ` +
              `\`fn: (s, [prices]) => …\`.`
            : undefined,
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

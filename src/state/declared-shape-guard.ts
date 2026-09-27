// declared-shape-guard.ts — say at the WRITE what the next boot will undo.
//
// `state:` is the restore template. Restore fills every declared key back in
// (so `delete s.key` of a declared key never survives a restart), and a key it
// does not declare under a closed object is drift (the next boot warns and
// drops it; dev refuses only when the declaration changed since the write). Both writes were accepted silently at every door and
// failed one restart later. Restore semantics stay exactly as documented; the
// write is made LOUD instead.
//
// ONE post-commit walk over the batch's Immer patches against the declared
// template — the patches already exist and the template is small, so the cost
// is O(patches × path depth), plus the capped drift walk for a replaced
// subtree that sits under a closed declaration.
//
// Observe-only and identical in dev and prod: it never changes what is
// written, it only says it — once per (cell, path).
import type { WirePatch } from "../protocol/patch-ops.ts";
import type { CellFieldFilter } from "./cell-types.ts";
import type { ComposedCells } from "./cell-compose-types.ts";
import { detectShapeDrift } from "./cell-migrate.ts";
import { persistFilterOf, persistingCellIds } from "./cell-persist-filter.ts";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Distinct paths reported per app before the guard goes quiet — a closed
 *  object used as a record would otherwise grow the dedupe set per write. */
const MAX_SAID = 500;

export type DeclaredShapeGuardOpts = {
  /** The declared state per cell (`initialState`). */
  template: Obj;
  /** Cell id → its `persist` filter: an unpersisted field restores nothing,
   *  so writing anything to it is not a restart hazard. */
  persist?: Record<string, CellFieldFilter>;
  /** Cells this guard does not watch (sync cells, which restore by their own
   *  op-log; cells a migration handled this boot). */
  skip?: ReadonlySet<string>;
  /** Unknown-key detection for a replaced subtree — the boot check's own
   *  predicate (`detectShapeDrift`), passed in so there is one decider. */
  unknownKeys: (declared: unknown, written: unknown) => string[];
  /** Paths (relative to `declared`, `""` = the value itself) whose TYPE the
   *  written value changed — the boot check's "type-changed" rule, passed in
   *  like `unknownKeys`. Omitted ⇒ types are not checked. */
  typeChanges?: (declared: unknown, written: unknown) => string[];
  /** Cells whose `onPersist` shapes what they store: their restore hands a
   *  retyped stored value back, so a type change there is not a loss. */
  shaped?: ReadonlySet<string>;
  /** Dev: a type change THROWS (the commit is refused) instead of warning.
   *  Not for framework-applied batches (a worker cell's patches, a
   *  time-travel restore) — those already committed elsewhere. */
  strict?: boolean;
  /** `cell.path` strings already said — shared with the persist-time dev
   *  watcher so one fact is one line. */
  said?: Set<string>;
  warn: (msg: string) => void;
};

/** The method an action belongs to, for the message. */
function methodOf(type: string): string {
  const i = type.indexOf(":");
  if (i <= 0) return type;
  const key = type.slice(i + 1);
  // An async method's write-set commits as `cell:__set<Method>`.
  if (key.startsWith("__set") && key.length > 5) {
    return `${type.slice(0, i)}:${key[5]!.toLowerCase()}${key.slice(6)}`;
  }
  return type;
}

function persisted(
  filter: CellFieldFilter | undefined,
  path: readonly (string | number)[],
): boolean {
  if (filter === undefined || filter === "all") return true;
  if (filter === "none") return false;
  if ("include" in filter) return filter.include.includes(String(path[0]));
  if ("exclude" in filter) {
    const dotted = path.join(".");
    return !filter.exclude.some((e) =>
      dotted === e || dotted.startsWith(e + ".")
    );
  }
  return true;
}

/** The declared node a path's PARENT names: `closed` (a non-empty plain
 *  object — its keys are schema), `open` (an array, a declared `{}` record,
 *  a `null`/primitive declaration — data), or `none` (the parent itself is
 *  not declared: the write that created it was already reported). */
function parentOf(
  cellDecl: unknown,
  parent: readonly (string | number)[],
): { kind: "closed"; node: Obj } | { kind: "open" | "none" } {
  let node = cellDecl;
  for (const seg of parent) {
    if (!isObj(node) || Object.keys(node).length === 0) return { kind: "open" };
    if (!Object.hasOwn(node, seg)) return { kind: "none" };
    node = node[seg as string];
  }
  if (!isObj(node) || Object.keys(node).length === 0) return { kind: "open" };
  return { kind: "closed", node };
}

/** Build the guard. Call it with each committed reduce's action type and
 *  patches; it never throws (a diagnostic is never why a write failed). */
export function createDeclaredShapeGuard(
  opts: DeclaredShapeGuardOpts,
): (actionType: string, patches: unknown) => void {
  const said = opts.said ?? new Set<string>();
  let full = false;
  const once = (where: string, msg: () => string): void => {
    if (said.has(where)) return;
    if (said.size >= MAX_SAID) {
      if (!full) {
        full = true;
        opts.warn(
          `state write: ${MAX_SAID} distinct declared-shape warnings — no ` +
            `more are printed this run. A closed object used as a record is ` +
            `the usual cause: declare it \`{}\` if its keys are data.`,
        );
      }
      return;
    }
    said.add(where);
    opts.warn(msg());
  };

  const check = (type: string, cell: string, op: WirePatch): void => {
    if (opts.skip?.has(cell) || !Object.hasOwn(opts.template, cell)) return;
    const path = op.path;
    if (path.length === 0) return; // the whole cell — a snapshot, not a key
    if (!persisted(opts.persist?.[cell], path)) return;
    const parent = parentOf(opts.template[cell], path.slice(0, -1));
    if (parent.kind !== "closed") return;
    const key = String(path[path.length - 1]);
    const declared = Object.hasOwn(parent.node, key);
    const where = `${cell}.${path.join(".")}`;
    const method = methodOf(type);
    const removed = op.op === "remove" ||
      (op.op === "replace" && op.value === undefined);
    if (removed) {
      if (!declared) return;
      once(
        where,
        () =>
          `state write: ${method} deleted "${where}", a key the cell's ` +
          `\`state:\` declares — deleting a declared key does not survive a ` +
          `restart — set it to null instead, or remove it from \`state:\`. ` +
          `(Restore fills every declared key back in with its default.)`,
      );
      return;
    }
    if (op.op === "append") return;
    if (!declared) {
      if (op.value === undefined) return; // JSON stores nothing — nothing lost
      once(where, () => addMessage(method, where, key));
      return;
    }
    // A declared key written with a value of another type: the next boot
    // restores the declared default over it (the boot check's own rule).
    if (opts.typeChanges && !opts.shaped?.has(cell)) {
      for (const sub of opts.typeChanges(parent.node[key], op.value)) {
        const at = sub ? `${where}.${sub}` : where;
        const msg = typeMessage(method, at, parent.node[key], op.value, sub);
        if (strict(type)) throw new TypeChangeRefused(msg);
        once(at, () => msg);
      }
    }
    // A declared key written with a whole value: its own undeclared keys are
    // the same failure one level down (`s.cfg = { ...s.cfg, extra: 1 }`).
    if (!isObj(op.value)) return;
    for (const sub of opts.unknownKeys(parent.node[key], op.value)) {
      const at = `${where}.${sub}`;
      once(at, () => addMessage(method, at, sub.split(".").pop()!));
    }
  };

  const strict = (type: string): boolean =>
    opts.strict === true && type !== "__aioWorkerPatch" &&
    type !== "aio:__timeTravel";

  return (actionType, patches) => {
    if (!patches) return;
    const list = (Array.isArray(patches) ? patches : [patches]) as {
      cell?: unknown;
      ops?: unknown;
    }[];
    try {
      for (const p of list) {
        if (typeof p?.cell !== "string" || !Array.isArray(p.ops)) continue;
        for (const op of p.ops as WirePatch[]) check(actionType, p.cell, op);
      }
    } catch (e) {
      if (e instanceof TypeChangeRefused) throw new Error(e.message);
      // aio-ok: observe-only — said, never allowed to fail the commit.
      opts.warn(`state write: the declared-shape check itself threw — ${e}`);
    }
  };
}

/** The boot restore's own rules (`detectShapeDrift`), as the guard's two
 *  deciders — one copy for every runtime that builds a guard. */
export const shapeDriftDeciders: Pick<
  DeclaredShapeGuardOpts,
  "unknownKeys" | "typeChanges"
> = {
  unknownKeys: (declared, written) =>
    detectShapeDrift({ c: declared }, { c: written })
      .filter((d) =>
        d.issue === "unknown-field" && d.storedType !== "undefined"
      )
      .map((d) => d.path),
  // A written `undefined` is not a type: JSON stores nothing there and the
  // restore fills the default back in — the "deleted declared key" case,
  // which is said, not refused (`s.o = { ...s.o, x: undefined }` is
  // `delete s.o.x`).
  typeChanges: (declared, written) =>
    detectShapeDrift({ c: declared }, { c: written })
      .filter((d) => d.issue === "type-changed" && d.storedType !== "undefined")
      .map((d) => d.path),
};

/** The guard over an in-process composition (the test harnesses): the same
 *  rules and exemptions the server boot passes — unpersisted fields and cells
 *  (`persist`), sync cells, cells whose `onPersist` shapes the slice — so a
 *  write dev refuses is refused under `testCell`/`bootCells`/`testUI` too,
 *  whether or not the harness persists. */
export function composedShapeGuard(
  composed: ComposedCells,
  opts: { strict: boolean; warn: (msg: string) => void },
): (actionType: string, patches: unknown) => void {
  const persisting = persistingCellIds(composed);
  return createDeclaredShapeGuard({
    template: composed.initialState as Obj,
    persist: Object.fromEntries(
      composed.cells.map((c) => [
        c.__aio.id,
        persisting.has(c.__aio.id) ? persistFilterOf(c) : "none",
      ]),
    ),
    skip: new Set(
      composed.cells.filter((c) => c.__aio.syncConfig).map((c) => c.__aio.id),
    ),
    shaped: new Set(
      composed.cells.filter((c) => c.__aio.persistTransform).map((c) =>
        c.__aio.id
      ),
    ),
    ...shapeDriftDeciders,
    strict: opts.strict,
    warn: opts.warn,
  });
}

/** A reducer whose every committed write (a new state) runs `guard` over its
 *  patches; a strict guard's throw refuses the commit like any reduce throw.
 *  A refused SYNC method is one cell error (`countError`), as any sync method
 *  throw is (cell-compose.ts); an async method's refused write-set is counted
 *  once, by its `:__error`. No guard ⇒ the reducer itself. */
export function withShapeGuard<S, A, R extends { state: S }>(
  reduce: (s: S, a: A) => R,
  guard?: (actionType: string, patches: unknown) => void,
  countError?: (cell: string) => void,
): (s: S, a: A) => R {
  if (!guard) return reduce;
  return (s, a) => {
    const r = reduce(s, a);
    if (r.state === s) return r;
    const type = String((a as { type?: unknown }).type ?? "");
    try {
      guard(type, (r as { patches?: unknown }).patches);
    } catch (e) {
      const i = type.indexOf(":");
      if (i > 0 && !type.startsWith("__set", i + 1)) {
        countError?.(type.slice(0, i));
      }
      throw e;
    }
    return r;
  };
}

/** The one throw the guard lets out (dev, `strict`). */
class TypeChangeRefused extends Error {}

const kind = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

function typeMessage(
  method: string,
  where: string,
  declared: unknown,
  written: unknown,
  sub: string,
): string {
  const at = (v: unknown): unknown => {
    for (const k of sub ? sub.split(".") : []) {
      v = (v as Obj)[k];
    }
    return v;
  };
  return `state write: ${method} wrote "${where}" as ${kind(at(written))} ` +
    `but the cell's \`state:\` declares it ${kind(at(declared))} — the next ` +
    `boot restores the declared default over it, so the value is lost at ` +
    `the first restart. Dev refuses the write; production keeps it and says ` +
    `so. Pass a value of the declared type (an \`am dispatch\` argument may ` +
    `arrive as text or as \`{ key: value }\`), or declare the field ` +
    `\`null as T | null\` if its type varies.`;
}

function addMessage(method: string, where: string, key: string): string {
  return `state write: ${method} added "${where}" — the cell's \`state:\` ` +
    `does not declare "${key}" under that (closed) object. It is kept now ` +
    `and fails one restart later: the next boot drops the value (and says ` +
    `so). Either declare it in \`state:\` (bump the ` +
    `cell's \`version\` with an \`onMigrate\` if stored data must be ` +
    `reshaped), or keep it out of state (\`persist: { exclude: [...] }\`, or ` +
    `declare the parent as \`{}\` if its keys are data).`;
}

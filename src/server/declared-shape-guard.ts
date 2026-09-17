// declared-shape-guard.ts — say at the WRITE what the next boot will undo.
//
// `state:` is the restore template. Restore fills every declared key back in
// (so `delete s.key` of a declared key never survives a restart), and a key it
// does not declare under a closed object is drift (dev refuses to boot, prod
// warns and drops it). Both writes were accepted silently at every door and
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
import type { CellFieldFilter } from "../state/cell-types.ts";

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
    // A declared key written with a whole value: its own undeclared keys are
    // the same failure one level down (`s.cfg = { ...s.cfg, extra: 1 }`).
    if (!isObj(op.value)) return;
    for (const sub of opts.unknownKeys(parent.node[key], op.value)) {
      const at = `${where}.${sub}`;
      once(at, () => addMessage(method, at, sub.split(".").pop()!));
    }
  };

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
      // aio-ok: observe-only — said, never allowed to fail the commit.
      opts.warn(`state write: the declared-shape check itself threw — ${e}`);
    }
  };
}

function addMessage(method: string, where: string, key: string): string {
  return `state write: ${method} added "${where}" — the cell's \`state:\` ` +
    `does not declare "${key}" under that (closed) object. It is kept now ` +
    `and fails one restart later: dev refuses to boot on the shape drift, ` +
    `production drops the value. Either declare it in \`state:\` (bump the ` +
    `cell's \`version\` with an \`onMigrate\` if stored data must be ` +
    `reshaped), or keep it out of state (\`persist: { exclude: [...] }\`, or ` +
    `declare the parent as \`{}\` if its keys are data).`;
}

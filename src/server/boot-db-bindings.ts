// `db:` table ↔ state bindings — which state array each declared table
// auto-syncs, and the pure path helpers the boot uses to place loaded rows.
// Split out of aio-boot.ts, which re-exports every name here, so no importer
// changes.

import {
  assertIdent,
  type DbBoundShape,
  type DbMapping,
  dbMappingOf,
  pkColumn,
  type TableDef,
} from "./sql.ts";
import type { Log } from "../diagnostics/logger-api.ts";
import { count } from "../diagnostics/fmt.ts";

// ── `db:` table ↔ state bindings ──────────────────────────────────────
//
// A `db:` table auto-syncs ONE array in state. With the cells API every
// top-level state key is a CELL ID whose slice is an object (`cell()` refuses
// anything else), so the array a table stores is always a FIELD of a cell —
// never a root key. Addressing the root was therefore unreachable: a table
// named after a cell threw at boot (AIO-419), and any other name bound to
// nothing at all, silently, while injecting an unowned root key into state and
// broadcasting it (v1.0.0-alpha45 — `examples/contacts` could not boot).
//
// A `db:` key now names the state array it stores:
//   - `field`        — the array field `field` of the ONE cell that declares
//                      it (or a root array, for the engine-level API). SQL
//                      table name = the key. This is the documented shape
//                      (`db: { contacts: table(…) }` ↔ `contacts.contacts`).
//   - `cell.field`   — explicit, for disambiguation. SQL table = `cell_field`.
//   - no match       — the table is SQL-only: it is created and left to
//                      `app.db`, and NOTHING is written into state for it.
// Every outcome is announced at boot; ambiguity and a failed explicit binding
// are hard errors. Nothing is ever assigned over a cell's slice.

/** One `db:` table's wiring to state. `path: []` = SQL-only (no auto-sync). */
export type DbBinding = {
  /** The SQL table name (what `app.db` queries). */
  table: string;
  /** Path to the state value this table mirrors; `[]` when unbound. */
  path: string[];
  /** How that value holds its rows (see `DbMapping.shape`). */
  shape: DbBoundShape;
  /** The pk column a `"map"` binding keys by (null for an array binding
   *  without one). */
  pk: string | null;
};

export const _isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Array fields a cell declares — the candidates a `db:` table can bind to. */
function _arrayFields(state: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const cell of Object.keys(state)) {
    const slice = state[cell];
    if (Array.isArray(slice)) out.push(cell);
    else if (_isObj(slice)) {
      for (const f of Object.keys(slice)) {
        if (Array.isArray(slice[f])) out.push(`${cell}.${f}`);
      }
    }
  }
  return out;
}

/** Resolve every `db:` key to a SQL table name + the state path it mirrors.
 *  Pure except for the boot log — extracted so the whole decision table is
 *  testable without booting a server. Throws on an ambiguous or impossible
 *  binding; never returns a binding that would overwrite a cell's slice. */
export function resolveDbBindings(
  initialState: Record<string, unknown>,
  dbSchema: Record<string, TableDef | DbMapping>,
  log: Pick<Log, "info" | "warn">,
): { bindings: DbBinding[]; sqlSchema: Record<string, TableDef> } {
  const bindings: DbBinding[] = [];
  const sqlSchema: Record<string, TableDef> = {};
  const declaredBy = new Map<string, string>(); // sql table → the db: key
  const candidates = () => {
    const c = _arrayFields(initialState);
    return c.length ? c.join(", ") : "(no cell declares an array field)";
  };

  for (const [key, entry] of Object.entries(dbSchema)) {
    if (entry === null || typeof entry !== "object") {
      throw new Error(
        `db: mapping "${key}" is ${
          entry === undefined
            ? "undefined"
            : `${typeof entry} ${JSON.stringify(entry)}`
        }, not a table. The usual cause is a typo'd or missing import — ` +
          `check the value you passed for "${key}". Each entry is a ` +
          `table({ … }) result, or { table, path, shape }.`,
      );
    }
    let table: string;
    let path: string[];
    const mapping = dbMappingOf(entry);
    const { shape } = mapping;
    const def: TableDef = { ...mapping.table, shape };
    const pk = pkColumn(def);
    // The value at the bound path must hold rows in the declared shape.
    const fits = (v: unknown): boolean =>
      shape === "map" ? _isObj(v) : Array.isArray(v);
    const noun = shape === "map" ? "a pk-keyed object map" : "an ARRAY";
    if (shape === "map" && !pk) {
      throw new Error(
        `db: mapping "${key}" has shape "map" but its table declares no ` +
          `pk() column — a map is keyed by the row's primary key, so there ` +
          `is nothing to key it by. Add \`id: pk()\` (or bind an array).`,
      );
    }
    if (mapping.path !== undefined && !key.includes(".")) {
      throw new Error(
        `db: mapping "${key}" sets path "${mapping.path}" but its key does ` +
          `not name a cell — a path is relative to a cell, so the key must ` +
          `be "<cell>.<field>".`,
      );
    }

    if (key.includes(".")) {
      // Explicit `cell.field` — an intent that must resolve or fail loud.
      const parts = key.split(".");
      const [cellId, field] = parts;
      const slice = cellId === undefined ? undefined : initialState[cellId];
      const inner = mapping.path?.split(".") ?? (field ? [field] : []);
      const target = _isObj(slice) ? readPath(slice, inner) : undefined;
      if (
        parts.length !== 2 || !cellId || !field || !_isObj(slice) ||
        inner.some((seg) => !seg) || !fits(target)
      ) {
        throw new Error(
          `db: table key "${key}" must name ${noun} ` +
            (mapping.path
              ? `at "${mapping.path}" inside a cell`
              : `field of a cell ("<cell>.<field>")`) +
            `, but ${
              !_isObj(slice)
                ? `there is no cell "${cellId}"`
                : `cell "${cellId}" has no ${
                  shape === "map" ? "object" : "array"
                } ${
                  mapping.path ? `at "${inner.join(".")}"` : `field "${field}"`
                }${
                  target !== undefined
                    ? ` (it is ${
                      Array.isArray(target) ? "an array" : typeof target
                    })`
                    : ""
                }`
            }. Available array fields: ${candidates()}.`,
        );
      }
      table = `${cellId}_${field}`;
      path = [cellId, ...inner];
    } else if (shape === "map" && _isObj(initialState[key])) {
      throw new Error(
        `db: mapping "${key}" has shape "map" and names a top-level key — a ` +
          `map binding must be explicit: db: { "<cell>.${key}": { table, ` +
          `shape: "map" } }.`,
      );
    } else if (Array.isArray(initialState[key])) {
      // Root-level array (engine-level `aio.run` config — no cells).
      table = key;
      path = [key];
    } else {
      const owners = Object.keys(initialState).filter((c) =>
        _isObj(initialState[c]) &&
        fits((initialState[c] as Record<string, unknown>)[key])
      );
      if (owners.length > 1) {
        throw new Error(
          `db: table "${key}" is ambiguous — cells ${
            owners.map((o) => `"${o}"`).join(" and ")
          } each declare an array field "${key}". Say which one: ` +
            `db: { "${owners[0]}.${key}": table({…}) }.`,
        );
      }
      table = key;
      path = owners.length === 1 ? [owners[0]!, key] : [];
    }

    assertIdent(table, "table name");
    const prev = declaredBy.get(table);
    if (prev !== undefined) {
      throw new Error(
        `db: keys "${prev}" and "${key}" both map to SQL table ` +
          `"${table}" — one of them would silently share the other's rows. ` +
          `Rename one.`,
      );
    }
    declaredBy.set(table, key);
    sqlSchema[table] = def;
    bindings.push({ table, path, shape, pk });

    if (path.length) {
      log.info(
        `db: table "${table}" ↔ state.${path.join(".")} (auto-sync${
          shape === "map" ? `, map keyed by "${pk}"` : ""
        })`,
      );
    } else {
      // Not an error — declaring a table you drive with raw SQL is a real
      // pattern — but it is the shape a typo produces, so it is never silent.
      log.warn(
        `db: table "${table}" is SQL-only — no state array is bound to it, so ` +
          `nothing auto-syncs and nothing is added to state. Read/write it ` +
          `with app.db. To auto-sync a cell's array field, name the table ` +
          `after that field, or bind it explicitly: ` +
          `db: { "<cell>.<field>": table({…}) }. Available: ${candidates()}.` +
          (_isObj(initialState[table])
            ? ` (Cell "${table}" exists but has no array field "${table}" — ` +
              `its slice is NOT touched.)`
            : ""),
      );
    }
  }
  return { bindings, sqlSchema };
}

/** Write each loaded table's rows into the state path it is bound to.
 *  Copy-on-write: only the objects along a bound path are cloned, and an
 *  unbound (SQL-only) table adds nothing — a table can never overwrite a
 *  cell's slice.
 *
 *  An EMPTY table the sync has never written never empties a non-empty array:
 *  that combination means the rows have not been written to SQLite yet — a
 *  binding that is new (the app just added `db:`, or upgraded to a version
 *  where the binding finally resolves), or a `state:` seed on first run. The
 *  array is adopted instead, and the first sync writes it into the table. An
 *  empty table the sync HAS written (`synced`) was emptied on purpose, and
 *  restores empty — it used to restore the declared default, so a seeded
 *  row the user deleted came back on every restart. */
export function placeLoadedTables(
  state: Record<string, unknown>,
  bindings: readonly (Pick<DbBinding, "table" | "path"> & Partial<DbBinding>)[],
  loaded: Record<string, unknown[]>,
  log?: (msg: string) => void,
  /** Tables the state sync has committed at least once (SYNCED_TABLES,
   *  src/db/state-sync.ts). For THOSE an empty table is the truth — the app
   *  emptied it — and the array restores empty; the seed/new-binding
   *  adoption below is only for a table that was never written. */
  synced?: ReadonlySet<string>,
): Record<string, unknown> {
  let next = state;
  for (const b of bindings) {
    if (b.path.length === 0 || !Object.hasOwn(loaded, b.table)) continue;
    const rows = loaded[b.table]!;
    if (rows.length === 0 && !synced?.has(b.table)) {
      const current = readPath(next, b.path);
      const held = Array.isArray(current)
        ? current.length
        : _isObj(current)
        ? Object.keys(current).length
        : 0;
      if (held > 0) {
        log?.(
          `db: table "${b.table}" is empty but state.${
            b.path.join(".")
          } holds ${count(held, "item")} — keeping them and writing them to ` +
            `the table on the next sync (a new binding or a seeded default; ` +
            `an empty table never empties a non-empty ${
              b.shape === "map" ? "map" : "array"
            }).`,
        );
        continue;
      }
    }
    // A map binding is rebuilt from the rows' pk — the one fact the table
    // holds; the key is derived, never stored twice.
    const value: unknown = b.shape === "map" && b.pk
      ? Object.fromEntries(
        (rows as Record<string, unknown>[]).map((r) => [String(r[b.pk!]), r]),
      )
      : rows;
    const placed = writePath(next, b.path, value);
    if (placed !== undefined) next = placed;
  }
  return next;
}

/** `state` with `value` at `path`, copy-on-write along the path only; the
 *  parents on the way must be plain objects (a vanished cell, or a non-object
 *  parent, returns undefined — never clobbered). */
function writePath(
  state: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> | undefined {
  const [head, ...rest] = path as [string, ...string[]];
  if (rest.length === 0) return { ...state, [head]: value };
  const child = state[head];
  if (!_isObj(child)) return undefined;
  const next = writePath(child, rest, value);
  return next === undefined ? undefined : { ...state, [head]: next };
}

/** The value at `path`, or undefined. */
export function readPath(
  state: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let cur: unknown = state;
  for (const k of path) {
    if (!_isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** `obj` without the values at `paths` — copy-on-write along each path only.
 *  Used to keep a `db:`-backed array out of the KV snapshot: SQLite owns those
 *  rows, and a second stale copy in the snapshot is a restore-order trap. */
export function omitPaths(
  obj: Record<string, unknown>,
  paths: readonly (readonly string[])[],
): Record<string, unknown> {
  let out = obj;
  for (const path of paths) {
    if (path.length === 0) continue;
    const [head, ...rest] = path as [string, ...string[]];
    if (!Object.hasOwn(out, head)) continue;
    if (rest.length === 0) {
      out = { ...out };
      delete out[head];
    } else {
      const child = out[head];
      if (!_isObj(child)) continue;
      out = { ...out, [head]: omitPaths(child, [rest]) };
    }
  }
  return out;
}

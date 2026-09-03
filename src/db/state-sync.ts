// Async versions of schema init, table loading, and incremental state sync

import type { DB } from "./types.ts";
import { applyDdl } from "./ddl.ts";
import {
  assertIdent,
  chunkParams,
  type ColumnDef,
  columnToSQL,
  createTableSQL,
  pkColumn,
  type TableDef,
} from "../server/sql.ts";

import { log } from "../diagnostics/logger-api.ts";
import { count } from "../diagnostics/fmt.ts";

/** One report per offending fact, for the whole process — a persist runs every
 *  debounce window and the same row shape would otherwise be named on each. */
const _reported = new Set<string>();
function reportOnce(key: string, msg: string): void {
  if (_reported.has(key)) return;
  _reported.add(key);
  log.warn("db", `${msg}`);
}

/** Test-only reset of the once-per-process report set. */
export function _resetDbReports(): void {
  _reported.clear();
}

/** What `PRAGMA table_info` reports about an existing column. */
type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt: unknown;
};

async function tableColumns(db: DB, name: string): Promise<ColumnInfo[]> {
  const { rows } = await db.query<
    { name: string; type: string; notnull: number; dflt_value: unknown }
  >(`PRAGMA table_info(${name})`);
  return rows.map((r) => ({
    name: r.name,
    type: String(r.type ?? ""),
    notnull: Number(r.notnull ?? 0),
    dflt: r.dflt_value,
  }));
}

/** A column that can be added to a table that already holds rows: SQLite fills
 *  the existing rows with its default, and NULL is only a legal default when
 *  the column is nullable. */
const _addableToNonEmpty = (def: ColumnDef): boolean =>
  def.nullable === true || def.default !== undefined;

/** Reconcile one declared table with what SQLite actually has.
 *
 *  `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table, so a
 *  column added to (or removed from) a `db:` table between two runs never
 *  reached SQLite. Boot looked perfect and then EVERY write failed — "no such
 *  column: b", or "NOT NULL constraint failed" — the diff baseline never
 *  advanced, and the app retried the same doomed statement on every debounce
 *  window for the rest of its life. Nothing said the schema had drifted.
 *
 *  Drift is now resolved at boot, once, with exactly three outcomes and no
 *  silent fourth:
 *   - the column can be added losslessly (nullable, defaulted, or the table is
 *     empty) → it is added;
 *   - it cannot (NOT NULL, no default, rows present) → throw, naming the column
 *     and both ways out;
 *   - the DB has a column the app no longer declares → harmless if SQLite can
 *     fill it (reported once), fatal if it is NOT NULL without a default,
 *     because every INSERT the framework builds would fail. */
async function reconcileTable(
  db: DB,
  name: string,
  def: TableDef,
  schema: Record<string, TableDef>,
): Promise<void> {
  const actual = await tableColumns(db, name);
  if (actual.length === 0) return; // brand-new table — CREATE just made it
  const have = new Map(actual.map((c) => [c.name, c]));
  const declared = Object.keys(def.columns);
  const missing = declared.filter((c) => !have.has(c));
  const extra = actual.filter((c) => !declared.includes(c.name));

  if (missing.length) {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${name}`,
    );
    const empty = Number(rows[0]?.n ?? 0) === 0;
    if (empty) {
      // No rows to preserve — rebuild the table in the declared shape. This is
      // the only lossless way to add a NOT NULL column without inventing a
      // value the app never asked for.
      await db.transaction([
        { sql: `DROP TABLE ${name}` },
        { sql: createTableSQL(name, def, schema) },
      ]);
      reportOnce(
        `recreate:${name}`,
        `table "${name}" was empty and its schema changed — recreated with ` +
          `column(s) ${missing.join(", ")}.`,
      );
      return;
    }
    const blocked = missing.filter((c) => !_addableToNonEmpty(def.columns[c]!));
    if (blocked.length) {
      throw new Error(
        `db: table "${name}" is missing column(s) ${
          blocked.map((c) => `"${c}"`).join(", ")
        } and holds ${
          count(rows[0]?.n ?? 0, "row")
        }, so SQLite has no value to put in ` +
          `them. Declare a default (\`text({ default: "" })\`) or make them ` +
          `nullable (\`text({ nullable: true })\`) and they are added on the ` +
          `next boot — or migrate the table yourself with app.db. Adding the ` +
          `column silently was never an option: until it exists EVERY write ` +
          `to "${name}" fails ("no such column"), which is what this replaces.`,
      );
    }
    for (const c of missing) {
      const stmt = `ALTER TABLE ${name} ADD COLUMN ${
        columnToSQL(c, def.columns[c]!, schema)
      }`;
      // ONE decider (applyDdl, src/db/ddl.ts) for what a refused DDL means:
      // "duplicate column name" → already there (a raced boot, or added
      // out-of-band) — the goal state is reached, not a failure. Anything
      // else is FATAL, named with the statement and this site: a DDL SQLite
      // refuses (a UNIQUE column ALTER cannot add, a non-constant default,
      // …) must stop the boot — continuing runs the app against a schema it
      // does not have, and every write to this table fails at some random
      // later moment.
      const outcome = await applyDdl(db, stmt, {
        ns: "db",
        subject: `table "${name}"`,
        source: "reconcileTable, src/db/state-sync.ts",
        remedy: `SQLite cannot apply this column change to the existing ` +
          `table. Migrate it yourself with app.db (add the column without ` +
          `the refused constraint, backfill, then recreate), or drop and ` +
          `recreate the table if its rows are disposable.`,
      });
      if (outcome === "already-applied") continue;
      reportOnce(
        `added:${name}.${c}`,
        `table "${name}" gained column "${c}" — added to the existing table.`,
      );
    }
  }

  for (const c of extra) {
    if (c.notnull === 1 && c.dflt === null) {
      throw new Error(
        `db: table "${name}" has a NOT NULL column "${c.name}" that the app no ` +
          `longer declares. Every row aio writes lists only the declared ` +
          `columns, so every INSERT would fail on it. Declare it again, or ` +
          `drop it (\`ALTER TABLE ${name} DROP COLUMN ${c.name}\`) — aio will ` +
          `not drop a column, and the data in it, on its own.`,
      );
    }
    reportOnce(
      `extra:${name}.${c.name}`,
      `table "${name}" has column "${c.name}", which the app no longer ` +
        `declares — new rows leave it empty and it is not part of state.`,
    );
  }
}

/** CREATE TABLE IF NOT EXISTS for all tables, then reconcile any schema drift
 *  against what the file already holds — called on DB open. */
export async function initSchema(
  db: DB,
  schema: Record<string, TableDef>,
): Promise<void> {
  for (const [name, def] of Object.entries(schema)) {
    const sql = createTableSQL(name, def, schema);
    try {
      await db.execute(sql);
    } catch (e) {
      // `assertIdent` passes anything shaped like an identifier, but SQLite
      // refuses its own keywords as bare ones: a column called `order` or
      // `group` produced `near "order": syntax error` — a message that names
      // neither the table nor the schema key, and that the boot path then
      // degrades into a single "sqlite: unavailable" warning, leaving the app
      // running with NO tables at all. SQLite is the authority on what it
      // accepts; this only says where the word came from.
      const raw = e instanceof Error ? e.message : String(e);
      const kw = /near "([^"]+)": syntax error/.exec(raw)?.[1];
      const isCol = kw !== undefined && kw in def.columns;
      throw new Error(
        `db: could not create table "${name}" — ${raw}` +
          (kw
            ? `\n"${kw}" is a SQL keyword, so SQLite will not accept it as ${
              isCol ? `the column name it is used as here` : `an identifier`
            }. Rename it (\`${kw}At\`, \`${kw}Index\`, \`item${
              kw.charAt(0).toUpperCase() + kw.slice(1)
            }\`) — a keyword cannot be used unquoted anywhere aio or your own ` +
              `app.db queries reference it.`
            : ""),
        { cause: e },
      );
    }
  }
  for (const [name, def] of Object.entries(schema)) {
    assertIdent(name, "table name");
    await reconcileTable(db, name, def, schema);
  }
}

/** Which column of `table` a failed `SELECT *` chokes on, or null.
 *  Only ever runs on the failure path: one narrow read per column, and the
 *  first one that reproduces the error is the culprit. */
async function offendingColumn(
  db: DB,
  table: string,
  def: TableDef,
): Promise<string | null> {
  for (const col of Object.keys(def.columns)) {
    try {
      assertIdent(col, "column name");
      await db.query(`SELECT ${col} FROM ${table}`);
    } catch {
      return col;
    }
  }
  return null;
}

/** Load all table rows into state — called on startup after KV merge.
 *
 *  A read failure is NAMED. `node:sqlite` throws
 *  `RangeError: Value is too large to be represented as a JavaScript number`
 *  when a column holds an integer beyond ±2^53 — and that message says nothing
 *  about WHERE, so at boot it surfaced as an anonymous crash that poisoned
 *  every read of that table. The table (and, where reachable, the column) is
 *  part of the error now, together with what to do about it. */
export async function loadTables(
  db: DB,
  schema: Record<string, TableDef>,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const name of Object.keys(schema)) {
    assertIdent(name, "table name");
    try {
      const { rows } = await db.query(`SELECT * FROM ${name}`);
      result[name] = rows;
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const col = await offendingColumn(db, name, schema[name]!).catch(() =>
        null
      );
      const tooBig = /too large|out of range|safe integer/i.test(raw);
      throw new Error(
        `db: reading table "${name}"${
          col ? ` failed on column "${col}"` : " failed"
        } — ${raw}` +
          (tooBig
            ? `\nSQLite INTEGERs are 64-bit; a value beyond ±2^53 cannot be ` +
              `read back as a JavaScript number, and ONE such row makes every ` +
              `read of "${name}" fail. Store it as TEXT (or split it), or ` +
              `read that column with an explicit cast ` +
              `(SELECT CAST(${col ?? "<col>"} AS TEXT) FROM ${name}).`
            : ""),
        { cause: e },
      );
    }
  }
  return result;
}

/** What `v` is, in words a developer can match to their own code. */
function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "number" && Number.isNaN(v)) return "NaN";
  if (typeof v === "object") {
    const ctor = (v as object).constructor?.name;
    return ctor && ctor !== "Object" ? `a ${ctor}` : "an object";
  }
  return `a ${typeof v}`;
}

/** Whether SQLite can bind `v` at all. `undefined`, booleans, objects (Date,
 *  Map, Set, arrays, plain objects) and NaN cannot: node:sqlite rejects them
 *  with "Provided value cannot be bound to SQLite parameter 3" — a 1-based
 *  index into a parameter list the developer never wrote, for a statement the
 *  framework built. */
const _bindable = (v: unknown): boolean =>
  v === null || typeof v === "string" || typeof v === "bigint" ||
  v instanceof Uint8Array ||
  (typeof v === "number" && !Number.isNaN(v));

/** The declared SQL type a value of this JS type will be COERCED into by
 *  column affinity, or null when it lands unchanged. SQLite does not reject a
 *  number in a TEXT column — it converts it, and `42` reads back as the string
 *  `"42.0"`. State then says 42 and the table says "42.0", and the next boot
 *  puts "42.0" into state. */
function affinityMismatch(sqlType: string, v: unknown): string | null {
  const t = sqlType.toUpperCase();
  if (v === null) return null;
  if (t.includes("TEXT") && typeof v !== "string") {
    return typeof v === "number" || typeof v === "bigint" ? t : null;
  }
  if ((t.includes("INT") || t.includes("REAL")) && typeof v === "string") {
    return t;
  }
  return null;
}

/** The key SQLite will actually file this row under, for collision purposes.
 *
 *  `pk()` is `INTEGER PRIMARY KEY` — an alias for the rowid — and SQLite
 *  applies INTEGER affinity before using a value as one. So `1`, `1.0` and
 *  `"1"` are ONE key in the table while being three distinct keys to a JS
 *  `Map`, and the duplicate guard below (which exists precisely because the
 *  second INSERT rolls the whole persist window back, forever) waved them
 *  through. A BigInt is used as the canonical form so it can never collide
 *  with a raw string value that happens to look like one.
 *
 *  Only INTEGER affinity is normalised: it is the only pk shape `pk()` can
 *  produce, and guessing at TEXT affinity's number→string rendering would risk
 *  reporting a duplicate that isn't one — a strictly worse failure. */
/** A pk value in an error message. `JSON.stringify` THROWS on a BigInt, and a
 *  bigint is a value SQLite binds happily — so the guard below would have died
 *  building the message that names the problem. */
const show = (v: unknown): string =>
  typeof v === "bigint" ? `${v}n` : JSON.stringify(v) ?? String(v);

function pkKey(v: unknown, sqlType: string): unknown {
  if (!sqlType.toUpperCase().includes("INT")) return v;
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) {
    try {
      return BigInt(v.trim());
    } catch {
      return v;
    }
  }
  return v;
}

/** The bound value as rows. A `db:` table mirrors an ARRAY of rows, or — for
 *  an object-shaped binding (`docs/persistence/sqlite.md` → "Object-shaped
 *  bindings") — a plain-object MAP whose values are the rows and whose keys
 *  are the rows' primary keys. Anything else is refused by name. */
function rowsOf(
  name: string,
  raw: unknown,
  pk: string | null,
  shape: "array" | "map" = "array",
): Record<string, unknown>[] {
  if (shape === "array") {
    if (Array.isArray(raw)) return raw as Record<string, unknown>[];
    throw new Error(
      `db: table "${name}" is bound to a state value that is not an array ` +
        `(it is ${typeName(raw)}). A db: table mirrors an ARRAY of rows — ` +
        `nothing was written. (A pk-keyed object map binds with ` +
        `\`{ table, shape: "map" }\`.)`,
    );
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && pk) {
    const map = raw as Record<string, Record<string, unknown>>;
    const rows: Record<string, unknown>[] = [];
    for (const [k, row] of Object.entries(map)) {
      // The map key and the row's pk are ONE fact spelled twice; a mismatch
      // means one of them is a lie and the next boot would key the row by
      // the other — refused before a statement is built.
      if (row !== null && typeof row === "object" && !Array.isArray(row)) {
        const key = row[pk];
        if (key !== undefined && key !== null && String(key) !== k) {
          throw new Error(
            `db: table "${name}" is bound to a map whose key ${
              show(k)
            } holds a row with "${pk}" = ${
              show(key)
            } — the key and the row's primary key must agree (the next boot ` +
              `rebuilds the map from "${pk}"). Key the map by the row's ` +
              `"${pk}" (\`s.byId[row.${pk}] = row\`).`,
          );
        }
      }
      rows.push(row);
    }
    return rows;
  }
  throw new Error(
    `db: table "${name}" is bound with shape "map" to a state value that ` +
      (raw !== null && typeof raw === "object" && !Array.isArray(raw) && !pk
        ? `is a map, but the table has no pk() column to key it by`
        : `is not a plain object (it is ${typeName(raw)})`) +
      ` — nothing was written.`,
  );
}

/** Per-row gate: shape, bindable values, affinity, undeclared fields. Runs
 *  ONLY on rows that changed since the last commit — a row whose reference is
 *  unchanged (immer shares structure) already passed it once, and committed
 *  state is frozen, so it cannot have changed underneath. */
function checkShape(
  name: string,
  i: number,
  row: unknown,
): asserts row is Record<string, unknown> {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(
      `db: table "${name}" row #${i} is ${typeName(row)}, not an object.`,
    );
  }
}

function checkRow(
  name: string,
  i: number,
  row: unknown,
  def: TableDef,
  cols: string[],
  declared: Set<string>,
): asserts row is Record<string, unknown> {
  checkShape(name, i, row);
  const r = row as Record<string, unknown>;
  for (const col of cols) {
    const v = r[col];
    if (!_bindable(v)) {
      throw new Error(
        `db: table "${name}" row #${i} column "${col}" is ${
          typeName(v)
        }, which SQLite cannot store. Columns hold null, numbers, strings, ` +
          `bigints or bytes — convert it first (a Date → \`.toISOString()\`, ` +
          `an object → \`JSON.stringify\`), or use an explicit null.`,
      );
    }
    const coerced = affinityMismatch(def.columns[col]!.sqlType, v);
    if (coerced) {
      reportOnce(
        `affinity:${name}.${col}`,
        `table "${name}" column "${col}" is declared ${coerced} but row #${i} ` +
          `holds ${typeName(v)} (${
            JSON.stringify(v)
          }) — SQLite converts it on write, so state and the table hold ` +
          `different values and the next boot adopts the converted one.`,
      );
    }
  }
  for (const field of Object.keys(r)) {
    if (declared.has(field)) continue;
    // The bound array is excluded from the KV snapshot — SQLite owns it. So
    // a field with no column is stored NOWHERE and disappears on the next
    // boot, with the app none the wiser.
    reportOnce(
      `undeclared:${name}.${field}`,
      `table "${name}" has no column for row field "${field}" — SQLite owns ` +
        `these rows, so that field is not persisted anywhere and is gone ` +
        `after a restart. Add it to the table({…}), or keep it in a field ` +
        `of the cell that is NOT bound to a table.`,
    );
  }
}

/** A pk that is not a value is the quietest data loss there was: the first
 *  such row INSERTs (SQLite assigns a rowid state never learns), and every
 *  later one is diffed against it, classified as an UPDATE, and written as
 *  `WHERE <pk> = NULL` — which matches nothing. The row is gone and every
 *  promise resolves. */
function checkPk(name: string, i: number, pk: string, key: unknown): void {
  if (key === undefined || key === null) {
    throw new Error(
      `db: table "${name}" row #${i} has no primary key — "${pk}" is ` +
        `${key === undefined ? "missing" : "null"}. Give every row an id ` +
        `before it reaches state (\`{ id: s.nextId++, … }\`); a row ` +
        `without one cannot be updated or deleted, and would be silently ` +
        `dropped on the next sync.`,
    );
  }
}

function duplicatePk(
  name: string,
  pk: string,
  first: { i: number; raw: unknown },
  i: number,
  key: unknown,
): Error {
  const retyped = typeof first.raw !== typeof key;
  return new Error(
    `db: table "${name}" has duplicate primary key ${
      show(first.raw)
    } (rows #${first.i} and #${i}${
      retyped
        ? `, whose "${pk}" is ${
          show(key)
        } — a ${typeof key} and a ${typeof first
          .raw} are different keys in JavaScript and the SAME key in an ` +
          `INTEGER PRIMARY KEY, which is the rowid`
        : ""
    }). SQLite would reject the second INSERT ` +
      `and roll back the ENTIRE persist window — every other table's ` +
      `changes with it — and the same batch would be retried forever.`,
  );
}

/** Rows not in ascending pk order come back REORDERED on the next boot — a
 *  SQL table is a SET, and `loadTables` walks the rowid. Reported once. */
function checkOrder(
  name: string,
  pk: string,
  rows: Record<string, unknown>[],
  at?: Iterable<number>,
): void {
  const before = (i: number): boolean => {
    const a = rows[i - 1]![pk], b = rows[i]![pk];
    return typeof a === "number" && typeof b === "number"
      ? a < b
      : String(a) < String(b);
  };
  let ascending = true;
  if (at === undefined) {
    for (let i = 1; i < rows.length && ascending; i++) ascending = before(i);
  } else {
    for (const i of at) {
      if (!ascending) break;
      if (i > 0 && i < rows.length) ascending = before(i);
      if (ascending && i + 1 < rows.length) ascending = before(i + 1);
    }
  }
  if (!ascending) {
    reportOnce(
      `order:${name}`,
      `table "${name}" holds rows in an order that is not ascending "${pk}" ` +
        `— SQL tables are unordered, so the next boot restores them sorted ` +
        `by "${pk}" and the current order is lost. Sort in the cell (or in ` +
        `the view) rather than relying on array position, or store the ` +
        `position in a column of its own.`,
    );
  }
}

/** The shape gate alone — is `raw` something this table's binding can hold
 *  rows in? — for a caller that wants the answer at BOOT rather than on the
 *  first debounce window. `planTablesIncremental` runs the same check per
 *  window and throws by name; the persistence manager runs this once at
 *  construction so a table whose bound value can never be planned refuses the
 *  boot instead of failing every window while the snapshot half keeps
 *  committing and the app looks healthy. */
export function checkTableShape(
  name: string,
  raw: unknown,
  def: TableDef,
): void {
  rowsOf(name, raw, pkColumn(def), def.shape);
}

/** The gate every bound array passes before a single statement is built —
 *  the whole-table form, kept for callers that diff without an index. */
function checkRows(
  name: string,
  raw: unknown,
  def: TableDef,
  cols: string[],
  pk: string | null,
): Record<string, unknown>[] {
  const rows = rowsOf(name, raw, pk, def.shape);
  const seen = pk ? new Map<unknown, { i: number; raw: unknown }>() : null;
  const pkType = pk ? def.columns[pk]!.sqlType : "";
  const declared = new Set(cols);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    checkShape(name, i, row);
    if (pk && seen) {
      const key = row[pk];
      checkPk(name, i, pk, key);
      const norm = pkKey(key, pkType);
      const first = seen.get(norm);
      if (first !== undefined) throw duplicatePk(name, pk, first, i, key);
      seen.set(norm, { i, raw: key });
    }
    checkRow(name, i, row, def, cols, declared);
  }
  if (pk && rows.length > 1) checkOrder(name, pk, rows);
  return rows;
}

function rowsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  cols: string[],
): boolean {
  for (const col of cols) {
    if (a[col] !== b[col]) return false;
  }
  return true;
}

/** What the last COMMITTED window held for one pk-keyed table: the row each
 *  normalized pk mapped to, and the array index it sat at. Kept ACROSS windows
 *  and advanced in place at commit, so a window costs the rows it touched —
 *  not a fresh O(rows) map per window. */
export type TableIndex = Map<
  unknown,
  { row: Record<string, unknown>; i: number }
>;

/** Which array indices a window's commits touched, per table — derived from
 *  the reducer's immer patches by the persistence manager. `"all"` when a
 *  patch replaced the array, shrank it or removed an element (the rows behind
 *  it may have moved, and only a full pass can tell what left). */
export type DirtyHint = Set<number> | "all";

export type TablePlan = {
  sql: string;
  params?: unknown[];
}[];

/** Build the index a table's next incremental window diffs against. */
function buildIndex(
  rows: Record<string, unknown>[],
  pk: string,
  pkType: string,
): TableIndex {
  const idx: TableIndex = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    idx.set(pkKey(row[pk], pkType), { row, i });
  }
  return idx;
}

type PkDiff = {
  toDelete: unknown[];
  toInsert: Record<string, unknown>[];
  toUpdate: Record<string, unknown>[];
  /** Index advances, applied at commit: deleted norms, then `set`s. */
  nextIndex: () => TableIndex;
};

/** Every row, but by IDENTITY first: a row that is the SAME reference at the
 *  SAME index as in the last committed window is unchanged (committed state
 *  is frozen — an unchanged reference cannot hide changed contents) and costs
 *  one comparison, no key work. Only rows whose reference or position moved
 *  are keyed, validated and compared column by column. Deletions are found
 *  by count — the scan of the index runs only when something actually left.
 *
 *  Duplicate keys are still caught completely: two rows with one key are
 *  either both changed (the `seen` map of changed rows), or one changed and
 *  one unchanged (the index still holds the unchanged one, live at its old
 *  index) — two unchanged rows cannot collide, the committed window had no
 *  duplicates. */
function diffFull(
  name: string,
  rows: Record<string, unknown>[],
  prevRows: readonly Record<string, unknown>[],
  def: TableDef,
  cols: string[],
  pk: string,
  idx: TableIndex,
): PkDiff {
  const pkType = def.columns[pk]!.sqlType;
  const declared = new Set(cols);
  const seen = new Map<unknown, { i: number; raw: unknown }>();
  const toInsert: Record<string, unknown>[] = [];
  const toUpdate: Record<string, unknown>[] = [];
  const sets: [unknown, { row: Record<string, unknown>; i: number }][] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === prevRows[i]) continue; // same reference, same place
    checkShape(name, i, row);
    const key = row[pk];
    checkPk(name, i, pk, key);
    checkRow(name, i, row, def, cols, declared);
    const norm = pkKey(key, pkType);
    const first = seen.get(norm);
    if (first !== undefined) throw duplicatePk(name, pk, first, i, key);
    seen.set(norm, { i, raw: key });
    const prev = idx.get(norm);
    if (prev === undefined) toInsert.push(row);
    else if (prev.i !== i && rows[prev.i] === prev.row) {
      throw duplicatePk(name, pk, { i: prev.i, raw: prev.row[pk] }, i, key);
    } else if (prev.row !== row && !rowsEqual(row, prev.row, cols)) {
      toUpdate.push(row);
    }
    // A new reference (or position) is remembered even when its columns are
    // equal, so the NEXT window recognizes it by identity.
    sets.push([norm, { row, i }]);
  }
  const toDelete: unknown[] = [];
  const deletedNorms: unknown[] = [];
  if (idx.size !== rows.length - toInsert.length) {
    for (const [norm, entry] of idx) {
      // Live iff still at its old index unchanged, or among the changed rows.
      if (rows[entry.i] === entry.row || seen.has(norm)) continue;
      toDelete.push(entry.row[pk]);
      deletedNorms.push(norm);
    }
  }
  if (rows.length > 1) checkOrder(name, pk, rows);
  return {
    toDelete,
    toInsert,
    toUpdate,
    nextIndex: () => {
      for (const n of deletedNorms) idx.delete(n);
      for (const [n, e] of sets) idx.set(n, e);
      return idx;
    },
  };
}

/** Only the touched indices — O(change). Valid ONLY when no patch shrank or
 *  replaced the array (then nothing left, and an untouched index still holds
 *  the row it held). Returns null when the hint cannot be trusted for this
 *  window (a pk moved between touched rows, a count that says something left
 *  after all) — the caller falls back to {@linkcode diffFull}, which is
 *  always right and merely slower. */
function diffDirty(
  name: string,
  rows: Record<string, unknown>[],
  def: TableDef,
  cols: string[],
  pk: string,
  idx: TableIndex,
  dirty: Set<number>,
): PkDiff | null {
  const pkType = def.columns[pk]!.sqlType;
  const declared = new Set(cols);
  const toInsert: Record<string, unknown>[] = [];
  const toUpdate: Record<string, unknown>[] = [];
  const sets: [unknown, { row: Record<string, unknown>; i: number }][] = [];
  const seen = new Map<unknown, { i: number; raw: unknown }>();
  for (const i of dirty) {
    if (i >= rows.length) return null; // shrank after all — not our case
    const row = rows[i];
    checkShape(name, i, row);
    const key = row[pk];
    checkPk(name, i, pk, key);
    checkRow(name, i, row, def, cols, declared);
    const norm = pkKey(key, pkType);
    const first = seen.get(norm);
    if (first !== undefined) throw duplicatePk(name, pk, first, i, key);
    seen.set(norm, { i, raw: key });
    const prev = idx.get(norm);
    if (prev === undefined) {
      toInsert.push(row);
      sets.push([norm, { row, i }]);
      continue;
    }
    if (prev.i !== i) {
      // The pk used to live at another index. If that index is untouched and
      // still holds the same row, these are TWO live rows with one key.
      if (!dirty.has(prev.i) && rows[prev.i] === prev.row) {
        throw duplicatePk(name, pk, { i: prev.i, raw: prev.row[pk] }, i, key);
      }
      return null; // moved — let the full pass sort it out
    }
    if (prev.row === row) continue;
    if (!rowsEqual(row, prev.row, cols)) toUpdate.push(row);
    sets.push([norm, { row, i }]);
  }
  // Nothing may have left: every untouched index still holds its row.
  if (idx.size + toInsert.length !== rows.length) return null;
  if (rows.length > 1) checkOrder(name, pk, rows, dirty);
  return {
    toDelete: [],
    toInsert,
    toUpdate,
    nextIndex: () => {
      for (const [n, e] of sets) idx.set(n, e);
      return idx;
    },
  };
}

/** The statements `syncTables` would run — built, not executed — plus the
 *  bookkeeping that makes the NEXT window cheap.
 *
 *  Split out so the persistence manager can commit the `db:` tables and the
 *  `aio_kv` state snapshot in ONE transaction. They are two halves of one
 *  cell's data living in one file, and two transactions meant a process that
 *  died between them came back with the table and the snapshot describing
 *  different moments — silently.
 *
 *  `index` holds each pk table's last-committed rows by key; it is read here
 *  and advanced ONLY by `commit()` — a window whose transaction is refused
 *  leaves it describing the last committed state, so the retry sees the same
 *  changes. `dirty` (from the window's immer patches) narrows a table's pass
 *  to the touched rows when it can be trusted, and is ignored when it cannot.
 *
 *  Pure apart from the row checks, which throw by name. */
export function planTablesIncremental(
  schema: Record<string, TableDef>,
  state: Record<string, unknown>,
  prev: Record<string, unknown>,
  index: Record<string, TableIndex>,
  dirty?: Record<string, DirtyHint>,
): { stmts: TablePlan; commit: () => void } {
  const changed = Object.keys(schema).filter((name) =>
    state[name] !== prev[name]
  );
  if (!changed.length) return { stmts: [], commit: () => {} };

  const stmts: TablePlan = [];
  const advances: (() => void)[] = [];

  // A window writes every changed table in ONE transaction, table by table in
  // the order the `db:` object happens to declare them — and aio opens the app
  // db with `PRAGMA foreign_keys = ON`. So `db: { comments: …, posts: … }`
  // inserted a comment before its post, SQLite refused it on the spot, and the
  // whole batch rolled back: with `ref()` and the two keys in that order,
  // NOTHING was ever written, on any window, forever. The same schema declared
  // the other way round worked. Declaration order in a config object is not a
  // decision anyone makes, and nothing said it was one.
  //
  // SQLite has exactly the right tool: check the constraints over the FINISHED
  // transaction instead of statement by statement. Every intra-window order —
  // child before parent, a parent deleted alongside its children, two tables
  // that reference each other — is then just an order. A reference that is
  // still dangling when the window ends is still refused, at COMMIT. The
  // pragma is scoped to the transaction (SQLite clears it at COMMIT/ROLLBACK)
  // and only appears when the schema actually declares a reference.
  const hasRefs = Object.values(schema).some((d) =>
    Object.values(d.columns).some((c) => c.ref)
  );

  for (const name of changed) {
    assertIdent(name, "table name");
    const def = schema[name]!;
    const cols = Object.keys(def.columns);
    for (const col of cols) assertIdent(col, "column name");
    const pk = pkColumn(def);
    const insert = (row: Record<string, unknown>) =>
      stmts.push({
        sql: `INSERT INTO ${name} (${cols.join(", ")}) VALUES (${
          cols.map(() => "?").join(", ")
        })`,
        params: cols.map((c) => row[c]),
      });

    if (pk) {
      const rows = rowsOf(name, state[name], pk, def.shape);
      if (rows.length > 0) {
        const pkType = def.columns[pk]!.sqlType;
        const prevRows = rowsOf(
          name,
          prev[name] ?? (def.shape === "map" ? {} : []),
          pk,
          def.shape,
        );
        const idx = index[name] ?? buildIndex(prevRows, pk, pkType);
        const hint = dirty?.[name];
        // Every row is checked BEFORE any statement is built, so a bad row can
        // never take a good table's writes down with it inside the
        // transaction.
        const d = (hint instanceof Set
          ? diffDirty(name, rows, def, cols, pk, idx, hint)
          : null) ?? diffFull(name, rows, prevRows, def, cols, pk, idx);

        // Chunked, always — the parameter count here is a function of how
        // many rows the USER removed, and SQLite refuses a statement with more
        // than SQLITE_MAX_VARS host parameters with a bare `too many SQL
        // variables`. One unbounded DELETE meant that pruning a big table
        // rolled the whole shared transaction back, the `db:` baseline
        // (deliberately) did not advance, and the identical batch was rebuilt
        // and refused on EVERY debounce window from then on — while the state
        // snapshot kept committing alone, so the app looked healthy and the
        // rows came back on the next boot. A confirmed deletion, silently
        // undone by a restart. The chunks share this transaction, so the
        // delete is still all-or-none.
        for (const batch of chunkParams(d.toDelete)) {
          stmts.push({
            sql: `DELETE FROM ${name} WHERE ${pk} IN (${
              batch.map(() =>
                "?"
              ).join(", ")
            })`,
            params: batch,
          });
        }
        for (const row of d.toInsert) insert(row);
        const setCols = cols.filter((c) => c !== pk);
        for (const row of d.toUpdate) {
          stmts.push({
            sql: `UPDATE ${name} SET ${
              setCols.map((c) => `${c} = ?`).join(", ")
            } WHERE ${pk} = ?`,
            params: [...setCols.map((c) => row[c]), row[pk]],
          });
        }
        advances.push(() => {
          index[name] = d.nextIndex();
        });
        continue;
      }
      // Empty array — full table replacement; the index empties with it.
      stmts.push({ sql: `DELETE FROM ${name}` });
      advances.push(() => {
        index[name] = new Map();
      });
      continue;
    }
    // No PK — full table replacement, in array order.
    const rows = checkRows(name, state[name], def, cols, pk);
    stmts.push({ sql: `DELETE FROM ${name}` });
    for (const row of rows) insert(row);
  }

  if (hasRefs && stmts.length) {
    stmts.unshift({ sql: `PRAGMA defer_foreign_keys = ON` });
  }
  return {
    stmts,
    commit: () => {
      for (const a of advances) a();
    },
  };
}

/** The statements `syncTables` would run — built, not executed. The
 *  index-free form: each call rebuilds its baseline from `prev`, which is what
 *  a one-shot caller wants and what the persistence manager no longer pays
 *  (see {@linkcode planTablesIncremental}). */
export function planTables(
  schema: Record<string, TableDef>,
  state: Record<string, unknown>,
  prev: Record<string, unknown>,
): TablePlan {
  return planTablesIncremental(schema, state, prev, {}).stmts;
}

/** Incremental sync — diffs state vs prev, flushes all changes in one transaction.
 *  prev must reflect the last state written to SQLite (maintained by aio.ts prevDbState). */
export async function syncTables(
  db: DB,
  schema: Record<string, TableDef>,
  state: Record<string, unknown>,
  prev: Record<string, unknown>,
): Promise<void> {
  const stmts = planTables(schema, state, prev);
  if (stmts.length) await db.transaction(stmts);
}

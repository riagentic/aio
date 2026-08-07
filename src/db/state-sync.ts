// Async versions of schema init, table loading, and incremental state sync

import type { DB } from "./types.ts";
import { applyDdl } from "./ddl.ts";
import {
  assertIdent,
  type ColumnDef,
  columnToSQL,
  createTableSQL,
  pkColumn,
  type TableDef,
} from "../server/sql.ts";

/** One report per offending fact, for the whole process — a persist runs every
 *  debounce window and the same row shape would otherwise be named on each. */
const _reported = new Set<string>();
function reportOnce(key: string, msg: string): void {
  if (_reported.has(key)) return;
  _reported.add(key);
  console.warn(`[aio:db] ${msg}`);
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
        } and holds ${rows[0]?.n} row(s), so SQLite has no value to put in ` +
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

/** The gate every bound array passes before a single statement is built.
 *
 *  Returns the rows, or throws an error that names the table, the row and the
 *  column. Reports (once) the two shapes that are not errors but do lose data:
 *  a field with no column, and a value the column's affinity will rewrite. */
function checkRows(
  name: string,
  raw: unknown,
  def: TableDef,
  cols: string[],
  pk: string | null,
): Record<string, unknown>[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `db: table "${name}" is bound to a state value that is not an array ` +
        `(it is ${typeName(raw)}). A db: table mirrors an ARRAY of rows — ` +
        `nothing was written.`,
    );
  }
  const rows = raw as Record<string, unknown>[];
  // Keyed as SQLite keys it (see pkKey), not as JS compares it — the two
  // disagree, and the table is the one that decides.
  const seen = pk ? new Map<unknown, { i: number; raw: unknown }>() : null;
  const pkType = pk ? def.columns[pk]!.sqlType : "";
  const declared = new Set(cols);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(
        `db: table "${name}" row #${i} is ${typeName(row)}, not an object.`,
      );
    }
    if (pk && seen) {
      const key = row[pk];
      // A pk that is not a value is the quietest data loss there was: the
      // first such row INSERTs (SQLite assigns a rowid state never learns),
      // and every later one is diffed against it, classified as an UPDATE, and
      // written as `WHERE <pk> = NULL` — which matches nothing. The row is
      // gone and every promise resolves.
      if (key === undefined || key === null) {
        throw new Error(
          `db: table "${name}" row #${i} has no primary key — "${pk}" is ` +
            `${key === undefined ? "missing" : "null"}. Give every row an id ` +
            `before it reaches state (\`{ id: s.nextId++, … }\`); a row ` +
            `without one cannot be updated or deleted, and would be silently ` +
            `dropped on the next sync.`,
        );
      }
      const norm = pkKey(key, pkType);
      const first = seen.get(norm);
      if (first !== undefined) {
        const retyped = typeof first.raw !== typeof key;
        throw new Error(
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
      seen.set(norm, { i, raw: key });
    }
    for (const col of cols) {
      const v = row[col];
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
    for (const field of Object.keys(row)) {
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

  // A SQL table is a SET. `loadTables` reads it back with `SELECT *`, which for
  // a `pk()` table walks the rowid — the pk itself — in ascending order. So an
  // array whose rows are NOT in ascending pk order comes back REORDERED on the
  // next boot, and nothing about the write said so. (Without a pk the diff
  // rewrites the table wholesale, in array order, and the order does survive.)
  if (pk && rows.length > 1) {
    let ascending = true;
    for (let i = 1; i < rows.length && ascending; i++) {
      const a = rows[i - 1]![pk], b = rows[i]![pk];
      if (typeof a === "number" && typeof b === "number") ascending = a < b;
      else ascending = String(a) < String(b);
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

/** The statements `syncTables` would run — built, not executed.
 *
 *  Split out so the persistence manager can commit the `db:` tables and the
 *  `aio_kv` state snapshot in ONE transaction. They are two halves of one
 *  cell's data living in one file, and two transactions meant a process that
 *  died between them came back with the table and the snapshot describing
 *  different moments — silently.
 *
 *  Pure apart from the row checks, which throw exactly as before. */
export function planTables(
  schema: Record<string, TableDef>,
  state: Record<string, unknown>,
  prev: Record<string, unknown>,
): { sql: string; params?: unknown[] }[] {
  const changed = Object.keys(schema).filter((name) =>
    state[name] !== prev[name]
  );
  if (!changed.length) return [];

  const stmts: { sql: string; params?: unknown[] }[] = [];

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
    // Every row is checked BEFORE any statement is built, so a bad row can
    // never take a good table's writes down with it inside the transaction.
    const rows = checkRows(name, state[name], def, cols, pk);

    if (pk && rows.length > 0) {
      const prevRows = (prev[name] as Record<string, unknown>[]) ?? [];
      const prevMap = new Map(prevRows.map((r) => [r[pk], r]));
      const stateIds = new Set(rows.map((r) => r[pk]));

      const toDelete = prevRows.filter((r) => !stateIds.has(r[pk])).map((r) =>
        r[pk]
      );
      const toInsert: Record<string, unknown>[] = [];
      const toUpdate: Record<string, unknown>[] = [];

      for (const row of rows) {
        const existing = prevMap.get(row[pk]);
        if (!existing) toInsert.push(row);
        else if (!rowsEqual(row, existing, cols)) toUpdate.push(row);
      }

      if (toDelete.length) {
        stmts.push({
          sql: `DELETE FROM ${name} WHERE ${pk} IN (${
            toDelete.map(() => "?").join(", ")
          })`,
          params: toDelete,
        });
      }
      for (const row of toInsert) {
        stmts.push({
          sql: `INSERT INTO ${name} (${cols.join(", ")}) VALUES (${
            cols.map(() => "?").join(", ")
          })`,
          params: cols.map((c) => row[c]),
        });
      }
      const setCols = cols.filter((c) => c !== pk);
      for (const row of toUpdate) {
        stmts.push({
          sql: `UPDATE ${name} SET ${
            setCols.map((c) => `${c} = ?`).join(", ")
          } WHERE ${pk} = ?`,
          params: [...setCols.map((c) => row[c]), row[pk]],
        });
      }
    } else {
      // No PK or empty array — full table replacement
      stmts.push({ sql: `DELETE FROM ${name}` });
      for (const row of rows) {
        stmts.push({
          sql: `INSERT INTO ${name} (${cols.join(", ")}) VALUES (${
            cols.map(() => "?").join(", ")
          })`,
          params: cols.map((c) => row[c]),
        });
      }
    }
  }

  if (hasRefs && stmts.length) {
    stmts.unshift({ sql: `PRAGMA defer_foreign_keys = ON` });
  }
  return stmts;
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

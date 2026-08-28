// SQLite schema helpers — column definitions, SQL generation, query builders
// DB operations live in src/db/ (async Worker-based)

// ── Types ───────────────────────────────────────────────────────────

/** Column options — nullable, unique, and default value */
export type ColumnOpts = {
  nullable?: boolean;
  unique?: boolean;
  default?: unknown;
};

/** Internal column definition produced by column helpers (pk, text, integer, real, ref) */
export type ColumnDef = {
  sqlType: string;
  pk?: boolean;
  ref?: string;
  nullable?: boolean;
  unique?: boolean;
  default?: unknown;
};

/** Table schema produced by table() — passed to aio.run({ db: { schema } }) */
export type TableDef = {
  columns: Record<string, ColumnDef>;
  /** How the bound state value holds its rows — stamped onto the resolved
   *  schema by `resolveDbBindings` from the `db:` mapping's `shape`, and read
   *  by the row diff. `"array"` (default) or `"map"` (a plain object keyed by
   *  the row's pk). Not something `table()` takes: the shape belongs to the
   *  BINDING, not to the table. */
  shape?: DbBoundShape;
};

/** The shape of a state value a `db:` table is bound to. */
export type DbBoundShape = "array" | "map";

/** The object-shaped form of a `db:` entry — `db: { key: TableDef }` says
 *  "this whole array field is this table"; this form says WHICH value and in
 *  WHAT shape (docs/persistence/sqlite.md → "Object-shaped bindings"):
 *
 *  ```ts
 *  db: {
 *    // a map keyed by pk: state.wallet.byMint = { [mint]: Holding }
 *    "wallet.byMint": { table: holdings, shape: "map" },
 *    // a subset deeper than one field: state.ledger.book.entries
 *    "ledger.entries": { table: entries, path: "book.entries" },
 *  }
 *  ```
 *
 *  Additive: a bare `TableDef` still means `{ table, shape: "array" }`. */
export type DbMapping = {
  table: TableDef;
  /** `"array"` (default): the bound value is an array of rows.
   *  `"map"`: the bound value is a plain object whose VALUES are the rows and
   *  whose KEYS are their primary keys (`String(row[pk])`) — the table needs a
   *  `pk()` column, and a key that disagrees with its row's pk is refused at
   *  write time (the next boot would key the row by the pk). */
  shape?: DbBoundShape;
  /** Dotted path INSIDE the cell to bind (a subset of the slice deeper than
   *  one field), e.g. `"book.entries"`. Default: the key's `<field>`. Only
   *  meaningful with an explicit `"<cell>.<field>"` key — the SQL table is
   *  still named `<cell>_<field>`. */
  path?: string;
};

/** Normalize a `db:` entry to its object form. */
export function dbMappingOf(v: TableDef | DbMapping):
  & Required<
    Pick<DbMapping, "table" | "shape">
  >
  & Pick<DbMapping, "path"> {
  const m = "table" in v && v.table !== undefined && "columns" in v.table
    ? v as DbMapping
    : { table: v as TableDef };
  const shape = m.shape ?? "array";
  if (shape !== "array" && shape !== "map") {
    throw new Error(
      `db: mapping shape ${JSON.stringify(shape)} is not one of ` +
        `"array" | "map".`,
    );
  }
  if (m.path !== undefined && (typeof m.path !== "string" || !m.path)) {
    throw new Error(`db: mapping path must be a non-empty dotted string.`);
  }
  return { table: m.table, shape, path: m.path };
}

/** Comparison operators for where() queries */
export type WhereOp = {
  gt?: unknown;
  gte?: unknown;
  lt?: unknown;
  lte?: unknown;
  ne?: unknown;
  like?: string;
  in?: unknown[];
};

/** Filter argument for where() — each field is an exact value or a WhereOp */
export type WhereClause<T> = Partial<{ [K in keyof T]: T[K] | WhereOp }>;

/** Query options — ordering, pagination */
export type QueryOpts<T> = {
  orderBy?: keyof T | [keyof T, "asc" | "desc"];
  limit?: number;
  offset?: number;
};

// ── Host-parameter limits ────────────────────────────────────────────
//
// SQLite refuses a statement with more host parameters (`?`) than
// SQLITE_MAX_VARIABLE_NUMBER — 32766 on every build aio ships against — with a
// bare `too many SQL variables`. A framework-built statement whose parameter
// count is a function of USER DATA (n rows deleted, n ids in an `in:`) is
// therefore a statement that works until the day the data gets big, and then
// fails on every retry forever. Measured, not assumed: 39 999 parameters in one
// `DELETE … WHERE id IN (…)` is refused, the shared transaction rolls back, and
// the rows come back on the next boot.

/** The real SQLite ceiling on host parameters in ONE statement. */
export const SQLITE_MAX_VARS = 32766;

/** The cap the framework chunks its OWN variadic statements to.
 *
 *  Deliberately far below {@linkcode SQLITE_MAX_VARS}: a chunk shares its
 *  transaction (and, for a `DELETE`, its statement budget) with whatever else
 *  the same window writes, and 900 is the value every SQLite driver has used as
 *  the safe batch size since the 999 era. Chunking costs one extra prepared
 *  statement per 900 rows; not chunking costs the user's deletion. */
export const SQL_PARAM_CHUNK = 900;

/** Split `items` into runs of at most `size` — the one chunker every
 *  framework-built variadic statement uses, so they cannot disagree. */
export function chunkParams<T>(
  items: readonly T[],
  size: number = SQL_PARAM_CHUNK,
): T[][] {
  if (size < 1) throw new Error(`chunkParams: size must be ≥ 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size) as T[]);
  }
  return out;
}

// ── Identifier validation ────────────────────────────────────────────

export const IDENT_RE = /^[a-zA-Z_]\w*$/;

/** Validates a SQL identifier (table/column name) — prevents injection via schema keys */
export function assertIdent(name: string, context: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(
      `invalid ${context}: "${name}" — must match /^[a-zA-Z_]\\w*$/`,
    );
  }
}

// ── Column helpers ──────────────────────────────────────────────────

/** Primary key column — INTEGER PRIMARY KEY (auto-increment) */
export function pk(): ColumnDef {
  return { sqlType: "INTEGER", pk: true };
}

/** TEXT column */
export function text(opts?: ColumnOpts): ColumnDef {
  return { sqlType: "TEXT", ...opts };
}

/** INTEGER column */
export function integer(opts?: ColumnOpts): ColumnDef {
  return { sqlType: "INTEGER", ...opts };
}

/** REAL (float) column */
export function real(opts?: ColumnOpts): ColumnDef {
  return { sqlType: "REAL", ...opts };
}

/** Foreign key reference — INTEGER column pointing to another table's pk */
export function ref(refTable: string, opts?: ColumnOpts): ColumnDef {
  return { sqlType: "INTEGER", ref: refTable, ...opts };
}

/** Define a table schema — pass to aio.run({ db: { tableName: table({...}) } }) */
export function table(columns: Record<string, ColumnDef>): TableDef {
  // Two pk() columns render `CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER
  // PRIMARY KEY)`, which SQLite refuses at CREATE ("more than one primary
  // key") — at BOOT, in a message that names neither the schema key nor the
  // second column. Worse, `pkColumn` answers with the FIRST one, so the row
  // diff and every `ref()` to this table quietly agree on a key the table was
  // never going to have. Refuse at declaration, where both names are in hand.
  const pks = Object.entries(columns).filter(([, c]) => c?.pk).map(([n]) => n);
  if (pks.length > 1) {
    throw new Error(
      `table(): ${pks.length} primary keys declared (${
        pks.join(", ")
      }) — SQLite accepts exactly one. Keep one pk() and make the others ` +
        `text({ unique: true }) / integer({ unique: true }).`,
    );
  }
  return { columns };
}

/** THE decider for "which column is this table's primary key", or null.
 *
 *  It used to be decided twice: the state diff looked for `pk: true`, while
 *  `ref()` hard-coded `REFERENCES <table>(id)`. A table whose key column is
 *  called anything else (`userId`) produced a schema SQLite happily CREATEs and
 *  then refuses every write to — `foreign key mismatch`, on every persist
 *  window, forever. One function, both call sites. */
export function pkColumn(def: TableDef): string | null {
  for (const [name, col] of Object.entries(def.columns)) {
    if (col.pk) return name;
  }
  return null;
}

// ── SQL generation ──────────────────────────────────────────────────

/** `schema` (the sibling tables) is what lets a `ref()` resolve its target's
 *  real primary key. It is optional so a lone column still renders; when it is
 *  absent, or the referenced table is not one aio declares (a table created by
 *  hand-written SQL), the reference falls back to `id`. */
export function columnToSQL(
  name: string,
  def: ColumnDef,
  schema?: Record<string, TableDef>,
): string {
  assertIdent(name, "column name");
  const parts = [name, def.sqlType];
  if (def.pk) {
    parts.push("PRIMARY KEY");
    return parts.join(" ");
  }
  if (!def.nullable) parts.push("NOT NULL");
  if (def.unique) parts.push("UNIQUE");
  if (def.default !== undefined) {
    if (typeof def.default === "string") {
      parts.push(`DEFAULT '${def.default.replace(/'/g, "''")}'`);
    } else if (
      typeof def.default === "number" && Number.isFinite(def.default)
    ) {
      parts.push(`DEFAULT ${def.default}`);
    } else {
      throw new Error(
        `invalid default value: ${
          JSON.stringify(def.default)
        } — must be string or finite number`,
      );
    }
  }
  if (def.ref) {
    assertIdent(def.ref, "ref table");
    const target = schema?.[def.ref];
    let refCol = "id";
    if (target) {
      const targetPk = pkColumn(target);
      if (!targetPk) {
        throw new Error(
          `column "${name}" references table "${def.ref}", but "${def.ref}" ` +
            `declares no primary key — a reference needs one. Give it a ` +
            `pk() column, or drop the ref().`,
        );
      }
      refCol = targetPk;
    }
    assertIdent(refCol, "ref column");
    parts.push(`REFERENCES ${def.ref}(${refCol})`);
  }
  return parts.join(" ");
}

export function createTableSQL(
  name: string,
  tableDef: TableDef,
  schema?: Record<string, TableDef>,
): string {
  assertIdent(name, "table name");
  const cols = Object.entries(tableDef.columns)
    .map(([n, d]) => columnToSQL(n, d, schema))
    .join(", ");
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols})`;
}

// ── Where clause builder (used by higher-level query wrappers) ───────

export function isWhereOp(v: unknown): v is WhereOp {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  const ops = ["gt", "gte", "lt", "lte", "ne", "like", "in"];
  return keys.length > 0 && keys.every((k) => ops.includes(k));
}

export function buildWhere(
  filter: Record<string, unknown>,
): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  for (const [field, value] of Object.entries(filter)) {
    assertIdent(field, "where field");
    if (value === undefined) continue;
    if (value === null) {
      clauses.push(`${field} IS NULL`);
      continue;
    }
    if (isWhereOp(value)) {
      const op = value;
      if (op.gt !== undefined) {
        clauses.push(`${field} > ?`);
        params.push(op.gt);
      }
      if (op.gte !== undefined) {
        clauses.push(`${field} >= ?`);
        params.push(op.gte);
      }
      if (op.lt !== undefined) {
        clauses.push(`${field} < ?`);
        params.push(op.lt);
      }
      if (op.lte !== undefined) {
        clauses.push(`${field} <= ?`);
        params.push(op.lte);
      }
      if (op.ne !== undefined) {
        clauses.push(`${field} != ?`);
        params.push(op.ne);
      }
      if (op.like !== undefined) {
        clauses.push(`${field} LIKE ?`);
        params.push(op.like);
      }
      if (op.in !== undefined) {
        if (op.in.length === 0) clauses.push("0 = 1");
        // empty IN → match nothing
        else {
          // A WHERE fragment is part of ONE statement, so — unlike the
          // framework's own DELETE batches — this cannot be chunked into more
          // statements: grouping the values into ORed `IN (…)` lists does not
          // help, because the ceiling is per STATEMENT. Say so at the call
          // site instead of letting SQLite answer `too many SQL variables`
          // from three layers down.
          if (op.in.length > SQLITE_MAX_VARS) {
            throw new Error(
              `db: where ${field} in [...] has ${op.in.length} values — ` +
                `SQLite allows at most ${SQLITE_MAX_VARS} host parameters in ` +
                `ONE statement, and a WHERE clause cannot be split across ` +
                `statements. fix: run the query once per batch of ≤` +
                `${SQLITE_MAX_VARS} ids and concatenate the results, or put ` +
                `the ids in a temporary table and JOIN against it.`,
            );
          }
          clauses.push(`${field} IN (${op.in.map(() => "?").join(", ")})`);
          params.push(...op.in);
        }
      }
    } else {
      clauses.push(`${field} = ?`);
      params.push(value);
    }
  }

  return {
    sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

// aio-ok: a query-builder surface exercised by tests/sql.test.ts that the framework itself composes SQL without — recorded, not deleted on one reader's judgment.
export function buildWhereOr(
  filters: Record<string, unknown>[],
): { sql: string; params: unknown[] } {
  const groups: string[] = [];
  const params: unknown[] = [];
  for (const filter of filters) {
    const { sql, params: p } = buildWhere(filter);
    if (sql) {
      groups.push(`(${sql.slice(7)})`);
      params.push(...p);
    } // slice 7 = strip " WHERE "
  }
  return { sql: groups.length ? ` WHERE ${groups.join(" OR ")}` : "", params };
}

// aio-ok: same as buildWhereOr above — tested, internal, and not on the public surface; deleting it would cascade through buildOrderBy/buildLimit, which is a deliberate sweep and not a drive-by.
export function buildQuerySuffix<T>(opts?: QueryOpts<T>): string {
  if (!opts) return "";
  let s = "";
  if (opts.orderBy) {
    const [col, dirRaw] = Array.isArray(opts.orderBy)
      ? [opts.orderBy[0] as string, opts.orderBy[1]]
      : [opts.orderBy as string, "asc" as const];
    assertIdent(col, "orderBy column");
    // Validate direction — never interpolate raw into SQL (injection guard).
    const dirLower = String(dirRaw ?? "").toLowerCase();
    if (dirLower !== "asc" && dirLower !== "desc") {
      throw new Error(
        `invalid orderBy direction: "${dirRaw}" — must be "asc" or "desc"`,
      );
    }
    s += ` ORDER BY ${col} ${dirLower.toUpperCase()}`;
  }
  if (opts.limit !== undefined) {
    s += ` LIMIT ${Math.max(0, Math.floor(opts.limit))}`;
  }
  if (opts.offset !== undefined) {
    s += ` OFFSET ${Math.max(0, Math.floor(opts.offset))}`;
  }
  return s;
}

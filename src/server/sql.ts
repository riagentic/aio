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
export type TableDef = { columns: Record<string, ColumnDef> };

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

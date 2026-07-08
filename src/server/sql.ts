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
  return { columns };
}

// ── SQL generation ──────────────────────────────────────────────────

export function columnToSQL(name: string, def: ColumnDef): string {
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
    parts.push(`REFERENCES ${def.ref}(id)`);
  }
  return parts.join(" ");
}

export function createTableSQL(name: string, tableDef: TableDef): string {
  assertIdent(name, "table name");
  const cols = Object.entries(tableDef.columns)
    .map(([n, d]) => columnToSQL(n, d))
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
    const [col, dir] = Array.isArray(opts.orderBy)
      ? [opts.orderBy[0] as string, opts.orderBy[1]]
      : [opts.orderBy as string, "asc" as const];
    assertIdent(col, "orderBy column");
    s += ` ORDER BY ${col} ${dir.toUpperCase()}`;
  }
  if (opts.limit !== undefined) {
    s += ` LIMIT ${Math.max(0, Math.floor(opts.limit))}`;
  }
  if (opts.offset !== undefined) {
    s += ` OFFSET ${Math.max(0, Math.floor(opts.offset))}`;
  }
  return s;
}

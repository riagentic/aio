// SQLite 3-tier persistence — column helpers, ORM, raw SQL, state sync
// Uses node:sqlite (built into Deno 2.2+) — zero external deps

import { DatabaseSync } from 'node:sqlite'

// node:sqlite types require SupportedValueType — runtime values are always valid SQL params
// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v

// ── Types ───────────────────────────────────────────────────────────

export type ColumnOpts = { nullable?: boolean; unique?: boolean; default?: unknown }

export type ColumnDef = {
  sqlType: string
  pk?: boolean
  ref?: string
  nullable?: boolean
  unique?: boolean
  default?: unknown
}

export type TableDef = { columns: Record<string, ColumnDef> }

export type WhereOp = {
  gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown
  ne?: unknown; like?: string; in?: unknown[]
}

export type WhereClause<T> = Partial<{ [K in keyof T]: T[K] | WhereOp }>

// deno-lint-ignore no-explicit-any
export type AioTable<T = any> = {
  all(): T[]
  find(id: number | string): T | undefined
  where(filter: WhereClause<T>): T[]
  insert(row: T): { lastInsertRowId: number }
  insertMany(rows: T[]): void
  update(where: WhereClause<T>, set: Partial<T>): { changes: number }
  delete(where: WhereClause<T>): { changes: number }
  count(where?: WhereClause<T>): number
}

export type AioDB = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowId: number }
  exec(sql: string): void
  transaction<R>(fn: (db: AioDB) => R): R
  close(): void
  // deno-lint-ignore no-explicit-any
  [tableName: string]: AioTable<any> | ((...args: any[]) => any) | (() => void)
}

// ── Identifier validation ────────────────────────────────────────────

const IDENT_RE = /^[a-zA-Z_]\w*$/

/** Validates a SQL identifier (table/column name) — prevents injection via schema keys */
function assertIdent(name: string, context: string): void {
  if (!IDENT_RE.test(name)) throw new Error(`invalid ${context}: "${name}" — must match /^[a-zA-Z_]\\w*$/`)
}

// ── Column helpers ──────────────────────────────────────────────────

export function pk(): ColumnDef {
  return { sqlType: 'INTEGER', pk: true }
}

export function text(opts?: ColumnOpts): ColumnDef {
  return { sqlType: 'TEXT', ...opts }
}

export function integer(opts?: ColumnOpts): ColumnDef {
  return { sqlType: 'INTEGER', ...opts }
}

export function real(opts?: ColumnOpts): ColumnDef {
  return { sqlType: 'REAL', ...opts }
}

export function ref(refTable: string, opts?: ColumnOpts): ColumnDef {
  return { sqlType: 'INTEGER', ref: refTable, ...opts }
}

export function table(columns: Record<string, ColumnDef>): TableDef {
  return { columns }
}

// ── SQL generation ──────────────────────────────────────────────────

export function columnToSQL(name: string, def: ColumnDef): string {
  assertIdent(name, 'column name')
  const parts = [name, def.sqlType]
  if (def.pk) { parts.push('PRIMARY KEY'); return parts.join(' ') }
  if (!def.nullable) parts.push('NOT NULL')
  if (def.unique) parts.push('UNIQUE')
  if (def.default !== undefined) {
    if (typeof def.default === 'string') {
      parts.push(`DEFAULT '${def.default.replace(/'/g, "''")}'`)
    } else if (typeof def.default === 'number' && Number.isFinite(def.default)) {
      parts.push(`DEFAULT ${def.default}`)
    } else {
      throw new Error(`invalid default value: ${JSON.stringify(def.default)} — must be string or finite number`)
    }
  }
  if (def.ref) { assertIdent(def.ref, 'ref table'); parts.push(`REFERENCES ${def.ref}(id)`) }
  return parts.join(' ')
}

export function createTableSQL(name: string, tableDef: TableDef): string {
  assertIdent(name, 'table name')
  const cols = Object.entries(tableDef.columns)
    .map(([n, d]) => columnToSQL(n, d))
    .join(', ')
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols})`
}

// ── Where clause builder ────────────────────────────────────────────

function isWhereOp(v: unknown): v is WhereOp {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const keys = Object.keys(v)
  const ops = ['gt', 'gte', 'lt', 'lte', 'ne', 'like', 'in']
  return keys.length > 0 && keys.every(k => ops.includes(k))
}

function buildWhere(filter: Record<string, unknown>): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []

  for (const [field, value] of Object.entries(filter)) {
    assertIdent(field, 'where field')
    if (value === undefined) continue
    if (value === null) { clauses.push(`${field} IS NULL`); continue }
    if (isWhereOp(value)) {
      const op = value
      if (op.gt !== undefined) { clauses.push(`${field} > ?`); params.push(op.gt) }
      if (op.gte !== undefined) { clauses.push(`${field} >= ?`); params.push(op.gte) }
      if (op.lt !== undefined) { clauses.push(`${field} < ?`); params.push(op.lt) }
      if (op.lte !== undefined) { clauses.push(`${field} <= ?`); params.push(op.lte) }
      if (op.ne !== undefined) { clauses.push(`${field} != ?`); params.push(op.ne) }
      if (op.like !== undefined) { clauses.push(`${field} LIKE ?`); params.push(op.like) }
      if (op.in !== undefined) {
        if (op.in.length === 0) { clauses.push('0 = 1') }  // empty IN → match nothing
        else {
          clauses.push(`${field} IN (${op.in.map(() => '?').join(', ')})`)
          params.push(...op.in)
        }
      }
    } else {
      clauses.push(`${field} = ?`)
      params.push(value)
    }
  }

  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params }
}

// ── ORM table wrapper ───────────────────────────────────────────────

function createTableAccessor<T>(db: DatabaseSync, name: string): AioTable<T> {
  return {
    all(): T[] {
      return db.prepare(`SELECT * FROM ${name}`).all() as T[]
    },

    find(id: number | string): T | undefined {
      return db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(id) as T | undefined
    },

    where(filter: WhereClause<T>): T[] {
      const { sql, params } = buildWhere(filter as Record<string, unknown>)
      return db.prepare(`SELECT * FROM ${name}${sql}`).all(..._p(params)) as T[]
    },

    insert(row: T): { lastInsertRowId: number } {
      const obj = row as Record<string, unknown>
      const keys = Object.keys(obj)
      for (const k of keys) assertIdent(k, 'insert column')
      const placeholders = keys.map(() => '?').join(', ')
      const result = db.prepare(`INSERT INTO ${name} (${keys.join(', ')}) VALUES (${placeholders})`)
        .run(..._p(keys.map(k => obj[k])))
      return { lastInsertRowId: Number(result.lastInsertRowid) }
    },

    insertMany(rows: T[]): void {
      if (!rows.length) return
      const keys = Object.keys(rows[0] as Record<string, unknown>)
      for (const k of keys) assertIdent(k, 'insert column')
      const placeholders = keys.map(() => '?').join(', ')
      const stmt = db.prepare(`INSERT INTO ${name} (${keys.join(', ')}) VALUES (${placeholders})`)
      db.exec('BEGIN')
      try {
        for (const row of rows) {
          const obj = row as Record<string, unknown>
          stmt.run(..._p(keys.map(k => obj[k])))
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },

    update(where: WhereClause<T>, set: Partial<T>): { changes: number } {
      const setObj = set as Record<string, unknown>
      const setKeys = Object.keys(setObj)
      if (!setKeys.length) return { changes: 0 }
      for (const k of setKeys) assertIdent(k, 'update column')
      const { sql, params } = buildWhere(where as Record<string, unknown>)
      if (!sql) throw new Error(`${name}.update() requires a where clause — pass at least one filter`)
      const setClauses = setKeys.map(k => `${k} = ?`).join(', ')
      const setParams = setKeys.map(k => setObj[k])
      const result = db.prepare(`UPDATE ${name} SET ${setClauses}${sql}`).run(..._p([...setParams, ...params]))
      return { changes: Number(result.changes) }
    },

    delete(where: WhereClause<T>): { changes: number } {
      const { sql, params } = buildWhere(where as Record<string, unknown>)
      if (!sql) throw new Error(`${name}.delete() requires a where clause — pass at least one filter`)
      const result = db.prepare(`DELETE FROM ${name}${sql}`).run(..._p(params))
      return { changes: Number(result.changes) }
    },

    count(where?: WhereClause<T>): number {
      if (!where) {
        const row = db.prepare(`SELECT COUNT(*) as c FROM ${name}`).get() as { c: number }
        return row.c
      }
      const { sql, params } = buildWhere(where as Record<string, unknown>)
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${name}${sql}`).get(..._p(params)) as { c: number }
      return row.c
    },
  }
}

// ── Core DB wrapper ─────────────────────────────────────────────────

/** Opens SQLite, creates tables, returns AioDB wrapper + raw handle for sync */
export function openDb(path: string, schema: Record<string, TableDef>): { aioDB: AioDB; raw: DatabaseSync } {
  // Validate all identifiers upfront — fail fast on bad schema keys
  for (const [tbl, def] of Object.entries(schema)) {
    assertIdent(tbl, 'table name')
    for (const col of Object.keys(def.columns)) assertIdent(col, `column name in ${tbl}`)
  }

  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA foreign_keys=ON')

  for (const [name, def] of Object.entries(schema)) {
    db.exec(createTableSQL(name, def))
  }

  const aioDB: AioDB = {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
      return db.prepare(sql).all(..._p(params ?? [])) as T[]
    },

    get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
      return db.prepare(sql).get(..._p(params ?? [])) as T | undefined
    },

    run(sql: string, params?: unknown[]): { changes: number; lastInsertRowId: number } {
      const r = db.prepare(sql).run(..._p(params ?? []))
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }
    },

    exec(sql: string): void { db.exec(sql) },

    transaction<R>(fn: (db: AioDB) => R): R {
      db.exec('BEGIN')
      try {
        const result = fn(aioDB)
        db.exec('COMMIT')
        return result
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },

    close(): void { db.close() },
  }

  for (const name of Object.keys(schema)) {
    (aioDB as Record<string, unknown>)[name] = createTableAccessor(db, name)
  }

  return { aioDB, raw: db }
}

// ── State sync functions (used by aio.ts) ───────────────────────────

/** Load all table data into state arrays — called on startup */
export function loadTables(db: DatabaseSync, schema: Record<string, TableDef>): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {}
  for (const name of Object.keys(schema)) {
    result[name] = db.prepare(`SELECT * FROM ${name}`).all()
  }
  return result
}

/** Sync changed state arrays to SQLite — called after reduce (debounced) */
export function syncTables(
  db: DatabaseSync, schema: Record<string, TableDef>,
  state: Record<string, unknown>, prev: Record<string, unknown>,
): void {
  const changed: string[] = []
  for (const name of Object.keys(schema)) {
    if (state[name] !== prev[name]) changed.push(name)
  }
  if (!changed.length) return

  db.exec('BEGIN')
  try {
    for (const name of changed) {
      const rows = state[name] as Record<string, unknown>[]
      const cols = Object.keys(schema[name].columns)
      db.exec(`DELETE FROM ${name}`)
      if (rows.length) {
        const placeholders = cols.map(() => '?').join(', ')
        const stmt = db.prepare(`INSERT INTO ${name} (${cols.join(', ')}) VALUES (${placeholders})`)
        for (const row of rows) {
          stmt.run(..._p(cols.map(c => row[c])))
        }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Reload a single table from SQLite — called after Level 2 ORM mutations */
export function reloadTable(db: DatabaseSync, tableName: string): unknown[] {
  assertIdent(tableName, 'table name')
  return db.prepare(`SELECT * FROM ${tableName}`).all()
}

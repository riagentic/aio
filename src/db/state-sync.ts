// Async versions of schema init, table loading, and incremental state sync

import type { DB } from './types.ts'
import { createTableSQL, type TableDef } from '../sql.ts'

/** CREATE TABLE IF NOT EXISTS for all tables — called on DB open */
export async function initSchema(db: DB, schema: Record<string, TableDef>): Promise<void> {
  for (const [name, def] of Object.entries(schema)) {
    await db.execute(createTableSQL(name, def))
  }
}

/** Load all table rows into state — called on startup after KV merge */
export async function loadTables(db: DB, schema: Record<string, TableDef>): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {}
  for (const name of Object.keys(schema)) {
    const { rows } = await db.query(`SELECT * FROM ${name}`)
    result[name] = rows
  }
  return result
}

function findPk(def: TableDef): string | null {
  for (const [name, col] of Object.entries(def.columns)) {
    if (col.pk) return name
  }
  return null
}

function rowsEqual(a: Record<string, unknown>, b: Record<string, unknown>, cols: string[]): boolean {
  for (const col of cols) {
    if (a[col] !== b[col]) return false
  }
  return true
}

/** Incremental sync — diffs state vs prev, flushes all changes in one transaction.
 *  prev must reflect the last state written to SQLite (maintained by aio.ts prevDbState). */
export async function syncTables(
  db: DB, schema: Record<string, TableDef>,
  state: Record<string, unknown>, prev: Record<string, unknown>,
): Promise<void> {
  const changed = Object.keys(schema).filter(name => state[name] !== prev[name])
  if (!changed.length) return

  const stmts: { sql: string; params?: unknown[] }[] = []

  for (const name of changed) {
    const rows = state[name] as Record<string, unknown>[]
    const cols = Object.keys(schema[name]!.columns)
    const pk = findPk(schema[name]!)

    if (pk && rows.length > 0) {
      const prevRows = (prev[name] as Record<string, unknown>[]) ?? []
      const prevMap = new Map(prevRows.map(r => [r[pk], r]))
      const stateIds = new Set(rows.map(r => r[pk]))

      const toDelete = prevRows.filter(r => !stateIds.has(r[pk])).map(r => r[pk])
      const toInsert: Record<string, unknown>[] = []
      const toUpdate: Record<string, unknown>[] = []

      for (const row of rows) {
        const existing = prevMap.get(row[pk])
        if (!existing) toInsert.push(row)
        else if (!rowsEqual(row, existing, cols)) toUpdate.push(row)
      }

      if (toDelete.length) {
        stmts.push({ sql: `DELETE FROM ${name} WHERE ${pk} IN (${toDelete.map(() => '?').join(', ')})`, params: toDelete })
      }
      for (const row of toInsert) {
        stmts.push({ sql: `INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params: cols.map(c => row[c]) })
      }
      const setCols = cols.filter(c => c !== pk)
      for (const row of toUpdate) {
        stmts.push({
          sql: `UPDATE ${name} SET ${setCols.map(c => `${c} = ?`).join(', ')} WHERE ${pk} = ?`,
          params: [...setCols.map(c => row[c]), row[pk]],
        })
      }
    } else {
      // No PK or empty array — full table replacement
      stmts.push({ sql: `DELETE FROM ${name}` })
      for (const row of rows) {
        stmts.push({ sql: `INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params: cols.map(c => row[c]) })
      }
    }
  }

  if (stmts.length) await db.transaction(stmts)
}

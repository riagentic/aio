import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { DatabaseSync } from 'node:sqlite'
import {
  pk, text, integer, real, ref, table,
  columnToSQL, createTableSQL,
  openDb, loadTables, syncTables, reloadTable,
  type AioTable,
} from '../src/sql.ts'

// Helper: temp db path
function tmpDb(): string {
  return Deno.makeTempFileSync({ suffix: '.db' })
}

// Helper: grab a typed table accessor from AioDB (avoids index-signature union noise)
// deno-lint-ignore no-explicit-any
function tbl<T = any>(aioDB: ReturnType<typeof openDb>['aioDB'], name: string): AioTable<T> {
  return aioDB[name] as AioTable<T>
}

// ── Identifier validation ────────────────────────────────────────────

Deno.test('sql: rejects invalid table name in createTableSQL', () => {
  assertThrows(() => createTableSQL('drop table; --', table({ id: pk() })), Error, 'invalid table name')
})

Deno.test('sql: rejects invalid column name in columnToSQL', () => {
  assertThrows(() => columnToSQL('1bad', pk()), Error, 'invalid column name')
})

Deno.test('sql: openDb rejects invalid schema keys', () => {
  const path = tmpDb()
  assertThrows(() => openDb(path, { 'my-table': table({ id: pk() }) }), Error, 'invalid table name')
  try { Deno.removeSync(path) } catch { /* may not have been created */ }
})

Deno.test('sql: openDb rejects invalid column keys', () => {
  const path = tmpDb()
  assertThrows(() => openDb(path, { items: table({ 'bad col': pk() }) }), Error, 'invalid column name')
  try { Deno.removeSync(path) } catch { /* may not have been created */ }
})

Deno.test('sql: where() rejects invalid field names', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  assertThrows(() => items.where({ '1; DROP TABLE': 'x' }), Error, 'invalid where field')
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: insert() rejects invalid column names', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  assertThrows(() => items.insert({ id: 1, 'bad col': 'x' }), Error, 'invalid insert column')
  aioDB.close()
  Deno.removeSync(path)
})

// ── Empty-where guard ───────────────────────────────────────────────

Deno.test('sql: delete({}) throws — prevents accidental delete-all', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insert({ id: 1, name: 'a' })
  assertThrows(() => items.delete({}), Error, 'requires a where clause')
  assertEquals(items.count(), 1)  // still there
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: update({}, set) throws — prevents accidental update-all', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insert({ id: 1, name: 'a' })
  assertThrows(() => items.update({}, { name: 'z' }), Error, 'requires a where clause')
  assertEquals((items.find(1) as { name: string }).name, 'a')  // unchanged
  aioDB.close()
  Deno.removeSync(path)
})

// ── Edge cases (from audit) ────────────────────────────────────────

Deno.test('sql: where() with in: [] returns no rows', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insert({ id: 1, name: 'a' })
  const result = items.where({ name: { in: [] } })
  assertEquals(result.length, 0)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: where() with null matches NULL values', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text({ nullable: true }) }) }
  const { aioDB } = openDb(path, schema)
  aioDB.run('INSERT INTO items (id, name) VALUES (?, ?)', [1, null])
  aioDB.run('INSERT INTO items (id, name) VALUES (?, ?)', [2, 'bob'])
  const items = tbl(aioDB, 'items')
  const result = items.where({ name: null })
  assertEquals(result.length, 1)
  assertEquals((result[0] as { id: number }).id, 1)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: string default with single quotes escapes correctly', () => {
  const sql = columnToSQL('label', text({ default: "it's" }))
  assertEquals(sql, "label TEXT NOT NULL DEFAULT 'it''s'")
})

Deno.test('sql: insertMany rolls back on failure', () => {
  const path = tmpDb()
  const schema = {
    users: table({ id: pk(), name: text({ unique: true }) }),
  }
  const { aioDB } = openDb(path, schema)
  const users = tbl(aioDB, 'users')
  users.insert({ id: 1, name: 'alice' })
  // Second row has duplicate name — should fail and rollback the whole batch
  assertThrows(() => users.insertMany([
    { id: 2, name: 'bob' },
    { id: 3, name: 'alice' },  // duplicate!
  ]))
  // Only original row should remain (batch was rolled back)
  assertEquals(users.count(), 1)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: syncTables rolls back on error', () => {
  const path = tmpDb()
  const schema = {
    items: table({ id: pk(), name: text({ unique: true }) }),
  }
  const { raw } = openDb(path, schema)
  raw.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run(1, 'original')

  // New state has duplicate names — sync should fail and rollback
  const prev = { items: [{ id: 1, name: 'original' }] }
  const state = { items: [{ id: 1, name: 'a' }, { id: 2, name: 'a' }] }  // duplicate!
  assertThrows(() => syncTables(raw, schema, state, prev))

  // Original data should be intact (rollback worked)
  const rows = raw.prepare('SELECT * FROM items').all() as { name: string }[]
  assertEquals(rows.length, 1)
  assertEquals(rows[0].name, 'original')
  raw.close()
  Deno.removeSync(path)
})

// ── Column helpers ──────────────────────────────────────────────────

Deno.test('sql: pk() produces INTEGER PRIMARY KEY', () => {
  const def = pk()
  assertEquals(def.sqlType, 'INTEGER')
  assertEquals(def.pk, true)
})

Deno.test('sql: text() defaults NOT NULL', () => {
  assertEquals(columnToSQL('name', text()), 'name TEXT NOT NULL')
})

Deno.test('sql: text({ nullable }) omits NOT NULL', () => {
  assertEquals(columnToSQL('bio', text({ nullable: true })), 'bio TEXT')
})

Deno.test('sql: text({ unique }) adds UNIQUE', () => {
  assertEquals(columnToSQL('email', text({ unique: true })), 'email TEXT NOT NULL UNIQUE')
})

Deno.test('sql: integer({ default }) adds DEFAULT', () => {
  assertEquals(columnToSQL('count', integer({ default: 0 })), 'count INTEGER NOT NULL DEFAULT 0')
})

Deno.test('sql: real() produces REAL NOT NULL', () => {
  assertEquals(columnToSQL('price', real()), 'price REAL NOT NULL')
})

Deno.test('sql: text({ default: string }) wraps in quotes', () => {
  assertEquals(columnToSQL('status', text({ default: 'active' })), "status TEXT NOT NULL DEFAULT 'active'")
})

Deno.test('sql: ref() produces REFERENCES', () => {
  assertEquals(columnToSQL('userId', ref('users')), 'userId INTEGER NOT NULL REFERENCES users(id)')
})

Deno.test('sql: ref({ nullable }) omits NOT NULL', () => {
  assertEquals(columnToSQL('parentId', ref('items', { nullable: true })), 'parentId INTEGER REFERENCES items(id)')
})

Deno.test('sql: pk() columnToSQL has PRIMARY KEY', () => {
  assertEquals(columnToSQL('id', pk()), 'id INTEGER PRIMARY KEY')
})

// ── createTableSQL ──────────────────────────────────────────────────

Deno.test('sql: createTableSQL generates correct DDL', () => {
  const t = table({ id: pk(), name: text(), score: real({ default: 0 }) })
  const sql = createTableSQL('players', t)
  assertEquals(sql, "CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL NOT NULL DEFAULT 0)")
})

Deno.test('sql: createTableSQL with ref', () => {
  const t = table({ id: pk(), userId: ref('users') })
  const sql = createTableSQL('orders', t)
  assertEquals(sql, 'CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL REFERENCES users(id))')
})

// ── openDb + WAL + foreign keys ─────────────────────────────────────

Deno.test('sql: openDb enables WAL and foreign keys', () => {
  const path = tmpDb()
  const { aioDB, raw } = openDb(path, {})
  const wal = raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
  assertEquals(wal.journal_mode, 'wal')
  const fk = raw.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
  assertEquals(fk.foreign_keys, 1)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: openDb creates tables from schema', () => {
  const path = tmpDb()
  const schema = {
    users: table({ id: pk(), name: text() }),
    items: table({ id: pk(), label: text(), userId: ref('users') }),
  }
  const { aioDB } = openDb(path, schema)
  // Tables exist — insert should work
  aioDB.run('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Alice'])
  aioDB.run('INSERT INTO items (id, label, userId) VALUES (?, ?, ?)', [1, 'thing', 1])
  const rows = aioDB.query('SELECT * FROM items')
  assertEquals(rows.length, 1)
  aioDB.close()
  Deno.removeSync(path)
})

// ── Foreign key enforcement ─────────────────────────────────────────

Deno.test('sql: ref() enforces foreign key constraint', () => {
  const path = tmpDb()
  const schema = {
    users: table({ id: pk(), name: text() }),
    orders: table({ id: pk(), userId: ref('users') }),
  }
  const { aioDB } = openDb(path, schema)
  // Insert without valid user → should fail
  assertThrows(() => {
    aioDB.run('INSERT INTO orders (id, userId) VALUES (?, ?)', [1, 999])
  })
  aioDB.close()
  Deno.removeSync(path)
})

// ── ORM: all, find, where ───────────────────────────────────────────

Deno.test('sql: ORM all() returns all rows', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insert({ id: 1, name: 'a' })
  items.insert({ id: 2, name: 'b' })
  assertEquals(items.all().length, 2)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: ORM find() returns row by id', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insert({ id: 42, name: 'found' })
  const row = items.find(42) as { id: number; name: string }
  assertEquals(row.name, 'found')
  assertEquals(items.find(999), undefined)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: ORM where() with equality', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text(), score: integer() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insert({ id: 1, name: 'a', score: 10 })
  items.insert({ id: 2, name: 'b', score: 20 })
  items.insert({ id: 3, name: 'a', score: 30 })
  const result = items.where({ name: 'a' }) as { id: number }[]
  assertEquals(result.length, 2)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: ORM where() with operators', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), val: integer() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  for (let i = 1; i <= 10; i++) items.insert({ id: i, val: i * 10 })

  // gt
  assertEquals((items.where({ val: { gt: 50 } }) as unknown[]).length, 5)
  // gte
  assertEquals((items.where({ val: { gte: 50 } }) as unknown[]).length, 6)
  // lt
  assertEquals((items.where({ val: { lt: 30 } }) as unknown[]).length, 2)
  // lte
  assertEquals((items.where({ val: { lte: 30 } }) as unknown[]).length, 3)
  // ne
  assertEquals((items.where({ val: { ne: 50 } }) as unknown[]).length, 9)
  // in
  assertEquals((items.where({ val: { in: [10, 30, 50] } }) as unknown[]).length, 3)

  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: ORM where() with like', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insert({ id: 1, name: 'alice' })
  items.insert({ id: 2, name: 'bob' })
  items.insert({ id: 3, name: 'alicia' })
  const result = items.where({ name: { like: 'ali%' } }) as unknown[]
  assertEquals(result.length, 2)
  aioDB.close()
  Deno.removeSync(path)
})

// ── ORM: insert, insertMany ────────────────────────────────────────

Deno.test('sql: ORM insert() returns lastInsertRowId', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  const r = items.insert({ id: 5, name: 'five' })
  assertEquals(r.lastInsertRowId, 5)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: ORM insertMany() inserts in transaction', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insertMany([
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
    { id: 3, name: 'c' },
  ])
  assertEquals(items.count(), 3)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: ORM insertMany() empty is no-op', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insertMany([])
  assertEquals(items.count(), 0)
  aioDB.close()
  Deno.removeSync(path)
})

// ── ORM: update, delete ────────────────────────────────────────────

Deno.test('sql: ORM update() modifies matching rows', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text(), val: integer() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insertMany([
    { id: 1, name: 'a', val: 10 },
    { id: 2, name: 'b', val: 20 },
  ])
  const r = items.update({ id: 1 }, { val: 99 })
  assertEquals(r.changes, 1)
  assertEquals((items.find(1) as { val: number }).val, 99)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: ORM delete() removes matching rows', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insertMany([
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
    { id: 3, name: 'c' },
  ])
  const r = items.delete({ name: 'b' })
  assertEquals(r.changes, 1)
  assertEquals(items.count(), 2)
  aioDB.close()
  Deno.removeSync(path)
})

// ── ORM: count ──────────────────────────────────────────────────────

Deno.test('sql: ORM count() with and without filter', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), cat: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insertMany([
    { id: 1, cat: 'x' },
    { id: 2, cat: 'y' },
    { id: 3, cat: 'x' },
  ])
  assertEquals(items.count(), 3)
  assertEquals(items.count({ cat: 'x' }), 2)
  aioDB.close()
  Deno.removeSync(path)
})

// ── Raw SQL: query, get, run, exec ──────────────────────────────────

Deno.test('sql: raw query() returns rows', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), val: integer() }) }
  const { aioDB } = openDb(path, schema)
  aioDB.run('INSERT INTO items (id, val) VALUES (?, ?)', [1, 100])
  aioDB.run('INSERT INTO items (id, val) VALUES (?, ?)', [2, 200])
  const rows = aioDB.query<{ total: number }>('SELECT SUM(val) as total FROM items')
  assertEquals(rows[0].total, 300)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: raw get() returns single row or undefined', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  aioDB.run('INSERT INTO items (id, name) VALUES (?, ?)', [1, 'one'])
  const row = aioDB.get<{ id: number; name: string }>('SELECT * FROM items WHERE id = ?', [1])
  assertEquals(row?.name, 'one')
  const missing = aioDB.get('SELECT * FROM items WHERE id = ?', [999])
  assertEquals(missing, undefined)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: raw run() returns changes + lastInsertRowId', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const r = aioDB.run('INSERT INTO items (id, name) VALUES (?, ?)', [7, 'seven'])
  assertEquals(r.lastInsertRowId, 7)
  assertEquals(r.changes, 1)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: raw exec() runs DDL', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  aioDB.exec('ALTER TABLE items ADD COLUMN notes TEXT')
  aioDB.run('INSERT INTO items (id, name, notes) VALUES (?, ?, ?)', [1, 'one', 'hello'])
  const row = aioDB.get<{ notes: string }>('SELECT notes FROM items WHERE id = ?', [1])
  assertEquals(row?.notes, 'hello')
  aioDB.close()
  Deno.removeSync(path)
})

// ── loadTables ──────────────────────────────────────────────────────

Deno.test('sql: loadTables populates arrays from DB', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { raw } = openDb(path, schema)
  raw.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run(1, 'a')
  raw.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run(2, 'b')
  const result = loadTables(raw, schema)
  assertEquals(result.items.length, 2)
  raw.close()
  Deno.removeSync(path)
})

Deno.test('sql: loadTables returns empty arrays for empty tables', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { raw } = openDb(path, schema)
  const result = loadTables(raw, schema)
  assertEquals(result.items, [])
  raw.close()
  Deno.removeSync(path)
})

// ── syncTables ──────────────────────────────────────────────────────

Deno.test('sql: syncTables writes changed arrays', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { raw } = openDb(path, schema)

  const items = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]
  const prev = { items: [] as unknown[] }
  const state = { items }

  syncTables(raw, schema, state, prev)

  const rows = raw.prepare('SELECT * FROM items').all() as { id: number; name: string }[]
  assertEquals(rows.length, 2)
  assertEquals(rows[0].name, 'a')
  raw.close()
  Deno.removeSync(path)
})

Deno.test('sql: syncTables skips unchanged arrays (ref equality)', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { raw } = openDb(path, schema)

  const items = [{ id: 1, name: 'a' }]
  // Same reference — should be skipped (no DELETE+INSERT)
  syncTables(raw, schema, { items }, { items })

  // Table should still be empty since we never wrote
  const rows = raw.prepare('SELECT * FROM items').all()
  assertEquals(rows.length, 0)
  raw.close()
  Deno.removeSync(path)
})

Deno.test('sql: syncTables empty array clears table', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { raw } = openDb(path, schema)

  // Seed data
  raw.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run(1, 'a')
  assertEquals(raw.prepare('SELECT COUNT(*) as c FROM items').get()!.c, 1)

  // Sync empty array (different ref)
  const prev = { items: [{ id: 1, name: 'a' }] }
  const state = { items: [] as unknown[] }
  syncTables(raw, schema, state, prev)

  assertEquals(raw.prepare('SELECT COUNT(*) as c FROM items').get()!.c, 0)
  raw.close()
  Deno.removeSync(path)
})

// ── reloadTable ─────────────────────────────────────────────────────

Deno.test('sql: reloadTable returns current rows', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { raw } = openDb(path, schema)
  raw.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run(1, 'fresh')
  const rows = reloadTable(raw, 'items') as { name: string }[]
  assertEquals(rows.length, 1)
  assertEquals(rows[0].name, 'fresh')
  raw.close()
  Deno.removeSync(path)
})

// ── syncTables incremental (PK-based) ────────────────────────────────

Deno.test('sql: syncTables incremental INSERT only', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { raw } = openDb(path, schema)
  raw.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run(1, 'a')

  const prev = { items: [{ id: 1, name: 'a' }] }
  const state = { items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }] }
  syncTables(raw, schema, state, prev)

  const rows = raw.prepare('SELECT * FROM items ORDER BY id').all() as { id: number; name: string }[]
  assertEquals(rows.length, 3)
  assertEquals(rows[1].name, 'b')
  assertEquals(rows[2].name, 'c')
  raw.close()
  Deno.removeSync(path)
})

Deno.test('sql: syncTables incremental UPDATE only', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { raw } = openDb(path, schema)
  raw.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run(1, 'a')
  raw.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run(2, 'b')

  const prev = { items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] }
  const state = { items: [{ id: 1, name: 'changed' }, { id: 2, name: 'b' }] }
  syncTables(raw, schema, state, prev)

  const rows = raw.prepare('SELECT * FROM items ORDER BY id').all() as { id: number; name: string }[]
  assertEquals(rows.length, 2)
  assertEquals(rows[0].name, 'changed')
  assertEquals(rows[1].name, 'b')
  raw.close()
  Deno.removeSync(path)
})

Deno.test('sql: syncTables incremental DELETE only', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { raw } = openDb(path, schema)
  raw.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run(1, 'a')
  raw.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run(2, 'b')
  raw.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run(3, 'c')

  const prev = { items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }] }
  const state = { items: [{ id: 1, name: 'a' }, { id: 3, name: 'c' }] }
  syncTables(raw, schema, state, prev)

  const rows = raw.prepare('SELECT * FROM items ORDER BY id').all() as { id: number; name: string }[]
  assertEquals(rows.length, 2)
  assertEquals(rows[0].id, 1)
  assertEquals(rows[1].id, 3)
  raw.close()
  Deno.removeSync(path)
})

Deno.test('sql: syncTables incremental mixed INSERT/UPDATE/DELETE', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text(), val: integer() }) }
  const { raw } = openDb(path, schema)
  raw.prepare('INSERT INTO items (id, name, val) VALUES (?, ?, ?)').run(1, 'a', 10)
  raw.prepare('INSERT INTO items (id, name, val) VALUES (?, ?, ?)').run(2, 'b', 20)
  raw.prepare('INSERT INTO items (id, name, val) VALUES (?, ?, ?)').run(3, 'c', 30)

  const prev = { items: [{ id: 1, name: 'a', val: 10 }, { id: 2, name: 'b', val: 20 }, { id: 3, name: 'c', val: 30 }] }
  const state = { items: [{ id: 1, name: 'a', val: 99 }, { id: 3, name: 'c', val: 30 }, { id: 4, name: 'd', val: 40 }] }
  syncTables(raw, schema, state, prev)

  const rows = raw.prepare('SELECT * FROM items ORDER BY id').all() as { id: number; name: string; val: number }[]
  assertEquals(rows.length, 3)
  assertEquals(rows[0].id, 1)
  assertEquals(rows[0].val, 99)  // updated
  assertEquals(rows[1].id, 3)    // unchanged
  assertEquals(rows[2].id, 4)    // inserted
  assertEquals(rows[2].name, 'd')
  raw.close()
  Deno.removeSync(path)
})

Deno.test('sql: syncTables unchanged row skips UPDATE', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { raw } = openDb(path, schema)
  raw.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run(1, 'same')

  const prev = { items: [{ id: 1, name: 'same' }] }
  const state = { items: [{ id: 1, name: 'same' }] }
  syncTables(raw, schema, state, prev)

  const rows = raw.prepare('SELECT * FROM items').all() as { id: number; name: string }[]
  assertEquals(rows.length, 1)
  assertEquals(rows[0].name, 'same')
  raw.close()
  Deno.removeSync(path)
})

Deno.test('sql: syncTables fallback to full sync without PK', () => {
  const path = tmpDb()
  const schema = { logs: table({ ts: integer(), msg: text() }) }  // no PK
  const { raw } = openDb(path, schema)
  raw.prepare('INSERT INTO logs (ts, msg) VALUES (?, ?)').run(1, 'old')

  const prev = { logs: [{ ts: 1, msg: 'old' }] }
  const state = { logs: [{ ts: 2, msg: 'new' }, { ts: 3, msg: 'another' }] }
  syncTables(raw, schema, state, prev)

  const rows = raw.prepare('SELECT * FROM logs ORDER BY ts').all() as { ts: number; msg: string }[]
  assertEquals(rows.length, 2)
  assertEquals(rows[0].ts, 2)
  assertEquals(rows[1].ts, 3)
  raw.close()
  Deno.removeSync(path)
})

Deno.test('sql: syncTables empty state with PK triggers DELETE', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { raw } = openDb(path, schema)
  raw.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run(1, 'a')
  raw.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run(2, 'b')

  const prev = { items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] }
  const state = { items: [] as unknown[] }
  syncTables(raw, schema, state, prev)

  assertEquals(raw.prepare('SELECT COUNT(*) as c FROM items').get()!.c, 0)
  raw.close()
  Deno.removeSync(path)
})

// ── insertMany column consistency (B7 audit fix) ─────────────────────

Deno.test('sql: insertMany throws when rows have different column sets', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text(), qty: integer({ nullable: true }) }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  assertThrows(
    () => items.insertMany([
      { id: 1, name: 'apple', qty: 3 },
      { id: 2, name: 'banana' },         // missing qty
    ]),
    Error,
    'different columns',
  )
  assertEquals(items.count(), 0)  // transaction rolled back
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: insertMany succeeds when all rows have identical columns', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insertMany([
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
    { id: 3, name: 'c' },
  ])
  assertEquals(items.count(), 3)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: whereOr returns rows matching any clause', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text(), score: integer() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insert({ id: 1, name: 'alice', score: 10 })
  items.insert({ id: 2, name: 'bob', score: 20 })
  items.insert({ id: 3, name: 'carol', score: 30 })
  const result = items.whereOr([{ name: 'alice' }, { name: 'carol' }])
  assertEquals(result.length, 2)
  assertEquals(result.map((r: { name: string }) => r.name).sort(), ['alice', 'carol'])
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: whereOr with empty array returns all rows', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insert({ id: 1, name: 'a' })
  items.insert({ id: 2, name: 'b' })
  assertEquals(items.whereOr([]).length, 2)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: all() with orderBy and limit', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), score: integer() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insert({ id: 1, score: 30 })
  items.insert({ id: 2, score: 10 })
  items.insert({ id: 3, score: 20 })
  const result = items.all({ orderBy: ['score', 'asc'], limit: 2 })
  assertEquals(result.length, 2)
  assertEquals((result[0] as { score: number }).score, 10)
  assertEquals((result[1] as { score: number }).score, 20)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: where() with offset', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), score: integer() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  for (let i = 1; i <= 5; i++) items.insert({ id: i, score: i * 10 })
  const result = items.where({ score: { gte: 10 } }, { orderBy: ['score', 'asc'], limit: 2, offset: 2 })
  assertEquals(result.length, 2)
  assertEquals((result[0] as { score: number }).score, 30)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: upsert inserts new row', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  const r = items.upsert({ id: 1, name: 'original' })
  assertEquals(r.lastInsertRowId, 1)
  assertEquals(items.count(), 1)
  aioDB.close()
  Deno.removeSync(path)
})

Deno.test('sql: upsert replaces existing row', () => {
  const path = tmpDb()
  const schema = { items: table({ id: pk(), name: text() }) }
  const { aioDB } = openDb(path, schema)
  const items = tbl(aioDB, 'items')
  items.insert({ id: 1, name: 'original' })
  items.upsert({ id: 1, name: 'updated' })
  const row = items.find(1) as { name: string }
  assertEquals(row.name, 'updated')
  assertEquals(items.count(), 1)
  aioDB.close()
  Deno.removeSync(path)
})

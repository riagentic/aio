// Tests for async SQLite module (src/db/) and schema helpers (src/sql.ts)
import { assertEquals, assertRejects, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  pk, text, integer, real, ref, table,
  columnToSQL, createTableSQL, buildWhere, assertIdent,
} from '../src/sql.ts'
import { createDB, initSchema, loadTables, syncTables } from '../src/db/mod.ts'

// ── Helpers ──────────────────────────────────────────────────────────

function tmpDb(): string {
  return Deno.makeTempFileSync({ suffix: '.db' })
}

// Schema used across DB tests
const usersSchema = { users: table({ id: pk(), name: text(), age: integer({ nullable: true }) }) }
const itemsSchema = { items: table({ id: pk(), label: text(), val: real({ default: 0 }) }) }

// ── assertIdent ──────────────────────────────────────────────────────

Deno.test('db: assertIdent passes valid identifiers', () => {
  assertIdent('id', 'column')
  assertIdent('user_name', 'column')
  assertIdent('_private', 'column')
  assertIdent('Col123', 'table')
})

Deno.test('db: assertIdent throws on bad identifiers', () => {
  assertThrows(() => assertIdent('1bad', 'column'), Error, 'invalid column')
  assertThrows(() => assertIdent('bad-name', 'column'), Error, 'invalid column')
  assertThrows(() => assertIdent('drop; --', 'table'), Error, 'invalid table')
  assertThrows(() => assertIdent('', 'column'), Error, 'invalid column')
  assertThrows(() => assertIdent('has space', 'column'), Error, 'invalid column')
})

// ── columnToSQL ──────────────────────────────────────────────────────

Deno.test('db: columnToSQL — pk', () => {
  assertEquals(columnToSQL('id', pk()), 'id INTEGER PRIMARY KEY')
})

Deno.test('db: columnToSQL — text variants', () => {
  assertEquals(columnToSQL('name', text()), 'name TEXT NOT NULL')
  assertEquals(columnToSQL('bio', text({ nullable: true })), 'bio TEXT')
  assertEquals(columnToSQL('email', text({ unique: true })), 'email TEXT NOT NULL UNIQUE')
  assertEquals(columnToSQL('status', text({ default: 'active' })), "status TEXT NOT NULL DEFAULT 'active'")
})

Deno.test('db: columnToSQL — string default with single quotes escapes correctly', () => {
  assertEquals(columnToSQL('note', text({ default: "it's" })), "note TEXT NOT NULL DEFAULT 'it''s'")
})

Deno.test('db: columnToSQL — integer variants', () => {
  assertEquals(columnToSQL('count', integer()), 'count INTEGER NOT NULL')
  assertEquals(columnToSQL('count', integer({ default: 0 })), 'count INTEGER NOT NULL DEFAULT 0')
  assertEquals(columnToSQL('count', integer({ nullable: true })), 'count INTEGER')
})

Deno.test('db: columnToSQL — real', () => {
  assertEquals(columnToSQL('price', real()), 'price REAL NOT NULL')
  assertEquals(columnToSQL('score', real({ default: 1.5 })), 'score REAL NOT NULL DEFAULT 1.5')
})

Deno.test('db: columnToSQL — ref with and without nullable', () => {
  assertEquals(columnToSQL('userId', ref('users')), 'userId INTEGER NOT NULL REFERENCES users(id)')
  assertEquals(columnToSQL('parentId', ref('items', { nullable: true })), 'parentId INTEGER REFERENCES items(id)')
  assertEquals(columnToSQL('tagId', ref('tags', { unique: true })), 'tagId INTEGER NOT NULL UNIQUE REFERENCES tags(id)')
})

Deno.test('db: columnToSQL rejects invalid column name', () => {
  assertThrows(() => columnToSQL('1bad', pk()), Error, 'invalid column name')
  assertThrows(() => columnToSQL('bad col', text()), Error, 'invalid column name')
})

Deno.test('db: columnToSQL throws on invalid default type', () => {
  assertThrows(() => columnToSQL('x', { sqlType: 'TEXT', default: true }), Error, 'invalid default value')
  assertThrows(() => columnToSQL('x', { sqlType: 'INTEGER', default: [] }), Error, 'invalid default value')
  assertThrows(() => columnToSQL('x', { sqlType: 'REAL', default: Infinity }), Error, 'invalid default value')
})

// ── createTableSQL ───────────────────────────────────────────────────

Deno.test('db: createTableSQL produces correct DDL', () => {
  const t = table({ id: pk(), name: text(), score: real({ default: 0 }) })
  assertEquals(
    createTableSQL('players', t),
    'CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL NOT NULL DEFAULT 0)',
  )
})

Deno.test('db: createTableSQL with ref', () => {
  const t = table({ id: pk(), userId: ref('users') })
  assertEquals(
    createTableSQL('orders', t),
    'CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL REFERENCES users(id))',
  )
})

Deno.test('db: createTableSQL rejects invalid table name', () => {
  assertThrows(() => createTableSQL('drop table; --', table({ id: pk() })), Error, 'invalid table name')
  assertThrows(() => createTableSQL('1invalid', table({ id: pk() })), Error, 'invalid table name')
})

// ── buildWhere ───────────────────────────────────────────────────────

Deno.test('db: buildWhere — equality and operators', async (t) => {
  await t.step('empty filter', () => {
    const { sql, params } = buildWhere({})
    assertEquals(sql, '')
    assertEquals(params, [])
  })

  await t.step('exact value', () => {
    const { sql, params } = buildWhere({ name: 'alice' })
    assertEquals(sql, ' WHERE name = ?')
    assertEquals(params, ['alice'])
  })

  await t.step('null → IS NULL', () => {
    const { sql, params } = buildWhere({ name: null })
    assertEquals(sql, ' WHERE name IS NULL')
    assertEquals(params, [])
  })

  await t.step('undefined skipped', () => {
    const { sql, params } = buildWhere({ name: undefined, age: 5 })
    assertEquals(sql, ' WHERE age = ?')
    assertEquals(params, [5])
  })

  await t.step('gt/gte/lt/lte/ne', () => {
    const { sql, params } = buildWhere({ val: { gt: 10, lte: 50 } })
    assertEquals(sql, ' WHERE val > ? AND val <= ?')
    assertEquals(params, [10, 50])
  })

  await t.step('like', () => {
    const { sql, params } = buildWhere({ name: { like: 'ali%' } })
    assertEquals(sql, ' WHERE name LIKE ?')
    assertEquals(params, ['ali%'])
  })

  await t.step('in with values', () => {
    const { sql, params } = buildWhere({ id: { in: [1, 2, 3] } })
    assertEquals(sql, ' WHERE id IN (?, ?, ?)')
    assertEquals(params, [1, 2, 3])
  })

  await t.step('in empty → match nothing', () => {
    const { sql, params } = buildWhere({ id: { in: [] } })
    assertEquals(sql, ' WHERE 0 = 1')
    assertEquals(params, [])
  })

  await t.step('invalid field name throws', () => {
    assertThrows(() => buildWhere({ 'bad field': 'x' }), Error, 'invalid where field')
  })
})

// ── createDB + initSchema ────────────────────────────────────────────

Deno.test('db: createDB + initSchema creates tables', async () => {
  const path = tmpDb()
  const db = createDB(path)
  try {
    await initSchema(db, usersSchema)
    // Table exists — insert should work
    const r = await db.execute('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Alice'])
    assertEquals(r.changes, 1)
    assertEquals(r.lastInsertRowId, 1n)
  } finally {
    await db.close()
    Deno.removeSync(path)
  }
})

Deno.test('db: initSchema is idempotent (IF NOT EXISTS)', async () => {
  const path = tmpDb()
  const db = createDB(path)
  try {
    await initSchema(db, usersSchema)
    // Running again must not throw
    await initSchema(db, usersSchema)
    const { rows } = await db.query('SELECT * FROM users')
    assertEquals(rows.length, 0)
  } finally {
    await db.close()
    Deno.removeSync(path)
  }
})

Deno.test('db: createDB is lazy — worker spawns on first call', async () => {
  const path = tmpDb()
  // createDB itself is sync and should not throw
  const db = createDB(path)
  try {
    // Worker hasn't spawned yet; first actual call triggers it
    await initSchema(db, usersSchema)
    const { rows } = await db.query('SELECT * FROM users')
    assertEquals(rows, [])
  } finally {
    await db.close()
    Deno.removeSync(path)
  }
})

// ── query ────────────────────────────────────────────────────────────

Deno.test('db: query', async (t) => {
  const path = tmpDb()
  const db = createDB(path)
  try {
    await initSchema(db, usersSchema)

    await t.step('empty table returns empty rows', async () => {
      const result = await db.query('SELECT * FROM users')
      assertEquals(result.rows, [])
      assertEquals(result.changes, 0)
      assertEquals(result.lastInsertRowId, 0n)
    })

    await t.step('returns rows after insert', async () => {
      await db.execute('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Bob'])
      const { rows } = await db.query<{ id: number; name: string }>('SELECT * FROM users')
      assertEquals(rows.length, 1)
      assertEquals(rows[0]!.name, 'Bob')
    })

    await t.step('param substitution works', async () => {
      await db.execute('INSERT INTO users (id, name) VALUES (?, ?)', [2, 'Carol'])
      const { rows } = await db.query<{ id: number; name: string }>('SELECT * FROM users WHERE id = ?', [2])
      assertEquals(rows.length, 1)
      assertEquals(rows[0]!.name, 'Carol')
    })

    await t.step('query result shape: changes=0, lastInsertRowId=0n', async () => {
      const result = await db.query('SELECT * FROM users')
      assertEquals(result.changes, 0)
      assertEquals(result.lastInsertRowId, 0n)
      assertEquals(typeof result.lastInsertRowId, 'bigint')
    })
  } finally {
    await db.close()
    Deno.removeSync(path)
  }
})

// ── execute ──────────────────────────────────────────────────────────

Deno.test('db: execute', async (t) => {
  const path = tmpDb()
  const db = createDB(path)
  try {
    await initSchema(db, usersSchema)

    await t.step('INSERT returns changes=1 and bigint lastInsertRowId', async () => {
      const r = await db.execute('INSERT INTO users (id, name) VALUES (?, ?)', [10, 'Dave'])
      assertEquals(r.changes, 1)
      assertEquals(r.lastInsertRowId, 10n)
      assertEquals(typeof r.lastInsertRowId, 'bigint')
    })

    await t.step('UPDATE returns changes=n', async () => {
      await db.execute('INSERT INTO users (id, name) VALUES (?, ?)', [11, 'Eve'])
      await db.execute('INSERT INTO users (id, name) VALUES (?, ?)', [12, 'Frank'])
      const r = await db.execute("UPDATE users SET name = 'Updated' WHERE id IN (11, 12)")
      assertEquals(r.changes, 2)
    })

    await t.step('DELETE returns changes=n', async () => {
      const r = await db.execute('DELETE FROM users WHERE id = ?', [10])
      assertEquals(r.changes, 1)
      const { rows } = await db.query('SELECT * FROM users WHERE id = 10')
      assertEquals(rows.length, 0)
    })

    await t.step('lastInsertRowId is bigint type', async () => {
      const r = await db.execute('INSERT INTO users (id, name) VALUES (?, ?)', [99, 'Zed'])
      assertEquals(typeof r.lastInsertRowId, 'bigint')
    })
  } finally {
    await db.close()
    Deno.removeSync(path)
  }
})

// ── transaction ──────────────────────────────────────────────────────

Deno.test('db: transaction', async (t) => {
  const path = tmpDb()
  const db = createDB(path)
  try {
    await initSchema(db, { users: table({ id: pk(), name: text({ unique: true }) }) })

    await t.step('multiple statements execute atomically', async () => {
      const results = await db.transaction([
        { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [1, 'Alpha'] },
        { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [2, 'Beta'] },
        { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [3, 'Gamma'] },
      ])
      assertEquals(results.length, 3)
      assertEquals(results[0]!.changes, 1)
      assertEquals(results[1]!.changes, 1)
      assertEquals(results[2]!.changes, 1)
    })

    await t.step('all changes visible after commit', async () => {
      const { rows } = await db.query('SELECT * FROM users ORDER BY id')
      assertEquals(rows.length, 3)
    })

    await t.step('returns array of QueryResult (one per stmt)', async () => {
      const results = await db.transaction([
        { sql: "UPDATE users SET name = 'A1' WHERE id = 1" },
      ])
      assertEquals(Array.isArray(results), true)
      assertEquals(results.length, 1)
      assertEquals(results[0]!.changes, 1)
    })

    await t.step('rolls back on unique constraint violation', async () => {
      const { rows: before } = await db.query('SELECT COUNT(*) as c FROM users')
      const countBefore = (before[0] as { c: number }).c

      await assertRejects(
        () => db.transaction([
          { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [100, 'New'] },
          { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [101, 'A1'] }, // duplicate name
        ]),
        Error,
      )

      // Rollback: count should be unchanged
      const { rows: after } = await db.query('SELECT COUNT(*) as c FROM users')
      assertEquals((after[0] as { c: number }).c, countBefore)
    })
  } finally {
    await db.close()
    Deno.removeSync(path)
  }
})

// ── loadTables ───────────────────────────────────────────────────────

Deno.test('db: loadTables', async (t) => {
  const path = tmpDb()
  const db = createDB(path)
  const schema = {
    users: table({ id: pk(), name: text() }),
    tags: table({ id: pk(), label: text() }),
  }
  try {
    await initSchema(db, schema)

    await t.step('returns empty arrays for empty tables', async () => {
      const result = await loadTables(db, schema)
      assertEquals(result.users, [])
      assertEquals(result.tags, [])
    })

    await t.step('returns all rows after inserts', async () => {
      await db.execute('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Alice'])
      await db.execute('INSERT INTO users (id, name) VALUES (?, ?)', [2, 'Bob'])
      await db.execute('INSERT INTO tags (id, label) VALUES (?, ?)', [1, 'typescript'])
      const result = await loadTables(db, schema)
      assertEquals(result.users!.length, 2)
      assertEquals(result.tags!.length, 1)
    })

    await t.step('works with multiple tables', async () => {
      const result = await loadTables(db, schema)
      assertEquals(Object.keys(result).sort(), ['tags', 'users'])
    })
  } finally {
    await db.close()
    Deno.removeSync(path)
  }
})

// ── syncTables ───────────────────────────────────────────────────────

Deno.test('db: syncTables', async (t) => {
  const schema = { items: table({ id: pk(), name: text(), val: integer({ default: 0 }) }) }

  await t.step('no-op when state === prev (reference equality)', async () => {
    const path = tmpDb()
    const db = createDB(path)
    try {
      await initSchema(db, schema)
      const items = [{ id: 1, name: 'a', val: 1 }]
      const state = { items }
      await syncTables(db, schema, state, state)  // same ref
      const { rows } = await db.query('SELECT * FROM items')
      assertEquals(rows.length, 0)  // nothing was written
    } finally {
      await db.close()
      Deno.removeSync(path)
    }
  })

  await t.step('inserts new rows', async () => {
    const path = tmpDb()
    const db = createDB(path)
    try {
      await initSchema(db, schema)
      const prev = { items: [] as unknown[] }
      const state = { items: [{ id: 1, name: 'alpha', val: 10 }, { id: 2, name: 'beta', val: 20 }] }
      await syncTables(db, schema, state, prev)
      const { rows } = await db.query<{ id: number; name: string }>('SELECT * FROM items ORDER BY id')
      assertEquals(rows.length, 2)
      assertEquals(rows[0]!.name, 'alpha')
      assertEquals(rows[1]!.name, 'beta')
    } finally {
      await db.close()
      Deno.removeSync(path)
    }
  })

  await t.step('updates changed rows', async () => {
    const path = tmpDb()
    const db = createDB(path)
    try {
      await initSchema(db, schema)
      await db.execute('INSERT INTO items (id, name, val) VALUES (?, ?, ?)', [1, 'old', 1])
      await db.execute('INSERT INTO items (id, name, val) VALUES (?, ?, ?)', [2, 'unchanged', 2])
      const prev = { items: [{ id: 1, name: 'old', val: 1 }, { id: 2, name: 'unchanged', val: 2 }] }
      const state = { items: [{ id: 1, name: 'new', val: 99 }, { id: 2, name: 'unchanged', val: 2 }] }
      await syncTables(db, schema, state, prev)
      const { rows } = await db.query<{ id: number; name: string; val: number }>('SELECT * FROM items ORDER BY id')
      assertEquals(rows.length, 2)
      assertEquals(rows[0]!.name, 'new')
      assertEquals(rows[0]!.val, 99)
      assertEquals(rows[1]!.name, 'unchanged')
    } finally {
      await db.close()
      Deno.removeSync(path)
    }
  })

  await t.step('deletes removed rows', async () => {
    const path = tmpDb()
    const db = createDB(path)
    try {
      await initSchema(db, schema)
      await db.execute('INSERT INTO items (id, name, val) VALUES (?, ?, ?)', [1, 'a', 1])
      await db.execute('INSERT INTO items (id, name, val) VALUES (?, ?, ?)', [2, 'b', 2])
      await db.execute('INSERT INTO items (id, name, val) VALUES (?, ?, ?)', [3, 'c', 3])
      const prev = { items: [{ id: 1, name: 'a', val: 1 }, { id: 2, name: 'b', val: 2 }, { id: 3, name: 'c', val: 3 }] }
      const state = { items: [{ id: 1, name: 'a', val: 1 }, { id: 3, name: 'c', val: 3 }] }
      await syncTables(db, schema, state, prev)
      const { rows } = await db.query<{ id: number }>('SELECT id FROM items ORDER BY id')
      assertEquals(rows.length, 2)
      assertEquals(rows[0]!.id, 1)
      assertEquals(rows[1]!.id, 3)
    } finally {
      await db.close()
      Deno.removeSync(path)
    }
  })

  await t.step('full replacement when table has no PK', async () => {
    const noPkSchema = { logs: table({ ts: integer(), msg: text() }) }
    const path = tmpDb()
    const db = createDB(path)
    try {
      await initSchema(db, noPkSchema)
      await db.execute('INSERT INTO logs (ts, msg) VALUES (?, ?)', [1, 'old'])
      const prev = { logs: [{ ts: 1, msg: 'old' }] }
      const state = { logs: [{ ts: 2, msg: 'new1' }, { ts: 3, msg: 'new2' }] }
      await syncTables(db, noPkSchema, state, prev)
      const { rows } = await db.query<{ ts: number; msg: string }>('SELECT * FROM logs ORDER BY ts')
      assertEquals(rows.length, 2)
      assertEquals(rows[0]!.ts, 2)
      assertEquals(rows[1]!.ts, 3)
    } finally {
      await db.close()
      Deno.removeSync(path)
    }
  })

  await t.step('empty array with PK deletes all rows (full replacement path)', async () => {
    const path = tmpDb()
    const db = createDB(path)
    try {
      await initSchema(db, schema)
      await db.execute('INSERT INTO items (id, name, val) VALUES (?, ?, ?)', [1, 'x', 0])
      await db.execute('INSERT INTO items (id, name, val) VALUES (?, ?, ?)', [2, 'y', 0])
      const prev = { items: [{ id: 1, name: 'x', val: 0 }, { id: 2, name: 'y', val: 0 }] }
      const state = { items: [] as unknown[] }
      await syncTables(db, schema, state, prev)
      const { rows } = await db.query('SELECT * FROM items')
      assertEquals(rows.length, 0)
    } finally {
      await db.close()
      Deno.removeSync(path)
    }
  })

  await t.step('multiple tables synced in one call', async () => {
    const multiSchema = {
      users: table({ id: pk(), name: text() }),
      tags: table({ id: pk(), label: text() }),
    }
    const path = tmpDb()
    const db = createDB(path)
    try {
      await initSchema(db, multiSchema)
      const prev = { users: [] as unknown[], tags: [] as unknown[] }
      const state = {
        users: [{ id: 1, name: 'Alice' }],
        tags: [{ id: 1, label: 'ts' }, { id: 2, label: 'deno' }],
      }
      await syncTables(db, multiSchema, state, prev)
      const { rows: userRows } = await db.query('SELECT * FROM users')
      const { rows: tagRows } = await db.query('SELECT * FROM tags')
      assertEquals(userRows.length, 1)
      assertEquals(tagRows.length, 2)
    } finally {
      await db.close()
      Deno.removeSync(path)
    }
  })

  await t.step('unchanged tables not touched', async () => {
    const multiSchema = {
      users: table({ id: pk(), name: text() }),
      tags: table({ id: pk(), label: text() }),
    }
    const path = tmpDb()
    const db = createDB(path)
    try {
      await initSchema(db, multiSchema)
      await db.execute('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Bob'])
      const tags = [{ id: 1, label: 'rust' }]
      const prev = { users: [{ id: 1, name: 'Bob' }], tags }
      // Only users changes (different ref), tags stays same ref
      const state = { users: [{ id: 1, name: 'Bob' }, { id: 2, name: 'Carol' }], tags }
      await syncTables(db, multiSchema, state, prev)
      const { rows: userRows } = await db.query('SELECT * FROM users ORDER BY id')
      assertEquals(userRows.length, 2)
      // tags table should still be empty — sync was skipped due to ref equality
      const { rows: tagRows } = await db.query('SELECT * FROM tags')
      assertEquals(tagRows.length, 0)
    } finally {
      await db.close()
      Deno.removeSync(path)
    }
  })

  await t.step('rolls back on error (unique constraint violation)', async () => {
    const uniqueSchema = { users: table({ id: pk(), name: text({ unique: true }) }) }
    const path = tmpDb()
    const db = createDB(path)
    try {
      await initSchema(db, uniqueSchema)
      await db.execute('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'original'])
      const prev = { users: [{ id: 1, name: 'original' }] }
      // State has duplicate names — sync must fail and rollback
      const state = { users: [{ id: 1, name: 'dup' }, { id: 2, name: 'dup' }] }
      await assertRejects(() => syncTables(db, uniqueSchema, state, prev), Error)
      // original data intact
      const { rows } = await db.query<{ name: string }>('SELECT * FROM users')
      assertEquals(rows.length, 1)
      assertEquals(rows[0]!.name, 'original')
    } finally {
      await db.close()
      Deno.removeSync(path)
    }
  })
})

// ── close ────────────────────────────────────────────────────────────

Deno.test('db: close resolves without error', async () => {
  const path = tmpDb()
  const db = createDB(path)
  await initSchema(db, usersSchema)
  await db.close()
  Deno.removeSync(path)
})

Deno.test('db: double close does not throw', async () => {
  const path = tmpDb()
  const db = createDB(path)
  await initSchema(db, usersSchema)
  await db.close()
  Deno.removeSync(path)
  // Second close: worker is null, ensureWorker reopens (then worker.terminate() again).
  // The DB file is gone so the open will fail — must reject, not crash.
  const path2 = tmpDb()
  const db2 = createDB(path2)
  await initSchema(db2, usersSchema)
  await db2.close()
  await db2.close().catch(() => {})  // must not throw/crash
  Deno.removeSync(path2)
})

// ── read replicas ─────────────────────────────────────────────────────

Deno.test('db: read replicas — queries work alongside writer', async (t) => {
  const path = tmpDb()
  const db = createDB(path, { readers: 2 })
  try {
    await initSchema(db, usersSchema)

    await t.step('write via execute, read via query (routes to replica)', async () => {
      await db.execute('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Alice'])
      await db.execute('INSERT INTO users (id, name) VALUES (?, ?)', [2, 'Bob'])
      const { rows } = await db.query<{ id: number; name: string }>('SELECT * FROM users ORDER BY id')
      assertEquals(rows.length, 2)
      assertEquals(rows[0]!.name, 'Alice')
      assertEquals(rows[1]!.name, 'Bob')
    })

    await t.step('concurrent queries resolve correctly', async () => {
      // Fire multiple queries in parallel — reader pool handles them
      const results = await Promise.all([
        db.query<{ id: number }>('SELECT id FROM users WHERE id = 1'),
        db.query<{ id: number }>('SELECT id FROM users WHERE id = 2'),
        db.query<{ id: number }>('SELECT id FROM users ORDER BY id'),
      ])
      assertEquals(results[0]!.rows[0]!.id, 1)
      assertEquals(results[1]!.rows[0]!.id, 2)
      assertEquals(results[2]!.rows.length, 2)
    })

    await t.step('transaction result visible to subsequent query', async () => {
      await db.transaction([
        { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [3, 'Carol'] },
        { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [4, 'Dan'] },
      ])
      const { rows } = await db.query('SELECT COUNT(*) as c FROM users')
      assertEquals((rows[0] as { c: number }).c, 4)
    })
  } finally {
    await db.close()
    Deno.removeSync(path)
  }
})

Deno.test('db: read replicas — close terminates all workers', async () => {
  const path = tmpDb()
  const db = createDB(path, { readers: 3 })
  await initSchema(db, usersSchema)
  await db.close()  // must terminate writer + 3 readers cleanly
  Deno.removeSync(path)
})

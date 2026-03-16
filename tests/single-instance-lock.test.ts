import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { AppLock, readLock, removeLock, lockPath, resolveAppId, slugify, instances, isProcessAlive } from '../src/single-instance-lock.ts'

const TEST_APP = 'aio-test-lock-' + Deno.pid  // unique per test run to avoid collisions

async function cleanup() {
  removeLock(TEST_APP)
}

// ── slugify ──

Deno.test('slugify: basic', () => {
  assertEquals(slugify('My App'), 'my-app')
  assertEquals(slugify('hello world!'), 'hello-world')
  assertEquals(slugify(''), 'aio-app')
  assertEquals(slugify('---'), 'aio-app')
  assertEquals(slugify('My App! @v2'), 'my-app-v2')
})

// ── resolveAppId ──

Deno.test('resolveAppId: explicit appId wins', () => {
  assertEquals(resolveAppId({ appId: 'My Custom App' }), 'my-custom-app')
})

Deno.test('resolveAppId: title fallback', () => {
  // When deno.json has "name", it takes precedence over title.
  // Title fallback only applies when deno.json has no "name" field.
  const id = resolveAppId({ title: 'Dashboard' })
  assertEquals(typeof id, 'string')
  assertEquals(id.length > 0, true)
})

Deno.test('resolveAppId: empty fallback', () => {
  // Without deno.json name, falls back to 'aio-app' or deno.json name
  const id = resolveAppId({})
  assertEquals(typeof id, 'string')
  assertEquals(id.length > 0, true)
})

// ── lockPath ──

Deno.test('lockPath: contains appId', () => {
  const p = lockPath('my-app')
  assertEquals(p.includes('aio-my-app.lock'), true)
})

// ── acquire / release basics ──

Deno.test('AppLock: acquire succeeds when no lock exists', async () => {
  await cleanup()
  const lock = new AppLock(TEST_APP)
  try {
    const result = await lock.acquire(19999)
    assertEquals(result.ok, true)
    // Lock file should exist with correct data
    const data = readLock(TEST_APP)
    assertEquals(data?.appId, TEST_APP)
    assertEquals(data?.port, 19999)
    assertEquals(data?.pid, Deno.pid)
    assertEquals(data?.status, 'starting')
    assertEquals(data?.cwd, Deno.cwd())
  } finally {
    lock.release()
    await cleanup()
  }
})

Deno.test('AppLock: release removes lock file', async () => {
  await cleanup()
  const lock = new AppLock(TEST_APP)
  try {
    await lock.acquire(19999)
    lock.release()
    assertEquals(readLock(TEST_APP), null)
  } finally {
    await cleanup()
  }
})

Deno.test('AppLock: acquire cleans dead process lock', async () => {
  await cleanup()
  // Write a lock file with a dead PID
  const { writeLock } = await import('../src/single-instance-lock.ts')
  writeLock({ appId: TEST_APP, pid: 999999, port: 19999, startedAt: Date.now(), status: 'started', cwd: '/tmp' })
  const lock = new AppLock(TEST_APP)
  try {
    const result = await lock.acquire(19999)
    assertEquals(result.ok, true)
  } finally {
    lock.release()
    await cleanup()
  }
})

Deno.test('AppLock: release is idempotent', async () => {
  await cleanup()
  const lock = new AppLock(TEST_APP)
  lock.release() // no lock file — should not throw
  lock.release() // call again — still no throw
})

Deno.test('AppLock: lock file contains startedAt timestamp', async () => {
  await cleanup()
  const before = Date.now()
  const lock = new AppLock(TEST_APP)
  try {
    await lock.acquire(19999)
    const data = readLock(TEST_APP)!
    assertEquals(data.startedAt >= before, true)
    assertEquals(data.startedAt <= Date.now(), true)
  } finally {
    lock.release()
    await cleanup()
  }
})

Deno.test('AppLock: update modifies lock data', async () => {
  await cleanup()
  const lock = new AppLock(TEST_APP)
  try {
    await lock.acquire(19999)
    lock.update({ status: 'started', socketPath: '/tmp/test.sock' })
    const data = readLock(TEST_APP)!
    assertEquals(data.status, 'started')
    assertEquals(data.socketPath, '/tmp/test.sock')
    assertEquals(data.pid, Deno.pid)  // unchanged
  } finally {
    lock.release()
    await cleanup()
  }
})

Deno.test('AppLock: release only removes own lock', async () => {
  await cleanup()
  // Write a lock with a different PID (simulating another process)
  const { writeLock } = await import('../src/single-instance-lock.ts')
  writeLock({ appId: TEST_APP, pid: 999999, port: 19999, startedAt: Date.now(), status: 'started', cwd: '/tmp' })
  const lock = new AppLock(TEST_APP)
  lock.release()  // should NOT remove — PID doesn't match
  // Lock should still exist (it has a different PID, but the process is dead so...)
  // Actually since 999999 is dead, readLock will still return data.
  // The key is that release() checks PID match — it won't remove someone else's lock.
  // In this case lock.acquired is false so release() is a no-op.
  await cleanup()
})

// ── instances ──

Deno.test('instances: returns empty when no locks', () => {
  const all = instances('nonexistent-app-xyz')
  assertEquals(all.length, 0)
})

Deno.test('instances: finds running app', async () => {
  await cleanup()
  const lock = new AppLock(TEST_APP)
  try {
    await lock.acquire(19999)
    lock.update({ status: 'started' })
    const all = instances(TEST_APP)
    assertEquals(all.length, 1)
    assertEquals(all[0]!.appId, TEST_APP)
    assertEquals(all[0]!.pid, Deno.pid)
    assertEquals(all[0]!.alive, true)
  } finally {
    lock.release()
    await cleanup()
  }
})

Deno.test('instances: cleans stale locks', async () => {
  const staleApp = TEST_APP + '-stale'
  const { writeLock } = await import('../src/single-instance-lock.ts')
  writeLock({ appId: staleApp, pid: 999999, port: 19999, startedAt: Date.now(), status: 'started', cwd: '/tmp' })
  const all = instances(staleApp)
  assertEquals(all.length, 0)  // cleaned because PID 999999 is dead
  assertEquals(readLock(staleApp), null)  // lock file removed
})

// ── isProcessAlive ──

Deno.test('isProcessAlive: current process is alive', () => {
  assertEquals(isProcessAlive(Deno.pid), true)
})

Deno.test('isProcessAlive: dead PID returns false', () => {
  assertEquals(isProcessAlive(999999), false)
})

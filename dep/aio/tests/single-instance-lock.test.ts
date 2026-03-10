import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { AppLock } from '../src/single-instance-lock.ts'

const LOCK_FILE = '.aio.lock'

async function cleanup() {
  try { await Deno.remove(LOCK_FILE) } catch { /* ok */ }
}

// ── acquire / release basics ──

Deno.test('AppLock: acquire succeeds when no lock exists', async () => {
  await cleanup()
  const lock = new AppLock()
  try {
    const ok = await lock.acquire(19999)
    assertEquals(ok, true)
    // Lock file should exist
    const content = await Deno.readTextFile(LOCK_FILE)
    const data = JSON.parse(content)
    assertEquals(data.port, 19999)
    assertEquals(data.pid, Deno.pid)
  } finally {
    lock.release()
    await cleanup()
  }
})

Deno.test('AppLock: release removes lock file', async () => {
  await cleanup()
  const lock = new AppLock()
  try {
    await lock.acquire(19999)
    lock.release()
    let exists = true
    try { await Deno.stat(LOCK_FILE); } catch { exists = false }
    assertEquals(exists, false)
  } finally {
    await cleanup()
  }
})

Deno.test('AppLock: acquire cleans dead process lock', async () => {
  await cleanup()
  // Write a lock file with a dead PID
  await Deno.writeTextFile(LOCK_FILE, JSON.stringify({ pid: 999999, port: 19999, ts: Date.now() }))
  const lock = new AppLock()
  try {
    const ok = await lock.acquire(19999)
    assertEquals(ok, true)
  } finally {
    lock.release()
    await cleanup()
  }
})

Deno.test('AppLock: acquire succeeds when lock has different port (dead pid)', async () => {
  await cleanup()
  // Lock for port 8000 with dead PID, acquire for port 9000 — different app, should succeed
  await Deno.writeTextFile(LOCK_FILE, JSON.stringify({ pid: 999999, port: 8000, ts: Date.now() }))
  const lock = new AppLock()
  try {
    const ok = await lock.acquire(9000)
    assertEquals(ok, true)
  } finally {
    lock.release()
    await cleanup()
  }
})

Deno.test('AppLock: release is idempotent', async () => {
  await cleanup()
  const lock = new AppLock()
  lock.release() // no lock file — should not throw
  lock.release() // call again — still no throw
})

Deno.test('AppLock: acquire handles corrupted lock file', async () => {
  await cleanup()
  await Deno.writeTextFile(LOCK_FILE, 'not-json!!!}}}')
  const lock = new AppLock()
  try {
    const ok = await lock.acquire(19999)
    assertEquals(ok, true) // should treat corrupt file as free
  } finally {
    lock.release()
    await cleanup()
  }
})

Deno.test('AppLock: lock file contains timestamp', async () => {
  await cleanup()
  const before = Date.now()
  const lock = new AppLock()
  try {
    await lock.acquire(19999)
    const content = await Deno.readTextFile(LOCK_FILE)
    const data = JSON.parse(content)
    assertEquals(data.ts >= before, true)
    assertEquals(data.ts <= Date.now(), true)
  } finally {
    lock.release()
    await cleanup()
  }
})

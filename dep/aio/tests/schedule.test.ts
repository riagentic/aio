import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  schedule, isScheduleEffect, createScheduleManager,
  parseCron, nextCronTime, type ScheduleEffect,
} from '../src/schedule.ts'

const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

// ── Effect creators ─────────────────────────────────────────────────

Deno.test('schedule.after produces correct shape', () => {
  const e = schedule.after('save', 3000, { type: 'Save' })
  assertEquals(e.type, '__schedule')
  assertEquals(e.kind, 'after')
  assertEquals(e.id, 'save')
  assertEquals((e as Extract<ScheduleEffect, { kind: 'after' }>).ms, 3000)
  assertEquals(e, { type: '__schedule', kind: 'after', id: 'save', ms: 3000, action: { type: 'Save' } })
})

Deno.test('schedule.every produces correct shape', () => {
  const e = schedule.every('poll', 5000, { type: 'Fetch' })
  assertEquals(e, { type: '__schedule', kind: 'every', id: 'poll', ms: 5000, action: { type: 'Fetch' } })
})

Deno.test('schedule.at produces correct shape', () => {
  const e = schedule.at('deadline', '2026-12-31T23:59:00Z', { type: 'Expire' })
  assertEquals(e, { type: '__schedule', kind: 'at', id: 'deadline', time: '2026-12-31T23:59:00Z', action: { type: 'Expire' } })
})

Deno.test('schedule.cron produces correct shape', () => {
  const e = schedule.cron('nightly', '0 2 * * *', { type: 'Cleanup' })
  assertEquals(e, { type: '__schedule', kind: 'cron', id: 'nightly', pattern: '0 2 * * *', action: { type: 'Cleanup' } })
})

Deno.test('schedule.cancel produces correct shape', () => {
  const e = schedule.cancel('poll')
  assertEquals(e, { type: '__schedule', kind: 'cancel', id: 'poll' })
})

Deno.test('isScheduleEffect: true for schedule, false for normal effect', () => {
  assertEquals(isScheduleEffect(schedule.after('x', 100, { type: 'A' })), true)
  assertEquals(isScheduleEffect(schedule.cancel('x')), true)
  assertEquals(isScheduleEffect({ type: 'Log', payload: {} }), false)
  assertEquals(isScheduleEffect(null), false)
  assertEquals(isScheduleEffect(undefined), false)
  assertEquals(isScheduleEffect('string'), false)
})

// ── Schedule manager ────────────────────────────────────────────────

Deno.test('manager: after fires action after delay, auto-removes', async () => {
  const dispatched: { type: string }[] = []
  const mgr = createScheduleManager((a) => dispatched.push(a), noop)

  mgr.handle(schedule.after('test', 50, { type: 'Fired' }))
  assertEquals(mgr.active().includes('test'), true)

  await new Promise(r => setTimeout(r, 80))
  assertEquals(dispatched, [{ type: 'Fired' }])
  assertEquals(mgr.active().includes('test'), false) // auto-removed
})

Deno.test('manager: every fires repeatedly, cancel stops it', async () => {
  const dispatched: { type: string }[] = []
  const mgr = createScheduleManager((a) => dispatched.push(a), noop)

  mgr.handle(schedule.every('tick', 30, { type: 'Tick' }))
  await new Promise(r => setTimeout(r, 85))
  const count = dispatched.length
  assertEquals(count >= 2, true, `expected >=2, got ${count}`)

  mgr.handle(schedule.cancel('tick'))
  assertEquals(mgr.active().includes('tick'), false)

  const countAfterCancel = dispatched.length
  await new Promise(r => setTimeout(r, 60))
  assertEquals(dispatched.length, countAfterCancel) // no more fires
})

Deno.test('manager: at fires at specified time', async () => {
  const dispatched: { type: string }[] = []
  const mgr = createScheduleManager((a) => dispatched.push(a), noop)

  const target = new Date(Date.now() + 50).toISOString()
  mgr.handle(schedule.at('soon', target, { type: 'AtFire' }))

  await new Promise(r => setTimeout(r, 100))
  assertEquals(dispatched, [{ type: 'AtFire' }])
  assertEquals(mgr.active().includes('soon'), false)
})

Deno.test('manager: at with past time fires immediately', async () => {
  const dispatched: { type: string }[] = []
  const mgr = createScheduleManager((a) => dispatched.push(a), noop)

  const past = new Date(Date.now() - 10_000).toISOString()
  mgr.handle(schedule.at('old', past, { type: 'PastFire' }))

  await new Promise(r => setTimeout(r, 30))
  assertEquals(dispatched, [{ type: 'PastFire' }])
})

Deno.test('manager: at with invalid date string throws', () => {
  const mgr = createScheduleManager(() => {}, noop)
  assertThrows(() => mgr.handle(schedule.at('bad', 'garbage', { type: 'X' })), Error, 'invalid schedule.at time')
  assertEquals(mgr.active().length, 0)
})

Deno.test('manager: cancel is no-op for unknown id', () => {
  const mgr = createScheduleManager(() => {}, noop)
  mgr.handle(schedule.cancel('nonexistent')) // should not throw
  assertEquals(mgr.active().length, 0)
})

Deno.test('manager: re-schedule same id replaces previous', async () => {
  const dispatched: { type: string }[] = []
  const mgr = createScheduleManager((a) => dispatched.push(a), noop)

  mgr.handle(schedule.after('x', 200, { type: 'Old' }))
  mgr.handle(schedule.after('x', 50, { type: 'New' }))

  await new Promise(r => setTimeout(r, 80))
  assertEquals(dispatched, [{ type: 'New' }]) // Old was replaced, never fires

  await new Promise(r => setTimeout(r, 200))
  assertEquals(dispatched.length, 1) // still just 1
})

Deno.test('manager: cancelAll clears everything', async () => {
  const dispatched: { type: string }[] = []
  const mgr = createScheduleManager((a) => dispatched.push(a), noop)

  mgr.handle(schedule.after('a', 50, { type: 'A' }))
  mgr.handle(schedule.every('b', 30, { type: 'B' }))
  assertEquals(mgr.active().length, 2)

  mgr.cancelAll()
  assertEquals(mgr.active().length, 0)

  await new Promise(r => setTimeout(r, 100))
  assertEquals(dispatched.length, 0) // nothing fired
})

Deno.test('manager: start boots config-level schedules', async () => {
  const dispatched: { type: string }[] = []
  const mgr = createScheduleManager((a) => dispatched.push(a), noop)

  mgr.start([
    { id: 'heartbeat', every: 30, action: { type: 'Heartbeat' } },
    { id: 'once', after: 50, action: { type: 'Once' } },
  ])
  assertEquals(mgr.active().length, 2)

  await new Promise(r => setTimeout(r, 80))
  const hbCount = dispatched.filter(a => a.type === 'Heartbeat').length
  assertEquals(hbCount >= 2, true, `heartbeat should fire >=2 times, got ${hbCount}`)
  assertEquals(dispatched.some(a => a.type === 'Once'), true)

  mgr.cancelAll()
})

// ── Cron parser ─────────────────────────────────────────────────────

Deno.test('parseCron: every minute (* * * * *)', () => {
  const f = parseCron('* * * * *')
  assertEquals(f.minute.length, 60)
  assertEquals(f.hour.length, 24)
  assertEquals(f.dom.length, 31)
  assertEquals(f.month.length, 12)
  assertEquals(f.dow.length, 7)
})

Deno.test('parseCron: every 5 minutes (*/5 * * * *)', () => {
  const f = parseCron('*/5 * * * *')
  assertEquals(f.minute, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
})

Deno.test('parseCron: Monday 9am (0 9 * * 1)', () => {
  const f = parseCron('0 9 * * 1')
  assertEquals(f.minute, [0])
  assertEquals(f.hour, [9])
  assertEquals(f.dow, [1])
})

Deno.test('parseCron: :00 and :30 (0,30 * * * *)', () => {
  const f = parseCron('0,30 * * * *')
  assertEquals(f.minute, [0, 30])
})

Deno.test('parseCron: invalid pattern throws', () => {
  assertThrows(() => parseCron('* * *'), Error, '5 fields')
  assertThrows(() => parseCron('99 * * * *'), Error, 'invalid cron value')
  assertThrows(() => parseCron('*/0 * * * *'), Error, 'invalid cron step')
})

Deno.test('nextCronTime: computes correct next fire', () => {
  const fields = parseCron('0,30 * * * *') // every half hour
  const after = new Date('2026-03-01T10:15:00Z')
  const next = nextCronTime(fields, after)
  assertEquals(next.getUTCMinutes(), 30)
  assertEquals(next.getUTCHours(), 10)
})

Deno.test('nextCronTime: every minute fires within 1 minute', () => {
  const fields = parseCron('* * * * *')
  const now = new Date()
  const next = nextCronTime(fields, now)
  const diffMs = next.getTime() - now.getTime()
  assertEquals(diffMs > 0, true)
  assertEquals(diffMs <= 60_000, true)
})

Deno.test('nextCronTime: specific day-of-week', () => {
  const fields = parseCron('0 9 * * 1') // Monday 9:00
  const wednesday = new Date('2026-03-04T12:00:00Z') // Wednesday
  const next = nextCronTime(fields, wednesday)
  assertEquals(next.getUTCDay(), 1) // Monday
  assertEquals(next.getUTCHours(), 9)
  assertEquals(next.getUTCMinutes(), 0)
})

// ── Manager: cron ───────────────────────────────────────────────────

Deno.test('manager: cron schedules next fire', () => {
  const mgr = createScheduleManager(() => {}, noop)
  mgr.handle(schedule.cron('every-min', '* * * * *', { type: 'Tick' }))
  assertEquals(mgr.active().includes('every-min'), true)
  mgr.cancelAll()
})

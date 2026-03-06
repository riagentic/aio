// schedule.ts — declarative timers/delays/cron as effects
// Two use cases: config-level always-on schedules, dynamic effects from reducer

// ── Types ────────────────────────────────────────────────────────────

export type ScheduleEffect =
  | { type: '__schedule'; kind: 'after'; id: string; ms: number; action: { type: string; payload?: unknown } }
  | { type: '__schedule'; kind: 'every'; id: string; ms: number; action: { type: string; payload?: unknown } }
  | { type: '__schedule'; kind: 'at'; id: string; time: string; action: { type: string; payload?: unknown } }
  | { type: '__schedule'; kind: 'cron'; id: string; pattern: string; action: { type: string; payload?: unknown } }
  | { type: '__schedule'; kind: 'cancel'; id: string }

export type ScheduleDef = { id: string; action: { type: string; payload?: unknown } } & (
  | { every: number }
  | { after: number }
  | { at: string }
  | { cron: string }
)

// ── Effect creators (pure) ──────────────────────────────────────────

export const schedule = {
  after: (id: string, ms: number, action: { type: string; payload?: unknown }): ScheduleEffect =>
    ({ type: '__schedule', kind: 'after', id, ms, action }),
  every: (id: string, ms: number, action: { type: string; payload?: unknown }): ScheduleEffect =>
    ({ type: '__schedule', kind: 'every', id, ms, action }),
  at: (id: string, time: string, action: { type: string; payload?: unknown }): ScheduleEffect =>
    ({ type: '__schedule', kind: 'at', id, time, action }),
  cron: (id: string, pattern: string, action: { type: string; payload?: unknown }): ScheduleEffect =>
    ({ type: '__schedule', kind: 'cron', id, pattern, action }),
  cancel: (id: string): ScheduleEffect =>
    ({ type: '__schedule', kind: 'cancel', id }),
}

export function isScheduleEffect(e: unknown): e is ScheduleEffect {
  return !!e && typeof e === 'object' && (e as Record<string, unknown>).type === '__schedule'
}

// ── Cron parser ─────────────────────────────────────────────────────

export type CronFields = {
  minute: number[]  // 0-59
  hour: number[]    // 0-23
  dom: number[]     // 1-31
  month: number[]   // 1-12
  dow: number[]     // 0-6 (Sun=0)
}

function parseField(field: string, min: number, max: number): number[] {
  const values: number[] = []
  for (const part of field.split(',')) {
    const trimmed = part.trim()
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.push(i)
    } else if (trimmed.startsWith('*/')) {
      const step = Number(trimmed.slice(2))
      if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step: ${trimmed}`)
      for (let i = min; i <= max; i += step) values.push(i)
    } else if (trimmed.includes('-')) {
      // Range: "1-5" or "1-5/2"
      const [rangePart, stepPart] = trimmed.split('/')
      const [startStr, endStr] = rangePart.split('-')
      if (!startStr || !endStr) throw new Error(`invalid cron range: ${trimmed} (${min}-${max})`)
      const start = Number(startStr), end = Number(endStr)
      const step = stepPart ? Number(stepPart) : 1
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end)
        throw new Error(`invalid cron range: ${trimmed} (${min}-${max})`)
      if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step: ${trimmed}`)
      for (let i = start; i <= end; i += step) values.push(i)
    } else {
      const n = Number(trimmed)
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`invalid cron value: ${trimmed} (${min}-${max})`)
      values.push(n)
    }
  }
  return [...new Set(values)].sort((a, b) => a - b)
}

export function parseCron(pattern: string): CronFields {
  const parts = pattern.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`cron pattern must have 5 fields, got ${parts.length}: "${pattern}"`)
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dom: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dow: parseField(parts[4], 0, 6),
  }
}

// NOTE: cron fields are matched against UTC time (getUTCHours, getUTCDay, etc.).
// A pattern like "0 9 * * 1-5" fires at 09:00 UTC, not local time.
// If local-time cron is needed, offset the hour field by your UTC offset.
export function nextCronTime(fields: CronFields, after: Date): Date {
  const d = new Date(after.getTime())
  d.setUTCSeconds(0, 0)
  d.setUTCMinutes(d.getUTCMinutes() + 1) // start from next minute

  const maxIterations = 366 * 24 * 60 // ~1 year of minutes
  for (let i = 0; i < maxIterations; i++) {
    if (
      fields.month.includes(d.getUTCMonth() + 1) &&
      fields.dom.includes(d.getUTCDate()) &&
      fields.dow.includes(d.getUTCDay()) &&
      fields.hour.includes(d.getUTCHours()) &&
      fields.minute.includes(d.getUTCMinutes())
    ) {
      return d
    }
    d.setUTCMinutes(d.getUTCMinutes() + 1)
  }
  throw new Error('no matching cron time within 366 days')
}

// ── Schedule manager ────────────────────────────────────────────────

type Log = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void; debug: (msg: string) => void }
type TimerEntry = { timerId: ReturnType<typeof setTimeout>; kind: string }

export function createScheduleManager(
  dispatch: (action: { type: string; payload?: unknown }) => void,
  log: Log,
): {
  handle: (effect: ScheduleEffect) => void
  start: (defs: ScheduleDef[]) => void
  cancelAll: () => void
  active: () => string[]
} {
  const timers = new Map<string, TimerEntry>()
  const VALID_ID = /^[\w\-:.]+$/

  function validateId(id: string): void {
    if (!id || !VALID_ID.test(id)) throw new Error(`invalid schedule id: ${JSON.stringify(id)} — use alphanumeric, hyphens, colons, dots`)
  }

  function cancelTimer(id: string): void {
    const entry = timers.get(id)
    if (entry) {
      if (entry.kind === 'every') clearInterval(entry.timerId)
      else clearTimeout(entry.timerId)
      timers.delete(id)
    }
  }

  function setTimer(id: string, kind: string, timerId: ReturnType<typeof setTimeout>): void {
    cancelTimer(id) // re-schedule: cancel previous
    timers.set(id, { timerId, kind })
  }

  function handleAfter(id: string, ms: number, action: { type: string; payload?: unknown }): void {
    const timerId = setTimeout(() => {
      timers.delete(id)
      log.debug(`schedule: after '${id}' fired`)
      dispatch(action)
    }, ms)
    setTimer(id, 'after', timerId)
    log.debug(`schedule: after '${id}' set for ${ms}ms`)
  }

  function handleEvery(id: string, ms: number, action: { type: string; payload?: unknown }): void {
    const timerId = setInterval(() => {
      log.debug(`schedule: every '${id}' fired`)
      dispatch(action)
    }, ms)
    setTimer(id, 'every', timerId)
    log.debug(`schedule: every '${id}' set for ${ms}ms`)
  }

  function handleAt(id: string, time: string, action: { type: string; payload?: unknown }): void {
    const target = new Date(time).getTime()
    if (Number.isNaN(target)) throw new Error(`invalid schedule.at time: ${JSON.stringify(time)}`)
    const delay = Math.max(0, target - Date.now())
    const timerId = setTimeout(() => {
      timers.delete(id)
      log.debug(`schedule: at '${id}' fired`)
      dispatch(action)
    }, delay)
    setTimer(id, 'at', timerId)
    log.debug(`schedule: at '${id}' set for ${delay}ms (${time})`)
  }

  function handleCron(id: string, pattern: string, action: { type: string; payload?: unknown }): void {
    const fields = parseCron(pattern)
    const MAX_DELAY = 2_147_483_647  // 2^31-1 ms — setTimeout max safe value
    function scheduleNext(): void {
      let next: Date
      try { next = nextCronTime(fields, new Date()) } catch (e) {
        log.error(`schedule: cron '${id}' — ${e instanceof Error ? e.message : e}`)
        return
      }
      const delay = Math.max(0, next.getTime() - Date.now())
      if (delay > MAX_DELAY) {
        // Re-check after 24 hours — avoids setTimeout overflow for far-future cron times
        const timerId = setTimeout(scheduleNext, 86_400_000)
        setTimer(id, 'cron', timerId)
        log.debug(`schedule: cron '${id}' next at ${next.toISOString()} (${delay}ms > max, re-check in 24h)`)
        return
      }
      const timerId = setTimeout(() => {
        log.debug(`schedule: cron '${id}' fired`)
        dispatch(action)
        scheduleNext()
      }, delay)
      setTimer(id, 'cron', timerId)
      log.debug(`schedule: cron '${id}' next at ${next.toISOString()} (${delay}ms)`)
    }
    scheduleNext()
  }

  function handle(effect: ScheduleEffect): void {
    validateId(effect.id)
    switch (effect.kind) {
      case 'after': handleAfter(effect.id, effect.ms, effect.action); break
      case 'every': handleEvery(effect.id, effect.ms, effect.action); break
      case 'at':    handleAt(effect.id, effect.time, effect.action); break
      case 'cron':  handleCron(effect.id, effect.pattern, effect.action); break
      case 'cancel':
        if (timers.has(effect.id)) {
          cancelTimer(effect.id)
          log.debug(`schedule: cancelled '${effect.id}'`)
        }
        break
    }
  }

  function start(defs: ScheduleDef[]): void {
    for (const def of defs) {
      if ('every' in def) handleEvery(def.id, def.every, def.action)
      else if ('after' in def) handleAfter(def.id, def.after, def.action)
      else if ('at' in def) handleAt(def.id, def.at, def.action)
      else if ('cron' in def) handleCron(def.id, def.cron, def.action)
    }
  }

  function cancelAll(): void {
    for (const [id] of timers) cancelTimer(id)
    timers.clear()
  }

  function active(): string[] {
    return [...timers.keys()]
  }

  return { handle, start, cancelAll, active }
}

// logger.ts — Structured logging for aio
//
// Three outputs:
//   app.log    — human narrative: machine transitions, flow events, lifecycle, deduped errors
//   debug.log  — all dispatched actions (diagnostic, rotated aggressively)
//   errors.log — errors + warnings only (ops/alerting)
//
// app.log is "smart": it reads like an architectural narrative, not a firehose.
// Only state changes, flow completions, and errors surface here.
// High-frequency internal actions never appear.

/** Log severity levels */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

/** Logger configuration — passed to aio.run({ log: {...} }) */
export type LogConfig = {
  /** Minimum level written to debug.log (default: 'debug') */
  level?: LogLevel
  /** Log directory (default: './logs') */
  dir?: string
  /** Pretty console output in dev (default: auto-detected) */
  console?: boolean
  /** app.log heartbeat interval in seconds — 0 to disable (default: 3600 = 1h) */
  heartbeat?: number
  /** Action types to suppress entirely — even from debug.log */
  suppressTypes?: string[]
  /**
   * Log rotation on (re)start: existing logs renamed to debug.log.1, debug.log.2, etc.
   * `keep` controls how many archived logs are retained (default: 7, 0 = unlimited).
   */
  rotate?: { keep?: number }
}

type LogEntry = {
  ts: string
  lvl: LogLevel
  cat: string
  msg: string
  src?: string
  data?: Record<string, unknown>
  dur?: number
}

const LEVELS: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 }

// Pure framework internals — never logged anywhere
const SKIP_SUFFIXES = [':__FlowState', ':__exec', ':__flow']
const SKIP_CONTAINS = [':__set']

// Flow steps — debug.log only (not app.log)
const FLOW_STEP_RE = /:Flow:(?!Done|Failed|Error)/

// ── Public singleton ──────────────────────────────────────────────────

let _active: AioLogger | null = null

/** Wire the framework logger instance into the public singleton */
export function setLogger(l: AioLogger | null): void { _active = l }

/** Public log API — no-ops when logging is not configured in aio.run() */
export interface Log {
  trace(cat: string, msg: string, data?: Record<string, unknown>): void
  debug(cat: string, msg: string, data?: Record<string, unknown>): void
  info (cat: string, msg: string, data?: Record<string, unknown>): void
  warn (cat: string, msg: string, data?: Record<string, unknown>): void
  error(cat: string, msg: string, data?: Record<string, unknown>): void
}

export const log: Log = {
  trace(cat: string, msg: string, data?: Record<string, unknown>): void { _active?.pub('trace', cat, msg, data) },
  debug(cat: string, msg: string, data?: Record<string, unknown>): void { _active?.pub('debug', cat, msg, data) },
  info (cat: string, msg: string, data?: Record<string, unknown>): void { _active?.pub('info',  cat, msg, data) },
  warn (cat: string, msg: string, data?: Record<string, unknown>): void { _active?.pub('warn',  cat, msg, data) },
  error(cat: string, msg: string, data?: Record<string, unknown>): void { _active?.pub('error', cat, msg, data) },
}

export class AioLogger {
  private cfg: Required<LogConfig>
  private dir: string
  private appName: string

  // Smart app.log state
  private lastStatus = new Map<string, string>()
  private flowStarts  = new Map<string, number>()        // "feature:flowName" → startMs
  private errorKeys   = new Map<string, ErrorEntry>()

  // Aggregation counters (reset each heartbeat window)
  private stats = { dispatched: 0, errors: 0, start: Date.now() }
  private heartbeatTimer?: ReturnType<typeof setInterval>

  private ready = false

  constructor(config: LogConfig & { appName?: string }) {
    this.cfg = {
      level:     config.level     ?? 'debug',
      dir:       config.dir       ?? './logs',
      console:   config.console   ?? isDevMode(),
      heartbeat: config.heartbeat ?? 3600,
      suppressTypes: config.suppressTypes ?? [],
      rotate:    { keep: config.rotate?.keep ?? 7 },
    }
    this.dir      = this.cfg.dir
    this.appName  = config.appName ?? 'app'
  }

  async init(): Promise<void> {
    try {
      await Deno.mkdir(this.dir, { recursive: true })
      await this.rotateOnStart()
      this.ready = true
      if (this.cfg.heartbeat > 0) {
        this.heartbeatTimer = setInterval(() => this.heartbeat(), this.cfg.heartbeat * 1000)
      }
    } catch (e) {
      console.error(`[logger] cannot create ${this.dir}: ${e}`)
    }
  }

  private async rotateOnStart(): Promise<void> {
    const keep = this.cfg.rotate.keep ?? 7
    for (const kind of ['app', 'debug', 'errors'] as const) {
      const base = this.path(kind)
      try { await Deno.stat(base) } catch { continue }  // file absent — nothing to rotate

      // find next available suffix (.1, .2, ...)
      let n = 1
      while (true) {
        try { await Deno.stat(`${base}.${n}`); n++ } catch { break }
      }

      try { await Deno.rename(base, `${base}.${n}`) } catch { /* best-effort */ }

      // prune archives older than `keep` (0 = unlimited)
      if (keep > 0) {
        for (let i = n - keep; i >= 1; i--) {
          try { await Deno.remove(`${base}.${i}`) } catch { /* already gone */ }
        }
      }
    }
  }

  /** Called once after aio.run() completes boot */
  onStart(featureNames: string[], port?: number): void {
    for (const n of featureNames) this.lastStatus.set(n, '')
    this.app('info', 'app', 'started', {
      features: featureNames.join(', '),
      ...(port ? { port } : {}),
    })
  }

  /** Called during aio shutdown */
  onStop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    const uptime = fmtUptime(Date.now() - this.stats.start)
    this.app('info', 'app', 'stopped', { uptime, dispatched: this.stats.dispatched, errors: this.stats.errors })
  }

  // ── Main observer — wire into onAction hook ──────────────────────

  observe(action: { type: string; payload?: unknown }, state: Record<string, unknown>): void {
    const type    = action.type
    const payload = (action.payload ?? {}) as Record<string, unknown>

    this.stats.dispatched++

    // Skip pure internals entirely
    if (SKIP_SUFFIXES.some(s => type.endsWith(s))) return
    if (SKIP_CONTAINS.some(s => type.includes(s)))  return
    if (this.cfg.suppressTypes.includes(type))        return

    const prefix = type.split(':')[0]?.toLowerCase() ?? 'unknown'

    // ── Feature lifecycle ─────────────────────────────────────────
    if (type.endsWith(':Init')) {
      this.app('info', `feature:${prefix}`, 'ready')
      return
    }
    if (type.endsWith(':Destroy')) {
      this.app('info', `feature:${prefix}`, 'stopped')
      return
    }

    // ── Flow events ───────────────────────────────────────────────
    if (FLOW_STEP_RE.test(type)) {
      const flowName = payload._flow as string | undefined
      if (flowName) {
        const key = `${prefix}:${flowName}`
        if (!this.flowStarts.has(key)) this.flowStarts.set(key, Date.now())
      }
      this.dbg(`flow:${prefix}`, stripFlowPrefix(type), filterInternal(payload))
      return
    }

    if (type.endsWith(':Flow:Done')) {
      const flowName = payload._flow as string ?? '?'
      const key      = `${prefix}:${flowName}`
      const dur      = elapsed(this.flowStarts.get(key))
      this.flowStarts.delete(key)
      this.clearErrors(prefix)
      this.app('info', `flow:${prefix}`, `${flowName} done`, filterInternal(payload), dur)
      return
    }

    if (type.endsWith(':Flow:Failed')) {
      const flowName = payload._flow as string ?? '?'
      this.flowStarts.delete(`${prefix}:${flowName}`)
      this.stats.errors++
      this.app('warn', `flow:${prefix}`, `${flowName} failed`, { reason: payload.reason ?? 'unknown' })
      return
    }

    if (type.endsWith(':Flow:Error')) {
      this.stats.errors++
      this.dedup(`flow:${prefix}`, `${payload.flow ?? '?'} error`, { error: String(payload.error ?? '?') })
      return
    }

    // ── Async method error ────────────────────────────────────────
    if (type.endsWith(':__error')) {
      this.stats.errors++
      this.dedup(`feature:${prefix}`, `${payload._method ?? '?'} failed`, { error: String(payload.error ?? '?') })
      return
    }

    // ── Everything else → debug.log only, then check machine state ─
    if (LEVELS[this.cfg.level] <= LEVELS.debug) {
      this.dbg(`feature:${prefix}`, type.slice(prefix.length + 1), filterInternal(payload))
    }

    // Check machine state transitions (any action may cause a status change)
    this.checkTransitions(state)
  }

  // ── Public write API ──────────────────────────────────────────────

  pub(lvl: LogLevel, cat: string, msg: string, data?: Record<string, unknown>): void {
    const src = callerFile()
    if (lvl === 'trace' || lvl === 'debug') this.dbg(cat, msg, data ?? null, src)
    else this.app(lvl, cat, msg, data ?? null, undefined, src)
  }

  // ── Private ───────────────────────────────────────────────────────

  private checkTransitions(state: Record<string, unknown>): void {
    for (const [name, last] of this.lastStatus) {
      const newStatus = (state[name] as Record<string, unknown> | undefined)?._status as string | undefined
      if (newStatus !== undefined && newStatus !== last) {
        this.lastStatus.set(name, newStatus)
        if (newStatus) this.app('info', `feature:${name}`, newStatus)
      }
    }
  }

  private dedup(cat: string, msg: string, data?: Record<string, unknown>): void {
    const key      = `${cat}:${msg}`
    const existing = this.errorKeys.get(key)
    const now      = Date.now()

    if (!existing) {
      this.errorKeys.set(key, { count: 1, first: now, last: now, suppressed: false })
      this.app('error', cat, msg, data)
      this.err(cat, msg, data)
      return
    }

    existing.count++
    existing.last = now

    if (!existing.suppressed && existing.count >= 5) {
      existing.suppressed = true
      this.app('error', cat, `${msg} (×${existing.count}, suppressing repeats)`)
    }
    // Always write to errors.log regardless of dedup
    this.err(cat, msg, data)
  }

  private clearErrors(prefix: string): void {
    for (const [key, entry] of this.errorKeys) {
      if (!key.startsWith(`feature:${prefix}:`) && !key.startsWith(`flow:${prefix}:`)) continue
      if (entry.suppressed) {
        const dur = Math.round((entry.last - entry.first) / 1000)
        this.app('info', `feature:${prefix}`, 'recovered', { errors: entry.count, over: `${dur}s` })
      }
      this.errorKeys.delete(key)
    }
  }

  private heartbeat(): void {
    const uptime = fmtUptime(Date.now() - this.stats.start)
    this.app('info', 'app', 'heartbeat', {
      uptime, dispatched: this.stats.dispatched, errors: this.stats.errors,
    })
  }

  // ── Write helpers ─────────────────────────────────────────────────

  private app(lvl: LogLevel, cat: string, msg: string, data?: Record<string, unknown> | null, dur?: number, src?: string): void {
    const e: LogEntry = { ts: now(), lvl, cat, msg, ...(src ? { src } : {}), ...(data ? { data } : {}), ...(dur !== undefined ? { dur } : {}) }
    if (lvl === 'info' || lvl === 'error') this.write(this.path('app'), e)
    if (lvl === 'error')                   this.write(this.path('errors'), e)
    if (lvl === 'warn')                    this.write(this.path('debug'), e)
    if (this.cfg.console && (lvl === 'info' || lvl === 'error')) printConsole(e)
  }

  private dbg(cat: string, msg: string, data?: Record<string, unknown> | null, src?: string): void {
    if (LEVELS[this.cfg.level] > LEVELS.debug) return
    this.write(this.path('debug'), { ts: now(), lvl: 'debug', cat, msg, ...(src ? { src } : {}), ...(data ? { data } : {}) })
  }

  private err(cat: string, msg: string, data?: Record<string, unknown> | null): void {
    this.write(this.path('errors'), { ts: now(), lvl: 'error', cat, msg, ...(data ? { data } : {}) })
  }

  private path(kind: 'app' | 'debug' | 'errors'): string {
    if (kind === 'app')    return `${this.dir}/app.log`
    if (kind === 'debug')  return `${this.dir}/debug.log`
    return `${this.dir}/errors.log`
  }

  private write(path: string, entry: LogEntry): void {
    if (!this.ready) return
    Deno.writeTextFile(path, JSON.stringify(entry) + '\n', { append: true }).catch(() => {})
  }
}

// ── Types ─────────────────────────────────────────────────────────────

type ErrorEntry = { count: number; first: number; last: number; suppressed: boolean }

// ── Helpers ───────────────────────────────────────────────────────────

function callerFile(): string | undefined {
  const frames = new Error().stack?.split('\n') ?? []
  for (const f of frames) {
    if (f.includes('logger.ts')) continue
    const m = f.match(/[/\\]([\w.-]+\.ts):(\d+):\d+/)
    if (m) return `${m[1]}:${m[2]}`
  }
}

function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23)
}

function elapsed(start?: number): number | undefined {
  return start !== undefined ? Date.now() - start : undefined
}

function fmtUptime(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

function stripFlowPrefix(type: string): string {
  const m = type.match(/:Flow:(.+)$/)
  return m ? m[1] ?? type : type
}

function filterInternal(p: Record<string, unknown>): Record<string, unknown> | null {
  const out = Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('_')))
  return Object.keys(out).length ? out : null
}

function isDevMode(): boolean {
  return import.meta.url.startsWith('file:///')
}

// ── Console pretty-printer ─────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m',
  cyan: '\x1b[36m', gray: '\x1b[90m',
} as const

const LEVEL_COLOR: Record<LogLevel, string> = {
  trace: C.gray, debug: C.cyan, info: C.green, warn: C.yellow, error: C.red,
}

function printConsole(e: LogEntry): void {
  const color  = LEVEL_COLOR[e.lvl]
  const lvl    = `${color}${C.bold}${e.lvl.toUpperCase().padEnd(5)}${C.reset}`
  const cat    = e.cat.padEnd(24)
  const data   = e.data
    ? '  ' + Object.entries(e.data).map(([k, v]) => `${C.dim}${k}${C.reset}=${v}`).join(' ')
    : ''
  const dur    = e.dur !== undefined ? `  ${C.dim}${e.dur}ms${C.reset}` : ''
  console.log(`${C.dim}${e.ts}${C.reset}  ${lvl}  ${cat}  ${e.msg}${data}${dur}`)
}

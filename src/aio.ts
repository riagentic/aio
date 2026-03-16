// Core runtime — boots KV, server, electron, wires everything together
import { skv, type SkvInstance } from './skv.ts'
import { loadOrCreateCert, type TlsCert } from './tls.ts'
import { createServer, type ServerHandle } from './server.ts'
import { launchElectron, launchElectronClient, type AioMeta } from './electron.ts'
import { join, resolve } from '@std/path'
import { deepMerge } from './deep-merge.ts'
import { createDispatch, type AioError, type PerfMode, type PerfBudget } from './dispatch.ts'
import { createTT, record, undo, redo, travelTo, pause, resume, stateAt, toBroadcast, type TTState, type PerfMetric } from './time-travel.ts'
import { isScheduleEffect, createScheduleManager, type ScheduleEffect, type ScheduleDef } from './schedule.ts'
import { createDB, initSchema, loadTables, syncTables, type DB } from './db/mod.ts'
import { type TableDef } from './sql.ts'
import { AppLock, resolveAppId, type SingletonMode } from './single-instance-lock.ts'
import { composeFeatures, bindFeature, type FeatureEntry, type FeatureDef, type ComposedFeatures, type FeatureStatus } from './feature.ts'
import { AioLogger, setLogger, type LogConfig } from './logger.ts'

/** Framework version — printed by --version, checked in tests */
export const VERSION = '0.9.1'

/** Validates that framework version matches deno.json version at build time */
function validateVersion(): void {
  try {
    // This check runs at build time for compile targets
    // At runtime in dev mode, deno.json may not be accessible
    const denoJson = new URL('../../deno.json', import.meta.url)
    const content = Deno.readTextFileSync(denoJson)
    const parsed = JSON.parse(content) as { version?: string }
    if (parsed.version && parsed.version !== VERSION) {
      console.warn(`[aio] version mismatch: aio.ts=${VERSION}, deno.json=${parsed.version}`)
    }
  } catch { /* deno.json not accessible at runtime — skip */ }
}

// Run validation on first import
validateVersion()

/** User identity — resolved from static token map */
export type AioUser = { id: string; role: string }
export type { AioError, PerfMode, PerfBudget } from './dispatch.ts'


// Electron + browser window options
export type UiConfig = {
  electron?: boolean   // default: true — opens electron window
  keepAlive?: boolean  // default: false — keep server running after electron closes
  title?: string       // default: 'AIO App'
  width?: number       // default: 800
  height?: number      // default: 600
  showStatus?: boolean // default: true — show reconnection indicator
  transport?: 'uds' | 'ws' | 'auto'  // default: 'auto' — UDS on linux/mac+electron, WS otherwise
  syncRate?: number                   // throttle UI updates: max 1 push per N ms — default: 10 (100fps), 0 = microtask-only coalescing
}

// Everything aio.run() needs to wire your app
export type AioConfig<S, A, E> = {
  reduce: (state: S, action: A) => { state: S; effects: (E | ScheduleEffect)[] }
  execute: (app: AioApp<S, A>, effect: E) => void
  persist?: boolean              // default: true — auto-opens Deno.Kv
  stateForDB?: (state: S) => Partial<S>   // filter what gets persisted (default: full state)
  stateForUI?: (state: S, user?: AioUser) => unknown   // filter what gets sent to UI (default: full state)
  deltaThreshold?: number          // 0-1: ratio of changed keys that triggers full state broadcast (default: 0.5)
  maxConnections?: number          // max concurrent WebSocket clients (default: 100)
  beforeReduce?: (action: A, state: S, user?: AioUser) => A | null  // intercept actions before reduce — return null to drop
  persistKey?: string            // KV key prefix (default: "state")
  persistDebounce?: number       // ms between KV writes (default: 100)
  persistMode?: 'single' | 'multi'  // 'single' (default): one blob ≤65KB. 'multi': one KV key per top-level state key — no 65KB limit
  users?: Record<string, AioUser>  // static token map — token is key, user is value
  ui?: UiConfig
  port?: number                  // default: 8000
  baseDir?: string               // default: ./src
  headless?: boolean             // default: false — skip browser/electron, server-only (for CLI apps)
  schedules?: ScheduleDef[]      // static scheduled effects — started on boot
  db?: Record<string, TableDef>  // SQLite table definitions — arrays auto-sync
  perfMode?: PerfMode           // 'strict' (default) or 'soft' — how to report performance violations
  perfBudget?: PerfBudget       // override default budgets (reduce: 100, effect: 5)
  effectTimeout?: number        // ms before logging a warning for slow async effects — warning only, does not cancel (default: 30000 = 30s)
  freezeState?: boolean         // default: false in prod, true in dev — deep freeze state after reduce to catch mutations
  onRestore?:    (state: S) => S       // transform state after restore, before server starts
  appId?: string                 // explicit unique app identity (default: resolved from deno.json name > title > 'aio-app')
  singleton?: SingletonMode      // true (default)=refuse if running, 'takeover'=kill+replace, false=allow multi
  // Lifecycle hooks — observe-only, all optional, error-guarded
  onAction?:     (action: A, state: S, user?: AioUser) => void
  onEffect?:     (effect: E, user?: AioUser) => void
  onConnect?:    (user?: AioUser) => void
  onDisconnect?: (user?: AioUser) => void
  onStart?:      (app: AioApp<S, A>) => void
  onStop?:       () => void
  onError?:      (error: AioError) => void
  /** Internal: schedule cancel callback set by _run, used by features disable */
  _onScheduleReady?: (cancelByPrefix: (prefix: string) => void) => void
}

// Handle returned by aio.run() — dispatch actions, read state, or shut down
export type AioApp<S = unknown, A = unknown> = {
  dispatch: (action: A) => void
  getState: () => S
  snapshot?: () => string          // server-only (undefined in standalone)
  loadSnapshot?: (json: string) => void  // server-only (undefined in standalone)
  db?: DB        // async SQLite — query/execute/transaction (undefined in standalone)
  close: () => Promise<void>
  mode?: string  // 'standalone' in Android WebView builds — branch effects accordingly
  port?: number  // server port — available after aio.run(), useful for connectCli()
  /** v0.5 feature control API — only available when using features-based config */
  features?: {
    enable: (name: string) => void
    disable: (name: string) => void
    status: (name: string) => string | undefined
    health: () => FeatureStatus[]
    list: () => string[]
  }
}

/** Composes multiple beforeReduce functions into one. */
export function composeMiddleware<S, A>(
  ...fns: NonNullable<AioConfig<S, A, unknown>['beforeReduce']>[]
): (action: A, state: S, user?: AioUser) => A | null {
  return (action: A, state: S, user?: AioUser): A | null => {
    let result: A | null = action
    for (const fn of fns) {
      if (result === null) return null
      result = fn(result, state, user)
    }
    return result
  }
}

// ── Middleware factories ─────────────────────────────────────────────

type MiddlewareFn = (action: unknown, state: unknown, user?: AioUser) => unknown | null

/** Built-in middleware factories for aio.run({ middleware: [...] }) */
const middleware = {
  /** Log all dispatched actions (or filter by feature name) */
  logger: (opts?: { features?: string[] }): MiddlewareFn => {
    const filter = opts?.features ? new Set(opts.features.map(f => f.toLowerCase())) : null
    return (action, _state) => {
      const type = (action as { type: string }).type
      if (filter) {
        const prefix = type.split(':')[0]?.toLowerCase() ?? ''
        if (!filter.has(prefix)) return action
      }
      const source = (action as { _source?: string })._source
      const tag = source ? ` [${source}]` : ''
      console.log(`[action]${tag} ${type}`)
      return action
    }
  },

  /** Redux DevTools integration — connects state to browser devtools extension */
  devtools: (): MiddlewareFn => {
    return (action, _state) => action // actual connection handled by connectDevTools() in browser
  },

  /** Performance budget — warn/error if reduce takes too long */
  perfBudget: (opts: { reduce?: number; effect?: number }): MiddlewareFn => {
    return (action, _state) => {
      // Perf budgets are already handled by createDispatch — this middleware
      // allows overriding via the middleware array as well
      const type = (action as { type: string }).type
      const start = performance.now()
      // Store start time for post-reduce check (side-channel via global)
      ;(globalThis as Record<string, unknown>).__aioMiddlewarePerfStart = start
      ;(globalThis as Record<string, unknown>).__aioMiddlewarePerfBudget = opts
      void type // used for logging in perf violations
      return action
    }
  },

  /** Validate action shapes — ensure type is string, payload is plain object */
  validate: (): MiddlewareFn => {
    return (action, _state) => {
      const a = action as Record<string, unknown>
      if (typeof a.type !== 'string') {
        console.error(`[middleware:validate] action.type must be a string, got ${typeof a.type}`)
        return null
      }
      if (a.payload !== undefined && (typeof a.payload !== 'object' || a.payload === null || Array.isArray(a.payload))) {
        console.warn(`[middleware:validate] action.payload should be a plain object: ${a.type}`)
      }
      return action
    }
  },

  /** Track action counts, timing, error rates per feature */
  metrics: (): MiddlewareFn => {
    const counters = new Map<string, { count: number; errors: number }>()
    ;(globalThis as Record<string, unknown>).__aioMetrics = counters
    return (action, _state) => {
      const type = (action as { type: string }).type
      const prefix = type.split(':')[0] ?? 'unknown'
      const entry = counters.get(prefix) ?? { count: 0, errors: 0 }
      entry.count += 1
      counters.set(prefix, entry)
      return action
    }
  },

  /** Deep freeze state after reduce (catches accidental mutations in dev) */
  freeze: (): MiddlewareFn => {
    // Actual freezing handled by dispatch.ts freezeState option
    return (action, _state) => action
  },

  /** Create custom middleware — return modified action, or null to drop.
   *  `pass` is identity — call it to signal the action should continue unmodified.
   *  The return value determines what happens: return action to continue, null to drop. */
  create: (fn: (action: unknown, state: unknown, pass: (action: unknown) => unknown, user?: AioUser) => unknown): MiddlewareFn => {
    return (action, state, user) => fn(action, state, (a) => a, user)
  },
}

// ── Logger ──────────────────────────────────────────────────────────

/** Formats current time as HH:MM:SS for log prefix */
function ts(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`
}

const log = {
  info:  (msg: string) => console.log(`[${ts()}][INFO] ${msg}`),
  warn:  (msg: string) => console.warn(`[${ts()}][WARNING] ${msg}`),
  error: (msg: string) => console.error(`[${ts()}][ERROR] ${msg}`),
  debug: (_: string) => {},
}

// ── Startup linter — validates config and src/ before running ───────

export type Lint = { ok: string[]; warn: string[]; hint: string[]; fail: string[] }

/** Checks state, config, App.tsx existence, and common mistakes */
export async function lint(state: unknown, config: { reduce?: unknown; execute?: unknown }, baseDir: string, prod = false, headless = false, useElectron = true): Promise<Lint> {
  const r: Lint = { ok: [], warn: [], hint: [], fail: [] }

  if (state == null) r.fail.push('initial state is null/undefined')
  else if (typeof state !== 'object') r.fail.push(`initial state must be an object, got ${typeof state}`)
  else {
    const keys = Object.keys(state as Record<string, unknown>)
    r.ok.push(`state (${keys.length} keys)`)
    const reserved = keys.filter(k => k === '$p' || k === '$d')
    if (reserved.length) r.warn.push(`state has reserved key(s): ${reserved.join(', ')} — rename them (e.g. $p → _patch, $d → _delete). These are used internally for delta patches and will cause data corruption.`)
    // Check JSON-serializability — Date, Map, Set, functions etc. break persistence/broadcast
    try {
      const json = JSON.stringify(state)
      const after = JSON.stringify(JSON.parse(json))
      if (json !== after) r.warn.push('state loses data on JSON round-trip — use primitives + plain objects/arrays only (no Date, Map, Set, functions, BigInt)')
    } catch (e) {
      r.warn.push(`state is not JSON-serializable: ${e}`)
    }
  }

  if (typeof config.reduce !== 'function') r.fail.push('config.reduce must be a function: (state, action) => { state, effects }')
  else r.ok.push('reduce')

  if (typeof config.execute !== 'function') r.fail.push('config.execute must be a function: (app, effect) => void')
  else r.ok.push('execute')

  // Prod mode or headless: App.tsx not needed
  if (headless) {
    r.ok.push('headless (no App.tsx)')
  } else if (prod) {
    r.ok.push('prod')
  } else {
    const appFile = join(baseDir, 'App.tsx')
    try {
      const src = await Deno.readTextFile(appFile)
      if (!src.includes('export default')) {
        r.warn.push('App.tsx has no `export default` — add it so the framework can mount your component')
      } else {
        r.ok.push('App.tsx')
      }
      if (src.includes('createRoot')) {
        r.hint.push('App.tsx has createRoot — remove it, the framework handles mounting')
      }
      if (/import\s+React[\s,{]/.test(src)) {
        r.hint.push('App.tsx has `import React` — not needed, JSX transforms are automatic')
      }
    } catch {
      r.fail.push(`App.tsx not found at ${appFile}`)
      r.hint.push('  create it: export default function App() { return <div>Hello</div> }')
    }
  }

  // Specifiers available in the browser import map — everything else silently fails
  // Keep in sync with IMPORT_MAP in server.ts
  const BROWSER_IMPORTS = new Set(['react', 'react-dom/client', 'react/jsx-runtime', 'aio'])

  try {
    for await (const entry of Deno.readDir(baseDir)) {
      if (!entry.isFile) continue
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
      const content = await Deno.readTextFile(join(baseDir, entry.name))
      if (content.includes("from '../dep/aio/") || content.includes("from \"../dep/aio/")) {
        r.hint.push(`${entry.name}: import from 'aio' instead of '../dep/aio/...'`)
      }
      // Check execute.ts for swapped params — first param named 'effect' suggests old (effect, app) order
      if (entry.name === 'execute.ts') {
        const match = content.match(/function\s+execute\s*\(\s*(\w+)/)
        if (match && /^effect$/i.test(match[1] ?? '')) {
          r.hint.push(`execute.ts: first param is "${match[1]}" — signature is execute(app, effect), matching reduce(state, action)`)
        }
        // Check for sync I/O anti-patterns
        if (content.includes('Deno.readTextFileSync') || content.includes('Deno.readDirSync') || content.includes('Deno.statSync')) {
          r.warn.push('execute.ts: sync I/O (readTextFileSync, readDirSync, statSync) blocks the dispatch loop — use async versions (readTextFile, readDir, stat) instead')
        }
        if (content.includes('Deno.writeTextFileSync')) {
          r.warn.push('execute.ts: sync file write (writeTextFileSync) blocks — use async writeTextFile instead')
        }
      }
      // Check reduce.ts for heavy patterns
      if (entry.name === 'reduce.ts') {
        if (/for\s*\([^)]+\)\s*\{[^}]{500}/.test(content)) {
          r.hint.push('reduce.ts: large loop detected — consider moving heavy computation to an effect')
        }
      }
      // Check .tsx files for imports that won't resolve in the browser
      // Dev mode transpiles but doesn't bundle — only import-mapped specifiers work
      if (!prod && entry.name.endsWith('.tsx')) {
        // Bare side-effect imports: import 'foo'
        for (const m of content.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
          const spec = m[1]
          if (!spec || spec.startsWith('.') || spec.startsWith('/') || BROWSER_IMPORTS.has(spec)) continue
          r.warn.push(`${entry.name}: import "${spec}" won't work in browser — dev mode transpiles but doesn't bundle. Move this import to a server-side .ts file, or use the npm package via an effect.`)
        }
        // Named/default imports and re-exports: import { x } from 'foo', export { x } from 'foo'
        for (const m of content.matchAll(/(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]/g)) {
          const spec = m[1]
          if (!spec || spec.startsWith('.') || spec.startsWith('/') || BROWSER_IMPORTS.has(spec)) continue
          // import type is erased by TS — never reaches the browser
          if (m[0].startsWith('import type ') || m[0].startsWith('import type{')) continue
          r.warn.push(`${entry.name}: import "${spec}" won't work in browser — dev mode transpiles but doesn't bundle. Move this import to a server-side .ts file, or use the npm package via an effect.`)
        }
      }
    }
  } catch { /* baseDir doesn't exist — already caught above */ }

  // Check esbuild — needed for dev mode TSX transpilation
  if (!prod) {
    const esbuildDir = join(Deno.cwd(), 'node_modules', 'esbuild')
    const esbuildBin = join(Deno.cwd(), 'node_modules', '.bin', 'esbuild')
    let esbuildFound = false
    try { await Deno.stat(esbuildDir); esbuildFound = true } catch { /* try bin */ }
    if (!esbuildFound) try { await Deno.stat(esbuildBin); esbuildFound = true } catch { /* not found */ }
    if (!esbuildFound) r.warn.push('esbuild not installed — dev mode needs it for TSX transpilation')
  }

  // Check electron install scripts — only relevant when actually running in Electron mode
  if (!prod && useElectron) {
    try {
      const electronDir = join(Deno.cwd(), 'node_modules', 'electron', 'dist')
      await Deno.stat(electronDir)
    } catch {
      try {
        // electron package exists but dist/ missing → scripts not approved
        await Deno.stat(join(Deno.cwd(), 'node_modules', 'electron'))
        r.hint.push('electron installed but dist/ missing — run `deno task install:electron`')
      } catch { /* electron not installed at all — handled by electron.ts */ }
    }
  }

  return r
}

/** Formats lint results — compact when clean, detailed when issues found */
function printLint(r: Lint): void {
  const hasIssues = r.warn.length + r.hint.length + r.fail.length > 0
  if (!hasIssues) {
    log.info(`✓ ${r.ok.join(' · ')}`)
    return
  }
  log.info('── checks ──')
  if (r.ok.length) log.info(`  ✓ ${r.ok.join(' · ')}`)
  for (const w of r.warn) log.warn(w)
  for (const h of r.hint) log.info(`  · ${h}`)
  for (const e of r.fail) log.error(e)
  if (r.fail.length) {
    throw new Error(`${r.fail.length} error(s) — fix and restart`)
  }
}

// ── CLI ─────────────────────────────────────────────────────────────

/** CLI flags — overrides config values. Accepts args for testing. */
export type CliFlags = { port?: number; persist?: boolean; electron?: boolean; keepAlive?: boolean; title?: string; verbose: boolean; prod?: boolean; version?: boolean; expose?: boolean; help?: boolean; url?: string; width?: number; height?: number; headless?: boolean; cert?: string; key?: string; isolate?: string[]; transport?: 'uds' | 'ws' }

/** Parses CLI flags from Deno.args (or custom array for testing) */
export function parseCli(args: readonly string[] = Deno.args): CliFlags {
  const r: CliFlags = { verbose: false }
  const known = ['--port=', '--no-persist', '--no-electron', '--keep-alive', '--title=', '--verbose', '--prod', '--version', '--expose', '--help', '--url', '--width=', '--height=', '--headless', '--cert=', '--key=', '--isolate=', '--transport=']
  for (const arg of args) {
    if (arg.startsWith('--port=')) {
      const n = Number(arg.slice(7))
      if (Number.isInteger(n) && n > 0 && n < 65536) r.port = n
      else log.warn(`invalid --port value: ${arg.slice(7)} (must be 1-65535)`)
    }
    else if (arg === '--no-persist') r.persist = false
    else if (arg === '--no-electron') r.electron = false
    else if (arg === '--keep-alive') r.keepAlive = true
    else if (arg.startsWith('--title=')) r.title = arg.slice(8)
    else if (arg === '--verbose') r.verbose = true
    else if (arg === '--prod') r.prod = true
    else if (arg === '--version') r.version = true
    else if (arg === '--expose') r.expose = true
    else if (arg === '--help') r.help = true
    else if (arg === '--url') r.url = ''
    else if (arg.startsWith('--url=')) r.url = arg.slice(6)
    else if (arg === '--headless') r.headless = true
    else if (arg.startsWith('--cert=')) r.cert = arg.slice(7)
    else if (arg.startsWith('--key=')) r.key = arg.slice(6)
    else if (arg.startsWith('--width=')) {
      const n = Number(arg.slice(8))
      if (Number.isInteger(n) && n > 0) r.width = n
    }
    else if (arg.startsWith('--height=')) {
      const n = Number(arg.slice(9))
      if (Number.isInteger(n) && n > 0) r.height = n
    }
    else if (arg.startsWith('--isolate=')) {
      r.isolate = arg.slice(10).split(',').map(s => s.trim()).filter(Boolean)
    }
    else if (arg.startsWith('--transport=')) {
      const v = arg.slice(12)
      if (v === 'uds' || v === 'ws') r.transport = v
      else log.warn(`invalid --transport value: ${v} (must be 'uds' or 'ws')`)
    }
    else if (arg.startsWith('--') && !known.some(k => k.endsWith('=') ? arg.startsWith(k) : arg === k)) {
      log.warn(`unknown flag ignored: ${arg} — run with --help for usage`)
    }
  }
  return r
}

/** Prints CLI usage and exits */
function printHelp(): void {
  console.log(`aio ${VERSION} — all-in-one framework

Usage: deno run -A src/app.ts [flags]

Flags:
  --port=N         Server port (default: 8000)
  --no-persist     Disable Deno.Kv persistence
  --no-electron    Skip Electron, open browser
  --keep-alive     Server survives Electron close
  --title=X        Override window/page title
  --verbose        Verbose logging (actions, state, effects, WS, HTTP)
  --prod           Serve pre-built dist/app.js
  --expose         Bind 0.0.0.0 + HTTPS + generate auth token for LAN access
  --cert=PATH      TLS certificate file (PEM) — used with --expose (auto-generated if omitted)
  --key=PATH       TLS private key file (PEM) — used with --expose (auto-generated if omitted)
  --headless       Server-only — no browser or Electron (for CLI apps)
  --url[=URL]      Connect to remote aio server (Electron thin client)
  --width=N        Initial window width (default: 800)
  --height=N       Initial window height (default: 600)
  --transport=X    Transport: 'uds' or 'ws' (default: auto — UDS for electron on linux/mac)
  --isolate=a,b    Only activate specified features (v0.5)
  --version        Print version and exit
  --help           Show this help`)
}

// ── KV path resolution ──────────────────────────────────────────────

// When inside an AppImage (or any compiled binary without a writable origin),
// Deno.openKv() default path lives in the read-only squashfs mount → fails.
// Use an explicit path in XDG_DATA_HOME / ~/.local/share/<app>/data.kv instead.
/** True when running inside a compiled binary (AppImage, deno compile) */
function isCompiled(): boolean {
  return !!Deno.env.get('APPIMAGE') || !import.meta.url.startsWith('file:///')
}

/** Resolves persistent data dir — ~/.local/share/<appId>/ */
function resolveDataDir(appId: string): string {
  const dataHome = Deno.env.get('XDG_DATA_HOME') ?? join(homedir(), '.local', 'share')
  const dir = join(dataHome, appId)
  Deno.mkdirSync(dir, { recursive: true })
  return dir
}

/** Resolves KV path — compiled: ~/.local/share/<appId>/data.kv, dev: Deno default */
function resolveKvPath(appId: string): string | undefined {
  if (!isCompiled()) return undefined  // dev mode — let Deno pick
  return join(resolveDataDir(appId), 'data.kv')
}

/** Resolves SQLite path — compiled: ~/.local/share/<appId>/data.db, dev: ./data.db */
function resolveDbPath(appId: string): string {
  if (!isCompiled()) return join(Deno.cwd(), 'data.db')
  return join(resolveDataDir(appId), 'data.db')
}

/** Returns user home directory — $HOME, $USERPROFILE, or /tmp fallback */
function homedir(): string {
  return Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE') ?? '/tmp'
}

// ── UDS (Unix Domain Socket) ────────────────────────────────────────

/** Resolves transport: UDS on linux/mac with electron, WS otherwise */
function resolveTransport(transport: 'uds' | 'ws' | 'auto' | undefined, useElectron: boolean, expose: boolean): 'uds' | 'ws' {
  if (transport === 'ws') return 'ws'
  if (transport === 'uds') return 'uds'
  // auto: UDS for electron on linux/mac (not Windows, not --expose)
  if (useElectron && !expose && (Deno.build.os === 'linux' || Deno.build.os === 'darwin')) return 'uds'
  return 'ws'
}

/** Resolves UDS socket path — $XDG_RUNTIME_DIR/aio-{appId}.sock or /tmp/aio-{appId}.sock */
function resolveSocketPath(appId: string): string {
  const runtimeDir = Deno.env.get('XDG_RUNTIME_DIR')
  const dir = runtimeDir ?? '/tmp'
  const sockPath = join(dir, `aio-${appId}.sock`)
  // Linux UDS path limit is 108 chars
  if (sockPath.length > 100) {
    log.warn(`UDS path is ${sockPath.length} chars (limit ~108) — using /tmp fallback`)
    return join('/tmp', `aio-${appId}.sock`)
  }
  return sockPath
}

type UDSHandle = {
  broadcast: (msg: string) => void
  shutdown: () => void
  socketPath: string
}

/** Creates a raw NDJSON listener on a Unix domain socket for Electron IPC bridge.
 *  Same messages as WS (state JSON, __reload, __css, __tt:, __boot:), just newline-delimited. */
function createUDSListener(
  socketPath: string,
  getUIState: () => unknown,
  onAction: (action: { type: string; payload?: unknown }) => void,
  debug: (msg: string) => void,
): UDSHandle {
  // Clean up stale socket
  try { Deno.removeSync(socketPath) } catch { /* doesn't exist */ }

  const listener = Deno.listen({ transport: 'unix', path: socketPath })
  const connections = new Set<Deno.Conn>()

  // Accept connections
  ;(async () => {
    for await (const conn of listener) {
      connections.add(conn)
      debug(`uds: client connected (${connections.size} total)`)

      // Send initial state
      const initial = JSON.stringify(getUIState()) + '\n'
      const writer = conn.writable.getWriter()
      writer.write(new TextEncoder().encode(initial)).catch(() => {})
      writer.releaseLock()

      // Read incoming messages (actions from Electron)
      handleUDSConn(conn, connections, onAction, debug)
    }
  })().catch(() => { /* listener closed */ })

  return {
    socketPath,
    broadcast: (msg: string) => {
      const data = new TextEncoder().encode(msg + '\n')
      for (const conn of connections) {
        try {
          const writer = conn.writable.getWriter()
          writer.write(data).catch(() => connections.delete(conn))
          writer.releaseLock()
        } catch { connections.delete(conn) }
      }
    },
    shutdown: () => {
      listener.close()
      for (const conn of connections) {
        try { conn.close() } catch { /* already closed */ }
      }
      connections.clear()
      try { Deno.removeSync(socketPath) } catch { /* already removed */ }
    },
  }
}

/** Handle incoming NDJSON from a UDS client (Electron → Deno) */
function handleUDSConn(
  conn: Deno.Conn,
  connections: Set<Deno.Conn>,
  onAction: (action: { type: string; payload?: unknown }) => void,
  debug: (msg: string) => void,
): void {
  const decoder = new TextDecoder()
  let buf = ''
  ;(async () => {
    const reader = conn.readable.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()!
        for (const line of lines) {
          if (!line) continue
          try {
            const action = JSON.parse(line)
            if (action && typeof action.type === 'string') {
              onAction(action)
            }
          } catch { debug('uds: malformed message') }
        }
      }
    } catch { /* connection closed */ }
    connections.delete(conn)
    debug(`uds: client disconnected (${connections.size} total)`)
  })()
}

// ── Runtime ─────────────────────────────────────────────────────────

let _running = false
const _dispatchUser: AioUser | undefined = undefined
let _electronProc: Deno.ChildProcess | null = null

/** v0.5 features-based config — pass to aio.run() instead of (initialState, config) */
export type FeaturesConfig = {
  features: FeatureEntry[]
  port?: number
  persist?: boolean
  persistKey?: string
  persistDebounce?: number
  persistMode?: 'single' | 'multi'
  ui?: UiConfig
  baseDir?: string
  headless?: boolean
  users?: Record<string, AioUser>
  db?: Record<string, TableDef>
  perfMode?: PerfMode
  perfBudget?: PerfBudget
  effectTimeout?: number
  freezeState?: boolean
  appId?: string
  singleton?: SingletonMode
  deltaThreshold?: number
  maxConnections?: number
  schedules?: ScheduleDef[]
  /** v0.5 middleware array — applied in order as beforeReduce chain */
  middleware?: MiddlewareFn[]
  /** State version — used with migrations for persisted state upgrades */
  version?: number
  /** Migration functions — run sequentially from stored version to current */
  migrations?: ((state: Record<string, unknown>) => Record<string, unknown>)[]
  /** Isolate features — only these features are active (dev mode convenience) */
  isolate?: string[]
  beforeReduce?: (action: unknown, state: unknown, user?: AioUser) => unknown | null
  onAction?: (action: unknown, state: unknown, user?: AioUser) => void
  onEffect?: (effect: unknown, user?: AioUser) => void
  onConnect?: (user?: AioUser) => void
  onDisconnect?: (user?: AioUser) => void
  onStart?: (app: AioApp) => void
  onStop?: () => void
  onError?: (error: AioError) => void
  onRestore?: (state: unknown) => unknown
  stateForUI?: (state: unknown, user?: AioUser) => unknown
  stateForDB?: (state: unknown) => unknown
  /** Structured logging — app.log (narrative), debug.log (all), errors.log (warn/error).
   *  `true` enables with all defaults. Omit to disable. */
  logging?: boolean | LogConfig
}

/** Single entry point — boots KV, server, electron, wires everything. CLI args override config. */
async function run<S, A, E>(initialState: S, config: AioConfig<S, A, E>): Promise<AioApp<S, A>>
async function run(fc: FeaturesConfig): Promise<AioApp<any, any>>
// deno-lint-ignore no-explicit-any
async function run(a: any, b?: any): Promise<AioApp<any, any>> {
  // Legacy API: aio.run(initialState, config) — kept for backward compat
  if (b !== undefined) {
    if (_running) throw new Error('aio.run() already called — one instance per process')
    _running = true
    try { return await _run(a, b) }
    catch (e) { _running = false; throw e }
  }
  const fc = a as FeaturesConfig
  if (_running) throw new Error('aio.run() already called — one instance per process')
  _running = true

  {

    // --isolate: filter features to only the specified ones
    let featureEntries = fc.features
    const cliIsolate = parseCli().isolate
    const isolate = fc.isolate ?? cliIsolate
    if (isolate && isolate.length) {
      const isolateSet = new Set(isolate)
      featureEntries = featureEntries.filter(entry => {
        const f = '_config' in entry ? entry as FeatureDef : (entry as { feature: FeatureDef }).feature
        return isolateSet.has(f.name)
      })
      if (featureEntries.length === 0) {
        log.warn(`isolate: no features matched [${[...isolateSet].join(', ')}] — check spelling`)
      } else {
        log.info(`isolate: ${featureEntries.map(e => ('_config' in e ? e as FeatureDef : (e as { feature: FeatureDef }).feature).name).join(', ')}`)
      }
    }

    const composed = composeFeatures(featureEntries)

    // Build auto-stateForDB from per-feature persist excludes (if user didn't supply one)
    let autoGetDBState = fc.stateForDB
    if (!fc.stateForDB) {
      const featureExcludes = new Map<string, string[]>()
      for (const f of composed.features) {
        if (f._config.persistExclude?.length) featureExcludes.set(f.name, f._config.persistExclude)
      }
      if (featureExcludes.size > 0) {
        autoGetDBState = (s: unknown) => {
          const result = { ...(s as Record<string, unknown>) }
          for (const [featureName, excludeKeys] of featureExcludes) {
            if (result[featureName] && typeof result[featureName] === 'object') {
              const filtered = { ...(result[featureName] as Record<string, unknown>) }
              for (const key of excludeKeys) delete filtered[key]
              result[featureName] = filtered
            }
          }
          return result
        }
      }
    }

    // Log feature composition
    log.info(`features: ${composed.featureNames.join(', ')}`)
    // Log foreign action listeners
    for (const f of composed.features) {
      if (f._config.foreignActions.length) {
        for (const fa of f._config.foreignActions) {
          log.info(`${f.name}: listens to ${fa}`)
        }
      }
    }

    // Create structured logger if configured
    const appId = fc.appId ?? 'app'
    const logCfg = fc.logging === true ? {} : fc.logging
    const logger = logCfg ? new AioLogger({ ...logCfg, appName: appId }) : null
    if (logger) await logger.init()
    setLogger(logger)

    // Store composed for useFeature (used by getUIState to expose feature names)
    ;(globalThis as Record<string, unknown>).__aioFeatures = composed

    // Build beforeReduce from middleware array + explicit beforeReduce
    let beforeReduce = fc.beforeReduce as ((action: unknown, state: unknown) => unknown | null) | undefined
    if (fc.middleware?.length) {
      const mws = fc.middleware
      const chainedMw = (action: unknown, state: unknown, user?: AioUser): unknown | null => {
        let result: unknown | null = action
        for (const mw of mws) {
          if (result === null) return null
          result = mw(result, state, user)
        }
        return result
      }
      if (beforeReduce) {
        const prev = beforeReduce
        beforeReduce = (action, state, user?: AioUser) => {
          const r = chainedMw(action, state, user)
          if (r === null) return null
          return prev(r, state)
        }
      } else {
        beforeReduce = chainedMw
      }
    }

    // State versioning + migrations: wrap onRestore to run migrations
    let onRestore = fc.onRestore as ((state: unknown) => unknown) | undefined
    if (fc.version != null && fc.migrations?.length) {
      const targetVersion = fc.version
      const migrations = fc.migrations
      if (migrations.length < targetVersion) {
        log.warn(`version is ${targetVersion} but only ${migrations.length} migration(s) provided — missing ${targetVersion - migrations.length}`)
      }
      const prevOnRestore = onRestore
      onRestore = (state: unknown) => {
        let s = state as Record<string, unknown>
        const storedVersion = (s.__aioVersion as number) ?? 0
        if (storedVersion < targetVersion) {
          const maxMigration = Math.min(targetVersion, migrations.length)
          for (let v = storedVersion; v < maxMigration; v++) {
            try {
              s = migrations[v]!(s)
              log.info(`migration: v${v} → v${v + 1}`)
            } catch (e) {
              log.error(`migration v${v} → v${v + 1} failed: ${e} — falling back to initialState`)
              return composed.initialState
            }
          }
        }
        s.__aioVersion = targetVersion
        if (prevOnRestore) return prevOnRestore(s)
        return s
      }
    } else if (fc.version != null) {
      // Store version in state even without migrations
      const prevOnRestore = onRestore
      onRestore = (state: unknown) => {
        const s = { ...(state as Record<string, unknown>), __aioVersion: fc.version }
        if (prevOnRestore) return prevOnRestore(s)
        return s
      }
    }

    // Mutable ref — set after _run() so closures in config can access the app
    let appRef: AioApp<Record<string, unknown>, unknown> | null = null

    // Convert to legacy config
    const config: AioConfig<Record<string, unknown>, unknown, unknown> = {
      reduce: composed.reduce as AioConfig<Record<string, unknown>, unknown, unknown>['reduce'],
      execute: ((app: AioApp<Record<string, unknown>, unknown>, effect: unknown) => {
        composed.execute(
          { dispatch: (a) => app.dispatch(a), getState: () => app.getState() },
          effect as { type: string; payload: unknown },
        )
      }) as AioConfig<Record<string, unknown>, unknown, unknown>['execute'],
      persist: fc.persist,
      persistKey: fc.persistKey,
      persistDebounce: fc.persistDebounce,
      persistMode: fc.persistMode,
      port: fc.port,
      baseDir: fc.baseDir,
      headless: fc.headless,
      users: fc.users,
      db: fc.db,
      perfMode: fc.perfMode,
      perfBudget: fc.perfBudget,
      effectTimeout: fc.effectTimeout,
      freezeState: fc.freezeState,
      appId: fc.appId,
      singleton: fc.singleton,
      deltaThreshold: fc.deltaThreshold,
      maxConnections: fc.maxConnections,
      schedules: fc.schedules,
      ui: fc.ui,
      beforeReduce: beforeReduce as AioConfig<Record<string, unknown>, unknown, unknown>['beforeReduce'],
      onAction: logger
        ? ((action, state, user) => {
            logger.observe(action as { type: string; payload?: unknown }, state as Record<string, unknown>)
            if (fc.onAction) fc.onAction(action, state, user)
          }) as AioConfig<Record<string, unknown>, unknown, unknown>['onAction']
        : fc.onAction as AioConfig<Record<string, unknown>, unknown, unknown>['onAction'],
      onEffect: fc.onEffect as AioConfig<Record<string, unknown>, unknown, unknown>['onEffect'],
      onConnect: fc.onConnect,
      onDisconnect: fc.onDisconnect,
      onStart: ((app: AioApp<Record<string, unknown>, unknown>) => {
        // Run lifecycle init for all features
        composed.initAll({ dispatch: (a) => app.dispatch(a), getState: () => app.getState() })
        logger?.onStart(composed.featureNames, app.port)
        if (fc.onStart) fc.onStart(app)
      }) as AioConfig<Record<string, unknown>, unknown, unknown>['onStart'],
      onStop: () => {
        logger?.onStop()
        setLogger(null)
        if (appRef) {
          composed.destroyAll({ dispatch: (a) => appRef!.dispatch(a), getState: () => appRef!.getState() })
        }
        if (fc.onStop) fc.onStop()
      },
      onError: fc.onError,
      onRestore: onRestore as AioConfig<Record<string, unknown>, unknown, unknown>['onRestore'],
      stateForUI: fc.stateForUI as AioConfig<Record<string, unknown>, unknown, unknown>['stateForUI'],
      stateForDB: autoGetDBState as AioConfig<Record<string, unknown>, unknown, unknown>['stateForDB'],
      _onScheduleReady: (cancelByPrefix) => composed.registry.setOnDisable(cancelByPrefix),
    }

    try {
      const app = await _run(composed.initialState, config)
      appRef = app

      // Attach features API to app
      const featuresApi = {
        enable: (name: string) => composed.registry.enable(name, { dispatch: (a) => app.dispatch(a), getState: () => app.getState() }),
        disable: (name: string) => composed.registry.disable(name, (a) => app.dispatch(a)),
        status: (name: string) => composed.registry.status(name, app.getState() as Record<string, unknown>),
        health: () => composed.registry.health(app.getState() as Record<string, unknown>),
        list: () => composed.featureNames,
      }
      ;(app as Record<string, unknown>).features = featuresApi

      // Bind features — enables todo.add('milk') syntax (dispatch + selector binding)
      for (const f of composed.features) {
        bindFeature(f, (a) => app.dispatch(a), () => app.getState() as Record<string, unknown>)
      }

      return app
    }
    catch (e) { _running = false; throw e }
  }
}

async function _run<S, A, E>(initialState: S, config: AioConfig<S, A, E>): Promise<AioApp<S, A>> {
  const cli = parseCli()
  if (cli.help) { printHelp(); Deno.exit(0) }
  if (cli.version) { console.log(`aio ${VERSION}`); Deno.exit(0) }

  // App identity — resolved once, used for lock, UDS socket, KV/SQLite paths
  const appId = resolveAppId({ appId: config.appId, title: cli.title ?? config.ui?.title })
  log.debug(`app-id: ${appId}`)

  // Single-instance enforcement — identity-based lock in /tmp/aio-{appId}.lock
  const singletonMode: SingletonMode = config.singleton ?? true
  let appLock: AppLock | null = null
  if (singletonMode !== false) {
    const port = cli.port ?? config.port ?? 8000
    appLock = new AppLock(appId)
    const result = await appLock.acquire(port, singletonMode)
    if (!result.ok) {
      const ex = result.existing
      console.error(`[AIO] ${singletonMode === 'takeover' ? 'Failed to take over' : 'Already running'}: ${ex.appId} (pid ${ex.pid}, port ${ex.port})`)
      Deno.exit(1)
    }
    log.debug(`lock: acquired /tmp/aio-${appId}.lock (PID ${Deno.pid})`)
  }

  // --url: thin client mode — launches connect-page electron that fetches meta from remote
  if (cli.url !== undefined) {
    if (cli.url) log.info(`connecting to ${cli.url}`)
    else log.info('launching connect page')
    const proc = await launchElectronClient(log, cli.url || undefined)
    if (proc) {
      const status = await proc.status
      log.info(`electron closed (code ${status.code ?? 0})`)
    }
    _running = false
    Deno.exit(0)
  }

  const baseDir = resolve(config.baseDir ?? join(Deno.cwd(), 'src'))

  // --verbose: enable verbose logging
  const VERBOSE = cli.verbose
  if (VERBOSE) log.debug = (msg: string) => console.log(`[${ts()}][DEBUG] ${msg}`)

  // Prod mode: explicit --prod flag or auto-detect in compiled binaries only
  // Running from source with dist/ lying around should NOT trigger prod
  const moduleRoot = import.meta.dirname ? resolve(import.meta.dirname, '..', '..', '..') : null
  let distDir = resolve(join(Deno.cwd(), 'dist'))
  let prod = cli.prod ?? false
  if (!prod && isCompiled()) {
    const candidates = [distDir, ...(moduleRoot ? [resolve(join(moduleRoot, 'dist'))] : [])]
    for (const dir of candidates) {
      try {
        await Deno.stat(join(dir, 'app.js'))
        distDir = dir
        prod = true
        log.info('auto-detected dist/app.js → prod mode')
        break
      } catch { /* not found */ }
    }
  }

  const headless = cli.headless ?? config.headless ?? false
  const { reduce, execute, onAction, onEffect, onStart, onStop, onError } = config
  const shouldPersist = (cli.persist ?? config.persist) !== false
  const getUIState = config.stateForUI ?? ((s: S, _user?: AioUser) => s)
  const getDBState = config.stateForDB ?? ((s: S) => s)
  const persistKey = config.persistKey ?? 'state'
  const persistMode = config.persistMode ?? 'single'
  const ui = config.ui ?? {}
  const useElectronEarly = !headless && (cli.electron ?? ui.electron) !== false
  const result = await lint(initialState, config, baseDir, prod, headless, useElectronEarly)
  printLint(result)
  const port = cli.port ?? config.port ?? 8000

  // Title: CLI > config > deno.json "title" > fallback
  let denoJsonTitle: string | undefined
  try { denoJsonTitle = JSON.parse(await Deno.readTextFile(join(Deno.cwd(), 'deno.json'))).title } catch { /* no deno.json or no title field */ }
  const title = cli.title ?? ui.title ?? denoJsonTitle ?? 'AIO App'

  log.debug(`config: port=${port} persist=${shouldPersist} electron=${(cli.electron ?? ui.electron) !== false} title="${title}" baseDir=${baseDir}`)

  let kvDb: SkvInstance | null = null
  let state = initialState

  // SQLite setup — spawns worker, creates tables (data loaded after KV merge below)
  const dbSchema = config.db
  const dbKeys = dbSchema ? Object.keys(dbSchema) : []
  let asyncDb: DB | null = null
  if (dbSchema && Object.keys(dbSchema).length) {
    try {
      const dbPath = resolveDbPath(appId)
      asyncDb = createDB(dbPath)
      await initSchema(asyncDb, dbSchema)
      log.info(`sqlite: ${dbKeys.length} table(s) at ${dbPath}`)
    } catch (e) {
      log.warn(`sqlite: unavailable — ${e}`)
      if (asyncDb) { await asyncDb.close().catch(() => {}); asyncDb = null }
    }
  }

  // KV: strip db-managed keys so arrays aren't double-stored
  const origGetDBState = getDBState
  const kvGetDBState = dbKeys.length
    ? (s: S) => {
        const full = origGetDBState(s)
        if (!full || typeof full !== 'object' || Array.isArray(full)) return full
        const filtered: Record<string, unknown> = {}
        for (const k of Object.keys(full as Record<string, unknown>)) {
          if (!dbKeys.includes(k)) filtered[k] = (full as Record<string, unknown>)[k]
        }
        return filtered
      }
    : origGetDBState

  if (shouldPersist) {
    try {
      const kvPath = resolveKvPath(appId)
      kvDb = skv(await Deno.openKv(kvPath))
      if (kvPath) log.debug(`persist: KV at ${kvPath} mode=${persistMode}`)
      const persisted = persistMode === 'multi'
        ? await kvDb.getMulti<Partial<S>>(persistKey)
        : await kvDb.get<Partial<S>>(persistKey)
      if (persisted) {
        state = deepMerge(initialState as Record<string, unknown>, persisted as Record<string, unknown>) as S
        log.debug(`persist: loaded from KV key="${persistKey}" (${persistMode})`)
      } else {
        log.debug(`persist: no saved state, using initialState`)
      }
    } catch (e) {
      log.warn(`persist: KV unavailable, running without persistence — ${e}`)
      kvDb = null
    }
  }

  // onRestore — let user transform/validate restored state before server starts
  if (config.onRestore) {
    try { state = config.onRestore(state) }
    catch (e) { log.error(`hook onRestore: ${e}`) }
  }

  // Load SQLite data into state (once, after KV merge — SQLite wins for db-managed keys)
  if (asyncDb && dbSchema) {
    const loaded = await loadTables(asyncDb, dbSchema)
    state = { ...(state as Record<string, unknown>), ...loaded } as S
  }

  log.debug(`state: ${Object.keys(state as Record<string, unknown>).length} keys`)

  // Track previous state for SQLite ref-equality diff
  let prevDbState: Record<string, unknown> = { ...(state as Record<string, unknown>) }

  /** Debounced persistence — KV for UI state, SQLite for db arrays */
  const persistMs = config.persistDebounce ?? 100
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let shuttingDown = false
  let prevPersistedKeys: string[] = []  // track multi-key keys for deletion when state keys removed
  // Debounced persistence — fire-and-forget during normal operation for throughput.
  // Data loss possible on crash between debounce intervals. Graceful shutdown awaits flushPersist().
  function schedulePersist(): void {
    if ((!kvDb && !asyncDb) || persistTimer || shuttingDown) return
    persistTimer = setTimeout(async () => {
      persistTimer = null
      // SQLite sync — reference equality check per table
      if (asyncDb && dbSchema) {
        try {
          await syncTables(asyncDb, dbSchema, state as Record<string, unknown>, prevDbState)
          log.debug('persist: sqlite synced')
        } catch (e) { log.error(`persist: sqlite sync failed — ${e}`) }
        prevDbState = { ...(state as Record<string, unknown>) }
      }
      // KV sync — UI state (db keys stripped)
      if (kvDb) {
        try {
          const dbState = kvGetDBState(state)
          if (persistMode === 'multi') {
            const obj = dbState as Record<string, unknown>
            const keys = Object.keys(obj)
            kvDb.setMulti(persistKey, obj, prevPersistedKeys)
              .then(() => { prevPersistedKeys = keys; log.debug(`persist: saved multi (${keys.length} keys)`) })
              .catch(e => { log.error(`persist: failed to save — ${e}`) })
          } else {
            const serialized = JSON.stringify(dbState)
            const bytes = new TextEncoder().encode(serialized).byteLength
            if (bytes > 63_000) {
              log.error(`persist: state is ${(bytes / 1024).toFixed(1)}KB — exceeds Deno KV 65KB limit. Use persistMode:'multi', stateForDB filter, or db:{} (SQLite)`)
              return
            }
            if (bytes > 50_000) {
              log.warn(`persist: state is ${(bytes / 1024).toFixed(1)}KB — approaching 65KB KV limit. Consider persistMode:'multi', stateForDB, or SQLite`)
            }
            kvDb.set(persistKey, dbState)
              .then(() => log.debug(`persist: saved (${(bytes / 1024).toFixed(1)}KB)`))
              .catch(e => { log.error(`persist: failed to save — ${e}`) })
          }
        } catch (e) {
          log.error(`persist: stateForDB threw — ${e}`)
        }
      }
    }, persistMs)
  }

  /** Immediate flush — cancel debounce and write now (used on shutdown) */
  async function flushPersist(): Promise<void> {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
    // Flush SQLite
    if (asyncDb && dbSchema) {
      try {
        await syncTables(asyncDb, dbSchema, state as Record<string, unknown>, prevDbState)
        prevDbState = { ...(state as Record<string, unknown>) }
      } catch (e) { log.error(`persist: sqlite flush failed — ${e}`) }
    }
    // Flush KV
    if (kvDb) {
      try {
        const dbState = kvGetDBState(state)
        if (persistMode === 'multi') {
          const obj = dbState as Record<string, unknown>
          const keys = Object.keys(obj)
          await kvDb.setMulti(persistKey, obj, prevPersistedKeys)
          prevPersistedKeys = keys
        } else {
          await kvDb.set(persistKey, dbState)
        }
        log.debug('persist: flushed')
      } catch (e) {
        const msg = String(e)
        if (msg.includes('too large') || msg.includes('65536') || msg.includes('value too')) {
          log.warn(`persist: state exceeds Deno KV 65KB limit — set persistMode:'multi' or use stateForDB / db:{} (SQLite)`)
        }
        log.error(`persist: flush failed — ${e}`)
      }
    }
  }

  // Hook-wrapped reduce/execute — observe-only, error-guarded
  const { beforeReduce } = config
  // Tracks whether any action in the current drain cycle actually ran reduce() — drops skip persist+broadcast
  let _anyProcessed = false
  const hookedReduce: typeof reduce = (s, a) => {
    // Extract per-action user tag (set by server dispatch) instead of shared mutable
    const user = (a as Record<string, unknown>)?._user as AioUser | undefined
    if (beforeReduce) {
      const filtered = beforeReduce(a, s, user)
      if (filtered === null) return { state: s, effects: [] as E[] }  // dropped — _anyProcessed stays false
      a = filtered as A
    }
    _anyProcessed = true
    if (onAction) try { onAction(a, s, user) } catch (e) { log.error(`hook onAction: ${e}`) }
    return reduce(s, a)
  }
  const hookedExecute: typeof execute = onEffect
    ? (app, e) => { try { onEffect(e, _dispatchUser) } catch (err) { log.error(`hook onEffect: ${err}`) }; execute(app, e) }
    : execute

  // Time-travel — active in dev mode, zero cost in prod
  let tt: TTState<S, { type: string }> | null = null
  if (!prod) {
    tt = createTT<S, { type: string }>()
    tt = record(tt, { type: '__init' }, state)
    log.debug('time-travel: initialized')
  }

  // Schedule manager — handles __schedule effects from reducer + config-level schedules
  const scheduleManager = createScheduleManager(
    (action) => dispatch(action as A), log
  )
  if (config._onScheduleReady) config._onScheduleReady((prefix) => scheduleManager.cancelByPrefix(prefix))

  // UDS handle — created after dispatch for electron+UDS transport
  let udsHandle: UDSHandle | null = null
  const udsSyncRate = ui.syncRate ?? 10
  let udsQueued = false
  let udsDirty = false
  let udsThrottle: ReturnType<typeof setTimeout> | null = null

  // Track per-action performance for dev-mode time-travel panel
  let lastPerf: PerfMetric | undefined
  const onPerf = tt
    ? (timing: { actionType: string; reduce: number; effects: number; budget: { reduce: number; effect: number } }) => {
        lastPerf = { reduce: timing.reduce, effects: timing.effects, budget: timing.budget }
      }
    : undefined

  // Internal action types to hide from time-travel history (framework noise)
  const TT_SKIP_SUFFIXES = [':__exec', ':__FlowState', ':__flow']
  const TT_SKIP_CONTAINS = [':__set', ':__error']
  function isInternalAction(type: string): boolean {
    if (TT_SKIP_SUFFIXES.some(s => type.endsWith(s))) return true
    if (TT_SKIP_CONTAINS.some(s => type.includes(s))) return true
    return false
  }

  // Shared dispatch loop — re-entrant-safe, overflow-guarded
  const dispatch = createDispatch<S, A, E>({
    reduce: tt
      ? (s, a) => {
          if (tt!.paused) {
            log.debug(`time-travel: paused, dropping action ${(a as { type?: string }).type ?? '?'}`)
            return { state: s, effects: [] as E[] }
          }
          const result = hookedReduce(s, a)
          const actionType = (a as { type?: string }).type ?? ''
          if (!isInternalAction(actionType)) {
            tt = record(tt!, a as unknown as { type: string }, result.state, lastPerf)
            lastPerf = undefined
            server.broadcastTT()
          }
          return result
        }
      : hookedReduce,
    execute: (effect) => {
      if (isScheduleEffect(effect)) { scheduleManager.handle(effect as ScheduleEffect); return }
      hookedExecute(app, effect)
    },
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {
      const processed = _anyProcessed; _anyProcessed = false
      if (!processed) return  // all actions dropped by beforeReduce — skip persist + broadcast
      if (!tt?.paused) { schedulePersist() }
      server.broadcast()
      // Also broadcast to UDS clients (Electron IPC bridge) — throttled same as WS
      if (udsHandle) {
        udsDirty = true
        if (!udsQueued && !(udsSyncRate > 0 && udsThrottle)) {
          udsQueued = true
          queueMicrotask(() => {
            udsQueued = false; udsDirty = false
            udsHandle!.broadcast(JSON.stringify(getUIState(state)))
            if (udsSyncRate > 0) {
              udsThrottle = setTimeout(() => {
                udsThrottle = null
                if (udsDirty) { udsDirty = true; udsHandle!.broadcast(JSON.stringify(getUIState(state))) }
              }, udsSyncRate)
            }
          })
        }
      }
    },
    log, debug: VERBOSE,
    onError,
    perfMode: config.perfMode,
    perfBudget: config.perfBudget,
    freezeState: config.freezeState ?? !prod,  // default: true in dev, false in prod
    effectTimeout: config.effectTimeout,
    onPerf,
  })

  const app: AioApp<S, A> = {
    dispatch,
    getState: () => state,
    port,
    db: asyncDb ?? undefined,
    snapshot: () => JSON.stringify(state),
    loadSnapshot: (json: string) => {
      const parsed = JSON.parse(json)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('snapshot must be a JSON object')
      // Validate keys — reject unknown keys not in initial state
      const initKeys = new Set(Object.keys(initialState as Record<string, unknown>))
      const snapKeys = Object.keys(parsed as Record<string, unknown>)
      const unknown = snapKeys.filter(k => !initKeys.has(k))
      if (unknown.length) log.warn(`snapshot: unknown keys present: ${unknown.join(', ')}`)
      state = parsed as S
      prevDbState = { ...(state as Record<string, unknown>) }
      if (tt) {
        tt = record(tt, { type: '__snapshot' }, state)
        server.broadcastTT()
      }
      schedulePersist()
      server.broadcast()
      if (udsHandle) udsHandle.broadcast(JSON.stringify(getUIState(state)))
      log.info('snapshot: loaded')
    },
    close: async () => { await shutdown() },
  }

  // Shared shutdown — idempotent, used by both close() and signal handler
  let shutdownPromise: Promise<void> | null = null
  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise
    shuttingDown = true
    shutdownPromise = _doShutdown()
    return shutdownPromise
  }
  async function _doShutdown(): Promise<void> {
    // Flush persistence BEFORE onStop/destroyAll — destroyAll resets feature state,
    // so persisting after destroy would save empty state (#002)
    try { await flushPersist() } catch (e) { log.error(`shutdown: persist — ${e}`) }

    if (onStop) try { onStop() } catch (e) { log.error(`hook onStop: ${e}`) }

    // Release single-instance lock
    if (appLock) {
      appLock.release()
      log.debug(`lock: released (PID ${Deno.pid})`)
    }

    scheduleManager.cancelAll()
    dispatch.close()
    if (_electronProc) {
      try { _electronProc.kill(); _electronProc = null } catch (e) { log.error(`shutdown: electron — ${e}`) }
    }
    if (udsHandle) { try { udsHandle.shutdown() } catch (e) { log.error(`shutdown: uds — ${e}`) } }
    try { await server.shutdown() } catch (e) { log.error(`shutdown: server — ${e}`) }
    try { await asyncDb?.close() } catch (e) { log.error(`shutdown: sqlite — ${e}`) }
    try { kvDb?.close() } catch (e) { log.error(`shutdown: kv — ${e}`) }
    _running = false
  }

  // --expose: bind 0.0.0.0, generate access token, auto-TLS
  const expose = cli.expose ?? false
  const users = config.users
  // --expose without users: auto-gen single token (backwards compatible)
  const token = (expose && !users) ? crypto.randomUUID() : undefined

  // TLS: auto-generate self-signed cert when --expose (or use user-provided --cert/--key)
  let tlsCert: TlsCert | null = null
  if (expose) {
    const certDir = isCompiled() ? resolveDataDir(appId) : join(Deno.cwd(), '.aio-tls')
    try {
      tlsCert = await loadOrCreateCert(certDir, cli.cert, cli.key)
      if (tlsCert.selfSigned) {
        log.info(`tls: self-signed cert at ${tlsCert.certPath}`)
        log.warn(`tls: self-signed — remote browsers will show a security warning. Trust the cert, or use --cert=/path.pem --key=/path.pem for a CA-signed cert`)
      } else {
        log.info(`tls: using cert ${tlsCert.certPath}`)
      }
    } catch (e) {
      log.warn(`tls: cert generation failed (${e}) — falling back to plain HTTP`)
    }
  }

  // TT command handler — undo/redo/goto restore state, pause/resume toggle
  function handleTTCommand(cmd: string, arg?: number): void {
    if (!tt) return
    const prev = tt
    switch (cmd) {
      case 'undo':   tt = undo(tt); break
      case 'redo':   tt = redo(tt); break
      case 'goto':   if (arg !== undefined) tt = travelTo(tt, arg); break
      case 'pause':  tt = pause(tt); break
      case 'resume': tt = resume(tt); break
      default: log.debug(`time-travel: unknown command '${cmd}'`); return
    }
    if (tt === prev) return  // no-op (e.g. undo at start)
    // Restore state at current index
    const restored = stateAt(tt)
    if (restored !== null) state = restored
    log.debug(`time-travel: ${cmd}${arg !== undefined ? ':' + arg : ''} → index ${tt.index}/${tt.entries.length - 1} paused=${tt.paused}`)
    server.broadcastTT()
    server.broadcast()
    if (udsHandle) udsHandle.broadcast(JSON.stringify(getUIState(state)))
  }

  // Resolve electron + transport early (needed for skipHttp decision)
  const useElectron = !headless && (cli.electron ?? ui.electron) !== false
  const transport = resolveTransport(cli.transport ?? ui.transport, useElectron, expose)

  // Prod + UDS + electron: skip HTTP server entirely (zero TCP ports — all via UDS+IPC)
  const skipHttp = prod && transport === 'uds' && useElectron && !expose
  const server: ServerHandle = skipHttp
    ? { broadcast: () => {}, broadcastTT: () => {}, shutdown: async () => {}, clientCount: () => 0 }
    : createServer({
    port,
    title,
    width: ui.width,
    height: ui.height,
    getUIState: (user?: AioUser) => getUIState(state, user),
    dispatch: (action, user?) => {
      // Tag user onto action so queued re-entrant dispatches carry the correct user
      const tagged = user ? { ...(action as Record<string, unknown>), _user: user } : action
      dispatch(tagged as A)
    },
    getSnapshot: () => app.snapshot!(),
    loadSnapshot: (json: string) => app.loadSnapshot!(json),
    baseDir,
    debug: (msg: string) => log.debug(msg),
    prod,
    distDir: prod ? distDir : undefined,
    expose,
    token,
    users,
    cert: tlsCert?.cert,
    key: tlsCert?.key,
    showStatus: ui.showStatus,
    deltaThreshold: config.deltaThreshold,
    maxConnections: config.maxConnections,
    syncRate: ui.syncRate,
    onConnect: config.onConnect,
    onDisconnect: config.onDisconnect,
    // Health endpoint — feature status when available, basic info otherwise
    getHealth: () => {
      const composed = (globalThis as Record<string, unknown>).__aioFeatures as ComposedFeatures | undefined
      const uptime = Math.round((Date.now() - ((globalThis as Record<string, unknown>).__aioStartedAt as number ?? Date.now())) / 1000)
      if (composed) {
        const features: Record<string, unknown> = {}
        for (const fs of composed.registry.health(state as Record<string, unknown>)) {
          features[fs.name] = {
            status: fs.status ?? 'active',
            enabled: fs.enabled,
            errors: fs.errors,
            lastAction: fs.lastAction,
          }
        }
        return { status: 'healthy', uptime, features }
      }
      return { status: 'healthy', uptime }
    },
    ...(tt ? {
      onTTCommand: handleTTCommand,
      getTTBroadcast: () => toBroadcast(tt!),
    } : {}),
    trojan: {
      getState: () => state,
      getSchedules: () => scheduleManager.active(),
      ...(tt ? { getTTHistory: () => toBroadcast(tt!) } : {}),
      ...(shouldPersist ? { forcePersist: () => schedulePersist() } : {}),
      ...(asyncDb ? { sqlQuery: async (sql: string) => (await asyncDb!.query(sql)).rows } : {}),
      shutdown: () => shutdown().then(() => Deno.exit(0)),
      startedAt: Date.now(),
    },
  })

  if (skipHttp) log.info('prod+UDS: HTTP server skipped (zero TCP ports)')

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    try {
      Deno.addSignalListener(sig, () => { shutdown().then(() => Deno.exit(0)).catch(() => Deno.exit(1)) })
    } catch { /* signal not supported on this platform */ }
  }

  ;(globalThis as Record<string, unknown>).__aioStartedAt = Date.now()
  if (onStart) try { onStart(app) } catch (e) { log.error(`hook onStart: ${e}`) }

  if (config.schedules?.length) {
    scheduleManager.start(config.schedules)
    log.info(`schedules: ${config.schedules.length} started`)
  }

  // UDS listener (transport already resolved above, before createServer)
  if (transport === 'uds') {
    const socketPath = resolveSocketPath(appId)
    udsHandle = createUDSListener(
      socketPath,
      () => getUIState(state),
      (action) => {
        // Tag action and dispatch into the shared loop
        dispatch(action as A)
      },
      (msg: string) => log.debug(msg),
    )
    log.info(`transport: UDS at ${socketPath}`)
  }

  const useHttps = expose && !!tlsCert
  // shareUrl: shown in logs / share links (0.0.0.0 when exposing — users replace with their LAN IP)
  const shareUrl = useHttps ? `https://0.0.0.0:${port}` : expose ? `http://0.0.0.0:${port}` : `http://localhost:${port}`
  // localUrl: used to open local browser/electron window
  const localUrl = useHttps ? `https://localhost:${port}` : `http://localhost:${port}`
  const url = shareUrl  // kept for compatibility with log messages below

  // Update lock file with runtime info (trojanPort, socketPath, started status)
  if (appLock) {
    appLock.update({
      status: 'started',
      ...(server.trojanPort ? { trojanPort: server.trojanPort } : {}),
      ...(udsHandle ? { socketPath: udsHandle.socketPath } : {}),
    })
  }

  const cliFlags = Deno.args.filter(a => a.startsWith('--') && a.length > 2)
  if (cliFlags.length) log.info(`cli: ${cliFlags.join(' ')}`)
  else log.debug('run with --help to see available flags')
  const mode = prod ? 'prod' : 'dev'
  const shell = headless ? 'headless' : useElectron ? 'electron' : 'browser'
  const transportLabel = transport === 'uds' ? ', uds' : ''
  if (skipHttp) {
    log.info(`running (${mode}, ${shell}, uds — no TCP port)`)
  } else {
    log.info(`running at ${url} (${mode}, ${shell}${transportLabel})`)
  }

  if (expose && users) {
    log.warn(`--expose: bound to 0.0.0.0 — per-user token auth, origin checks disabled`)
    for (const [t, u] of Object.entries(users)) {
      log.info(`share (${u.id}/${u.role}): ${url}?token=${t}`)
    }
  } else if (expose && token) {
    log.warn(`--expose: bound to 0.0.0.0 — token auth only, origin checks disabled, token changes on restart`)
    log.info(`share: ${url}?token=${token}`)
  } else if (users) {
    log.info(`auth: ${Object.keys(users).length} user(s) configured`)
  }

  if (headless) {
    // Headless — server-only, no UI launch (CLI apps use connectCli() to connect)
  } else if (useElectron) {
    const keepAlive = cli.keepAlive ?? ui.keepAlive ?? false
    const meta: AioMeta = { title, width: cli.width ?? ui.width, height: cli.height ?? ui.height }
    const electronUrl = token ? `${localUrl}?token=${token}` : localUrl
    const udsBaseDir = prod ? distDir : undefined  // prod: serve from dist/, dev: use HTTP
    let udsHasCSS = false
    if (udsBaseDir) try { Deno.statSync(join(udsBaseDir, 'style.css')); udsHasCSS = true } catch { /* no CSS */ }
    const udsConfig = udsHandle ? { socketPath: udsHandle.socketPath, baseDir: udsBaseDir, title, hasCSS: udsHasCSS } : undefined
    launchElectron(electronUrl, log, meta, udsConfig)
      .then(proc => {
        if (!proc) { log.warn(`Electron did not launch — open ${url} in a browser`); return }
        _electronProc = proc
        proc.status
          .then(s => {
            _electronProc = null
            if (keepAlive) {
              log.info(`electron closed (code ${s.code ?? 0}) — server still running at ${url}`)
            } else {
              shutdown().then(() => Deno.exit(0))
            }
          })
          .catch(e => log.error(`electron status: ${e}`))
      })
      .catch(e => log.error(`electron: ${e}`))
  } else {
    // Wait briefly for existing browser tabs to reconnect via WS
    setTimeout(() => {
      if (server.clientCount() > 0) {
        log.debug('browser: existing client connected — skipping open')
        return
      }
      const cmd = Deno.build.os === 'darwin' ? 'open'
        : Deno.build.os === 'windows' ? 'start'
        : 'xdg-open'
      try { new Deno.Command(cmd, { args: [localUrl], stdout: 'null', stderr: 'null' }).spawn() }
      catch { log.info(`open ${localUrl} in your browser`) }
    }, 1500)
  }

  return app
}

/** Main aio namespace — `aio.run(config)` starts the server, `aio.middleware` has built-in middleware factories */
export const aio = { run, middleware }
export type { FeatureDef, FeatureEntry, ComposedFeatures } from './feature.ts'

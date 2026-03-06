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
import { openDb, loadTables, syncTables, type TableDef, type AioDB } from './sql.ts'

/** Framework version — printed by --version, checked in tests */
export const VERSION = '0.4.0'

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
}

// Everything aio.run() needs to wire your app
export type AioConfig<S, A, E> = {
  reduce: (state: S, action: A) => { state: S; effects: (E | ScheduleEffect)[] }
  execute: (app: AioApp<S, A>, effect: E) => void
  persist?: boolean              // default: true — auto-opens Deno.Kv
  getDBState?: (state: S) => Partial<S>   // filter what gets persisted (default: full state)
  getUIState?: (state: S, user?: AioUser) => unknown   // filter what gets sent to UI (default: full state)
  deltaThreshold?: number          // 0-1: ratio of changed keys that triggers full state broadcast (default: 0.5)
  maxConnections?: number          // max concurrent WebSocket clients (default: 100)
  beforeReduce?: (action: A, state: S) => A | null  // intercept actions before reduce — return null to drop
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
  effectTimeout?: number        // ms to wait for async effects before warning (default: 30000 = 30s)
  freezeState?: boolean         // default: false in prod, true in dev — deep freeze state after reduce to catch mutations
  onRestore?:    (state: S) => S       // transform state after restore, before server starts
  // Lifecycle hooks — observe-only, all optional, error-guarded
  onAction?:     (action: A, state: S, user?: AioUser) => void
  onEffect?:     (effect: E, user?: AioUser) => void
  onConnect?:    (user?: AioUser) => void
  onDisconnect?: (user?: AioUser) => void
  onStart?:      (app: AioApp<S, A>) => void
  onStop?:       () => void
  onError?:      (error: AioError) => void
}

// Handle returned by aio.run() — dispatch actions, read state, or shut down
export type AioApp<S = unknown, A = unknown> = {
  dispatch: (action: A) => void
  getState: () => S
  snapshot?: () => string          // server-only (undefined in standalone)
  loadSnapshot?: (json: string) => void  // server-only (undefined in standalone)
  db?: AioDB     // SQLite — Level 2 ORM + Level 3 raw SQL (undefined in standalone)
  close: () => Promise<void>
  mode?: string  // 'standalone' in Android WebView builds — branch effects accordingly
  port?: number  // server port — available after aio.run(), useful for connectCli()
}

/** Composes multiple beforeReduce functions into one. */
export function composeMiddleware<S, A>(
  ...fns: NonNullable<AioConfig<S, A, unknown>['beforeReduce']>[]
): (action: A, state: S) => A | null {
  return (action: A, state: S): A | null => {
    let result: A | null = action
    for (const fn of fns) {
      if (result === null) return null
      result = fn(result, state)
    }
    return result
  }
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
export async function lint(state: unknown, config: { reduce?: unknown; execute?: unknown }, baseDir: string, prod = false, headless = false): Promise<Lint> {
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
        if (match && /^effect$/i.test(match[1])) {
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
          if (spec.startsWith('.') || spec.startsWith('/') || BROWSER_IMPORTS.has(spec)) continue
          r.warn.push(`${entry.name}: import "${spec}" won't work in browser — dev mode transpiles but doesn't bundle. Move this import to a server-side .ts file, or use the npm package via an effect.`)
        }
        // Named/default imports and re-exports: import { x } from 'foo', export { x } from 'foo'
        for (const m of content.matchAll(/(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]/g)) {
          const spec = m[1]
          if (spec.startsWith('.') || spec.startsWith('/') || BROWSER_IMPORTS.has(spec)) continue
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

  // Check electron install scripts — Deno requires manual approval
  if (!prod) {
    try {
      const electronDir = join(Deno.cwd(), 'node_modules', 'electron', 'dist')
      await Deno.stat(electronDir)
    } catch {
      try {
        // electron package exists but dist/ missing → scripts not approved
        await Deno.stat(join(Deno.cwd(), 'node_modules', 'electron'))
        r.hint.push('electron installed but dist/ missing — run `deno approve-scripts` then `deno install`')
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
export type CliFlags = { port?: number; persist?: boolean; electron?: boolean; keepAlive?: boolean; title?: string; verbose: boolean; prod?: boolean; version?: boolean; expose?: boolean; help?: boolean; url?: string; width?: number; height?: number; headless?: boolean; cert?: string; key?: string }

/** Parses CLI flags from Deno.args (or custom array for testing) */
export function parseCli(args: readonly string[] = Deno.args): CliFlags {
  const r: CliFlags = { verbose: false }
  const known = ['--port=', '--no-persist', '--no-electron', '--keep-alive', '--title=', '--verbose', '--prod', '--version', '--expose', '--help', '--url', '--width=', '--height=', '--headless', '--cert=', '--key=']
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

/** Resolves persistent data dir for compiled binaries — ~/.local/share/<slug>/ */
function resolveDataDir(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'aio-app'
  const dataHome = Deno.env.get('XDG_DATA_HOME') ?? join(homedir(), '.local', 'share')
  const dir = join(dataHome, slug)
  Deno.mkdirSync(dir, { recursive: true })
  return dir
}

/** Resolves KV path for compiled binaries (AppImage, deno compile) */
function resolveKvPath(title: string): string | undefined {
  if (!isCompiled()) return undefined  // dev mode — let Deno pick
  return join(resolveDataDir(title), 'data.kv')
}

/** Resolves SQLite path — parallel to KV. Compiled: ~/.local/share/<slug>/data.db, dev: ./data.db */
function resolveDbPath(title: string): string {
  if (!isCompiled()) return join(Deno.cwd(), 'data.db')
  return join(resolveDataDir(title), 'data.db')
}

/** Returns user home directory — $HOME, $USERPROFILE, or /tmp fallback */
function homedir(): string {
  return Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE') ?? '/tmp'
}

// ── Runtime ─────────────────────────────────────────────────────────

let _running = false
let _dispatchUser: AioUser | undefined = undefined
let _electronProc: Deno.ChildProcess | null = null

/** Single entry point — boots KV, server, electron, wires everything. CLI args override config. */
async function run<S, A, E>(initialState: S, config: AioConfig<S, A, E>): Promise<AioApp<S, A>> {
  if (_running) throw new Error('aio.run() already called — one instance per process')
  _running = true
  try { return await _run(initialState, config) } catch (e) { _running = false; throw e }
}

async function _run<S, A, E>(initialState: S, config: AioConfig<S, A, E>): Promise<AioApp<S, A>> {
  const cli = parseCli()
  if (cli.help) { printHelp(); Deno.exit(0) }
  if (cli.version) { console.log(`aio ${VERSION}`); Deno.exit(0) }

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
  const result = await lint(initialState, config, baseDir, prod, headless)
  printLint(result)

  const { reduce, execute, onAction, onEffect, onStart, onStop, onError } = config
  const shouldPersist = (cli.persist ?? config.persist) !== false
  const getUIState = config.getUIState ?? ((s: S, _user?: AioUser) => s)
  const getDBState = config.getDBState ?? ((s: S) => s)
  const persistKey = config.persistKey ?? 'state'
  const persistMode = config.persistMode ?? 'single'
  const ui = config.ui ?? {}
  const port = cli.port ?? config.port ?? 8000

  // Title: CLI > config > deno.json "title" > fallback
  let denoJsonTitle: string | undefined
  try { denoJsonTitle = JSON.parse(await Deno.readTextFile(join(Deno.cwd(), 'deno.json'))).title } catch { /* no deno.json or no title field */ }
  const title = cli.title ?? ui.title ?? denoJsonTitle ?? 'AIO App'

  log.debug(`config: port=${port} persist=${shouldPersist} electron=${(cli.electron ?? ui.electron) !== false} title="${title}" baseDir=${baseDir}`)

  let kvDb: SkvInstance | null = null
  let state = initialState

  // SQLite setup — opens DB, creates tables (data loaded after KV merge below)
  const dbSchema = config.db
  const dbKeys = dbSchema ? Object.keys(dbSchema) : []
  let sqlDb: ReturnType<typeof openDb> | null = null
  if (dbSchema && Object.keys(dbSchema).length) {
    try {
      const dbPath = resolveDbPath(title)
      sqlDb = openDb(dbPath, dbSchema)
      log.info(`sqlite: ${dbKeys.length} table(s) at ${dbPath}`)
    } catch (e) {
      log.warn(`sqlite: unavailable — ${e}`)
      sqlDb = null
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
      const kvPath = resolveKvPath(title)
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
  if (sqlDb && dbSchema) {
    const loaded = loadTables(sqlDb.raw, dbSchema)
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
  function schedulePersist(): void {
    if ((!kvDb && !sqlDb) || persistTimer || shuttingDown) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      // SQLite sync — reference equality check per table
      if (sqlDb && dbSchema) {
        try {
          syncTables(sqlDb.raw, dbSchema, state as Record<string, unknown>, prevDbState)
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
              log.error(`persist: state is ${(bytes / 1024).toFixed(1)}KB — exceeds Deno KV 65KB limit. Use persistMode:'multi', getDBState filter, or db:{} (SQLite)`)
              return
            }
            if (bytes > 50_000) {
              log.warn(`persist: state is ${(bytes / 1024).toFixed(1)}KB — approaching 65KB KV limit. Consider persistMode:'multi', getDBState, or SQLite`)
            }
            kvDb.set(persistKey, dbState)
              .then(() => log.debug(`persist: saved (${(bytes / 1024).toFixed(1)}KB)`))
              .catch(e => { log.error(`persist: failed to save — ${e}`) })
          }
        } catch (e) {
          log.error(`persist: getDBState threw — ${e}`)
        }
      }
    }, persistMs)
  }

  /** Immediate flush — cancel debounce and write now (used on shutdown) */
  async function flushPersist(): Promise<void> {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
    // Flush SQLite
    if (sqlDb && dbSchema) {
      try {
        syncTables(sqlDb.raw, dbSchema, state as Record<string, unknown>, prevDbState)
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
          log.warn(`persist: state exceeds Deno KV 65KB limit — set persistMode:'multi' or use getDBState / db:{} (SQLite)`)
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
    if (beforeReduce) {
      try { a = beforeReduce(a, s) as A } catch (e) { log.error(`beforeReduce threw: ${e}`); return { state: s, effects: [] as E[] } }
      if (a === null) return { state: s, effects: [] as E[] }  // dropped — _anyProcessed stays false
    }
    _anyProcessed = true
    if (onAction) try { onAction(a, s, _dispatchUser) } catch (e) { log.error(`hook onAction: ${e}`) }
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

  // Track per-action performance for dev-mode time-travel panel
  let lastPerf: PerfMetric | undefined
  const onPerf = tt
    ? (timing: { actionType: string; reduce: number; effects: number; budget: { reduce: number; effect: number } }) => {
        lastPerf = { reduce: timing.reduce, effects: timing.effects, budget: timing.budget }
      }
    : undefined

  // Shared dispatch loop — re-entrant-safe, overflow-guarded
  const dispatch = createDispatch<S, A, E>({
    reduce: tt
      ? (s, a) => {
          if (tt!.paused) {
            log.debug(`time-travel: paused, dropping action ${(a as { type?: string }).type ?? '?'}`)
            return { state: s, effects: [] as E[] }
          }
          const result = hookedReduce(s, a)
          tt = record(tt!, a as unknown as { type: string }, result.state, lastPerf)
          lastPerf = undefined
          server.broadcastTT()
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
      const processed = _anyProcessed; _anyProcessed = false; _dispatchUser = undefined
      if (!processed) return  // all actions dropped by beforeReduce — skip persist + broadcast
      if (!tt?.paused) { schedulePersist() }
      server.broadcast()
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
    db: sqlDb?.aioDB,
    snapshot: () => JSON.stringify(state),
    loadSnapshot: (json: string) => {
      const parsed = JSON.parse(json)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('snapshot must be a JSON object')
      // Validate keys — reject unknown keys not in initial state
      const initKeys = new Set(Object.keys(initialState as Record<string, unknown>))
      const snapKeys = Object.keys(parsed as Record<string, unknown>)
      const unknown = snapKeys.filter(k => !initKeys.has(k))
      if (unknown.length) log.warn(`snapshot: ignoring unknown keys: ${unknown.join(', ')}`)
      state = parsed as S
      prevDbState = { ...(state as Record<string, unknown>) }
      if (tt) {
        tt = record(tt, { type: '__snapshot' }, state)
        server.broadcastTT()
      }
      schedulePersist()
      server.broadcast()
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
    if (onStop) try { onStop() } catch (e) { log.error(`hook onStop: ${e}`) }
    scheduleManager.cancelAll()
    dispatch.close()
    if (_electronProc) {
      try { _electronProc.kill(); _electronProc = null } catch (e) { log.error(`shutdown: electron — ${e}`) }
    }
    try { await server.shutdown() } catch (e) { log.error(`shutdown: server — ${e}`) }
    try { await flushPersist() } catch (e) { log.error(`shutdown: persist — ${e}`) }
    try { sqlDb?.aioDB.close() } catch (e) { log.error(`shutdown: sqlite — ${e}`) }
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
    const certDir = isCompiled() ? resolveDataDir(title) : join(Deno.cwd(), '.aio-tls')
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
  }

  const server: ServerHandle = createServer({
    port,
    title,
    width: ui.width,
    height: ui.height,
    getUIState: (user?: AioUser) => getUIState(state, user),
    dispatch: (action, user?) => { _dispatchUser = user; dispatch(action as A) },
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
    onConnect: config.onConnect,
    onDisconnect: config.onDisconnect,
    ...(tt ? {
      onTTCommand: handleTTCommand,
      getTTBroadcast: () => toBroadcast(tt!),
    } : {}),
    trojan: {
      getState: () => state,
      getSchedules: () => scheduleManager.active(),
      ...(tt ? { getTTHistory: () => toBroadcast(tt!) } : {}),
      ...(shouldPersist ? { forcePersist: () => schedulePersist() } : {}),
      ...(sqlDb ? { sqlQuery: (sql: string) => sqlDb!.aioDB.query(sql) } : {}),
      shutdown: () => shutdown().then(() => Deno.exit(0)),
      startedAt: Date.now(),
    },
  })

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    try {
      Deno.addSignalListener(sig, () => { shutdown().then(() => Deno.exit(0)).catch(() => Deno.exit(1)) })
    } catch { /* signal not supported on this platform */ }
  }

  if (onStart) try { onStart(app) } catch (e) { log.error(`hook onStart: ${e}`) }

  if (config.schedules?.length) {
    scheduleManager.start(config.schedules)
    log.info(`schedules: ${config.schedules.length} started`)
  }

  const useElectron = !headless && (cli.electron ?? ui.electron) !== false
  const useHttps = expose && !!tlsCert
  // shareUrl: shown in logs / share links (0.0.0.0 when exposing — users replace with their LAN IP)
  const shareUrl = useHttps ? `https://0.0.0.0:${port}` : expose ? `http://0.0.0.0:${port}` : `http://localhost:${port}`
  // localUrl: used to open local browser/electron window
  const localUrl = useHttps ? `https://localhost:${port}` : `http://localhost:${port}`
  const url = shareUrl  // kept for compatibility with log messages below

  // Update PID file with trojanPort (aio HTTP control port) when TLS is active
  if (useHttps && server.trojanPort) {
    try {
      const raw = Deno.readTextFileSync('.aio.pid')
      const pf = JSON.parse(raw) as Record<string, unknown>
      pf.trojanPort = server.trojanPort
      pf.status = 'started'
      Deno.writeTextFileSync('.aio.pid', JSON.stringify(pf))
    } catch { /* not running under am — fine */ }
  }

  const cliFlags = Deno.args.filter(a => a.startsWith('--') && a.length > 2)
  if (cliFlags.length) log.info(`cli: ${cliFlags.join(' ')}`)
  else log.debug('run with --help to see available flags')
  const mode = prod ? 'prod' : 'dev'
  const shell = headless ? 'headless' : useElectron ? 'electron' : 'browser'
  log.info(`running at ${url} (${mode}, ${shell})`)

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
    launchElectron(electronUrl, log, meta)
      .then(proc => {
        if (!proc) return
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

export const aio = { run }

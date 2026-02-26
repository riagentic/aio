// Core runtime — boots KV, server, electron, wires everything together
import { skv, type SkvInstance } from './skv.ts'
import { createServer, type ServerHandle } from './server.ts'
import { launchElectron } from './electron.ts'
import { join, resolve } from '@std/path'

// Electron + browser window options
export type UiConfig = {
  electron?: boolean   // default: true — opens electron window
  keepAlive?: boolean  // default: false — keep server running after electron closes
  title?: string       // default: 'AIO App'
  width?: number       // default: 800
  height?: number      // default: 600
}

// Everything aio.run() needs to wire your app
export type AioConfig<S, A, E> = {
  reduce: (state: S, action: A) => { state: S; effects: E[] }
  execute: (effect: E, app: AioApp<S, A>) => void
  persist?: boolean              // default: true — auto-opens Deno.Kv
  getDBState?: (state: S) => unknown   // filter what gets persisted (default: full state)
  getUIState?: (state: S) => unknown   // filter what gets sent to UI (default: full state)
  persistKey?: string            // KV key (default: "state")
  ui?: UiConfig
  port?: number                  // default: 8000
  baseDir?: string               // default: ./src
}

// Handle returned by aio.run() — dispatch actions, read state, or shut down
export type AioApp<S, A> = {
  dispatch: (action: A) => void
  getState: () => S
  close: () => Promise<void>
}

// ── Logger ──────────────────────────────────────────────────────────

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

// Checks state, config, App.tsx existence, and common mistakes
export async function lint(state: unknown, config: Record<string, unknown>, baseDir: string, prod = false): Promise<Lint> {
  const r: Lint = { ok: [], warn: [], hint: [], fail: [] }

  if (state == null) r.fail.push('initial state is null/undefined')
  else if (typeof state !== 'object') r.fail.push(`initial state must be an object, got ${typeof state}`)
  else {
    const keys = Object.keys(state as Record<string, unknown>)
    r.ok.push(`state (${keys.length} keys)`)
    const reserved = keys.filter(k => k === '$p' || k === '$d')
    if (reserved.length) r.warn.push(`state has reserved key(s): ${reserved.join(', ')} — these are used internally for delta patches and will cause data corruption`)
  }

  if (typeof config.reduce !== 'function') r.fail.push('config.reduce must be a function: (state, action) => { state, effects }')
  else r.ok.push('reduce')

  if (typeof config.execute !== 'function') r.fail.push('config.execute must be a function: (effect, app) => void')
  else r.ok.push('execute')

  // Prod mode: App.tsx not needed (pre-built into dist/app.js)
  if (prod) {
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
      r.fail.push('App.tsx not found in ' + baseDir)
      r.hint.push('  create it: export default function App() { return <div>Hello</div> }')
    }
  }

  try {
    for await (const entry of Deno.readDir(baseDir)) {
      if (!entry.isFile) continue
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
      const content = await Deno.readTextFile(join(baseDir, entry.name))
      if (content.includes("from '../dep/aio/") || content.includes("from \"../dep/aio/")) {
        r.hint.push(`${entry.name}: import from 'aio' instead of '../dep/aio/...'`)
      }
      // Check execute.ts for swapped params — first param named 'app' suggests (app, effect) instead of (effect, app)
      if (entry.name === 'execute.ts') {
        const match = content.match(/function\s+execute\s*\(\s*(\w+)/)
        if (match && /^app$/i.test(match[1])) {
          r.hint.push(`execute.ts: first param is "${match[1]}" — signature is execute(effect, app), reads as "execute this effect on this app"`)
        }
      }
    }
  } catch { /* baseDir doesn't exist — already caught above */ }

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

// Formats lint results — compact when clean, detailed when issues found
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

// Reads CLI flags — overrides config values. Accepts args for testing.
export function parseCli(args: readonly string[] = Deno.args): { port?: number; persist?: boolean; electron?: boolean; keepAlive?: boolean; title?: string; debug: boolean; prod?: boolean } {
  const r: { port?: number; persist?: boolean; electron?: boolean; keepAlive?: boolean; title?: string; debug: boolean; prod?: boolean } = { debug: false }
  const known = ['--port=', '--no-persist', '--no-electron', '--keep-alive', '--title=', '--debug', '--prod']
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
    else if (arg === '--debug') r.debug = true
    else if (arg === '--prod') r.prod = true
    else if (arg.startsWith('--') && !known.some(k => arg.startsWith(k) || arg === k)) {
      log.warn(`unknown flag: ${arg}`)
    }
  }
  return r
}

// ── Deep merge — restores persisted state while preserving new schema fields ──

// Uses `initial` as the structural template: any key in initial is guaranteed to exist
// in the result. Persisted values override leaf values but can't remove keys or change
// object→primitive. Arrays are replaced wholesale (not merged element-by-element).
export function deepMerge(initial: Record<string, unknown>, persisted: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...initial }
  for (const key of Object.keys(persisted)) {
    if (!(key in initial)) continue  // drop keys removed from schema
    const iv = initial[key]
    const pv = persisted[key]
    if (isPlainObject(iv) && isPlainObject(pv)) {
      result[key] = deepMerge(iv as Record<string, unknown>, pv as Record<string, unknown>)
    } else if (typeof iv === typeof pv) {
      result[key] = pv  // same type → use persisted
    }
    // type mismatch → keep initial (schema wins)
  }
  return result
}

function isPlainObject(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// ── KV path resolution ──────────────────────────────────────────────

// When inside an AppImage (or any compiled binary without a writable origin),
// Deno.openKv() default path lives in the read-only squashfs mount → fails.
// Use an explicit path in XDG_DATA_HOME / ~/.local/share/<app>/data.kv instead.
function resolveKvPath(title: string): string | undefined {
  const appImage = Deno.env.get('APPIMAGE')
  // Also detect compiled binaries: import.meta.main + no readable origin
  const compiled = !import.meta.url.startsWith('file:///')
  if (!appImage && !compiled) return undefined  // dev mode — let Deno pick

  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'aio-app'
  const dataHome = Deno.env.get('XDG_DATA_HOME') ?? join(homedir(), '.local', 'share')
  const dir = join(dataHome, slug)
  Deno.mkdirSync(dir, { recursive: true })
  return join(dir, 'data.kv')
}

function homedir(): string {
  return Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE') ?? '/tmp'
}

// ── Runtime ─────────────────────────────────────────────────────────

// Single entry point — call once, runs forever. CLI args override config.
async function run<S, A, E>(initialState: S, config: AioConfig<S, A, E>): Promise<AioApp<S, A>> {
  const cli = parseCli()
  const baseDir = resolve(config.baseDir ?? join(Deno.cwd(), 'src'))

  // --debug: enable verbose logging
  if (cli.debug) log.debug = (msg: string) => console.log(`[${ts()}][DEBUG] ${msg}`)

  // Prod mode: explicit --prod flag or auto-detect dist/app.js
  // Check cwd first (normal run), then module root (compiled binary — embedded files live there)
  const moduleRoot = import.meta.dirname ? resolve(import.meta.dirname, '..', '..', '..') : null
  let distDir = resolve(join(Deno.cwd(), 'dist'))
  let prod = cli.prod ?? false
  if (!prod) {
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

  const result = await lint(initialState, config as unknown as Record<string, unknown>, baseDir, prod)
  printLint(result)

  const { reduce, execute } = config
  const shouldPersist = (cli.persist ?? config.persist) !== false
  const getUIState = config.getUIState ?? ((s: S) => s)
  const getDBState = config.getDBState ?? ((s: S) => s)
  const persistKey = config.persistKey ?? 'state'
  const ui = config.ui ?? {}
  const port = cli.port ?? config.port ?? 8000

  // Title: CLI > config > deno.json "title" > fallback
  let denoJsonTitle: string | undefined
  try { denoJsonTitle = JSON.parse(await Deno.readTextFile(join(Deno.cwd(), 'deno.json'))).title } catch { /* */ }
  const title = cli.title ?? ui.title ?? denoJsonTitle ?? 'AIO App'

  log.debug(`config: port=${port} persist=${shouldPersist} electron=${(cli.electron ?? ui.electron) !== false} title="${title}" baseDir=${baseDir}`)

  let db: SkvInstance | null = null
  let state = initialState
  if (shouldPersist) {
    try {
      const kvPath = resolveKvPath(title)
      db = skv(await Deno.openKv(kvPath))
      if (kvPath) log.debug(`persist: KV at ${kvPath}`)
      const persisted = await db.get<Partial<S>>(persistKey)
      if (persisted) {
        state = deepMerge(initialState as Record<string, unknown>, persisted as Record<string, unknown>) as S
        log.debug(`persist: loaded from KV key="${persistKey}"`)
      } else {
        log.debug(`persist: no saved state, using initialState`)
      }
    } catch (e) {
      log.warn(`persist: KV unavailable, running without persistence — ${e}`)
      db = null
    }
  }

  log.debug(`state: ${Object.keys(state as Record<string, unknown>).length} keys`)

  // Safely extract type/payload for debug logging
  function tag(v: unknown): string {
    const o = v as Record<string, unknown>
    return `${o?.type ?? '?'} ${JSON.stringify(o?.payload ?? {})}`
  }

  // Debounced KV persistence — writes at most once per 100ms
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  function schedulePersist(): void {
    if (!db || persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      db!.set(persistKey, getDBState(state))
        .then(() => log.debug(`persist: saved`))
        .catch(e => log.error(`persist: failed to save — ${e}`))
    }, 100)
  }

  // Immediate flush — cancel debounce and write now (used on shutdown)
  async function flushPersist(): Promise<void> {
    if (!db) return
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
    try {
      await db.set(persistKey, getDBState(state))
      log.debug('persist: flushed')
    } catch (e) {
      log.error(`persist: flush failed — ${e}`)
    }
  }

  // Re-entrant-safe dispatch queue — effects calling app.dispatch() are queued
  let dispatching = false
  const dispatchQueue: A[] = []

  // The core loop: action → reduce → persist → broadcast → effects
  function dispatch(action: A): void {
    dispatchQueue.push(action)
    if (dispatching) return  // queued — will be processed by the outer loop
    dispatching = true

    while (dispatchQueue.length > 0) {
      const current = dispatchQueue.shift()!
      log.debug(`action → reduce: ${tag(current)}`)

      let reduced: { state: S; effects: E[] }
      try {
        reduced = reduce(state, current)
      } catch (e) {
        log.error(`reduce error on ${tag(current)}: ${e}`)
        continue
      }

      // Validate reducer output shape
      if (!reduced || typeof reduced !== 'object' || !('state' in reduced) || !Array.isArray(reduced.effects)) {
        log.error(`reduce() must return { state, effects[] } — got ${JSON.stringify(reduced)} for action ${tag(current)}`)
        continue
      }

      const prev = state
      state = reduced.state
      if (prev !== state && typeof state === 'object' && state && typeof prev === 'object' && prev) {
        const changed = Object.keys(state as Record<string, unknown>).filter(k =>
          (state as Record<string, unknown>)[k] !== (prev as Record<string, unknown>)[k]
        )
        if (changed.length) log.debug(`state: changed [${changed.join(', ')}]`)
      }

      for (const effect of reduced.effects) {
        if (!effect || typeof (effect as Record<string, unknown>).type !== 'string') {
          log.warn(`reducer returned invalid effect (missing .type string) — skipping. Action was: ${tag(current)}`)
          continue
        }
        log.debug(`effect → execute: ${tag(effect)}`)
        try { execute(effect, app) } catch (e) { log.error(`effect error: ${e}`) }
      }
    }

    dispatching = false
    schedulePersist()
    server.broadcast()  // one broadcast after all queued dispatches drain
  }

  const app: AioApp<S, A> = {
    dispatch,
    getState: () => state,
    close: async () => {
      await flushPersist()
      db?.close()
      await server.shutdown()
    },
  }

  const server: ServerHandle = createServer({
    port,
    title,
    getUIState: () => getUIState(state),
    dispatch: (action) => dispatch(action as A),
    baseDir,
    debug: (msg: string) => log.debug(msg),
    prod,
    distDir: prod ? distDir : undefined,
  })

  // Graceful shutdown — flush pending state before exit
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    try {
      Deno.addSignalListener(sig, () => {
        flushPersist().then(() => { db?.close(); Deno.exit(0) })
      })
    } catch { /* signal not supported on this platform */ }
  }

  const useElectron = (cli.electron ?? ui.electron) !== false
  const url = `http://localhost:${port}`

  const cliFlags = Deno.args.filter(a => a.startsWith('--'))
  if (cliFlags.length) log.info(`cli: ${cliFlags.join(' ')}`)
  const mode = prod ? 'prod' : 'dev'
  log.info(`running at ${url} (${mode}, ${useElectron ? 'electron' : 'browser'})`)

  if (useElectron) {
    const keepAlive = cli.keepAlive ?? ui.keepAlive ?? false
    launchElectron(port, log, ui.width, ui.height)
      .then(proc => {
        if (!proc) return
        proc.status.then(s => {
          if (keepAlive) {
            log.info(`electron closed (code ${s.code ?? 0}) — server still running at ${url}`)
          } else {
            flushPersist().then(() => { db?.close(); Deno.exit(s.code ?? 0) })
          }
        })
      })
      .catch(e => log.error(`electron: ${e}`))
  } else {
    const cmd = Deno.build.os === 'darwin' ? 'open'
      : Deno.build.os === 'windows' ? 'start'
      : 'xdg-open'
    try { new Deno.Command(cmd, { args: [url], stdout: 'null', stderr: 'null' }).spawn() }
    catch { log.info(`open ${url} in your browser`) }
  }

  return app
}

export const aio = { run }

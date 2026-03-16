// aio create — scaffold a new aio project
// Called by: cli.ts `aio create <path>` or init.ts (legacy wrapper)

import { resolve, relative } from 'jsr:@std/path@^1'

// mirror mode: repo root is one level up from utils/ (undefined when run remotely)
const REPO_ROOT = import.meta.dirname ? resolve(import.meta.dirname, '..') : ''

const REPO = 'riagentic/aio'
const BRANCH = 'main'

// ── Colors ──

const c = {
  bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m', reset: '\x1b[0m',
}

// ── App Types ──

type AppType = {
  id: string
  label: string
  desc: string
  hasUI: boolean
  hasServer: boolean
  isRemote: boolean
}

const APP_TYPES: AppType[] = [
  // Local
  { id: 'browser',         label: 'Browser',           desc: 'Full-stack web app — server + React UI',                hasUI: true,  hasServer: true,  isRemote: false },
  { id: 'electron',        label: 'Electron',          desc: 'Desktop app — Electron window + embedded server',       hasUI: true,  hasServer: true,  isRemote: false },
  { id: 'android',         label: 'Android',           desc: 'Mobile app — Android WebView + embedded server',        hasUI: true,  hasServer: true,  isRemote: false },
  { id: 'cli',             label: 'CLI',               desc: 'Headless server + CLI interface, no UI',                hasUI: false, hasServer: true,  isRemote: false },
  { id: 'service',         label: 'Service',           desc: 'Background daemon — headless server + systemd',         hasUI: false, hasServer: true,  isRemote: false },
  // Remote
  { id: 'remote-browser',  label: 'Browser (remote)',  desc: 'Exposed web server — 0.0.0.0 + auth + systemd',        hasUI: true,  hasServer: true,  isRemote: true },
  { id: 'remote-service',  label: 'Service (remote)',  desc: 'Exposed headless server — 0.0.0.0 + auth + systemd',   hasUI: false, hasServer: true,  isRemote: true },
  { id: 'remote-electron', label: 'Electron (remote)', desc: 'Thin Electron client — connects to remote server',     hasUI: false, hasServer: false, isRemote: true },
  { id: 'remote-cli',      label: 'CLI (remote)',      desc: 'Thin CLI client — connects to remote server',          hasUI: false, hasServer: false, isRemote: true },
  { id: 'remote-android',  label: 'Android (remote)',  desc: 'Thin Android client — connect page, no local server',  hasUI: false, hasServer: false, isRemote: true },
]

// ── Interactive I/O ──

// Line-buffered stdin reader (handles piped input correctly)
const _stdinBuf: string[] = []
let _stdinEOF = false

async function _readLine(): Promise<string | null> {
  if (_stdinBuf.length > 0) return _stdinBuf.shift()!
  if (_stdinEOF) return null
  const buf = new Uint8Array(1024)
  const n = await Deno.stdin.read(buf)
  if (n === null) { _stdinEOF = true; return null }
  const text = new TextDecoder().decode(buf.subarray(0, n))
  const lines = text.split('\n').map(l => l.trim())
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return null
  _stdinBuf.push(...lines.slice(1))
  return lines[0] ?? null
}

async function prompt(question: string, fallback?: string): Promise<string> {
  const suffix = fallback ? ` ${c.dim}(${fallback})${c.reset}` : ''
  Deno.stdout.writeSync(new TextEncoder().encode(`${c.cyan}▸${c.reset} ${question}${suffix}: `))
  const answer = await _readLine()
  if (answer === null) {
    if (fallback) return fallback
    console.error(`\n${c.red}✗${c.reset} Unexpected end of input`)
    Deno.exit(1)
  }
  return answer || fallback || ''
}

async function menu(title: string, options: { label: string; desc: string }[]): Promise<number> {
  console.log(`\n${c.bold}${title}${c.reset}\n`)
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${c.cyan}${i + 1}${c.reset}  ${c.bold}${options[i]!.label}${c.reset}`)
    console.log(`     ${c.dim}${options[i]!.desc}${c.reset}`)
  }
  console.log()
  while (true) {
    const answer = await prompt(`Choose (1-${options.length})`)
    const n = parseInt(answer)
    if (n >= 1 && n <= options.length) return n - 1
  }
}

async function groupedMenu(): Promise<AppType> {
  console.log(`\n${c.bold}Choose app type:${c.reset}\n`)
  const pad = (n: number) => String(n).padStart(2)
  console.log(`  ${c.magenta}Local${c.reset} ${c.dim}— self-contained, runs on the device${c.reset}`)
  for (let i = 0; i < 5; i++) {
    const t = APP_TYPES[i]!
    console.log(`   ${c.cyan}${pad(i + 1)}${c.reset}  ${c.bold}${t.label}${c.reset}  ${c.dim}${t.desc}${c.reset}`)
  }
  console.log(`\n  ${c.magenta}Remote${c.reset} ${c.dim}— exposed server or thin client${c.reset}`)
  for (let i = 5; i < APP_TYPES.length; i++) {
    const t = APP_TYPES[i]!
    console.log(`   ${c.cyan}${pad(i + 1)}${c.reset}  ${c.bold}${t.label}${c.reset}  ${c.dim}${t.desc}${c.reset}`)
  }
  console.log()
  while (true) {
    const answer = await prompt(`Choose (1-${APP_TYPES.length})`)
    const n = parseInt(answer)
    if (n >= 1 && n <= APP_TYPES.length) return APP_TYPES[n - 1]!
  }
}

// ── Path helpers ──

function expandPath(raw: string): string {
  if (raw.startsWith('~/') || raw === '~') {
    const home = Deno.env.get('HOME')
    if (!home) throw new Error('$HOME not set')
    return raw === '~' ? home : resolve(home, raw.slice(2))
  }
  return resolve(raw)
}

function titleCase(name: string): string {
  return name.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// ── Framework delivery ──

async function downloadFramework(projectDir: string): Promise<void> {
  const tarUrl = `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz`
  console.log(`\n${c.cyan}▸${c.reset} Downloading aio framework...`)

  const resp = await fetch(tarUrl)
  if (!resp.ok) throw new Error(`Failed to download: ${resp.status}`)

  const tmpDir = await Deno.makeTempDir()
  const tarFile = `${tmpDir}/aio.tar.gz`
  await Deno.writeFile(tarFile, new Uint8Array(await resp.arrayBuffer()))

  const tar = new Deno.Command('tar', { args: ['xzf', tarFile, '-C', tmpDir] })
  const { success } = await tar.output()
  if (!success) throw new Error('tar extraction failed')

  const entries = []
  for await (const e of Deno.readDir(tmpDir)) {
    if (e.isDirectory && e.name.startsWith('aio')) entries.push(e.name)
  }
  const extractedDir = entries[0]
  if (!extractedDir) throw new Error('Could not find extracted directory')

  const repoDir = `${tmpDir}/${extractedDir}`
  const destAio = `${projectDir}/dep/aio`
  await Deno.mkdir(destAio, { recursive: true })
  for (const dir of ['src', 'tests', 'docs', 'utils', 'scripts', 'android-template']) {
    try { await copyDir(`${repoDir}/${dir}`, `${destAio}/${dir}`) } catch { /* optional */ }
  }
  await Deno.copyFile(`${repoDir}/mod.ts`, `${destAio}/mod.ts`)
  await Deno.remove(tmpDir, { recursive: true })
  console.log(`${c.green}✓${c.reset} Framework downloaded`)
}

async function copyDir(src: string, dst: string): Promise<void> {
  await Deno.mkdir(dst, { recursive: true })
  for await (const entry of Deno.readDir(src)) {
    const s = `${src}/${entry.name}`
    const d = `${dst}/${entry.name}`
    if (entry.isDirectory) await copyDir(s, d)
    else await Deno.copyFile(s, d)
  }
}

async function mirrorFramework(projectDir: string): Promise<void> {
  try {
    await Deno.stat(`${REPO_ROOT}/mod.ts`)
  } catch {
    console.error(`${c.red}✗${c.reset} Framework not found at ${REPO_ROOT} — --mirror requires running from the aio repo`)
    Deno.exit(1)
  }
  const aioDir = `${projectDir}/dep/aio`
  await Deno.mkdir(aioDir, { recursive: true })
  const items = ['src', 'tests', 'docs', 'utils', 'scripts', 'android-template', 'mod.ts']
  for (const item of items) {
    const target = relative(aioDir, `${REPO_ROOT}/${item}`)
    await Deno.symlink(target, `${aioDir}/${item}`)
  }
  console.log(`${c.green}✓${c.reset} Symlinked dep/aio/ → ${c.dim}${REPO_ROOT}${c.reset} (${items.length} entries)`)
}

// ── File writer ──

async function writeFile(dir: string, path: string, content: string): Promise<void> {
  const full = `${dir}/${path}`
  const parent = full.substring(0, full.lastIndexOf('/'))
  await Deno.mkdir(parent, { recursive: true })
  await Deno.writeTextFile(full, content)
}

// ── deno.json ──

function denoJson(title: string, appType: AppType): string {
  const isElectronApp = appType.id === 'electron' || appType.id === 'remote-electron'
  const imports: Record<string, string> = {
    '@types/react': 'npm:@types/react@^18',
    'react': 'npm:react@^18',
    'react-dom': 'npm:react-dom@^18',
    'aio': './dep/aio/mod.ts',
    'esbuild': 'npm:esbuild@^0.24',
    'immer': 'npm:immer@^10',
    '@std/path': 'jsr:@std/path@^1',
  }
  if (isElectronApp) imports['electron'] = 'npm:electron'

  const devCmd = appType.hasServer
    ? `deno run -A src/app.ts${!appType.hasUI ? ' --headless' : (appType.id === 'browser' || appType.id === 'remote-browser') ? ' --no-electron' : ''}`
    : appType.id === 'remote-cli'
      ? 'deno run -A src/client.ts'
      : appType.id === 'remote-electron'
        ? 'deno run -A src/app.ts --url'
        : appType.id === 'remote-android'
          ? 'deno run -A src/app.ts --no-electron'
          : undefined

  const tasks: Record<string, string> = {}
  if (devCmd) tasks.dev = devCmd
  if (appType.hasServer) tasks.am = 'deno run -A dep/aio/src/am.ts'
  tasks.test = 'deno test -A --unstable-kv tests/'
  tasks.compile = `deno run -A dep/aio/src/build.ts ${compileFlags(appType)}`
  tasks['compile:browser'] = 'deno run -A dep/aio/src/build.ts --compile'
  tasks['compile:browser:remote'] = 'deno run -A dep/aio/src/build.ts --compile --service --remote'
  tasks['compile:electron'] = 'deno run -A dep/aio/src/build.ts --compile --electron'
  tasks['compile:electron:remote'] = 'deno run -A dep/aio/src/build.ts --client'
  tasks['compile:cli'] = 'deno run -A dep/aio/src/build.ts --compile --cli'
  tasks['compile:cli:remote'] = 'deno run -A dep/aio/src/build.ts --compile --cli --remote'
  tasks['compile:android'] = 'deno run -A dep/aio/src/build.ts --android'
  tasks['compile:android:remote'] = 'deno run -A dep/aio/src/build.ts --android --remote'
  tasks['compile:service'] = 'deno run -A dep/aio/src/build.ts --compile --service --headless'
  tasks['compile:service:remote'] = 'deno run -A dep/aio/src/build.ts --compile --service --headless --remote'

  const obj: Record<string, unknown> = {
    title,
    version: '0.1.0',
    nodeModulesDir: 'auto',
    unstable: ['kv'],
  }
  if (appType.hasUI || appType.id === 'remote-android') {
    obj.compilerOptions = {
      jsx: 'react-jsx',
      jsxImportSource: 'react',
      jsxImportSourceTypes: '@types/react',
    }
  }
  obj.imports = imports
  obj.tasks = tasks

  return JSON.stringify(obj, null, 2) + '\n'
}

function compileFlags(appType: AppType): string {
  // Map app type to build.ts flags
  const m: Record<string, string> = {
    'browser':         '--compile',
    'electron':        '--compile --electron',
    'android':         '--android',
    'cli':             '--compile --cli',
    'service':         '--compile --service --headless',
    'remote-browser':  '--compile --service --remote',
    'remote-service':  '--compile --service --headless --remote',
    'remote-electron': '--client',
    'remote-cli':      '--compile --cli --remote',
    'remote-android':  '--android --remote',
  }
  return m[appType.id]!
}

// ── Templates ──

function templateEmpty(title: string): Record<string, string> {
  return {
    'src/app.ts': `import { aio, feature } from 'aio'

export const counter = feature('counter', {
  state: { count: 0 },
  methods: {
    inc(s) { s.count++ },
    dec(s) { s.count-- },
  },
})

await aio.run({
  features: [counter],
  ui: { title: '${title}' },
})
`,
    'src/App.tsx': `import { useAio, msg } from 'aio'

type State = { counter: { count: number } }

export default function App() {
  const { state, send } = useAio<State>()
  if (!state) return <div>Loading...</div>

  return (
    <div style={{ padding: '3rem', fontFamily: 'system-ui', textAlign: 'center' }}>
      <h1>${title}</h1>
      <div style={{ fontSize: '4rem', margin: '1rem 0' }}>{state.counter.count}</div>
      <button onClick={() => send(msg('counter:dec'))}>-</button>
      {' '}
      <button onClick={() => send(msg('counter:inc'))}>+</button>
    </div>
  )
}
`,
  }
}

function templateMinimal(title: string): Record<string, string> {
  return {
    'src/app.ts': `import { aio } from 'aio'
import { counter } from './counter.ts'

await aio.run({
  features: [counter],
  ui: { title: '${title}' },
})
`,
    'src/counter.ts': `import { feature } from 'aio'

export const counter = feature('counter', {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) { s.count += by },
    decrement(s, by = 1) { s.count -= by },
    reset(s) { s.count = 0 },
  },
})
`,
    'src/App.tsx': `import { useFeature } from 'aio'
import { counter } from './counter.ts'

export default function App() {
  const { state, send } = useFeature(counter)
  if (!state) return <div>Connecting...</div>

  return (
    <div style={{ padding: '3rem', fontFamily: 'system-ui, sans-serif', textAlign: 'center' }}>
      <h1>${title}</h1>
      <div style={{ fontSize: '4rem', margin: '1rem 0', color: '#00a6cc' }}>
        {state.count}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
        <button onClick={() => send.decrement()}>-</button>
        <button onClick={() => send.reset()}>Reset</button>
        <button onClick={() => send.increment()}>+</button>
      </div>
    </div>
  )
}
`,
  }
}

function templateMedium(title: string): Record<string, string> {
  return {
    'src/app.ts': `import { aio } from 'aio'
import { todo } from './features/todo.ts'

await aio.run({
  features: [todo],
  ui: { title: '${title}' },
})
`,
    'src/features/todo.ts': `import { feature } from 'aio'

export type TodoItem = { id: number; text: string; done: boolean }

export const todo = feature('todo', {
  state: { items: [] as TodoItem[], nextId: 1 },
  methods: {
    addTodo(s, text: string) {
      s.items.push({ id: s.nextId++, text, done: false })
    },
    toggleTodo(s, id: number) {
      const item = s.items.find(i => i.id === id)
      if (item) item.done = !item.done
    },
    removeTodo(s, id: number) {
      s.items = s.items.filter(i => i.id !== id)
    },
  },
})
`,
    'src/ui/TodoList.tsx': `import { useFeature } from 'aio'
import { todo } from '../features/todo.ts'

export function TodoList() {
  const { state, send } = useFeature(todo)
  if (!state) return null

  return (
    <div>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {state.items.map(item => (
          <li key={item.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.3rem 0' }}>
            <input
              type="checkbox"
              checked={item.done}
              onChange={() => send.toggleTodo(item.id)}
            />
            <span style={{ textDecoration: item.done ? 'line-through' : 'none', flex: 1 }}>
              {item.text}
            </span>
            <button onClick={() => send.removeTodo(item.id)}>×</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
`,
    'src/ui/AddTodo.tsx': `import { useState } from 'react'
import { useFeature } from 'aio'
import { todo } from '../features/todo.ts'

export function AddTodo() {
  const { send } = useFeature(todo)
  const [text, setText] = useState('')

  const add = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    send.addTodo(trimmed)
    setText('')
  }

  return (
    <form onSubmit={e => { e.preventDefault(); add() }} style={{ display: 'flex', gap: '0.5rem' }}>
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="What needs to be done?"
        style={{ flex: 1, padding: '0.4rem' }}
      />
      <button type="submit">Add</button>
    </form>
  )
}
`,
    'src/App.tsx': `import { useFeature } from 'aio'
import { todo } from './features/todo.ts'
import { TodoList } from './ui/TodoList.tsx'
import { AddTodo } from './ui/AddTodo.tsx'

export default function App() {
  const { state } = useFeature(todo)
  if (!state) return <div>Loading...</div>

  return (
    <div style={{ maxWidth: '500px', margin: '2rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>${title}</h1>
      <AddTodo />
      <TodoList />
      <p style={{ color: '#888', fontSize: '0.85rem', marginTop: '1rem' }}>
        {state.items.filter(i => !i.done).length} remaining
      </p>
    </div>
  )
}
`,
  }
}

function templateLarge(title: string): Record<string, string> {
  return {
    'src/app.ts': `import { aio } from 'aio'
import { todo } from './features/todo/todo.ts'
import { user } from './features/user/user.ts'

await aio.run({
  features: [todo, user],
  ui: { title: '${title}' },
})
`,
    'src/features/todo/todo.ts': `import { feature } from 'aio'

export type TodoItem = { id: number; text: string; done: boolean }

export const todo = feature('todo', {
  state: { items: [] as TodoItem[], nextId: 1 },
  methods: {
    addTodo(s, text: string) {
      s.items.push({ id: s.nextId++, text, done: false })
    },
    toggleTodo(s, id: number) {
      const item = s.items.find(i => i.id === id)
      if (item) item.done = !item.done
    },
    removeTodo(s, id: number) {
      s.items = s.items.filter(i => i.id !== id)
    },
    clearDone(s) {
      s.items = s.items.filter(i => !i.done)
    },
  },
})
`,
    'src/features/user/user.ts': `import { feature } from 'aio'

export const user = feature('user', {
  state: { name: 'Anonymous', theme: 'light' as 'light' | 'dark' },
  methods: {
    setName(s, name: string) { s.name = name },
    toggleTheme(s) { s.theme = s.theme === 'light' ? 'dark' : 'light' },
  },
})
`,
    'src/ui/layout/Header.tsx': `import { useFeature } from 'aio'
import { user } from '../../features/user/user.ts'

export function Header() {
  const { state, send } = useFeature(user)
  if (!state) return null

  return (
    <header style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '0.75rem 1rem', borderBottom: '1px solid #eee',
    }}>
      <span style={{ fontSize: '0.85rem', color: '#888' }}>{state.name}</span>
      <button onClick={() => send.toggleTheme()}>
        {state.theme === 'light' ? '🌙' : '☀️'}
      </button>
    </header>
  )
}
`,
    'src/ui/todo/TodoList.tsx': `import { useFeature } from 'aio'
import { todo } from '../../features/todo/todo.ts'

export function TodoList() {
  const { state, send } = useFeature(todo)
  if (!state) return null

  return (
    <div>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {state.items.map(item => (
          <li key={item.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.3rem 0' }}>
            <input type="checkbox" checked={item.done} onChange={() => send.toggleTodo(item.id)} />
            <span style={{ textDecoration: item.done ? 'line-through' : 'none', flex: 1, color: item.done ? '#aaa' : 'inherit' }}>
              {item.text}
            </span>
            <button onClick={() => send.removeTodo(item.id)} style={{ fontSize: '0.8rem' }}>×</button>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: '#888', marginTop: '0.5rem' }}>
        <span>{state.items.filter(i => !i.done).length} remaining</span>
        {state.items.some(i => i.done) && (
          <button onClick={() => send.clearDone()} style={{ fontSize: '0.8rem' }}>Clear done</button>
        )}
      </div>
    </div>
  )
}
`,
    'src/ui/todo/AddTodo.tsx': `import { useState } from 'react'
import { useFeature } from 'aio'
import { todo } from '../../features/todo/todo.ts'

export function AddTodo() {
  const { send } = useFeature(todo)
  const [text, setText] = useState('')

  const add = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    send.addTodo(trimmed)
    setText('')
  }

  return (
    <form onSubmit={e => { e.preventDefault(); add() }} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="What needs to be done?"
        style={{ flex: 1, padding: '0.5rem' }}
      />
      <button type="submit">Add</button>
    </form>
  )
}
`,
    'src/ui/user/Settings.tsx': `import { useState } from 'react'
import { useFeature } from 'aio'
import { user } from '../../features/user/user.ts'

export function Settings() {
  const { state, send } = useFeature(user)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  if (!state) return null

  const save = () => {
    const trimmed = name.trim()
    if (trimmed) send.setName(trimmed)
    setEditing(false)
  }

  return (
    <div style={{ padding: '1rem', background: '#f9f9f9', borderRadius: '6px', marginTop: '1rem' }}>
      <h3 style={{ margin: '0 0 0.5rem' }}>Settings</h3>
      {editing ? (
        <form onSubmit={e => { e.preventDefault(); save() }} style={{ display: 'flex', gap: '0.5rem' }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" style={{ padding: '0.3rem' }} />
          <button type="submit">Save</button>
        </form>
      ) : (
        <button onClick={() => { setName(state.name); setEditing(true) }}>Change name</button>
      )}
    </div>
  )
}
`,
    'src/App.tsx': `import { useFeature } from 'aio'
import { user } from './features/user/user.ts'
import { Header } from './ui/layout/Header.tsx'
import { TodoList } from './ui/todo/TodoList.tsx'
import { AddTodo } from './ui/todo/AddTodo.tsx'
import { Settings } from './ui/user/Settings.tsx'

export default function App() {
  const { state } = useFeature(user)
  if (!state) return <div style={{ padding: '2rem' }}>Loading...</div>

  const bg = state.theme === 'dark' ? '#1a1a2e' : '#fff'
  const fg = state.theme === 'dark' ? '#e0e0e0' : '#222'

  return (
    <div style={{ minHeight: '100vh', background: bg, color: fg }}>
      <Header />
      <main style={{ maxWidth: '500px', margin: '0 auto', padding: '1.5rem 1rem' }}>
        <AddTodo />
        <TodoList />
        <Settings />
      </main>
    </div>
  )
}
`,
  }
}

// ── App type post-processing ──

function applyAppType(files: Record<string, string>, appType: AppType, title: string): Record<string, string> {
  if (!appType.hasServer) return clientOnlyFiles(appType, title)

  const result: Record<string, string> = {}
  for (const [path, content] of Object.entries(files)) {
    // Strip UI files for headless types
    if (!appType.hasUI && (path.endsWith('.tsx') || path.includes('src/ui/'))) continue
    result[path] = content
  }

  // Inject headless: true for server types without UI
  if (!appType.hasUI && result['src/app.ts']) {
    result['src/app.ts'] = result['src/app.ts'].replace(
      /ui:\s*\{[^}]*\},?\n/,
      `headless: true,\n`,
    )
  }

  // Browser types: dev task already uses --no-electron; no need to bake electron:false into app.ts
  // (keeps config clean and lets users switch to Electron by just removing --no-electron)

  // Auth hint for remote server types — inside config object
  if (appType.isRemote && appType.hasServer && result['src/app.ts']) {
    result['src/app.ts'] = result['src/app.ts'].replace(
      /\n\}\)\n$/,
      `\n  // users: { admin: { name: 'Admin', token: 'change-me' } },\n})\n`,
    )
  }

  return result
}

function clientOnlyFiles(appType: AppType, title: string): Record<string, string> {
  if (appType.id === 'remote-electron') {
    return {
      'src/app.ts': `import { aio, feature } from 'aio'

// ${title} — Electron remote client
// Dev:     deno task dev           (opens connect page)
// Direct:  deno task dev --url=http://server:8000
// Build:   deno task compile       (AppImage)

const _stub = feature('app', { state: {}, methods: {} })
await aio.run({ features: [_stub], ui: { title: '${title}' } })
`,
    }
  }

  // remote-android: connect page HTML served locally for dev, APK for compile
  return {
    'src/app.ts': `import { aio, feature } from 'aio'

// ${title} — Android remote client
// Dev:   deno task dev        (serves connect page at http://localhost:8000)
// Build: deno task compile    (APK)

const _stub = feature('app', { state: {}, methods: {} })
await aio.run({ features: [_stub], ui: { title: '${title}' } })
`,
    'src/App.tsx': `import { useState } from 'react'

export default function App() {
  const [url, setUrl] = useState('')

  const connect = () => {
    const target = url.trim()
    if (target) window.location.href = target
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#1a1a2e', color: '#e0e0e0', fontFamily: 'system-ui' }}>
      <div style={{ textAlign: 'center', padding: '2rem', width: '90%', maxWidth: '400px' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 300, letterSpacing: '.1em', color: '#4a9eff', marginBottom: '1.5rem' }}>${title}</h1>
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && connect()}
          placeholder="http://server:8000"
          style={{ width: '100%', padding: '.8rem 1rem', fontSize: '1rem', background: '#16213e', border: '1px solid #333', borderRadius: '8px', color: '#e0e0e0', outline: 'none', marginBottom: '.8rem' }}
        />
        <button
          onClick={connect}
          style={{ width: '100%', padding: '.8rem', fontSize: '1rem', background: '#4a9eff', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer' }}
        >Connect</button>
      </div>
    </div>
  )
}
`,
  }
}

// ── CLI client templates (remote-cli) ──

function cliTemplateEmpty(_title: string): Record<string, string> {
  return {
    'src/client.ts': `import { connectCli } from 'aio'

type State = { count: number }

const url = Deno.args[0] || 'ws://localhost:8000/ws'
console.log('Connecting to', url, '...')

const app = connectCli<State>(url)
await app.ready
console.log('Connected! State:', app.state)

app.subscribe(state => {
  console.log('State updated:', state)
})

// Example: send an action
// import { msg } from 'aio'
// app.send(msg('Inc'))

// Keep alive — Ctrl+C to exit
await new Promise(() => {})
`,
  }
}

function cliTemplateMinimal(_title: string): Record<string, string> {
  return {
    'src/state.ts': `// Mirror of server state — feature 'counter' namespaces its state
export type AppState = { counter: { count: number } }
`,
    'src/commands.ts': `import { msg } from 'aio'

export function parseCommand(args: string[]): { type: string; payload?: unknown } | null {
  const [cmd, ...rest] = args
  switch (cmd) {
    case 'inc': return msg('counter:increment', { args: [Number(rest[0]) || 1] })
    case 'dec': return msg('counter:decrement', { args: [Number(rest[0]) || 1] })
    case 'reset': return msg('counter:reset', { args: [] })
    default: return null
  }
}

export function printHelp(): void {
  console.log('Commands: inc [n], dec [n], reset')
}
`,
    'src/client.ts': `import { connectCli } from 'aio'
import type { AppState } from './state.ts'
import { parseCommand, printHelp } from './commands.ts'

const url = Deno.args[0] || 'ws://localhost:8000/ws'
console.log('Connecting to', url, '...')

const app = connectCli<AppState>(url)
await app.ready
console.log('Connected! Counter:', app.state?.counter.count)

app.subscribe(state => {
  console.log('Counter:', state.counter.count)
})

const decoder = new TextDecoder()
const buf = new Uint8Array(1024)
printHelp()
Deno.stdout.writeSync(new TextEncoder().encode('> '))

while (true) {
  const n = await Deno.stdin.read(buf)
  if (n === null) break
  const line = decoder.decode(buf.subarray(0, n)).trim()
  if (!line) { Deno.stdout.writeSync(new TextEncoder().encode('> ')); continue }
  const action = parseCommand(line.split(/\\s+/))
  if (action) app.send(action)
  else printHelp()
  Deno.stdout.writeSync(new TextEncoder().encode('> '))
}
`,
  }
}

function cliTemplateMedium(_title: string): Record<string, string> {
  return {
    'src/types.ts': `export type TodoItem = {
  id: number
  text: string
  done: boolean
}
`,
    'src/state.ts': `import type { TodoItem } from './types.ts'

export type AppState = {
  todo: { items: TodoItem[]; nextId: number }
}
`,
    'src/commands.ts': `import { msg } from 'aio'

export function parseCommand(args: string[]): { type: string; payload?: unknown } | null {
  const [cmd, ...rest] = args
  switch (cmd) {
    case 'add': {
      const text = rest.join(' ').trim()
      return text ? msg('AddTodo', { text }) : null
    }
    case 'toggle': return rest[0] ? msg('ToggleTodo', { id: Number(rest[0]) }) : null
    case 'remove': return rest[0] ? msg('RemoveTodo', { id: Number(rest[0]) }) : null
    case 'list': return null // handled in client
    default: return null
  }
}

export function printHelp(): void {
  console.log('Commands: add <text>, toggle <id>, remove <id>, list')
}
`,
    'src/display.ts': `import type { AppState } from './state.ts'

export function displayState(state: AppState): void {
  const { items } = state.todo
  if (items.length === 0) {
    console.log('  (no todos)')
    return
  }
  for (const item of items) {
    const check = item.done ? '\\u2713' : ' '
    const text = item.done ? \`\\x1b[2m\${item.text}\\x1b[0m\` : item.text
    console.log(\`  [\${check}] #\${item.id} \${text}\`)
  }
  const remaining = items.filter(i => !i.done).length
  console.log(\`  \\x1b[2m\${remaining} remaining\\x1b[0m\`)
}
`,
    'src/client.ts': `import { connectCli } from 'aio'
import type { AppState } from './state.ts'
import { parseCommand, printHelp } from './commands.ts'
import { displayState } from './display.ts'

const url = Deno.args[0] || 'ws://localhost:8000/ws'
console.log('Connecting to', url, '...')

const app = connectCli<AppState>(url)
await app.ready
console.log('Connected!')
displayState(app.state!)

app.subscribe(state => {
  displayState(state)
})

const decoder = new TextDecoder()
const buf = new Uint8Array(1024)
printHelp()
Deno.stdout.writeSync(new TextEncoder().encode('> '))

while (true) {
  const n = await Deno.stdin.read(buf)
  if (n === null) break
  const line = decoder.decode(buf.subarray(0, n)).trim()
  if (!line) { Deno.stdout.writeSync(new TextEncoder().encode('> ')); continue }
  if (line === 'list') { displayState(app.state!); Deno.stdout.writeSync(new TextEncoder().encode('> ')); continue }
  const action = parseCommand(line.split(/\\s+/))
  if (action) app.send(action)
  else printHelp()
  Deno.stdout.writeSync(new TextEncoder().encode('> '))
}
`,
  }
}

function cliTemplateLarge(_title: string): Record<string, string> {
  return {
    'src/model/todo/todo-types.ts': `export type TodoItem = {
  id: number
  text: string
  done: boolean
}

export type TodoState = {
  items: TodoItem[]
  nextId: number
}
`,
    'src/model/user/user-types.ts': `export type UserState = {
  name: string
  theme: 'light' | 'dark'
}
`,
    'src/state.ts': `import type { TodoState } from './model/todo/todo-types.ts'
import type { UserState } from './model/user/user-types.ts'

export type AppState = {
  todo: TodoState
  user: UserState
}
`,
    'src/commands/todo.ts': `import { msg } from 'aio'

export function parseTodoCommand(args: string[]): { type: string; payload?: unknown } | null {
  const [cmd, ...rest] = args
  switch (cmd) {
    case 'add': {
      const text = rest.join(' ').trim()
      return text ? msg('AddTodo', { text }) : null
    }
    case 'toggle': return rest[0] ? msg('ToggleTodo', { id: Number(rest[0]) }) : null
    case 'remove': return rest[0] ? msg('RemoveTodo', { id: Number(rest[0]) }) : null
    case 'clear': return msg('ClearDone')
    default: return null
  }
}
`,
    'src/commands/user.ts': `import { msg } from 'aio'

export function parseUserCommand(args: string[]): { type: string; payload?: unknown } | null {
  const [cmd, ...rest] = args
  switch (cmd) {
    case 'name': {
      const name = rest.join(' ').trim()
      return name ? msg('SetName', { name }) : null
    }
    case 'theme': return msg('ToggleTheme')
    default: return null
  }
}
`,
    'src/display.ts': `import type { AppState } from './state.ts'

const dim = '\\x1b[2m'
const reset = '\\x1b[0m'

export function displayState(state: AppState): void {
  console.log(\`  User: \${state.user.name} (theme: \${state.user.theme})\`)
  const { items } = state.todo
  if (items.length === 0) {
    console.log('  Todos: (none)')
    return
  }
  console.log('  Todos:')
  for (const item of items) {
    const check = item.done ? '\\u2713' : ' '
    const text = item.done ? \`\${dim}\${item.text}\${reset}\` : item.text
    console.log(\`    [\${check}] #\${item.id} \${text}\`)
  }
  const remaining = items.filter(i => !i.done).length
  console.log(\`  \${dim}\${remaining} remaining\${reset}\`)
}

export function printHelp(): void {
  console.log('Commands:')
  console.log('  add <text>     Add a todo')
  console.log('  toggle <id>    Toggle todo done/undone')
  console.log('  remove <id>    Remove a todo')
  console.log('  clear          Clear done todos')
  console.log('  name <name>    Set user name')
  console.log('  theme          Toggle light/dark theme')
  console.log('  list           Show current state')
}
`,
    'src/client.ts': `import { connectCli } from 'aio'
import type { AppState } from './state.ts'
import { parseTodoCommand } from './commands/todo.ts'
import { parseUserCommand } from './commands/user.ts'
import { displayState, printHelp } from './display.ts'

const url = Deno.args[0] || 'ws://localhost:8000/ws'
console.log('Connecting to', url, '...')

const app = connectCli<AppState>(url)
await app.ready
console.log('Connected!')
displayState(app.state!)

app.subscribe(state => {
  displayState(state)
})

const decoder = new TextDecoder()
const buf = new Uint8Array(1024)
printHelp()
Deno.stdout.writeSync(new TextEncoder().encode('> '))

while (true) {
  const n = await Deno.stdin.read(buf)
  if (n === null) break
  const line = decoder.decode(buf.subarray(0, n)).trim()
  if (!line) { Deno.stdout.writeSync(new TextEncoder().encode('> ')); continue }
  const parts = line.split(/\\s+/)
  if (parts[0] === 'list') { displayState(app.state!); Deno.stdout.writeSync(new TextEncoder().encode('> ')); continue }
  const action = parseTodoCommand(parts) || parseUserCommand(parts)
  if (action) app.send(action)
  else printHelp()
  Deno.stdout.writeSync(new TextEncoder().encode('> '))
}
`,
  }
}

// ── Template registry ──

type Template = { label: string; desc: string; fn: (title: string) => Record<string, string> }

function getTemplates(appType: AppType): Template[] {
  const ui = appType.hasUI
  return [
    { label: 'Empty',   desc: ui ? '2 files — inline feature + App.tsx. Fastest start.' : '1 file — inline feature. Fastest start.', fn: templateEmpty },
    { label: 'Minimal', desc: ui ? '3 files — counter feature + app entry + UI. Methods style.' : '2 files — counter feature + app entry. Methods style.', fn: templateMinimal },
    { label: 'Medium',  desc: ui ? '5 files — todo feature + UI components. Feature API.' : '2 files — todo feature + app entry. Feature API.', fn: templateMedium },
    { label: 'Large',   desc: ui ? '9 files — todo + user features + UI hierarchy. Full architecture.' : '3 files — todo + user features + app entry. Full architecture.', fn: templateLarge },
  ]
}

function getCliTemplates(): Template[] {
  return [
    { label: 'Empty',   desc: '1 file — src/client.ts, inline state type. Fastest start.', fn: cliTemplateEmpty },
    { label: 'Minimal', desc: '3 files — state + commands. Counter client.', fn: cliTemplateMinimal },
    { label: 'Medium',  desc: '5 files — types + commands + display. Todo client.', fn: cliTemplateMedium },
    { label: 'Large',   desc: '7 files — model + command modules + display. Todo + user client.', fn: cliTemplateLarge },
  ]
}

// ── Main export ──

export async function create(args: string[]): Promise<void> {
  // Parse args
  let rawPath = ''
  let mirror = false
  let typeFlag = ''
  let templateFlag = ''
  for (const a of args) {
    if (a === '--mirror') mirror = true
    else if (a.startsWith('--type=')) typeFlag = a.slice(7)
    else if (a.startsWith('--template=')) templateFlag = a.slice(11)
    else if (!a.startsWith('--')) rawPath = a
  }

  if (!rawPath) rawPath = await prompt('Project path', './my-app')

  const projectDir = expandPath(rawPath)
  const name = projectDir.split('/').pop()!.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() || 'my-app'
  const title = titleCase(name)

  // Check if dir already exists
  try {
    await Deno.stat(projectDir)
    console.log(`\n${c.red}✗${c.reset} Directory ${c.bold}${projectDir}${c.reset} already exists`)
    Deno.exit(1)
  } catch { /* good */ }

  // App type selection — skip menu with --type flag
  let appType: AppType
  if (typeFlag) {
    const found = APP_TYPES.find(t => t.id === typeFlag)
    if (!found) {
      console.error(`${c.red}✗${c.reset} Unknown app type: ${typeFlag}`)
      console.error(`  Valid types: ${APP_TYPES.map(t => t.id).join(', ')}`)
      Deno.exit(1)
    }
    appType = found
  } else {
    appType = await groupedMenu()
  }

  // Template selection
  let files: Record<string, string>
  let templateLabel: string

  if (appType.hasServer) {
    const templates = getTemplates(appType)
    if (templateFlag) {
      const idx = templates.findIndex(t => t.label.toLowerCase() === templateFlag.toLowerCase())
      if (idx === -1) {
        console.error(`${c.red}✗${c.reset} Unknown template: ${templateFlag}`)
        console.error(`  Valid templates: ${templates.map(t => t.label.toLowerCase()).join(', ')}`)
        Deno.exit(1)
      }
      templateLabel = templates[idx]!.label
      files = applyAppType(templates[idx]!.fn(title), appType, title)
    } else {
      const choice = await menu('Choose a template:', templates)
      templateLabel = templates[choice]!.label
      files = applyAppType(templates[choice]!.fn(title), appType, title)
    }
  } else if (appType.id === 'remote-cli') {
    const templates = getCliTemplates()
    if (templateFlag) {
      const idx = templates.findIndex(t => t.label.toLowerCase() === templateFlag.toLowerCase())
      if (idx === -1) {
        console.error(`${c.red}✗${c.reset} Unknown template: ${templateFlag}`)
        console.error(`  Valid templates: ${templates.map(t => t.label.toLowerCase()).join(', ')}`)
        Deno.exit(1)
      }
      templateLabel = templates[idx]!.label
      files = templates[idx]!.fn(title)
    } else {
      const choice = await menu('Choose a template:', templates)
      templateLabel = templates[choice]!.label
      files = templates[choice]!.fn(title)
    }
  } else {
    templateLabel = 'client'
    files = clientOnlyFiles(appType, title)
  }

  await Deno.mkdir(projectDir, { recursive: true })
  console.log(`\n${c.cyan}▸${c.reset} Creating ${c.bold}${name}/${c.reset} — ${c.cyan}${appType.label}${c.reset} (${templateLabel})`)

  if (mirror) {
    await mirrorFramework(projectDir)
  } else {
    await downloadFramework(projectDir)
  }

  await writeFile(projectDir, 'deno.json', denoJson(title, appType))

  for (const [path, content] of Object.entries(files)) {
    await writeFile(projectDir, path, content)
  }

  await writeFile(projectDir, '.gitignore', `node_modules/
dist/
*.db
*.sqlite
.env
`)

  console.log(`${c.green}✓${c.reset} ${Object.keys(files).length + 2} files written`)

  // Install deps
  console.log(`\n${c.cyan}▸${c.reset} Installing dependencies...`)

  const isElectronType = appType.id === 'electron' || appType.id === 'remote-electron'
  if (isElectronType) {
    // Approve electron build scripts first so deno install runs postinstall
    const approve = new Deno.Command('deno', {
      args: ['approve-scripts', 'npm:electron'],
      cwd: projectDir,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    await approve.output()
  }

  const install = new Deno.Command('deno', {
    args: ['install'],
    cwd: projectDir,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const { success } = await install.output()
  if (success) {
    console.log(`${c.green}✓${c.reset} Dependencies installed`)
  } else {
    console.error(`${c.red}✗${c.reset} deno install failed — run manually: cd ${name} && deno install`)
  }

  // Done message — adapt to app type
  const hint = appType.id === 'remote-cli'
    ? `  ${c.dim}deno task dev${c.reset}\n\n${c.dim}Connects to a running aio server (default: ws://localhost:8000/ws).${c.reset}`
    : appType.id === 'remote-electron'
      ? `  ${c.dim}deno task dev${c.reset}                  ${c.dim}Open connect page${c.reset}\n  ${c.dim}deno task dev -- --url=http://server:8000${c.reset}  ${c.dim}Connect directly${c.reset}`
      : appType.id === 'remote-android'
        ? `  ${c.dim}deno task dev${c.reset}\n\n${c.dim}Then open ${c.cyan}http://localhost:8000${c.dim} — connect page for testing.${c.reset}`
        : appType.id === 'electron'
          ? `  ${c.dim}deno task dev${c.reset}\n\n${c.dim}Electron window opens automatically. Skip it with ${c.reset}--no-electron${c.dim} (browser tab instead).${c.reset}`
          : appType.hasUI
            ? `  ${c.dim}deno task dev${c.reset}\n\n${c.dim}Then open ${c.cyan}http://localhost:8000${c.dim} in your browser.${c.reset}`
            : `  ${c.dim}deno task dev${c.reset}`

  console.log(`
${c.green}${c.bold}Done!${c.reset} Your aio app is ready.

  ${c.dim}cd ${projectDir}${c.reset}
${hint}
`)
}

// ── Test exports ──

export const _test = {
  templateEmpty, templateMinimal, templateMedium, templateLarge,
  cliTemplateEmpty, cliTemplateMinimal, cliTemplateMedium, cliTemplateLarge,
  getTemplates, getCliTemplates, applyAppType, clientOnlyFiles, denoJson,
  APP_TYPES,
}

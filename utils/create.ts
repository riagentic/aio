// aio create — scaffold a new aio project
// Called by: cli.ts `aio create <path>` or init.ts (legacy wrapper)

import { relative, resolve } from "jsr:@std/path@^1";

// mirror mode: repo root is one level up from utils/ (undefined when run remotely)
const REPO_ROOT = import.meta.dirname ? resolve(import.meta.dirname, "..") : "";

const REPO = "riagentic/aio";
const BRANCH = "main";

// ── Colors ──

const c = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  reset: "\x1b[0m",
};

// ── App Types ──

type AppType = {
  id: string;
  label: string;
  desc: string;
  hasUI: boolean;
  hasServer: boolean;
  isRemote: boolean;
};

const APP_TYPES: AppType[] = [
  // Local
  {
    id: "browser",
    label: "Browser",
    desc: "Full-stack web app — server + React UI",
    hasUI: true,
    hasServer: true,
    isRemote: false,
  },
  {
    id: "electron",
    label: "Electron",
    desc: "Desktop app — Electron window + embedded server",
    hasUI: true,
    hasServer: true,
    isRemote: false,
  },
  {
    id: "android",
    label: "Android",
    desc: "Mobile app — Android WebView + embedded server",
    hasUI: true,
    hasServer: true,
    isRemote: false,
  },
  {
    id: "cli",
    label: "CLI",
    desc: "Server-only + CLI interface, no UI",
    hasUI: false,
    hasServer: true,
    isRemote: false,
  },
  {
    id: "service",
    label: "Service",
    desc: "Background daemon — server-only + systemd",
    hasUI: false,
    hasServer: true,
    isRemote: false,
  },
  // Remote
  {
    id: "remote-browser",
    label: "Browser (remote)",
    desc: "Exposed web server — 0.0.0.0 + auth + systemd",
    hasUI: true,
    hasServer: true,
    isRemote: true,
  },
  {
    id: "remote-service",
    label: "Service (remote)",
    desc: "Exposed server-only — 0.0.0.0 + auth + systemd",
    hasUI: false,
    hasServer: true,
    isRemote: true,
  },
  {
    id: "remote-electron",
    label: "Electron (remote)",
    desc: "Thin Electron client — connects to remote server",
    hasUI: false,
    hasServer: false,
    isRemote: true,
  },
  {
    id: "remote-cli",
    label: "CLI (remote)",
    desc: "Thin CLI client — connects to remote server",
    hasUI: false,
    hasServer: false,
    isRemote: true,
  },
  {
    id: "remote-android",
    label: "Android (remote)",
    desc: "Thin Android client — connect page, no local server",
    hasUI: false,
    hasServer: false,
    isRemote: true,
  },
];

// ── Interactive I/O ──

// Line-buffered stdin reader (handles piped input correctly)
const _stdinBuf: string[] = [];
let _stdinEOF = false;

async function _readLine(): Promise<string | null> {
  if (_stdinBuf.length > 0) return _stdinBuf.shift()!;
  if (_stdinEOF) return null;
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) {
    _stdinEOF = true;
    return null;
  }
  const text = new TextDecoder().decode(buf.subarray(0, n));
  const lines = text.split("\n").map((l) => l.trim());
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return null;
  _stdinBuf.push(...lines.slice(1));
  return lines[0] ?? null;
}

async function prompt(question: string, fallback?: string): Promise<string> {
  const suffix = fallback ? ` ${c.dim}(${fallback})${c.reset}` : "";
  Deno.stdout.writeSync(
    new TextEncoder().encode(`${c.cyan}▸${c.reset} ${question}${suffix}: `),
  );
  const answer = await _readLine();
  if (answer === null) {
    if (fallback) return fallback;
    console.error(`\n${c.red}✗${c.reset} Unexpected end of input`);
    Deno.exit(1);
  }
  return answer || fallback || "";
}

async function menu(
  title: string,
  options: { label: string; desc: string }[],
): Promise<number> {
  console.log(`\n${c.bold}${title}${c.reset}\n`);
  for (let i = 0; i < options.length; i++) {
    console.log(
      `  ${c.cyan}${i + 1}${c.reset}  ${c.bold}${options[i]!.label}${c.reset}`,
    );
    console.log(`     ${c.dim}${options[i]!.desc}${c.reset}`);
  }
  console.log();
  while (true) {
    const answer = await prompt(`Choose (1-${options.length})`);
    const n = parseInt(answer);
    if (n >= 1 && n <= options.length) return n - 1;
  }
}

async function groupedMenu(): Promise<AppType> {
  console.log(`\n${c.bold}Choose app type:${c.reset}\n`);
  const pad = (n: number) => String(n).padStart(2);
  console.log(
    `  ${c.magenta}Local${c.reset} ${c.dim}— self-contained, runs on the device${c.reset}`,
  );
  for (let i = 0; i < 5; i++) {
    const t = APP_TYPES[i]!;
    console.log(
      `   ${c.cyan}${
        pad(i + 1)
      }${c.reset}  ${c.bold}${t.label}${c.reset}  ${c.dim}${t.desc}${c.reset}`,
    );
  }
  console.log(
    `\n  ${c.magenta}Remote${c.reset} ${c.yellow}(experimental)${c.reset} ${c.dim}— exposed server or thin client; not yet field-validated off-box${c.reset}`,
  );
  for (let i = 5; i < APP_TYPES.length; i++) {
    const t = APP_TYPES[i]!;
    console.log(
      `   ${c.cyan}${
        pad(i + 1)
      }${c.reset}  ${c.bold}${t.label}${c.reset}  ${c.dim}${t.desc}${c.reset}`,
    );
  }
  console.log();
  while (true) {
    const answer = await prompt(`Choose (1-${APP_TYPES.length})`);
    const n = parseInt(answer);
    if (n >= 1 && n <= APP_TYPES.length) return APP_TYPES[n - 1]!;
  }
}

// ── Path helpers ──

function expandPath(raw: string): string {
  if (raw.startsWith("~/") || raw === "~") {
    const home = Deno.env.get("HOME");
    if (!home) throw new Error("$HOME not set");
    return raw === "~" ? home : resolve(home, raw.slice(2));
  }
  return resolve(raw);
}

function titleCase(name: string): string {
  return name.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Derive an aio appId (lock file / KV / socket identity) from the title
function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  ) || "app";
}

// ── Framework delivery ──

async function downloadFramework(projectDir: string): Promise<void> {
  const tarUrl =
    `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz`;
  console.log(`\n${c.cyan}▸${c.reset} Downloading aio framework...`);

  const resp = await fetch(tarUrl);
  if (!resp.ok) throw new Error(`Failed to download: ${resp.status}`);

  const tmpDir = await Deno.makeTempDir();
  const tarFile = `${tmpDir}/aio.tar.gz`;
  await Deno.writeFile(tarFile, new Uint8Array(await resp.arrayBuffer()));

  const tar = new Deno.Command("tar", { args: ["xzf", tarFile, "-C", tmpDir] });
  const { success } = await tar.output();
  if (!success) throw new Error("tar extraction failed");

  const entries = [];
  for await (const e of Deno.readDir(tmpDir)) {
    if (e.isDirectory && e.name.startsWith("aio")) entries.push(e.name);
  }
  const extractedDir = entries[0];
  if (!extractedDir) throw new Error("Could not find extracted directory");

  const repoDir = `${tmpDir}/${extractedDir}`;
  const destAio = `${projectDir}/dep/aio`;
  await Deno.mkdir(destAio, { recursive: true });
  for (
    const dir of [
      "src",
      "tests",
      "docs",
      "utils",
      "scripts",
      "android-template",
    ]
  ) {
    try {
      await copyDir(`${repoDir}/${dir}`, `${destAio}/${dir}`);
    } catch { /* optional */ }
  }
  await Deno.copyFile(`${repoDir}/mod.ts`, `${destAio}/mod.ts`);
  await Deno.remove(tmpDir, { recursive: true });
  console.log(`${c.green}✓${c.reset} Framework downloaded`);
}

async function copyDir(src: string, dst: string): Promise<void> {
  await Deno.mkdir(dst, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    const s = `${src}/${entry.name}`;
    const d = `${dst}/${entry.name}`;
    if (entry.isDirectory) await copyDir(s, d);
    else await Deno.copyFile(s, d);
  }
}

async function mirrorFramework(projectDir: string): Promise<void> {
  try {
    await Deno.stat(`${REPO_ROOT}/mod.ts`);
  } catch {
    console.error(
      `${c.red}✗${c.reset} Framework not found at ${REPO_ROOT} — --mirror requires running from the aio repo`,
    );
    Deno.exit(1);
  }
  const aioDir = `${projectDir}/dep/aio`;
  await Deno.mkdir(aioDir, { recursive: true });
  const items = [
    "src",
    "tests",
    "docs",
    "utils",
    "scripts",
    "android-template",
    "mod.ts",
  ];
  for (const item of items) {
    const target = relative(aioDir, `${REPO_ROOT}/${item}`);
    await Deno.symlink(target, `${aioDir}/${item}`);
  }
  console.log(
    `${c.green}✓${c.reset} Symlinked dep/aio/ → ${c.dim}${REPO_ROOT}${c.reset} (${items.length} entries)`,
  );
}

async function cloneFramework(projectDir: string): Promise<void> {
  const repoUrl = `https://github.com/${REPO}`;
  console.log(`\n${c.cyan}▸${c.reset} Cloning aio framework (vendored)...`);
  const clone = new Deno.Command("git", {
    args: ["clone", repoUrl, `${projectDir}/dep/aio`],
    stdout: "inherit",
    stderr: "inherit",
  });
  const { success } = await clone.output().catch(() => ({ success: false }));
  if (!success) {
    console.error(
      `${c.red}✗${c.reset} git clone failed — is git installed and ${repoUrl} reachable?`,
    );
    Deno.exit(1);
  }
  console.log(
    `${c.green}✓${c.reset} Framework cloned to dep/aio/ — update anytime with ${c.dim}git -C dep/aio pull${c.reset}`,
  );
}

// ── File writer ──

async function writeFile(
  dir: string,
  path: string,
  content: string,
): Promise<void> {
  const full = `${dir}/${path}`;
  const parent = full.substring(0, full.lastIndexOf("/"));
  await Deno.mkdir(parent, { recursive: true });
  await Deno.writeTextFile(full, content);
}

// ── deno.json ──

function denoJson(title: string, appType: AppType): string {
  const isElectronApp = appType.id === "electron" ||
    appType.id === "remote-electron";
  const imports: Record<string, string> = {
    "aio": "./dep/aio/mod.ts",
    "aio/air": "./dep/aio/src/air.ts",
    "aio/jsx-runtime": "./dep/aio/src/jsx-runtime.ts",
    "esbuild": "npm:esbuild@^0.24",
    "immer": "npm:immer@^10",
    "@std/path": "jsr:@std/path@^1",
  };
  if (isElectronApp) imports["electron"] = "npm:electron";

  const devCmd = appType.hasServer
    ? `deno run -A src/app.ts${
      !appType.hasUI
        ? " --client=server-only"
        : (appType.id === "browser" || appType.id === "remote-browser")
        ? " --client=browser"
        : ""
    }`
    : appType.id === "remote-cli"
    ? "deno run -A src/client.ts"
    : appType.id === "remote-electron"
    ? "deno run -A src/app.ts --server-url"
    : appType.id === "remote-android"
    ? "deno run -A src/app.ts --client=browser"
    : undefined;

  const tasks: Record<string, string> = {};
  if (devCmd) tasks.dev = devCmd;
  if (appType.hasServer) tasks.am = "deno run -A dep/aio/src/am.ts";
  // Error remedies across src/ say "run: deno task install:electron" — keep it emitted
  if (isElectronApp) {
    tasks["install:electron"] = "deno install --allow-scripts=npm:electron";
  }
  tasks.test = "deno test -A --unstable-kv tests/";
  tasks.doctor = "deno run -A dep/aio/src/server/doctor.ts";
  tasks.compile = `deno run -A dep/aio/src/build.ts ${compileFlags(appType)}`;
  tasks["compile:browser"] = "deno run -A dep/aio/src/build.ts --compile";
  tasks["compile:browser:remote"] =
    "deno run -A dep/aio/src/build.ts --compile --service --remote";
  tasks["compile:electron"] =
    "deno run -A dep/aio/src/build.ts --compile --electron";
  tasks["compile:electron:remote"] =
    "deno run -A dep/aio/src/build.ts --client";
  tasks["compile:cli"] = "deno run -A dep/aio/src/build.ts --compile --cli";
  tasks["compile:cli:remote"] =
    "deno run -A dep/aio/src/build.ts --compile --cli --remote";
  tasks["compile:android"] = "deno run -A dep/aio/src/build.ts --android";
  tasks["compile:android:remote"] =
    "deno run -A dep/aio/src/build.ts --android --remote";
  tasks["compile:service"] =
    "deno run -A dep/aio/src/build.ts --compile --service --headless";
  tasks["compile:service:remote"] =
    "deno run -A dep/aio/src/build.ts --compile --service --headless --remote";

  const obj: Record<string, unknown> = {
    title,
    version: "0.1.0",
    nodeModulesDir: "auto",
    unstable: ["kv"],
  };
  // aio re-exports DOM-touching modules (vitals, air, jsx-runtime) even from
  // server entry points, so every project needs the dom libs to type-check.
  const compilerOptions: Record<string, unknown> = {
    lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
  };
  if (appType.hasUI || appType.id === "remote-android") {
    compilerOptions.jsx = "react-jsx";
    compilerOptions.jsxImportSource = "aio";
  }
  obj.compilerOptions = compilerOptions;
  obj.imports = imports;
  obj.tasks = tasks;

  return JSON.stringify(obj, null, 2) + "\n";
}

function compileFlags(appType: AppType): string {
  // Map app type to build.ts flags
  const m: Record<string, string> = {
    "browser": "--compile",
    "electron": "--compile --electron",
    "android": "--android",
    "cli": "--compile --cli",
    "service": "--compile --service --headless",
    "remote-browser": "--compile --service --remote",
    "remote-service": "--compile --service --headless --remote",
    "remote-electron": "--client",
    "remote-cli": "--compile --cli --remote",
    "remote-android": "--android --remote",
  };
  return m[appType.id]!;
}

// ── Templates ──

function templateEmpty(title: string): Record<string, string> {
  return {
    "src/app.ts": `import { aio, cell } from 'aio'

export const counter = cell('counter', {
  state: { count: 0 },
  methods: {
    inc(s) { s.count++ },
    dec(s) { s.count-- },
  },
})

await aio.run({
  appId: '${slug(title)}',
  appVersion: '0.1.0',
  cells: [counter],
  ui: { title: '${title}' },
  baseDir: import.meta.dirname!,
})
`,
    "src/App.tsx": `import { counter } from './app.ts'

export default function App() {
  return (
    <div style={{ padding: '3rem', fontFamily: 'system-ui', textAlign: 'center' }}>
      <h1>${title}</h1>
      <div style={{ fontSize: '4rem', margin: '1rem 0' }}>{counter.count}</div>
      <button type="button" onClick={() => counter.dec()}>-</button>
      {' '}
      <button type="button" onClick={() => counter.inc()}>+</button>
    </div>
  )
}
`,
  };
}

function templateMinimal(title: string): Record<string, string> {
  return {
    "src/app.ts": `import { aio } from 'aio'
import { counter } from './cell/counter.ts'

await aio.run({
  appId: '${slug(title)}',
  appVersion: '0.1.0',
  cells: [counter],
  ui: { title: '${title}' },
  baseDir: import.meta.dirname!,
})
`,
    "src/cell/counter.ts": `import { cell } from 'aio'

export const counter = cell('counter', {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) { s.count += by },
    decrement(s, by = 1) { s.count -= by },
    reset(s) { s.count = 0 },
  },
})
`,
    "src/App.tsx": `import { counter } from './cell/counter.ts'

export default function App() {
  return (
    <div style={{ padding: '3rem', fontFamily: 'system-ui, sans-serif', textAlign: 'center' }}>
      <h1>${title}</h1>
      <div style={{ fontSize: '4rem', margin: '1rem 0', color: '#00a6cc' }}>
        {counter.count}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
        <button type="button" onClick={() => counter.decrement()}>-</button>
        <button type="button" onClick={() => counter.reset()}>Reset</button>
        <button type="button" onClick={() => counter.increment()}>+</button>
      </div>
    </div>
  )
}
`,
  };
}

function templateMedium(title: string): Record<string, string> {
  return {
    "src/app.ts": `import { aio } from 'aio'
import { todo } from './cell/todo.ts'

await aio.run({
  appId: '${slug(title)}',
  appVersion: '0.1.0',
  cells: [todo],
  ui: { title: '${title}' },
  baseDir: import.meta.dirname!,
})
`,
    "src/cell/todo.ts": `import { cell } from 'aio'

export type TodoItem = { id: number; text: string; done: boolean }

export const todo = cell('todo', {
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
    "src/ui/TodoList.tsx": `import { todo } from '../cell/todo.ts'

export function TodoList() {
  return (
    <div>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {todo.items.map(item => (
          <li key={item.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.3rem 0' }}>
            <input
              type="checkbox"
              checked={item.done}
              onChange={() => todo.toggleTodo(item.id)}
            />
            <span style={{ textDecoration: item.done ? 'line-through' : 'none', flex: 1 }}>
              {item.text}
            </span>
            <button type="button" onClick={() => todo.removeTodo(item.id)}>×</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
`,
    "src/ui/AddTodo.tsx": `import { useLocal } from 'aio/air'
import { todo } from '../cell/todo.ts'

export function AddTodo() {
  const { local: text, set: setText } = useLocal('')

  const add = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    todo.addTodo(trimmed)
    setText('')
  }

  return (
    <form onSubmit={e => { e.preventDefault(); add() }} style={{ display: 'flex', gap: '0.5rem' }}>
      <input
        value={text}
        onChange={e => setText(e.currentTarget.value)}
        placeholder="What needs to be done?"
        style={{ flex: 1, padding: '0.4rem' }}
      />
      <button type="submit">Add</button>
    </form>
  )
}
`,
    "src/App.tsx": `import { todo } from './cell/todo.ts'
import { TodoList } from './ui/TodoList.tsx'
import { AddTodo } from './ui/AddTodo.tsx'

export default function App() {
  return (
    <div style={{ maxWidth: '500px', margin: '2rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>${title}</h1>
      <AddTodo />
      <TodoList />
      <p style={{ color: '#888', fontSize: '0.85rem', marginTop: '1rem' }}>
        {todo.items.filter(i => !i.done).length} remaining
      </p>
    </div>
  )
}
`,
  };
}

function templateLarge(title: string): Record<string, string> {
  return {
    "src/app.ts": `import { aio } from 'aio'
import { todo } from './cell/todo/todo.ts'
import { user } from './cell/user/user.ts'

await aio.run({
  appId: '${slug(title)}',
  appVersion: '0.1.0',
  cells: [todo, user],
  ui: { title: '${title}' },
  baseDir: import.meta.dirname!,
})
`,
    "src/cell/todo/todo.ts": `import { cell } from 'aio'

export type TodoItem = { id: number; text: string; done: boolean }

export const todo = cell('todo', {
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
    "src/cell/user/user.ts": `import { cell } from 'aio'

export const user = cell('user', {
  state: { name: 'Anonymous', theme: 'light' as 'light' | 'dark' },
  methods: {
    setName(s, name: string) { s.name = name },
    toggleTheme(s) { s.theme = s.theme === 'light' ? 'dark' : 'light' },
  },
})
`,
    "src/ui/layout/Header.tsx": `import { user } from '../../cell/user/user.ts'

export function Header() {
  return (
    <header style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '0.75rem 1rem', borderBottom: '1px solid #eee',
    }}>
      <span style={{ fontSize: '0.85rem', color: '#888' }}>{user.name}</span>
      <button type="button" onClick={() => user.toggleTheme()}>
        {user.theme === 'light' ? '🌙' : '☀️'}
      </button>
    </header>
  )
}
`,
    "src/ui/todo/TodoList.tsx": `import { todo } from '../../cell/todo/todo.ts'

export function TodoList() {
  return (
    <div>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {todo.items.map(item => (
          <li key={item.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.3rem 0' }}>
            <input type="checkbox" checked={item.done} onChange={() => todo.toggleTodo(item.id)} />
            <span style={{ textDecoration: item.done ? 'line-through' : 'none', flex: 1, color: item.done ? '#aaa' : 'inherit' }}>
              {item.text}
            </span>
            <button type="button" onClick={() => todo.removeTodo(item.id)} style={{ fontSize: '0.8rem' }}>×</button>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: '#888', marginTop: '0.5rem' }}>
        <span>{todo.items.filter(i => !i.done).length} remaining</span>
        {todo.items.some(i => i.done) && (
          <button type="button" onClick={() => todo.clearDone()} style={{ fontSize: '0.8rem' }}>Clear done</button>
        )}
      </div>
    </div>
  )
}
`,
    "src/ui/todo/AddTodo.tsx": `import { useLocal } from 'aio/air'
import { todo } from '../../cell/todo/todo.ts'

export function AddTodo() {
  const { local: text, set: setText } = useLocal('')

  const add = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    todo.addTodo(trimmed)
    setText('')
  }

  return (
    <form onSubmit={e => { e.preventDefault(); add() }} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
      <input
        value={text}
        onChange={e => setText(e.currentTarget.value)}
        placeholder="What needs to be done?"
        style={{ flex: 1, padding: '0.5rem' }}
      />
      <button type="submit">Add</button>
    </form>
  )
}
`,
    "src/ui/user/Settings.tsx": `import { useLocal } from 'aio/air'
import { user } from '../../cell/user/user.ts'

export function Settings() {
  const { local: editing, set: setEditing } = useLocal(false)
  const { local: name, set: setName } = useLocal('')

  const save = () => {
    const trimmed = name.trim()
    if (trimmed) user.setName(trimmed)
    setEditing(false)
  }

  return (
    <div style={{ padding: '1rem', background: '#f9f9f9', borderRadius: '6px', marginTop: '1rem' }}>
      <h3 style={{ margin: '0 0 0.5rem' }}>Settings</h3>
      {editing ? (
        <form onSubmit={e => { e.preventDefault(); save() }} style={{ display: 'flex', gap: '0.5rem' }}>
          <input value={name} onChange={e => setName(e.currentTarget.value)} placeholder="Your name" style={{ padding: '0.3rem' }} />
          <button type="submit">Save</button>
        </form>
      ) : (
        <button type="button" onClick={() => { setName(user.name); setEditing(true) }}>Change name</button>
      )}
    </div>
  )
}
`,
    "src/App.tsx": `import { user } from './cell/user/user.ts'
import { Header } from './ui/layout/Header.tsx'
import { TodoList } from './ui/todo/TodoList.tsx'
import { AddTodo } from './ui/todo/AddTodo.tsx'
import { Settings } from './ui/user/Settings.tsx'

export default function App() {
  const bg = user.theme === 'dark' ? '#1a1a2e' : '#fff'
  const fg = user.theme === 'dark' ? '#e0e0e0' : '#222'

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
  };
}

// ── App type post-processing ──

function applyAppType(
  files: Record<string, string>,
  appType: AppType,
  title: string,
): Record<string, string> {
  if (!appType.hasServer) return clientOnlyFiles(appType, title);

  const result: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    // Strip UI files for headless types
    if (!appType.hasUI && (path.endsWith(".tsx") || path.includes("src/ui/"))) {
      continue;
    }
    result[path] = content;
  }

  // Inject client: 'server-only' for server types without UI
  if (!appType.hasUI && result["src/app.ts"]) {
    result["src/app.ts"] = result["src/app.ts"].replace(
      /ui:\s*\{[^}]*\},?\n/,
      `client: 'server-only',\n`,
    );
  }

  // Browser types: dev task already uses --client=browser; no need to bake client:'browser' into app.ts
  // (keeps config clean and lets users switch to Electron by just removing --client=browser)

  // Auth hint for remote server types — inside config object
  if (appType.isRemote && appType.hasServer && result["src/app.ts"]) {
    result["src/app.ts"] = result["src/app.ts"].replace(
      /\n\}\)\n$/,
      `\n  // users: { 'change-me-token': { id: 'admin', role: 'admin' } },\n})\n`,
    );
  }

  return result;
}

function clientOnlyFiles(
  appType: AppType,
  title: string,
): Record<string, string> {
  if (appType.id === "remote-electron") {
    return {
      "src/app.ts": `import { aio, cell } from 'aio'

// ${title} — Electron remote client
// Dev:     deno task dev                              (opens connect page)
// Direct:  deno task dev --server-url=http://server:8000
// Build:   deno task compile                          (AppImage)

const _stub = cell('app', { state: {}, methods: {} })
await aio.run({
  appId: '${slug(title)}',
  appVersion: '0.1.0',
  cells: [_stub],
  ui: { title: '${title}' },
  baseDir: import.meta.dirname!,
})
`,
    };
  }

  // remote-android: connect page HTML served locally for dev, APK for compile
  return {
    "src/app.ts": `import { aio, cell } from 'aio'

// ${title} — Android remote client
// Dev:   deno task dev        (serves connect page at http://localhost:8000)
// Build: deno task compile    (APK)

const _stub = cell('app', { state: {}, methods: {} })
await aio.run({
  appId: '${slug(title)}',
  appVersion: '0.1.0',
  cells: [_stub],
  ui: { title: '${title}' },
  baseDir: import.meta.dirname!,
})
`,
    "src/App.tsx": `import { useLocal } from 'aio/air'

export default function App() {
  const { local: url, set: setUrl } = useLocal('')

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
          onChange={e => setUrl(e.currentTarget.value)}
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
  };
}

// ── CLI client templates (remote-cli) ──

function cliTemplateEmpty(_title: string): Record<string, string> {
  return {
    "src/client.ts": `import { connectCli } from 'aio'

type State = { count: number }

const url = Deno.args[0] || 'ws://localhost:8000/ws'
console.log('Connecting to', url, '...')

const app = connectCli<State>(url)
await app.ready
console.log('Connected! State:', app.state)

app.subscribe(state => {
  console.log('State updated:', state)
})

// Example: send an action to a methods-style cell.
// A call to \`counter.increment(1)\` on the server maps to:
// app.send({ type: 'counter:increment', payload: { args: [1] } })

// Keep alive — Ctrl+C to exit
await new Promise(() => {})
`,
  };
}

function cliTemplateMinimal(_title: string): Record<string, string> {
  return {
    "src/state.ts":
      `// Mirror of server state — cell 'counter' namespaces its state
export type AppState = { counter: { count: number } }
`,
    "src/commands.ts":
      `export function parseCommand(args: string[]): { type: string; payload?: unknown } | null {
  const [cmd, ...rest] = args
  switch (cmd) {
    case 'inc': return { type: 'counter:increment', payload: { args: [Number(rest[0]) || 1] } }
    case 'dec': return { type: 'counter:decrement', payload: { args: [Number(rest[0]) || 1] } }
    case 'reset': return { type: 'counter:reset', payload: { args: [] } }
    default: return null
  }
}

export function printHelp(): void {
  console.log('Commands: inc [n], dec [n], reset')
}
`,
    "src/client.ts": `import { connectCli } from 'aio'
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
  };
}

function cliTemplateMedium(_title: string): Record<string, string> {
  return {
    "src/types.ts": `export type TodoItem = {
  id: number
  text: string
  done: boolean
}
`,
    "src/state.ts": `import type { TodoItem } from './types.ts'

export type AppState = {
  todo: { items: TodoItem[]; nextId: number }
}
`,
    "src/commands.ts":
      `export function parseCommand(args: string[]): { type: string; payload?: unknown } | null {
  const [cmd, ...rest] = args
  switch (cmd) {
    case 'add': {
      const text = rest.join(' ').trim()
      return text ? { type: 'todo:addTodo', payload: { args: [text] } } : null
    }
    case 'toggle': return rest[0] ? { type: 'todo:toggleTodo', payload: { args: [Number(rest[0])] } } : null
    case 'remove': return rest[0] ? { type: 'todo:removeTodo', payload: { args: [Number(rest[0])] } } : null
    case 'list': return null // handled in client
    default: return null
  }
}

export function printHelp(): void {
  console.log('Commands: add <text>, toggle <id>, remove <id>, list')
}
`,
    "src/display.ts": `import type { AppState } from './state.ts'

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
    "src/client.ts": `import { connectCli } from 'aio'
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
  };
}

function cliTemplateLarge(_title: string): Record<string, string> {
  return {
    "src/model/todo/todo-types.ts": `export type TodoItem = {
  id: number
  text: string
  done: boolean
}

export type TodoState = {
  items: TodoItem[]
  nextId: number
}
`,
    "src/model/user/user-types.ts": `export type UserState = {
  name: string
  theme: 'light' | 'dark'
}
`,
    "src/state.ts": `import type { TodoState } from './model/todo/todo-types.ts'
import type { UserState } from './model/user/user-types.ts'

export type AppState = {
  todo: TodoState
  user: UserState
}
`,
    "src/commands/todo.ts":
      `export function parseTodoCommand(args: string[]): { type: string; payload?: unknown } | null {
  const [cmd, ...rest] = args
  switch (cmd) {
    case 'add': {
      const text = rest.join(' ').trim()
      return text ? { type: 'todo:addTodo', payload: { args: [text] } } : null
    }
    case 'toggle': return rest[0] ? { type: 'todo:toggleTodo', payload: { args: [Number(rest[0])] } } : null
    case 'remove': return rest[0] ? { type: 'todo:removeTodo', payload: { args: [Number(rest[0])] } } : null
    case 'clear': return { type: 'todo:clearDone', payload: { args: [] } }
    default: return null
  }
}
`,
    "src/commands/user.ts":
      `export function parseUserCommand(args: string[]): { type: string; payload?: unknown } | null {
  const [cmd, ...rest] = args
  switch (cmd) {
    case 'name': {
      const name = rest.join(' ').trim()
      return name ? { type: 'user:setName', payload: { args: [name] } } : null
    }
    case 'theme': return { type: 'user:toggleTheme', payload: { args: [] } }
    default: return null
  }
}
`,
    "src/display.ts": `import type { AppState } from './state.ts'

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
    "src/client.ts": `import { connectCli } from 'aio'
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
  };
}

// ── Template registry ──

type Template = {
  label: string;
  desc: string;
  fn: (title: string) => Record<string, string>;
};

function getTemplates(appType: AppType): Template[] {
  const ui = appType.hasUI;
  return [
    {
      label: "Empty",
      desc: ui
        ? "2 files — inline cell + App.tsx. Fastest start."
        : "1 file — inline cell. Fastest start.",
      fn: templateEmpty,
    },
    {
      label: "Minimal",
      desc: ui
        ? "3 files — counter cell + app entry + UI. Methods style."
        : "2 files — counter cell + app entry. Methods style.",
      fn: templateMinimal,
    },
    {
      label: "Medium",
      desc: ui
        ? "5 files — todo cell + UI components. Cell API."
        : "2 files — todo cell + app entry. Cell API.",
      fn: templateMedium,
    },
    {
      label: "Large",
      desc: ui
        ? "9 files — todo + user cells + UI hierarchy. Full architecture."
        : "3 files — todo + user cells + app entry. Full architecture.",
      fn: templateLarge,
    },
  ];
}

function getCliTemplates(): Template[] {
  return [
    {
      label: "Empty",
      desc: "1 file — src/client.ts, inline state type. Fastest start.",
      fn: cliTemplateEmpty,
    },
    {
      label: "Minimal",
      desc: "3 files — state + commands. Counter client.",
      fn: cliTemplateMinimal,
    },
    {
      label: "Medium",
      desc: "5 files — types + commands + display. Todo client.",
      fn: cliTemplateMedium,
    },
    {
      label: "Large",
      desc: "7 files — model + command modules + display. Todo + user client.",
      fn: cliTemplateLarge,
    },
  ];
}

// ── Main export ──

export async function create(args: string[]): Promise<void> {
  // Parse args
  let rawPath = "";
  let mirror = false;
  let vendored = false;
  let typeFlag = "";
  let templateFlag = "";
  for (const a of args) {
    if (a === "--mirror") mirror = true;
    else if (a === "--vendored") vendored = true;
    else if (a.startsWith("--type=")) typeFlag = a.slice(7);
    else if (a.startsWith("--template=")) templateFlag = a.slice(11);
    else if (!a.startsWith("--")) rawPath = a;
  }

  if (!rawPath) rawPath = await prompt("Project path", "./my-app");

  const projectDir = expandPath(rawPath);
  const name = projectDir.split("/").pop()!.replace(/[^a-zA-Z0-9_-]/g, "-")
    .toLowerCase() || "my-app";
  const title = titleCase(name);

  // Check if dir already exists
  try {
    await Deno.stat(projectDir);
    console.log(
      `\n${c.red}✗${c.reset} Directory ${c.bold}${projectDir}${c.reset} already exists`,
    );
    Deno.exit(1);
  } catch { /* good */ }

  // App type selection — skip menu with --type flag
  let appType: AppType;
  if (typeFlag) {
    const found = APP_TYPES.find((t) => t.id === typeFlag);
    if (!found) {
      console.error(`${c.red}✗${c.reset} Unknown app type: ${typeFlag}`);
      console.error(`  Valid types: ${APP_TYPES.map((t) => t.id).join(", ")}`);
      Deno.exit(1);
    }
    appType = found;
  } else {
    appType = await groupedMenu();
  }

  // Template selection
  let files: Record<string, string>;
  let templateLabel: string;

  if (appType.hasServer) {
    const templates = getTemplates(appType);
    if (templateFlag) {
      const idx = templates.findIndex((t) =>
        t.label.toLowerCase() === templateFlag.toLowerCase()
      );
      if (idx === -1) {
        console.error(`${c.red}✗${c.reset} Unknown template: ${templateFlag}`);
        console.error(
          `  Valid templates: ${
            templates.map((t) => t.label.toLowerCase()).join(", ")
          }`,
        );
        Deno.exit(1);
      }
      templateLabel = templates[idx]!.label;
      files = applyAppType(templates[idx]!.fn(title), appType, title);
    } else {
      const choice = await menu("Choose a template:", templates);
      templateLabel = templates[choice]!.label;
      files = applyAppType(templates[choice]!.fn(title), appType, title);
    }
  } else if (appType.id === "remote-cli") {
    const templates = getCliTemplates();
    if (templateFlag) {
      const idx = templates.findIndex((t) =>
        t.label.toLowerCase() === templateFlag.toLowerCase()
      );
      if (idx === -1) {
        console.error(`${c.red}✗${c.reset} Unknown template: ${templateFlag}`);
        console.error(
          `  Valid templates: ${
            templates.map((t) => t.label.toLowerCase()).join(", ")
          }`,
        );
        Deno.exit(1);
      }
      templateLabel = templates[idx]!.label;
      files = templates[idx]!.fn(title);
    } else {
      const choice = await menu("Choose a template:", templates);
      templateLabel = templates[choice]!.label;
      files = templates[choice]!.fn(title);
    }
  } else {
    templateLabel = "client";
    files = clientOnlyFiles(appType, title);
  }

  await Deno.mkdir(projectDir, { recursive: true });
  console.log(
    `\n${c.cyan}▸${c.reset} Creating ${c.bold}${name}/${c.reset} — ${c.cyan}${appType.label}${c.reset} (${templateLabel})`,
  );

  if (mirror) {
    await mirrorFramework(projectDir);
  } else if (vendored) {
    await cloneFramework(projectDir);
  } else {
    await downloadFramework(projectDir);
  }

  await writeFile(projectDir, "deno.json", denoJson(title, appType));

  for (const [path, content] of Object.entries(files)) {
    await writeFile(projectDir, path, content);
  }

  await writeFile(
    projectDir,
    ".gitignore",
    `node_modules/
dist/
*.db
*.sqlite
.env
`,
  );

  console.log(
    `${c.green}✓${c.reset} ${Object.keys(files).length + 2} files written`,
  );

  // Install deps
  console.log(`\n${c.cyan}▸${c.reset} Installing dependencies...`);

  const isElectronType = appType.id === "electron" ||
    appType.id === "remote-electron";
  if (isElectronType) {
    // Approve electron build scripts first so deno install runs postinstall
    const approve = new Deno.Command("deno", {
      args: ["approve-scripts", "npm:electron"],
      cwd: projectDir,
      stdout: "inherit",
      stderr: "inherit",
    });
    await approve.output();
  }

  const install = new Deno.Command("deno", {
    args: ["install"],
    cwd: projectDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { success } = await install.output();
  if (success) {
    console.log(`${c.green}✓${c.reset} Dependencies installed`);
  } else {
    console.error(
      `${c.red}✗${c.reset} deno install failed — run manually: cd ${name} && deno install`,
    );
  }

  // Done message — adapt to app type
  const hint = appType.id === "remote-cli"
    ? `  ${c.dim}deno task dev${c.reset}\n\n${c.dim}Connects to a running aio server (default: ws://localhost:8000/ws).${c.reset}`
    : appType.id === "remote-electron"
    ? `  ${c.dim}deno task dev${c.reset}                             ${c.dim}Open connect page${c.reset}\n  ${c.dim}deno task dev -- --server-url=http://server:8000${c.reset}  ${c.dim}Connect directly${c.reset}`
    : appType.id === "remote-android"
    ? `  ${c.dim}deno task dev${c.reset}\n\n${c.dim}Then open ${c.cyan}http://localhost:8000${c.dim} — connect page for testing.${c.reset}`
    : appType.id === "electron"
    ? `  ${c.dim}deno task dev${c.reset}\n\n${c.dim}Electron window opens automatically. Skip it with ${c.reset}--client=browser${c.dim} (browser tab instead).${c.reset}`
    : appType.hasUI
    ? `  ${c.dim}deno task dev${c.reset}\n\n${c.dim}Then open ${c.cyan}http://localhost:8000${c.dim} in your browser.${c.reset}`
    : `  ${c.dim}deno task dev${c.reset}`;

  console.log(`
${c.green}${c.bold}Done!${c.reset} Your aio app is ready.

  ${c.dim}cd ${projectDir}${c.reset}
${hint}
`);
}

// ── Test exports ──

export const _test = {
  templateEmpty,
  templateMinimal,
  templateMedium,
  templateLarge,
  cliTemplateEmpty,
  cliTemplateMinimal,
  cliTemplateMedium,
  cliTemplateLarge,
  getTemplates,
  getCliTemplates,
  applyAppType,
  clientOnlyFiles,
  denoJson,
  APP_TYPES,
};

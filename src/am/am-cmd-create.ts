/**
 * @module
 * `am create` — scaffold a new aio project (onboard kata). Non-interactive,
 * single command: `am create <name> [--template=counter|todo]`. Produces a
 * minimal, immediately runnable app pinned to this am's aio version (JSR), so
 * `am@X create` and the app's `aio@X` stay in lockstep.
 *
 *   am create my-app                 # counter (default)
 *   am create my-app --template=todo # todo list
 *   am create my-app --mirror        # framework-dev: import aio from the repo
 */

import { VERSION } from "../server/aio.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { resolve } from "@std/path";

const PKG = "@riagentic/aio";
const TEMPLATES = ["counter", "todo"] as const;
export type Template = (typeof TEMPLATES)[number];

/** Parsed `am create` options. */
export type CreateOpts = {
  name?: string;
  template: Template;
  force: boolean;
  /** Framework-dev: import aio from a local repo copy instead of JSR. */
  mirror?: string;
};

/** Parse positional name + create-scoped flags out of the raw args. Unknown
 *  `--flags` are ignored (am's global parser already handled the shared ones). */
export function parseCreateArgs(args: string[]): CreateOpts {
  const opts: CreateOpts = { template: "counter", force: false };
  for (const a of args) {
    if (a === "--force") opts.force = true;
    else if (a === "--mirror" || a === "--dev") opts.mirror = "";
    else if (a.startsWith("--mirror=")) opts.mirror = a.slice(9);
    else if (a.startsWith("--template=")) {
      opts.template = a.slice(11) as Template;
    } else if (!a.startsWith("-") && opts.name === undefined) opts.name = a;
  }
  return opts;
}

/** Framework import specifiers — JSR-pinned by default (version-locked to this
 *  am), or local-repo paths in mirror mode. */
export function frameworkSpecs(mirrorRoot?: string): {
  imports: Record<string, string>;
  build: string;
  am: string;
  doctor: string;
  aiol: string;
} {
  if (mirrorRoot) {
    // Consuming framework SOURCE — the app's map must also carry the source's
    // own bare deps (esbuild/immer/…), which JSR would otherwise resolve.
    return {
      imports: {
        "aio": `${mirrorRoot}/mod.ts`,
        "aio/air": `${mirrorRoot}/src/air.ts`,
        "aio/jsx-runtime": `${mirrorRoot}/src/jsx-runtime.ts`,
        "aio/testing": `${mirrorRoot}/src/cell-test.ts`,
        "esbuild": "npm:esbuild@^0.24",
        "immer": "npm:immer@^10",
        "happy-dom": "npm:happy-dom@^17",
        "@std/path": "jsr:@std/path@^1",
        "@std/assert": "jsr:@std/assert@^1",
      },
      build: `${mirrorRoot}/src/build.ts`,
      am: `${mirrorRoot}/src/am.ts`,
      doctor: `${mirrorRoot}/src/server/doctor.ts`,
      aiol: `${mirrorRoot}/aiol/mod.ts`,
    };
  }
  // JSR: the published package resolves its own deps, so the app map stays tiny.
  const v = `jsr:${PKG}@${VERSION}`;
  return {
    imports: {
      "aio": v,
      "aio/air": `${v}/air`,
      "aio/jsx-runtime": `${v}/jsx-runtime`,
      "aio/testing": `${v}/testing`,
    },
    build: `${v}/build`,
    am: `${v}/am`,
    doctor: `${v}/doctor`,
    aiol: `${v}/aiol`,
  };
}

/** Build the app's `deno.json` — one `deno task` line per target so the app is
 *  runnable (`dev`) and buildable to a binary (`compile`), Electron desktop
 *  (`electron`), Android APK (`android`), and headless service (`service`). */
export function denoJson(name: string, mirrorRoot?: string): string {
  const fw = frameworkSpecs(mirrorRoot);
  const obj = {
    title: name,
    version: "0.1.0",
    nodeModulesDir: "auto",
    unstable: ["kv"],
    compilerOptions: {
      lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
      jsx: "react-jsx",
      jsxImportSource: "aio",
    },
    imports: fw.imports,
    tasks: {
      dev: "deno run -A src/app.ts",
      compile: `deno run -A ${fw.build} --compile`,
      electron: `deno run -A ${fw.build} --compile --electron`,
      android: `deno run -A ${fw.build} --android`,
      service: `deno run -A ${fw.build} --compile --service --headless`,
      "compile:client": `deno run -A ${fw.build} --client`,
      "install:electron": "deno install --allow-scripts=npm:electron",
      test: "deno test -A",
      am: `deno run -A ${fw.am}`,
      doctor: `deno run -A ${fw.doctor}`,
      lint: `deno run -A ${fw.aiol}`,
    },
  };
  return JSON.stringify(obj, null, 2) + "\n";
}

const GITIGNORE = `.aio/
dist/
node_modules/
*.sqlite
`;

/** Full file set for a new project — pure (path → content), no disk I/O. */
export function scaffold(
  name: string,
  template: Template,
  mirrorRoot?: string,
): Record<string, string> {
  // `src/`-based layout: aio infers baseDir from the entry (so `dev` finds
  // src/App.tsx), and the compile pipeline (build.ts) expects src/App.tsx too —
  // one layout that satisfies both `deno task dev` and `deno task compile`.
  const files: Record<string, string> = {
    "deno.json": denoJson(name, mirrorRoot),
    ".gitignore": GITIGNORE,
    "src/app.ts": template === "todo" ? TODO_APP : COUNTER_APP,
    "src/cell.ts": template === "todo" ? TODO_CELL : COUNTER_CELL,
    "src/App.tsx": template === "todo" ? TODO_UI : COUNTER_UI,
    "src/cell.test.ts": template === "todo" ? TODO_TEST : COUNTER_TEST,
    "README.md": readme(name, template),
  };
  return files;
}

export async function cmdCreate(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const opts = parseCreateArgs(args);

  if (!opts.name) {
    outError(
      "usage: am create <name> [--template=counter|todo]",
      mode,
    );
    return;
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(opts.name)) {
    outError(
      `invalid project name '${opts.name}' — start with a letter/digit, then letters, digits, '-', '_', '.'`,
      mode,
    );
    return;
  }
  if (!TEMPLATES.includes(opts.template)) {
    outError(
      `unknown template '${opts.template}' — choose: ${TEMPLATES.join(", ")}`,
      mode,
    );
    return;
  }

  const dir = resolve(Deno.cwd(), opts.name);
  // Refuse a non-empty target — never clobber existing work silently.
  try {
    const entries = [...Deno.readDirSync(dir)];
    if (entries.length > 0 && !opts.force) {
      outError(
        `'${opts.name}' already exists and is not empty — pick another name or pass --force`,
        mode,
      );
      return;
    }
  } catch { /* doesn't exist — good */ }

  // Mirror path resolves to the framework repo this am runs from (dev only).
  let mirrorRoot: string | undefined;
  if (opts.mirror !== undefined) {
    const root = opts.mirror
      ? resolve(Deno.cwd(), opts.mirror)
      : repoRoot();
    if (!root) {
      outError(
        "--mirror needs the framework repo — run am from the repo, or pass --mirror=<path-to-aio>",
        mode,
      );
      return;
    }
    mirrorRoot = root;
  }

  // Dev footgun guard: an `am` running from the framework repo (not JSR-
  // installed) pins the app to `jsr:@riagentic/aio@${VERSION}` — which may be
  // an UNPUBLISHED dev version, so the app's `deno task dev` would fail to
  // resolve. Real users (JSR-installed am) always report a published VERSION,
  // so this only fires for framework devs — tell them to use --mirror.
  if (!mirrorRoot && repoRoot() && !flags.json) {
    console.error(
      `⚠ am is running from the framework source — the new app pins ` +
        `jsr:${PKG}@${VERSION}, which may be unpublished.\n` +
        `  For local framework work, re-run with --mirror to import aio from this repo.`,
    );
  }

  const files = scaffold(opts.name, opts.template, mirrorRoot);
  await Deno.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const path = resolve(dir, rel);
    // Nested paths (src/app.ts) need their parent dir created first.
    await Deno.mkdir(resolve(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }

  // Make it a real project from second one — best-effort, never fatal.
  const gitInit = await tryGitInit(dir);

  if (flags.json) {
    out({
      created: opts.name,
      template: opts.template,
      files: Object.keys(files),
      git: gitInit,
    }, "json");
    return;
  }

  const C = mode === "pretty";
  const b = (s: string) => C ? `\x1b[1m${s}\x1b[0m` : s;
  const dim = (s: string) => C ? `\x1b[2m${s}\x1b[0m` : s;
  const cyan = (s: string) => C ? `\x1b[36m${s}\x1b[0m` : s;
  const grn = (s: string) => C ? `\x1b[32m${s}\x1b[0m` : s;
  out(
    [
      "",
      `  ${grn("✓")} ${b(opts.name)} ${dim(`— aio ${opts.template} app`)}${
        gitInit ? dim("  ·  git initialized") : ""
      }`,
      "",
      `  ${dim("run it")}`,
      `    cd ${opts.name}`,
      `    ${cyan("deno task dev")}       ${dim("→ opens in your browser")}`,
      "",
      `  ${dim("ship it — one line each")}`,
      `    ${cyan("deno task compile")}   ${dim("→ a single binary")}`,
      `    ${cyan("deno task electron")}  ${dim("→ desktop app")}`,
      `    ${cyan("deno task android")}   ${dim("→ APK")}`,
      "",
      `  ${dim("also:")} ${cyan("deno task test")} ${dim("·")} ${
        cyan("deno task am status")
      } ${dim("·")} ${cyan("deno task lint")}`,
      "",
    ].join("\n"),
    mode,
  );
}

/** `git init` + first commit so the new project has history from minute one.
 *  Best-effort: no git, or an existing repo, is fine — never fails the create. */
async function tryGitInit(dir: string): Promise<boolean> {
  try {
    // Already inside a repo? Don't nest one.
    const inside = await new Deno.Command("git", {
      args: ["rev-parse", "--is-inside-work-tree"],
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).output();
    if (inside.success) return false;
    const run = (args: string[]) =>
      new Deno.Command("git", { args, cwd: dir, stdout: "null", stderr: "null" })
        .output();
    if (!(await run(["init"])).success) return false;
    await run(["add", "-A"]);
    await run(["commit", "-m", "initial commit — scaffolded with am"]);
    return true;
  } catch {
    return false; // git not installed — fine.
  }
}

/** The framework repo root when am runs from source (deno task am); undefined
 *  when am is a JSR-installed global. */
function repoRoot(): string | undefined {
  // src/am/am-cmd-create.ts → repo root is three levels up.
  const dir = import.meta.dirname;
  if (!dir) return undefined;
  const root = resolve(dir, "..", "..");
  try {
    Deno.statSync(resolve(root, "mod.ts"));
    return root;
  } catch {
    return undefined;
  }
}

function readme(name: string, template: Template): string {
  return `# ${name}

An [aio](https://jsr.io/${PKG}) app (${template} template).

\`\`\`sh
deno task dev          # run in the browser
deno task test         # run the starter test
deno task compile      # build a single binary
deno task electron     # build a desktop app
deno task android      # build an Android APK
\`\`\`

State lives in \`src/cell.ts\`, UI in \`src/App.tsx\`, entry in \`src/app.ts\`.
Manage a running app with \`deno task am\` (status, state, logs, …).
`;
}

// ── Templates ──────────────────────────────────────────────────────────────
// Kept in lockstep with examples/counter and examples/todo — the two apps aio
// ships out of the box.

const COUNTER_CELL = `// Cell — pure state + methods; UI and server both import from here.
import { cell } from "aio";

// Persists by default — restart and the count survives.
export const counter = cell("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
    decrement(s, by = 1) {
      s.count -= by;
    },
    reset(s) {
      s.count = 0;
    },
  },
});
`;

const COUNTER_APP = `// Entry — zero-config: cells self-register on import; appId/version/baseDir
// are inferred from deno.json + this file's location.
import "./cell.ts";
import { aio } from "aio";

await aio.run();
`;

const COUNTER_UI = `// UI — export default; the framework mounts it.
import { counter } from "./cell.ts";

const btn: Record<string, string> = {
  padding: "0.75rem 1.5rem",
  fontSize: "1.25rem",
  cursor: "pointer",
};

export default function App() {
  return (
    <div style={{ padding: "3rem", fontFamily: "system-ui, sans-serif", textAlign: "center" }}>
      <h1>AIO Counter</h1>
      <div style={{ fontSize: "4rem", margin: "1rem 0", color: "#00a6cc" }}>
        {counter.count}
      </div>
      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center" }}>
        <button type="button" onClick={() => counter.decrement()} style={btn}>−</button>
        <button type="button" onClick={() => counter.reset()} style={btn}>Reset</button>
        <button type="button" onClick={() => counter.increment()} style={btn}>+</button>
      </div>
    </div>
  );
}
`;

const COUNTER_TEST = `// A starter test — \`deno task test\`. Cells are pure, so they test in isolation
// (no server, no DOM) with the testCell harness.
import { testCell } from "aio/testing";
import { counter } from "./cell.ts";

testCell(counter, "increments, adds, and resets", (t) => {
  t.send.increment();
  t.send.increment(5);
  t.expect.state((s) => s.count === 6);
  t.send.reset();
  t.expect.state((s) => s.count === 0);
});
`;

const TODO_CELL = `// Cells — pure state + methods; UI and server both import from here.
import { cell } from "aio";

export type Todo = { id: number; text: string; done: boolean };
export type Filter = "all" | "active" | "done";

export const todo = cell("todo", {
  state: {
    items: [] as Todo[],
    nextId: 1,
  },
  methods: {
    add(s, text: string) {
      s.items.push({ id: s.nextId++, text, done: false });
    },
    toggle(s, id: number) {
      const item = s.items.find((t) => t.id === id);
      if (item) item.done = !item.done;
    },
    remove(s, id: number) {
      s.items = s.items.filter((t) => t.id !== id);
    },
    clearDone(s) {
      s.items = s.items.filter((t) => !t.done);
    },
  },
});

// Per-tab UI state — client-scoped: never syncs, never persists.
export const view = cell("view", {
  scope: "client",
  state: { filter: "all" as Filter },
  methods: {
    setFilter(s, filter: Filter) {
      s.filter = filter;
    },
  },
});
`;

const TODO_TEST = `// A starter test — \`deno task test\`. Cells are pure, so they test in isolation
// (no server, no DOM) with the testCell harness.
import { testCell } from "aio/testing";
import { todo } from "./cell.ts";

testCell(todo, "adds, toggles, and clears items", (t) => {
  t.send.add("write a test");
  t.send.add("ship it");
  t.expect.state((s) => s.items.length === 2);
  t.send.toggle(1);
  t.expect.state((s) => s.items[0].done === true);
  t.send.clearDone();
  t.expect.state((s) => s.items.length === 1);
});
`;

const TODO_APP = `// Entry — zero-config: cells self-register on import.
import "./cell.ts";
import { aio } from "aio";

export type { Filter, Todo } from "./cell.ts";

await aio.run();
`;

const TODO_UI = `// UI — a filterable todo list.
import { useLocal } from "aio/air";
import { type Filter, type Todo, todo, view } from "./cell.ts";

const FILTERS: Filter[] = ["all", "active", "done"];

export default function App() {
  const { local: input, set: setInput } = useLocal("");

  const filtered: Todo[] = todo.items.filter((t: Todo) =>
    view.filter === "all" ? true : view.filter === "done" ? t.done : !t.done
  );
  const remaining = todo.items.filter((t: Todo) => !t.done).length;

  return (
    <div style={{ maxWidth: 480, margin: "2rem auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ textAlign: "center", color: "#c77" }}>todos</h1>

      <form
        onSubmit={() => {
          if (input.trim()) {
            todo.add(input.trim());
            setInput("");
          }
        }}
        style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          placeholder="What needs to be done?"
          style={{ flex: 1, padding: "0.5rem", fontSize: "1rem" }}
        />
        <button type="submit" style={{ padding: "0.5rem 1rem" }}>Add</button>
      </form>

      <ul style={{ listStyle: "none", padding: 0 }}>
        {filtered.map((t) => (
          <li
            key={t.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.5rem 0",
              borderBottom: "1px solid #eee",
            }}
          >
            <input type="checkbox" checked={t.done} onChange={() => todo.toggle(t.id)} />
            <span
              style={{
                flex: 1,
                textDecoration: t.done ? "line-through" : "none",
                color: t.done ? "#999" : "inherit",
              }}
            >
              {t.text}
            </span>
            <button
              type="button"
              onClick={() => todo.remove(t.id)}
              style={{ color: "#c44", border: "none", background: "none", cursor: "pointer" }}
            >
              x
            </button>
          </li>
        ))}
      </ul>

      {todo.items.length > 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: "0.5rem",
            fontSize: "0.85rem",
            color: "#888",
          }}
        >
          <span>{remaining} item{remaining !== 1 ? "s" : ""} left</span>
          <div style={{ display: "flex", gap: "0.25rem" }}>
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => view.setFilter(f)}
                style={{
                  padding: "0.2rem 0.5rem",
                  border: view.filter === f ? "1px solid #c77" : "1px solid transparent",
                  background: "none",
                  cursor: "pointer",
                  borderRadius: 3,
                }}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => todo.clearDone()}
            style={{ border: "none", background: "none", cursor: "pointer", color: "#888" }}
          >
            Clear done
          </button>
        </div>
      )}
    </div>
  );
}
`;

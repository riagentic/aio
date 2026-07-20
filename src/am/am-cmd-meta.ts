/**
 * @module
 * Meta commands for am — version, new, help.
 */

import { VERSION } from "../server/aio.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { repoRoot } from "./am-cmd-create.ts";

const PKG = "@riagentic/aio";

export function cmdVersion(_args: string[], flags: GlobalFlags): void {
  const mode = detectMode(flags);
  out(mode === "pretty" ? `am ${VERSION}` : { version: VERSION }, mode);
}

/** `deno` argv that (re)installs the latest `am` as a global — used by both the
 *  curl installer and `am update`, so there is exactly one install recipe.
 *  `--reload` bypasses the module cache so "latest" is really latest; `-f`
 *  overwrites the existing `am`, making update idempotent. */
export function updateArgv(): string[] {
  // Prerelease range, not a bare spec: a bare `jsr:@riagentic/aio` resolves to
  // the latest STABLE (an old 0.9.x with no ./am export). `^1.0.0-alpha` lands
  // on the newest alpha and widens to 1.0.0 final automatically once it ships.
  return [
    "install",
    "-gAf",
    "--reload",
    "-n",
    "am",
    `jsr:${PKG}@^1.0.0-alpha/am`,
  ];
}

/** `deno` argv that removes the global `am`. Only touches the installed CLI —
 *  aio apps on disk are never read or modified. */
export function uninstallArgv(): string[] {
  return ["uninstall", "-g", "am"];
}

async function runDeno(argv: string[]): Promise<number> {
  const cmd = new Deno.Command("deno", {
    args: argv,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  return code;
}

export async function cmdUpdate(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  // Source install (the default): am runs from a git checkout — update it in
  // place with `git pull`. am points at the live files, so the next run picks
  // up the change. JSR install: reinstall the newest alpha.
  const root = repoRoot();
  if (root) {
    const git = new Deno.Command("git", {
      args: ["-C", root, "pull", "--ff-only"],
      stdout: "inherit",
      stderr: "inherit",
    });
    const { code } = await git.output();
    if (code !== 0) {
      outError(`git pull failed in ${root} — resolve conflicts and retry`, mode);
      Deno.exit(code);
    }
    out(mode === "json" ? { updated: true, via: "git" } : `✓ aio updated (${root})`, mode);
    return;
  }
  const code = await runDeno(updateArgv());
  if (code !== 0) {
    outError(`update failed (deno exit ${code})`, mode);
    Deno.exit(code);
  }
  out(mode === "json" ? { updated: true, via: "jsr" } : "✓ am updated to the latest release", mode);
}

export async function cmdUninstall(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const code = await runDeno(uninstallArgv());
  if (code !== 0) {
    outError(
      `uninstall failed (deno exit ${code}) — am may not be installed globally`,
      mode,
    );
    Deno.exit(code);
  }
  out(
    mode === "json"
      ? { uninstalled: true }
      : "✓ am removed — your aio apps are untouched",
    mode,
  );
}

export async function cmdNew(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const kind = args[0];
  const name = args[1];
  const mode = detectMode(flags);

  if (!kind || !name) {
    outError("usage: am new <cell|page> <name>", mode);
    return;
  }

  if (kind === "cell") {
    const dir = `src/cells/${name}`;
    const file = `${dir}/index.ts`;
    try {
      await Deno.stat(file);
      outError(`${file} already exists`, mode);
      return;
    } catch { /* ok */ }
    await Deno.mkdir(dir, { recursive: true });
    const content = `import { cell } from 'aio'

export const ${name} = cell('${name}', {
  state: {},
  methods: {
  },
})
`;
    await Deno.writeTextFile(file, content);
    out(flags.json ? { created: file } : `created ${file}`, mode);
  } else if (kind === "page") {
    const pascal = name.charAt(0).toUpperCase() + name.slice(1);
    const dir = "src/pages";
    const file = `${dir}/${pascal}.tsx`;
    try {
      await Deno.stat(file);
      outError(`${file} already exists`, mode);
      return;
    } catch { /* ok */ }
    await Deno.mkdir(dir, { recursive: true });
    const content = `import { useAio } from 'aio'

export function ${pascal}() {
  const { state } = useAio()
  if (!state) return <div>Loading\u2026</div>

  return (
    <div>
      <h1>${pascal}</h1>
    </div>
  )
}
`;
    await Deno.writeTextFile(file, content);
    out(flags.json ? { created: file } : `created ${file}`, mode);
  } else {
    outError(
      `unknown scaffold type: '${kind}' — use 'cell' or 'page'`,
      mode,
    );
  }
}

/** Show help text. Accepts command keys to list available commands. */
export function cmdHelp(
  _args: string[],
  flags: GlobalFlags,
  commandKeys: string[],
): void {
  if (flags.json) {
    out({ commands: commandKeys }, "json");
    return;
  }
  console.log(`am ${VERSION} — aio manager

Onboard:
  create <name> [--template=counter|todo]  Scaffold a new aio app (runnable + buildable)
  update                  Update am to the latest release
  uninstall               Remove am (your aio apps are untouched)

Process (singleton — one instance per app identity):
  start                   Start app (kills zombies, refuses if already running)
  stop                    Graceful shutdown (SIGTERM → SIGKILL)
  restart                 Stop + start
  watch [dir]             Hot-restart on .ts/.tsx change in dir (default: src/)
  status                  stopped|starting|started|stopping (exit 0=started, 1=stopped, 2=transitional)
  instances               List all running aio apps on this machine

State:
  state [path] [--wait=N] State query (dot-path, [*] wildcard, {pick})
  ui [user]               Server-side UI state (for live client UI use: surface)
  dispatch <Type> [k=v]   Dispatch action (or --body='{"type":...}')
  actions                 Time-travel history

Time-travel:
  tt undo|redo            Step back/forward
  tt goto <N>             Jump to index
  tt pause|resume         Freeze/unfreeze state

Persistence:
  persist                 Force immediate persist
  snapshot                Dump state JSON to stdout
  snapshot save [file]    Save snapshot to file
  snapshot load <file>    Load snapshot from file

Inspect:
  clients                 Connected WebSocket clients (with index)
  client <index>          Request component tree from client (dev mode)
  surface [clientIdx]     Semantic UI surface — every component + triggerable element, by name
  trigger <idx> <path> <action> [text]  Drive the live UI (click/type/press/hover/focus/blur/scroll) — same engine as testUI
  sql <query>             Execute read-only SQL
  tables                  List SQLite tables
  schedules               Active scheduled effects
  log [filter]            Tail app log (--client for client.log) (--filter --lines --follow)
  errors                  Last build error
  metrics                 Uptime, connections, schedules
  health                  HTTP health check
  discover [--timeout=ms] Find exposed aio apps on the LAN (UDP broadcast)
  profile [--out=file]    Export this app's .aioapp profile (cert + key) for the client
  config                  Server configuration

Scaffold:
  new cell <name>      Generate src/cells/<name>/index.ts
  new page <name>         Generate src/pages/<Name>.tsx

Other:
  version                 Print version
  help                    This message

Flags: --app=X  --port=N  --entry=<path>  --wait[=N]  --json  --quiet  --body='{...}'  --filter=X  --lines=N  --follow/-f  --transport=ws|uds  --client=N/-cN  --all

--app: target specific app by ID (default: resolved from deno.json name)
--entry: override entry point (default: deno.json "entry" > src/app.ts > src/main.ts)
--wait: start/stop block until complete (default 10s/5s). state polls every Ns.`);
}

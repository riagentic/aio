/**
 * @module
 * Meta commands for am — version, new, help.
 */

import { VERSION } from "../server/aio.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { repoRoot } from "./am-cmd-create.ts";
import { resolve } from "@std/path";

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

/** `deno` argv that installs am from a LOCAL checkout — the dev-am switch. */
export function installFromArgv(checkout: string): string[] {
  return [
    "install",
    "-gAf",
    "--config",
    `${checkout}/deno.json`,
    "-n",
    "am",
    `${checkout}/src/am.ts`,
  ];
}

/** The canonical install location — what plain `am update` returns you to. */
function canonicalRoot(): string {
  return Deno.env.get("AIO_HOME") ??
    `${Deno.env.get("HOME") ?? ""}/.local/lib/aio`;
}

export async function cmdUpdate(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);

  // `am update <path>` — switch the GLOBAL am to a local checkout's am (a DEV
  // am, running that checkout's live files: your unpushed edits apply
  // immediately). The complement of a per-app path pin: it works everywhere,
  // including before any app exists (`am create`, `am pin` themselves).
  // Plain `am update` returns to the released am from the canonical install.
  const pathArg = args.find((a) => !a.startsWith("--"));
  if (pathArg) {
    const checkout = resolve(Deno.cwd(), pathArg);
    for (const probe of ["mod.ts", "src/am.ts", "deno.json"]) {
      try {
        await Deno.stat(`${checkout}/${probe}`);
      } catch {
        outError(
          `${checkout} is not an aio checkout (${probe} missing) — ` +
            `point at a framework clone, e.g. am update ~/code/aio`,
          mode,
        );
        Deno.exit(1);
      }
    }
    const code = await runDeno(installFromArgv(checkout));
    if (code !== 0) {
      outError(`install from ${checkout} failed (deno exit ${code})`, mode);
      Deno.exit(code);
    }
    console.error(
      `⚠ global am now runs from ${checkout} — a DEV am on live files ` +
        `(your edits apply immediately). Plain "am update" returns to the ` +
        `released am.`,
    );
    out(
      mode === "json"
        ? { updated: true, via: "path", checkout }
        : `✓ am → ${checkout} (dev)`,
      mode,
    );
    return;
  }

  // Source install (the default): am runs from a git checkout — fetch and check
  // out the LAST TAGGED release (not the branch tip / WIP). am points at the
  // live files, so the next run picks up the change. JSR install: reinstall.
  let root = repoRoot();
  // Dev-am state (am running from some checkout that is NOT the canonical
  // install): NEVER git-mutate that checkout — `git checkout --force <tag>`
  // inside a developer's working repo would destroy their WIP. Return to the
  // canonical install instead: update IT, then reinstall am from it.
  if (root && resolve(root) !== resolve(canonicalRoot())) {
    const canonical = canonicalRoot();
    try {
      await Deno.stat(`${canonical}/src/am.ts`);
    } catch {
      outError(
        `am currently runs from ${root} (dev), and no canonical install ` +
          `exists at ${canonical} — run install.sh to restore the released am`,
        mode,
      );
      Deno.exit(1);
    }
    const code = await runDeno(installFromArgv(canonical));
    if (code !== 0) {
      outError(`reinstall from ${canonical} failed (deno exit ${code})`, mode);
      Deno.exit(code);
    }
    console.error(`am: returned from dev checkout (${root}) to ${canonical}`);
    root = canonical;
  }
  if (root) {
    const git = async (args: string[], capture = false) => {
      const o = await new Deno.Command("git", {
        args: ["-C", root, ...args],
        stdout: capture ? "piped" : "inherit",
        stderr: capture ? "null" : "inherit",
      }).output();
      return {
        code: o.code,
        text: capture ? new TextDecoder().decode(o.stdout).trim() : "",
      };
    };
    if ((await git(["fetch", "--tags", "--force", "origin"])).code !== 0) {
      outError(`git fetch failed in ${root} — check network`, mode);
      Deno.exit(1);
    }
    // Latest tag reachable from origin/main (ancestry-based — robust to the
    // alphaN naming that breaks semver/version sorts).
    let tag =
      (await git(["describe", "--tags", "--abbrev=0", "origin/main"], true))
        .text;
    if (!tag) {
      tag = (await git(["tag", "-l", "v*", "--sort=-creatordate"], true)).text
        .split("\n")[0] ?? "";
    }
    const target = tag || "origin/main";
    if ((await git(["checkout", "--force", target])).code !== 0) {
      outError(`git checkout ${target} failed in ${root}`, mode);
      Deno.exit(1);
    }
    out(
      mode === "json"
        ? { updated: true, via: "git", tag: target }
        : `✓ aio updated → ${target}`,
      mode,
    );
    return;
  }
  const code = await runDeno(updateArgv());
  if (code !== 0) {
    outError(`update failed (deno exit ${code})`, mode);
    Deno.exit(code);
  }
  out(
    mode === "json"
      ? { updated: true, via: "jsr" }
      : "✓ am updated to the latest release",
    mode,
  );
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
  // The name becomes BOTH a path segment and an identifier in generated
  // source, and it arrived from argv completely unchecked (`am create`
  // validates its own, this never did). `am new cell "../etc/x"` wrote outside
  // src/, and a name carrying `}` closed the generated `cell(` literal and let
  // the rest run as code — in the developer's own project file.
  //
  // A cell/page name is an identifier, so require one: nothing else can be
  // either a traversal or a syntax break.
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    outError(
      `invalid name '${name}' — start with a letter, then letters, digits, ` +
        `'-' or '_' (it becomes a file path AND an identifier in the ` +
        `generated code)`,
      mode,
    );
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
    const symbol = name.replace(/-([a-z0-9])/gi, (_m, c) => c.toUpperCase());
    const content = `import { cell } from 'aio'

export const ${symbol} = cell('${name}', {
  state: {},
  methods: {
  },
})
`;
    await Deno.writeTextFile(file, content);
    out(flags.json ? { created: file } : `created ${file}`, mode);
  } else if (kind === "page") {
    const pascal = (name.charAt(0).toUpperCase() + name.slice(1))
      .replace(/-([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());
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
  expect <path> <op> [v]  Assert on state (eq/ne/gt/lt/contains/exists…); e2e; --wait=N
  record [out] --from=J  Generate a bootCells replay test from a journal
  ui [user]               Server-side UI state (for live client UI use: surface)
  dispatch <Type> [k=v]   Dispatch action (or --body='{"type":...}')
  actions                 Time-travel history

Time-travel:
  timeline [--from=J]     Recent dispatches + payload + state diff (--lines=N)
  replay [N..M] [--dry]   Re-dispatch a journal range for repro (--from=J)
  tt undo|redo            Step back/forward
  tt goto <N>             Jump to index
  tt pause|resume         Freeze/unfreeze state

Persistence:
  persist                 Force immediate persist
  snapshot                Dump state JSON to stdout
  snapshot save [file]    Save snapshot to file
  snapshot load <file>    Load snapshot from file
  migrations              Cell versions (declared vs stored) + shape drift

Framework version:
  pin                     Which aio version this app builds against
  pin <version>           Switch to it (provisions + relinks + records it)
  pin main                Follow the branch tip (a moving target)
  pin --latest            Pin the newest release

Files (~/.<app>/ — data/ is the whole backup):
  data                    Where this app keeps everything, and what to back up
  backup [dest]           Copy data/ to dest (stop the app first, or --force)
  restore <dir>           Put a backup back (keeps the data it replaces)

Inspect:
  clients                 Connected WebSocket clients (with index)
  client <index>          Request component tree from client (dev mode)
  surface [clientIdx|server]  Semantic UI surface — every component + element, by name (server = headless render, no client needed)
  surface --full          …with untruncated element text (default caps at 80, marked with …)
  surface --component=X   only that component (every instance), with its subtree
  surface --path=A/B      only that subtree, by path prefix
  surface --depth=N       cap the tree depth (0 = the component alone)
  trigger <idx> <path> <action> [text]  Drive the live UI (click/type/press/keyDown/keyUp/hover/focus/blur/scroll) — same engine as testUI
  sql <query>             Execute read-only SQL
  tables                  List SQLite tables
  schedules               Active scheduled effects
  log [filter]            Tail app log (--client for client.log) (--filter --lines --follow)
  errors                  Last build error
  metrics                 Uptime, connections, schedules
  cost                    Bytes pushed/s, per cell and per key, + reduce p95
  cost --keys             …every key, not just the top three
  cost --cell=X           …one cell
  cost --window=5m        …over a different window (default 60s)
  top [secs]              Live runtime view (per-cell state sizes); --json = one shot
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

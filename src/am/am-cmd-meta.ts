/**
 * @module
 * Meta commands for am — version, add, help.
 */

import { VERSION } from "../server/aio.ts";
import type { GlobalFlags } from "./am-types.ts";
import {
  detectMode,
  fail,
  heading,
  hints,
  out,
  outError,
  pad,
  stack,
  style,
  termWidth,
  width,
  wrap,
} from "./am-output.ts";
import type { Style } from "../diagnostics/fmt.ts";
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

/** Why `am update` must not `git checkout --force` in this checkout, or null.
 *
 *  THE historical data-loss bug in this project: an unconditional
 *  `git checkout --force <tag>` inside a working repo deletes uncommitted
 *  work, and it wiped the framework's own tree twice. It was fixed in
 *  `install.sh` (its AIO_DEV_CHECKOUT block) and NOWHERE ELSE — `am update`
 *  re-implements fetch+checkout and guarded on LOCATION instead: "is this the
 *  canonical install?". But `canonicalRoot()` reads `AIO_HOME`, so
 *  `AIO_HOME=~/code/aio am update` answers yes for a developer's own repo and
 *  walks straight past the guard. One fact, two deciders, one of them fixed.
 *
 *  So this is install.sh's rule, in TypeScript, applied to the same inputs:
 *  local changes are always protected; a checkout ON A BRANCH counts as worked
 *  in (the canonical install is always detached at a tag). `deno.lock` is
 *  excluded for install.sh's measured reason — `deno install` from the
 *  checkout rewrites it, so counting it would freeze every canonical install
 *  after its first run.
 *
 *  Pure, so both answers are testable without a repo. */
export function gitMutationRefusal(
  st: {
    root: string;
    dirty: string[];
    onBranch: string | null;
    force: boolean;
  },
): string | null {
  if (st.force) return null;
  if (st.dirty.length === 0 && !st.onBranch) return null;
  const why = st.dirty.length > 0
    ? `it has uncommitted changes:\n` +
      st.dirty.slice(0, 10).map((l) => `      ${l}`).join("\n") +
      (st.dirty.length > 10 ? `\n      … and ${st.dirty.length - 10} more` : "")
    : `it is on a branch (${st.onBranch}) — the canonical install is always ` +
      `detached at a tag, so this is a checkout someone WORKS in`;
  return `refusing to git-update ${st.root}: ${why}\n` +
    `  \`git checkout --force <tag>\` here would DELETE that work. ` +
    `(This is the bug that wiped aio's own tree twice.)\n` +
    `  fix: commit or stash it, then re-run — or \`am upgrade --force\` to ` +
    `move this checkout anyway (your changes are gone).`;
}

/** `git status --porcelain` lines that mean "worked in", by install.sh's rule.
 *  Untracked files are excluded (checkout does not remove them); so is
 *  deno.lock. Exported for the test that pins the two spellings together. */
export function dirtyLines(porcelain: string): string[] {
  return porcelain.split("\n").map((l) => l.trim()).filter((l) =>
    l.length > 0 && !/\bdeno\.lock$/.test(l)
  );
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
            `point at a framework clone, e.g. am upgrade ~/code/aio`,
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
        `(your edits apply immediately). Plain "am upgrade" returns to the ` +
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
    console.error(
      `am: note: returned from dev checkout (${root}) to ${canonical}`,
    );
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
    // Before ANY git mutation — the fetch is harmless, the checkout is not,
    // and refusing after the fetch would still be refusing at the right time,
    // but refusing before it keeps the two rules in one place.
    const refusal = gitMutationRefusal({
      root,
      dirty: dirtyLines(
        (await git(["status", "--porcelain", "--untracked-files=no"], true))
          .text,
      ),
      onBranch:
        (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], true))
          .text ||
        null,
      force: !!flags.force,
    });
    if (refusal) {
      outError(refusal, mode);
      Deno.exit(1);
    }
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

/** Does this path exist? A plain predicate, so the refusal that follows is not
 *  written inside a `catch` that would swallow it. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function cmdAdd(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const kind = args[0];
  const name = args[1];
  const mode = detectMode(flags);

  if (!kind || !name) {
    fail("usage: am add cell <name>", mode);
  }
  // The name becomes BOTH a path segment and an identifier in generated
  // source, and it arrived from argv completely unchecked (`am create`
  // validates its own, this never did). `am add cell "../etc/x"` wrote outside
  // src/, and a name carrying `}` closed the generated `cell(` literal and let
  // the rest run as code — in the developer's own project file.
  //
  // A cell name is an identifier, so require one: nothing else can be
  // either a traversal or a syntax break.
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    fail(
      `invalid name '${name}' — start with a letter, then letters, digits, ` +
        `'-' or '_' (it becomes a file path AND an identifier in the ` +
        `generated code)`,
      mode,
    );
  }

  if (kind === "cell") {
    // One flat file per cell, in the scaffold's own style (src/cell.ts):
    // pure state + methods, imported directly by UI and server alike.
    const dir = "src/cell";
    const file = `${dir}/${name}.ts`;
    // The exit lives OUTSIDE the try: `fail()` does not return, and a
    // catch-all around it would swallow the very thing it is trying to do.
    if (await exists(file)) fail(`${file} already exists`, mode);
    await Deno.mkdir(dir, { recursive: true });
    const symbol = name.replace(/-([a-z0-9])/gi, (_m, c) => c.toUpperCase());
    const content =
      `// Cell — pure state + methods; UI and server both import from here.
import { cell } from "aio";

export const ${symbol} = cell("${name}", {
  state: {},
  methods: {},
});
`;
    await Deno.writeTextFile(file, content);
    // `mode`, not `flags.json`: stdout that is not a tty IS json mode (every
    // other am command branches this way), so a piped `am add cell x | jq
    // -r .created` used to receive the pretty STRING, JSON-stringified.
    out(mode === "pretty" ? `created ${file}` : { created: file }, mode);
  } else if (kind === "page") {
    // `am new page` generated a useAio() component wired to nothing — code
    // the framework deprecated. A page is a plain component; there is nothing
    // an aio-specific generator adds.
    fail(
      "`am add page` was removed — a page is a plain component: create " +
        "src/<Name>.tsx exporting one, import your cells and read their " +
        "state directly (see the scaffold's src/App.tsx)",
      mode,
    );
  } else {
    fail(
      `unknown scaffold type: '${kind}' — use 'cell'`,
      mode,
    );
  }
}

/** Show help text. Accepts command keys to list available commands. */
/** The block of the help text that documents ONE command: the entries whose
 *  first word is `cmd` (two-space indent), each with its continuation lines
 *  (indented further). Pure; null when the text has no such entry.
 *  `am log --help` used to print all 170 lines — every `--help` routed to the
 *  full text, whatever came before it. */
export function helpBlock(text: string, cmd: string): string | null {
  const lines = text.split("\n");
  const picked: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const entry = /^ {2}(\S+)/.exec(line);
    if (entry) inBlock = entry[1] === cmd;
    else if (!/^ {3,}\S/.test(line)) inBlock = false; // heading / blank
    if (inBlock) picked.push(line);
  }
  return picked.length > 0 ? picked.join("\n") : null;
}

/** One line per command: its signature, and the FIRST line of its
 *  description. Derived from {@link HELP_TEXT} itself, so the summary cannot
 *  drift from the prose — there is one help text, read two ways.
 *
 *  `am help` used to print all 240 lines of that prose: every flag of every
 *  one of 62 commands, in paragraphs, past the top of the scrollback before
 *  the reader had found the verb they wanted. The full entry is one keystroke
 *  away (`am help <cmd>`) and the whole text is still one flag away
 *  (`am help --all`); what the bare command owes you is the LIST. */
export function helpSummary(text: string, st: Style = style): string {
  const out: string[] = [];
  const entries: { head: string; sig: string; desc: string }[] = [];
  let head = "";
  let afterBlank = true;
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      afterBlank = true;
      continue;
    }
    // A heading sits at column 0 and STARTS a group only right after a blank
    // line: several headings in the full text wrap over two lines, and without
    // that rule the continuation ("so `am build` and `deno task build` can
    // never differ)") became a group of its own. The parenthetical explaining
    // a group is dropped — a one-line list wants the noun, not the essay.
    if (/^\S/.test(line)) {
      if (afterBlank) head = line.replace(/\s*\(.*$/, "").replace(/:$/, "");
      afterBlank = false;
      continue;
    }
    afterBlank = false;
    const m = /^ {2}(\S(?:.*?\S)?)(?: {2,}(.*))?$/.exec(line);
    if (m) {
      entries.push({ head, sig: m[1]!, desc: (m[2] ?? "").trim() });
    } else if (entries.length > 0) {
      // A wrapped continuation of the entry above. Collected so the summary
      // can cut on a SENTENCE — the first physical line alone ended every row
      // mid-clause ("= deno task build — every target in deno.json"), which
      // reads as a truncation bug rather than as a summary.
      entries.at(-1)!.desc += " " + line.trim();
    }
  }
  // First sentence, then a hard cap: a one-line row is a label, not the prose.
  for (const e of entries) {
    const dot = /\.(?:\s|$)/.exec(e.desc);
    if (dot) e.desc = e.desc.slice(0, dot.index + 1);
    e.desc = e.desc.replace(/\s+/g, " ").trim();
  }
  // One column for the whole list, so the descriptions line up across groups
  // — but capped, or `create <name> [--template=counter|todo]` sets the column
  // for 62 rows that do not need it.
  const CAP = 24;
  const w = Math.min(
    CAP,
    Math.max(
      0,
      ...entries.filter((e) => width(e.sig) <= CAP).map((e) => width(e.sig)),
    ),
  );
  // Fit the terminal: the description gets whatever is left after the
  // signature column, with an ellipsis when the sentence is longer than that.
  const room = Math.max(24, termWidth() - w - 5);
  let last = "";
  for (const e of entries) {
    if (width(e.desc) > room) {
      e.desc = wrap(e.desc, room - 1)[0] + "…";
    }
    if (e.head !== last) {
      if (out.length) out.push("");
      out.push(st.bold(e.head));
      last = e.head;
    }
    const sig = st.cyan(e.sig);
    if (!e.desc) out.push(`  ${sig}`);
    else if (width(e.sig) > w) {
      out.push(`  ${sig}\n  ${" ".repeat(w)}  ${st.dim(e.desc)}`);
    } else out.push(`  ${pad(sig, w)}  ${st.dim(e.desc)}`);
  }
  return out.join("\n");
}

export function cmdHelp(
  args: string[],
  flags: GlobalFlags,
  commandKeys: string[],
): void {
  if (flags.json) {
    out({ commands: commandKeys }, "json");
    return;
  }
  const cmd = args.find((a) => !a.startsWith("-"));
  if (cmd) {
    const block = helpBlock(HELP_TEXT, cmd);
    if (block) {
      console.log(
        stack(
          heading(`am ${cmd}`),
          block,
          hints([["am help", "every command"]]),
        ),
      );
      return;
    }
    // A mapped command with no entry of its own (`help`) or an unknown word:
    // say so, then the whole text — never a silent fall-through.
    console.error(
      commandKeys.includes(cmd)
        ? `am: "${cmd}" has no help entry of its own — see the full list:`
        : `am: unknown command "${cmd}" — the full list:`,
    );
  }
  // `flags.all`, not `args.includes("--all")`: `--all` is a GLOBAL flag, so
  // parseGlobalFlags consumes it before a command ever sees argv. Reading argv
  // here made `am help --all` silently print the summary — the one form whose
  // entire job is to print the opposite.
  const full = flags.all === true;
  console.log(stack(
    heading("am", VERSION, "the aio app manager"),
    full ? HELP_TEXT : helpSummary(HELP_TEXT),
    hints([
      ["am help <command>", "everything that command accepts"],
      ["am help --all", "every command, in full"],
    ]),
  ));
}

export const HELP_TEXT = `Onboard:
  create <name> [--template=counter|todo]  Scaffold a new aio app (runnable + buildable)
  upgrade [<app>|<dir>]   Update am itself to the latest release. One verb,
                          the object says which: "am upgrade <app>" upgrades
                          an installed APP; "am upgrade <checkout-dir>"
                          switches the GLOBAL am to that checkout's am (a dev
                          am on live files — your edits apply at once)
  uninstall               Remove am (your aio apps are untouched)

Build & run (each IS the app's own task — the same command line, run for you,
so \`am build\` and \`deno task build\` can never differ):
  build [target…]         = deno task build — every target in deno.json
                          build.targets → dist/ + manifest.json. Words narrow
                          it (am build server electron = --targets=…); fleet
                          flags pass through (--list --release --force
                          --platforms=… --all-platforms)
  compile [target]        = deno task compile — the DEFAULT target (deno.json
                          "client") alone; \`am compile cli\` = build --targets=cli
  dev [flags]             = deno task dev — in the FOREGROUND (your terminal,
                          your Ctrl-C); flags pass through (--client=electron
                          --expose --port=N). \`am start\` is the supervised
                          background form: lock, health wait, am stop/status

Release:
  publish [--key=K]       Build, sign and lay out the channel directory an
                          update client fetches (<dir>/<channel>/<os>-<arch>.json
                          beside its artifact). --dir=DIR --channel=C --notes=…
                          --targets=… --target=<one, when two build for one
                          platform> --no-build (publish what dist/ holds)
                          --allow-dirty (publish a -dirty/-nogit build; logged)

Visual manager:
  ui                      Open amui, the visual app manager (Electron;
                          \`am ui --client=browser\` opens a browser tab instead)

Process (singleton — one instance per app identity):
  start [component]       Start the app and WAIT until it answers (--no-wait
                          returns as soon as it is spawned; --wait=N sets the
                          budget). Kills zombies, refuses if already
                          running. In a project that declares COMPONENTS —
                          several entries in one repo — plain "am start" starts
                          all of them and "am start <label>" starts one.
  stop [component]        Graceful shutdown (SIGTERM → SIGKILL). Stops the
                          whole project when it declares components.
  stop --all              Stop EVERY app of this project, declared or not —
                          scoped to instances whose cwd is under this project
                          root, so another project's app is never touched
                          (am instances is machine-wide, this is not).
  kill                    End it now, no asking (SIGTERM + drop the lock)
  kill --stale            Reap ORPHANS — processes still SERVING with no lock
                          to account for them. That is the one that answers
                          am state with old numbers while am status says
                          stopped. Add --port=N for an orphan on a port
                          nothing records.
  restart [component]     Stop + start (the whole project, or one component)
  watch [dir]             Hot-restart on .ts/.tsx change in dir (default: src/)
  status [component]      stopped|starting|started|stopping (exit 0=started,
                          1=stopped, 2=transitional). With components: one line
                          each, and the same three codes read over the whole
                          project — 0 every one up, 1 every one down, 2 partial.
  instances               List all running aio apps on this machine

State:
  state [path] [--wait=N]  State query (dot-path, [*] wildcard, {pick})
  state --ui [user]       Server-side UI-state projection (was \`am ui\`; for
                          live client UI use: surface)
  expect <path> <op> [v]  Assert on state (eq/ne/gt/lt/contains/exists…); e2e; --wait=N
  record [out] --from=J  Generate a bootCells replay test from a journal
  dispatch <cell:method> [a b …]  Call a method with POSITIONAL args (setHost "1.2.3.4")
  dispatch … --as-server  Dispatch past the cell access gate — the operator
                          door for a "public read, server-only write" cell.
                          Loopback-only, logged, dev-only (as the trojan is).
  dispatch <cell:method> --args='["1.2.3.4"]'  …the same, JSON-exact (values with '=', exact types)
  dispatch <Type> [k=v]   Dispatch a plain action with a named payload
  dispatch --body='{"type":...,"payload":...}'  Raw envelope (after a <Type>, --body is its payload)
  actions                 Time-travel history

Time-travel:
  timeline [--from=J]     Recent dispatches + payload + state diff (--lines=N)
  replay [N..M] [--dry]   Re-dispatch a journal range for repro (--from=J)
  timetravel undo|redo    Step back/forward
  timetravel goto <N>     Jump to index
  timetravel pause|resume Freeze/unfreeze state

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
  pin latest              Pin the newest release (--latest is the same)

Manual labs (a REAL desktop or device you click around in — not a gate):
  lab windows             Boot Windows in a container, mount dist/, print the
                          viewer URL (first run installs: ~30 min, tens of GB)
  lab macos               The same for macOS (setup is partly MANUAL)
  lab linux               An Ubuntu XFCE desktop — a container, not a VM: no
                          KVM, no disk, up in seconds; dist/ is /shared inside
  lab android             The Android 14 emulator + viewer — needs /dev/kvm and
                          an APK in dist/; am waits for boot and adb-installs it
  lab <os> --status|--stop|--reset   up? / clean shutdown / delete the VM disk
                          Flags: --port=N --dist=<dir> --tunnel; VMs also
                          --ram=8G --cpus=4 --disk=64G --version=11;
                          android also --apk=<file>
                          See docs/testing/vm-labs.md — and note this is the
                          manual tier: \`deno task test:wine\` and
                          \`deno task lab\` are the automated ones.

Look:
  theme adopt             Take aio's stylesheet INTO this app (src/aio-theme.css)
                          — yours from then on: editable, in your git history,
                          and no aio upgrade can change it. Build ON the
                          default look without depending on the framework for it.

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
  trigger <idx> <path> <action> [text]  Drive the live UI (click/type/setValue/press/keyDown/keyUp/hover/focus/blur/scroll) — same engine as testUI; path "window" drives an onGlobalKey binding
                          type APPENDS to the field, setValue REPLACES it (as in testUI)
  shot [n] [--out=F.png] [--full]  PNG of the live Electron window via CDP — the app
                          must run with --cdp (or AIO_CDP=1); --json → {file,bytes,url}
  where <file>            Which execution context this file runs in, and WHY —
                          the import chain from the UI entry, from the same
                          module graph the dev server walks
  sql <query>             Execute read-only SQL
  sql --tables            List SQLite tables
  tables                  The same list under its own name (= sql --tables)
  schedules               Active scheduled effects
  logs [filter]           Tail app log (--client for client.log) (--filter --lines --follow)
                          A filter is a substring, e.g. "am logs error"
                          keeps error events
  errors                  What went wrong: the build error (if any) first,
                          then the tail of error.log (--lines=N)
  metrics                 Uptime, connections, schedules
  cost                    Bytes pushed/s, per cell and per key, + reduce p95
  cost --keys             …every key, not just the top three
  cost --cell=X           …one cell
  cost --window=5m        …over a different window (default 60s)
  top [secs]              Live runtime view (per-cell state sizes); --json = one shot
  health                  HTTP health check
  doctor                  running instances vs dep/aio on disk (fix: am restart)
  open [--print]          Open THIS app in a browser (--print writes the URL)
  discover [--timeout=ms] Find exposed aio apps on the LAN (UDP broadcast)
  profile [--out=file]    Export this app's .aioapp profile (cert + key) for the client
  pair                    Fresh single-use pairing PIN (3 min) — no restart needed
  trust                   Show this machine's aio root + how to install it, so
                          browsers stop warning about EVERY aio app (one
                          install, all apps, forever). Name-constrained: it can
                          only vouch for localhost/.local/LAN, never the public
                          web. \`am trust path\` prints just the file.
  config                  Server configuration

Scaffold:
  add cell <name>         Generate src/cell/<name>.ts

Repair (a clone that does not run yet):
  fix                     Full repair: dep/aio symlink, env, electron, config,
                          tasks — the one to run after a git clone.
                          --dry-run reports without writing; --no-download
                          skips the network steps (Electron, deno cache)
  link                    Just the dep/aio symlink (fix does this and more)

Auth (apps running with auth: true) — run "am auth" for all of them:
  auth users              List accounts
  auth create <id>        Add one (prints a generated password if none given)
  auth passwd <id>        Set a password (also clears the lockout + sessions)
  auth unlock <id>        Clear a lockout
  auth totp <id> off      Clear the second factor (lost device)
  auth revoke <id>        Revoke every session of a user

Feedback:
  report                  Collect a problem report (logs + versions + state
                          shape) for an app configured with feedback: true

Install (apps that run.sh installed into ~/app/):
  installed               List them, with version + where each came from
  upgrade <app>           Rebuild and reinstall from its recorded source
                          (a bare "am upgrade" updates am itself)
  remove <app> [--data]   Uninstall one — the PROGRAM; --data also deletes
                          ~/.<app>/ (state, logs, keys — it does not come back)

Other:
  version                 Print version
  help                    This message

--json: machine-readable output for EVERY command — the scripting interface
        (errors included; a non-zero exit still means failed)

Flags: --app=X  --port=N  --entry=<path>  --wait[=N]  --no-wait  --json  --quiet  --body='{...}'  --args='[...]'  --filter=X  --lines=N  --follow/-f  --transport=ws|uds  --client-index=N/-i N  --all  --home=<dir>  --timeout=<ms>

--app: target specific app by ID (default: resolved from deno.json name)
--home: target the instance of that app running from <dir> (an isolated
        second boot); AIO_APPS_DIR is the env-level equivalent
--timeout: ms to wait for a live client (surface/trigger; default 8000)
--entry: override entry point (default: deno.json "entry" > src/app.ts)
--wait: start/stop block until complete (default 10s/5s) — start does this by
        default; --no-wait returns the moment the child is spawned.
        state polls every Ns.`;

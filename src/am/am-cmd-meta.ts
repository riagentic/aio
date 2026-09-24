/**
 * @module
 * Meta commands for am — version, add, help.
 */

import { VERSION } from "../server/aio.ts";
import { DEFAULT_ENTRY } from "../server/app-files.ts";
import { EVERYDAY, HELP_TEXT } from "./am-help-text.ts";
import type { GlobalFlags } from "./am-types.ts";
import {
  detectMode,
  fail,
  heading,
  hints,
  out,
  outError,
  pad,
  say,
  sayErr,
  stack,
  style,
  termWidth,
  width,
  wrap,
} from "./am-output.ts";
import type { Style } from "../diagnostics/fmt.ts";
import { repoRoot } from "./am-cmd-create.ts";
import { resolve } from "@std/path";
import { gitEnvFor, isClone } from "./am-versions.ts";

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

/** The refusal for a `git`-updated install that is not a clone of aio — a
 *  tarball copy, a folder with mod.ts — or null. Without it, git WALKED UP:
 *  a plain install inside any enclosing repo (a dotfiles repo at `~`) had
 *  `am upgrade` fetch into THAT repo and `git checkout --force <tag>` there. */
async function notCloneRefusal(root: string): Promise<string | null> {
  if (await isClone(root)) return null;
  const oneLiner = Deno.build.os === "windows"
    ? "irm https://raw.githubusercontent.com/riagentic/aio/main/install.ps1 | iex"
    : "curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh";
  return `AIO at ${root} is not a git clone of aio — am upgrade updates a ` +
    `clone with git, and never runs git anywhere else. Reinstall with:\n` +
    `  ${oneLiner}`;
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
    sayErr(
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
    // Refused BEFORE am is reinstalled from it, not after.
    const refused = await notCloneRefusal(canonical);
    if (refused) {
      outError(refused, mode);
      Deno.exit(1);
    }
    const code = await runDeno(installFromArgv(canonical));
    if (code !== 0) {
      outError(`reinstall from ${canonical} failed (deno exit ${code})`, mode);
      Deno.exit(code);
    }
    sayErr(
      `am: note: returned from dev checkout (${root}) to ${canonical}`,
    );
    root = canonical;
  }
  if (root) {
    const refused = await notCloneRefusal(root);
    if (refused) {
      outError(refused, mode);
      Deno.exit(1);
    }
    const git = async (args: string[], capture = false) => {
      const o = await new Deno.Command("git", {
        args: ["-C", root, ...args],
        stdout: capture ? "piped" : "inherit",
        stderr: capture ? "null" : "inherit",
        stdin: "null",
        // Pinned to `root` (see gitCeiling), never an enclosing repo nor one
        // an inherited GIT_DIR names (a hook) — see gitEnvFor.
        ...gitEnvFor(root),
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
    fail("usage: am add cell <name>  |  am add server <name>", mode);
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
  } else if (kind === "server") {
    // A SERVER-ONLY module plus the line that makes it exist. The report's
    // complaint (report 6 §10.6-adjacent) is that scaffolding the file is the
    // easy half: a `serverFns` namespace that nothing imports is registered
    // nowhere, so calling it from a cell fails at runtime with "unknown
    // namespace" — and the author has a file that looks finished.
    const dir = "src/server";
    const file = `${dir}/${name}.server.ts`;
    if (await exists(file)) fail(`${file} already exists`, mode);
    const symbol = name.replace(/-([a-z0-9])/gi, (_m, c) => c.toUpperCase());
    await Deno.mkdir(dir, { recursive: true });
    // `serverFns` comes from "aio", NOT "aio/server": the server entry holds
    // only what would poison a browser graph (SQLite, CLI transport), and
    // serverFns is isomorphic (the browser build maps it to the WS proxy). The
    // generator shipped with "aio/server", so every module it wrote
    // failed its own type-check and the app died at boot on a missing export.
    // tests/am-add-server-imports-resolve.test.ts checks the generated names
    // against the real entry.
    await Deno.writeTextFile(
      file,
      `// Server-only functions. The \`.server.ts\` name is the convention aio
// enforces: the dev server refuses to serve one, and the build refuses a
// browser bundle that reached it — so anything in here (keys, queries, the
// filesystem) stays on the server.
//
// Call it from a cell method: \`const rows = await ${symbol}.list()\`.
import { serverFns } from "aio";

export const ${symbol} = serverFns("${name}", {
  list(): string[] {
    return [];
  },
});
`,
    );
    // The WIRING. A module nobody imports registers nothing, so the import is
    // added to the server entry — and if there is none, that is SAID rather
    // than left as a file that looks finished.
    let entry: string | undefined;
    for (const f of [DEFAULT_ENTRY, "src/main.ts", "app.ts"]) {
      if (await exists(f)) {
        entry = f;
        break;
      }
    }
    let wired: string | null = null;
    if (entry) {
      const src = await Deno.readTextFile(entry);
      const line = `import "./server/${name}.server.ts";\n`;
      if (!src.includes(`server/${name}.server.ts`)) {
        await Deno.writeTextFile(entry, line + src);
        wired = entry;
      }
    }
    out(
      mode === "pretty"
        ? `created ${file}` +
          (wired
            ? `\nimported from ${wired} — a serverFns namespace nobody imports is registered nowhere`
            : `\n⚠ no server entry found (src/app.ts) — import it yourself, or the namespace is registered nowhere`)
        : { created: file, wired },
      mode,
    );
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
      `unknown scaffold type: '${kind}' — use 'cell' or 'server'`,
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
export function helpSummary(
  text: string,
  st: Style = style,
  only?: readonly string[],
): string {
  const out: string[] = [];
  const entries: { head: string; sig: string; desc: string }[] = [];
  let head = "";
  let afterBlank = true;
  // The COMMAND part only. The tail (`--json:` … `Flags: …`) is not a command
  // group: its continuation lines are indented like an entry's, so they were
  // collected as prose belonging to the last command listed — `help` ended up
  // describing the --json contract, and the global flags vanished from the
  // compact help entirely (discoverable only via `am help --all`).
  // {@linkcode helpTail} prints them, verbatim, under the list.
  const body = helpCommandText(text);
  const col = descColumn(body);
  for (const line of body.split("\n")) {
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
    // A signature that exactly FILLS the description field is separated from
    // its description by a single space, not two — `record [out] [--from=J]`
    // is 23 columns wide in a 24-column field. The 2-space rule read the whole
    // sentence as the signature and then promoted the entry's second line to
    // its description ("the RUNNING app's timeline, so a bug you reproduced…"),
    // so the column the text lays itself out on decides first, and the 2-space
    // rule handles the signatures that run PAST that column.
    const atCol = line.length > col && line[col - 1] === " " &&
      line[col] !== " " && line.slice(2, col - 1).trim() !== "";
    const m: (string | undefined)[] | null = atCol
      ? [undefined, line.slice(2, col).trimEnd(), line.slice(col)]
      : /^ {2}(\S(?:.*?\S)?)(?: {2,}(.*))?$/.exec(line);
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
  // The one-screen tier: the named verbs, and for each of them only its BASE
  // row. A verb's flag variants (`dev --cdp`, `stop --all`, four `dispatch`
  // forms) are entries of their own in the text — right for `am help <verb>`,
  // and the reason one line per command still came to 120 rows. First row per
  // verb wins because the text lists the plain form first.
  if (only) {
    const want = new Set(only);
    const seen = new Set<string>();
    const kept: typeof entries = [];
    for (const e of entries) {
      const verb = /^\S+/.exec(e.sig)?.[0] ?? "";
      if (!want.has(verb) || seen.has(verb)) continue;
      seen.add(verb);
      kept.push(e);
    }
    entries.length = 0;
    entries.push(...kept);
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

/** The column an entry's description starts at: the indent the text's own
 *  continuation lines use, taken by majority so one odd block cannot move it.
 *  Derived rather than spelled, because the layout is the only thing that
 *  says where a signature ends. Pure. */
function descColumn(text: string): number {
  const tally = new Map<number, number>();
  for (const line of text.split("\n")) {
    if (!/^ {4,}\S/.test(line)) continue;
    const n = /^ */.exec(line)![0].length;
    tally.set(n, (tally.get(n) ?? 0) + 1);
  }
  let col = 0, best = 0;
  for (const [n, count] of tally) if (count > best) [col, best] = [n, count];
  return col;
}

/** Where the help text stops being a list of commands: the first blank-line
 *  block that holds no entry at all — a PARAGRAPH, not a group.
 *
 *  This was once "the first column-0 line starting with `--`", which named one
 *  paragraph (`--json:` … `Flags:`) instead of describing what a paragraph is.
 *  The next prose block added above it — the agent-verbs note — was read as a
 *  group heading again, and its indented continuation was glued onto the last
 *  row of the list: `help  This message expect, DRIVE with dispatch, READ the…`.
 *  A block with no `  entry` line is prose; prose ends the list. Pure. */
function tailIndex(text: string): number {
  const lines = text.split("\n");
  let start = -1, entries = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim()) {
      if (start >= 0 && entries === 0) return start;
      start = -1;
      entries = 0;
      continue;
    }
    if (start < 0) start = i;
    if (/^ {2}\S/.test(lines[i]!)) entries++;
  }
  return start >= 0 && entries === 0 ? start : -1;
}

/** The command half of the help text (everything above the flags tail). */
export function helpCommandText(text: string): string {
  const i = tailIndex(text);
  return i < 0 ? text : text.split("\n").slice(0, i).join("\n");
}

/** The FLAGS half: the `--json` contract and the global flags, which every
 *  verb takes and which the summary therefore has to keep.
 *
 *  `brief` drops the paragraphs that EXPLAIN one flag (`--app:`, `--home:`,
 *  `--timeout:` …) and keeps the ones that apply to everything: the agent
 *  note, the `--json` contract, and the `Flags:` line that names them all.
 *  Those paragraphs are eight lines of the one-screen tier and each is about a
 *  single flag, which is what `am help <command>` and `--all` are for. Pure. */
export function helpTail(text: string, brief = false): string {
  const i = tailIndex(text);
  if (i < 0) return "";
  const tail = text.split("\n").slice(i).join("\n").trim();
  if (!brief) return tail;
  return tail
    .split("\n\n")
    .filter((p) => !/^--(?!json\b)[a-z-]+:/.test(p))
    .join("\n\n");
}

export function cmdHelp(
  args: string[],
  flags: GlobalFlags,
  commandKeys: string[],
): void {
  // `am help <cmd> --json` used to answer with the whole command LIST: the
  // json branch ran before the argument was read, so the one form a script
  // would use to ask "what does this verb take?" silently answered a different
  // question. The argument decides in both modes; --json only changes the
  // shape of the answer.
  const cmd = args.find((a) => !a.startsWith("-"));
  if (flags.json) {
    if (cmd) {
      const block = helpBlock(HELP_TEXT, cmd);
      if (block) {
        out({ command: cmd, help: block, flags: helpTail(HELP_TEXT) }, "json");
        return;
      }
      if (commandKeys.includes(cmd)) {
        out({ command: cmd, help: null, commands: commandKeys }, "json");
        return;
      }
      outError(
        `unknown command "${cmd}" — run "am help" for the list`,
        "json",
      );
      Deno.exit(1);
    }
    // `everyday` is ADDITIVE and always present: `commands` stays the full 71
    // (a script asking "does this verb exist?" must not start getting "no"),
    // and the tier a reader is shown is named rather than left to be guessed
    // from a line count.
    out(
      flags.all === true
        ? { commands: commandKeys, everyday: EVERYDAY, help: HELP_TEXT }
        : {
          commands: commandKeys,
          everyday: EVERYDAY,
          flags: helpTail(HELP_TEXT),
        },
      "json",
    );
    return;
  }
  if (cmd) {
    const block = helpBlock(HELP_TEXT, cmd);
    if (block) {
      say(
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
    sayErr(
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
  // Three tiers, one text. Bare: the everyday verbs, one screen. `--commands`:
  // one line for all 71 — the tier the old bare output WAS, kept because a
  // flat list is how you find the verb whose name you half-remember. `--all`:
  // the prose, every flag of every command.
  const listAll = !full && args.includes("--commands");
  say(stack(
    heading("am", VERSION, "the aio app manager"),
    full
      ? HELP_TEXT
      : helpSummary(HELP_TEXT, style, listAll ? undefined : EVERYDAY),
    full ? "" : helpTail(HELP_TEXT, !listAll),
    hints(
      full ? [["am help <command>", "everything that command accepts"]] : [
        ["am help <command>", "everything that command accepts"],
        ...(listAll ? [] : [[
          "am help --commands",
          `all ${commandKeys.length} commands, one line each`,
        ] as [string, string]]),
        ["am help --all", "every command, in full"],
      ],
    ),
  ));
}

/** The help text, and the template list it names, live in a LEAF module
 *  (`am-help-text.ts`) so a gate can read them without importing the server
 *  through this file. Re-exported here because `am help` is what callers
 *  think of as the owner. */
export { HELP_TEXT } from "./am-help-text.ts";

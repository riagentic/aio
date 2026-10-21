// How am launches an app process — the deno argv (entry task words, runtime
// flags), the stdout log, the timing constants, and the detached spawn. Split
// out of am-cmd-process.ts, which re-exports every name here, so no importer
// changes.

import { windowsCommandLine } from "../server/no-console.ts";
import { dirname, join, resolve } from "@std/path";
import { appDirs } from "../server/app-dirs.ts";
import {
  DEFAULT_BACKUP_KEEP,
  rotateFile,
  wipeFile,
} from "../diagnostics/logger-rotate.ts";
import {
  envHeapCapMB,
  maxHeapFlagArgs,
  physicalMemoryBytes,
  resolveMaxHeapMB,
} from "../server/heap-policy.ts";
import { EXIT_WAIT_MS } from "../server/shutdown-budget.ts";

// ── Constants ───────────────────────────────────────────────

// Flags Deno consumes itself (must sit BEFORE the entry script), as opposed to
// app flags that follow it. Only `--`-prefixed forms are ever seen here (`am`
// keeps only those); short forms like -c/-r are filtered upstream.
const DENO_RUNTIME_FLAG =
  /^(--env-file|--env|--config|--no-config|--import-map|--importmap|--reload|--no-remote|--cached-only|--lock|--no-lock|--frozen|--cert|--unstable|--unstable-[\w-]+|--v8-flags|--seed|--location|--inspect|--inspect-brk|--inspect-wait|--allow-[\w-]+|--deny-[\w-]+|--no-npm|--node-modules-dir|--vendor)(=|$)/;
const isDenoRuntimeFlag = (a: string): boolean => DENO_RUNTIME_FLAG.test(a);

/** The positional WORDS an app's own `dev` task hands its entry — `serve` in
 *  `deno run -A src/app.ts serve`. Flags are deliberately excluded: they are
 *  am's to decide (--client, --port, the display plan), and only the command
 *  word is a fact about the app that am cannot derive any other way.
 *
 *  The `cli` scaffold is ONE binary with two roles and routes on that word, so
 *  `deno run -A src/app.ts` with no word exits 2 with "missing command — run
 *  `todo --help`". That was fixed for `deno task dev` and nowhere else, so
 *  `am start` — the form the scaffold's own README tells an agent to use,
 *  because `deno task dev` dies with its terminal — was dead on arrival for
 *  that template. The dev task is the app's declaration of how it starts;
 *  reading it is what keeps the two from differing again.
 *
 *  A task is a SHELL line, and am is not a shell. So only a plain positional
 *  word is taken, and the first token that is anything else ends the read: an
 *  operator (`&& || ; | &`), a redirection, a quote, a `$` or a backtick. The
 *  naive "every token that does not start with `-`" handed the child argv it
 *  never should have seen —
 *
 *    deno run -A <entry> serve --title="My App"  → serve, App"
 *    deno run -A <entry> serve && echo done      → serve, &&, echo, done
 *    deno run -A <entry> > out.log 2>&1          → >, out.log, 2>&1
 *
 *  — which is the "child exited immediately, it said: unknown command" this
 *  function was written to remove, re-created for a different task line. A
 *  quoted entry (`deno run -A "<entry>" serve`) matched no token at all, so
 *  the word was dropped and the cli scaffold was quietly broken again.
 *
 *  Pure: no task, no match, or no words → nothing added, today's launch. */
/** A character that makes a token the shell's business rather than an argument:
 *  an operator or redirection (`& | ; < >`), a quote, a variable or command
 *  substitution (`$`, a backtick), a subshell/group, or a glob. Listed as what
 *  DISQUALIFIES a token rather than as an allowlist of what a word may contain,
 *  so an ordinary argument am has not thought of — `mode=dev`, a non-ASCII
 *  command word — is still passed on. */
const SHELL_CHAR = /[&|;<>$`(){}\[\]*?!~\\'"]/;
/** A double- or single-quoted entry names the same file the bare token does. */
const unquote = (t: string): string =>
  (t.length > 1 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0])
    ? t.slice(1, -1)
    : t;

export function entryTaskWords(
  devTask: string | undefined,
  entry: string,
  root: string,
): string[] {
  if (!devTask) return [];
  const tokens = devTask.split(/\s+/).filter(Boolean);
  const at = tokens.findIndex((t) =>
    !t.startsWith("-") && resolve(root, unquote(t)) === resolve(entry)
  );
  if (at < 0) return [];
  const words: string[] = [];
  for (const t of tokens.slice(at + 1)) {
    if (t.startsWith("-")) continue; // a flag — am decides those
    if (SHELL_CHAR.test(t)) break; // the shell's, not this command's
    words.push(t);
  }
  return words;
}

/** Assemble the `deno run` argv: runtime flags (--env-file, …) BEFORE the entry
 *  script, app flags (--port, …) after it — placement Deno requires. Exported
 *  so the ordering contract is unit-tested.
 *
 *  `declaredMaxHeap` is the app's `memory.maxHeap` from its deno.json. It has
 *  to be applied HERE or nowhere: V8 freezes the ceiling at isolate creation,
 *  so the process that reads the config can no longer act on it. Before this
 *  the launcher ignored the key and every `am start` got the automatic share —
 *  a config line that the build honoured and the launcher silently did not. */
export function buildDenoArgs(
  entry: string,
  passthrough: string[],
  declaredMaxHeap?: string | number | null,
): string[] {
  const denoFlags = passthrough.filter(isDenoRuntimeFlag);
  const appFlags = passthrough.filter((a) => !isDenoRuntimeFlag(a));
  // The heap ceiling, resolved for THIS machine (25% of RAM, floor 4 GB) or
  // from the app's declared `memory.maxHeap`, which wins when it states one.
  // A launcher is the only place that can size it correctly: V8 freezes the
  // ceiling at isolate creation, so by the time the app runs it is far too
  // late. Skipped when the caller already passed `--v8-flags` — an explicit
  // choice at the command line outranks a computed default.
  const heap = denoFlags.some((f) => f.startsWith("--v8-flags"))
    ? []
    : maxHeapFlagArgs(
      resolveMaxHeapMB(
        physicalMemoryBytes(),
        declaredMaxHeap,
        envHeapCapMB(),
      ),
    );
  return [
    "run",
    "-A",
    "--unstable-kv",
    ...heap,
    ...denoFlags,
    entry,
    ...appFlags,
  ];
}

/** Raw stdout+stderr of an app `am` launched: `~/.<appId>/logs/stdout.log`.
 *
 *  It used to be `<project>/.aio.log`, which split one app's output across two
 *  directories (the framework's own logs already went to the app dir) and left a
 *  stray file in every project. It has to exist because the framework logger
 *  can't capture what it doesn't route: a bare `console.log` in a cell, and the
 *  stack trace of a crash before the logger is up. */
export function stdoutLogPath(appId: string): string {
  const path = join(appDirs(appId).logs, "stdout.log");
  try {
    Deno.mkdirSync(dirname(path), { recursive: true });
  } catch { /* exists, or unwritable — the redirect will report it */ }
  return path;
}

/** Apply the log-retention policy to `stdout.log` BEFORE the spawn.
 *
 *  It is the one log the app's own logger must not touch: the shell redirect
 *  holds its fd, so a rename from inside the app would carry the writer into
 *  the archive and an unlink would send the whole run's output to a file with
 *  no name. `am` is the only process that can rotate it — here, while nothing
 *  is writing to it — and it does so under the SAME policy the logger uses
 *  (`backupLogs` on by default, `--no-backup-logs` to wipe), because a log
 *  directory where five files keep history and one silently doesn't is the
 *  version of this that already shipped. Byte-budget eviction still belongs to
 *  the app: `stdout.log.<n>` archives have no open fd, so `enforceBudget`
 *  reaches them like any other. */
export async function prepareStdoutLog(
  logFile: string,
  flags: string[],
): Promise<void> {
  const backup = !flags.includes("--no-backup-logs");
  // `.err` is the Windows stderr split (detachedSpawnSpec); absent elsewhere,
  // where rotateFile/wipeFile are no-ops.
  for (const base of [logFile, `${logFile}.err`]) {
    if (backup) await rotateFile(base, DEFAULT_BACKUP_KEEP);
    else await wipeFile(base);
  }
}
// How long `am` waits for a STOPPING instance before it SIGKILLs — the
// runtime's own worst-case graceful stop plus a margin, imported rather than
// retyped: a 3 s wait against an 8 s budget killed legitimate final flushes.
// `EXIT_WAIT_MS` covers the app's own exit watchdog too, so `am` never kills
// an app one tick before it was going to end itself and say why.
export const SINGLETON_WAIT_MS = EXIT_WAIT_MS;
/** Default for `--wait` on stop/restart, in seconds — the same budget. */
export const STOP_WAIT_DEFAULT_S = Math.ceil(SINGLETON_WAIT_MS / 1000);
export const POLL_INTERVAL_MS = 200;
/** How long `am watch` waits after the last FS event before restarting. One
 *  editor save fires several events across several files; restarting on each
 *  would restart the app three times for one keystroke. */
export const WATCH_DEBOUNCE_MS = 250;
/** How long `am start` waits before asking whether the child it just spawned
 *  is still there. A failed exec is reaped in single-digit milliseconds; a
 *  real boot takes far longer than this, so the check can only ever catch a
 *  child that never started. */
export const SPAWN_LIVENESS_GRACE_MS = 150;
export const HEALTH_TIMEOUT_MS = 2000;
export const QUICK_TIMEOUT_MS = 1000;
export const STOP_CHECK_TIMEOUT_MS = 500;

// ── Process management commands ─────────────────────────────

/** The per-OS command that spawns a DETACHED deno child whose stdout+stderr
 *  land in `logFile` and whose real PID is written to `<logFile>.pid`.
 *
 *  A FILE, never the launcher's stdout: on Windows `Start-Process` creates the
 *  child with handle inheritance on (its redirects need it), so the child
 *  inherited PowerShell's stdout — am's pipe — and am, reading that pipe to
 *  EOF for the pid, waited for the APP's whole lifetime (measured: `am start`
 *  still running 12 min after the app was healthy, exiting 237 ms after the
 *  app was killed). Run it with {@linkcode launchDetached}, which gives the
 *  launcher no pipe at all.
 *
 *  POSIX: `sh -c "nohup deno … >log 2>&1 & echo $!"` — nohup detaches from
 *  the session so the child survives am's exit and terminal close.
 *  Windows: there is no sh/nohup (`am start` used to fail outright) —
 *  PowerShell `Start-Process -PassThru` detaches natively; it cannot merge
 *  the two streams into one file, so stderr goes to `<log>.err`.
 *  Exported pure so both shapes are testable on any OS. */
export function detachedSpawnSpec(
  os: typeof Deno.build.os,
  denoArgs: string[],
  logFile: string,
  denoBin: string = Deno.execPath(),
): { cmd: string; args: string[] } {
  if (os === "windows") {
    const q = psQuote;
    // ONE pre-quoted command line, not an ARRAY of values. `Start-Process`
    // joins `-ArgumentList` elements into a single string with spaces and does
    // NOT quote them (the single quotes above are PowerShell syntax and are
    // gone by then), so an argument containing a space — the entry under
    // `C:\Users\John Doe\…`, a `--title=My App` — was split into several by
    // the child: the app never booted, and the pid am recorded belonged to a
    // process that exec'd nothing. `windowsCommandLine` is the same MSVC
    // quoting the update swap already uses.
    const argLine = windowsCommandLine(denoArgs);
    // A launch that fails (no such binary, access denied) says why in
    // `<log>.err`, where a child's own stderr would be: PowerShell's error
    // went to the launcher's null stderr, so `am start` reported a dead pid
    // and quoted an empty log.
    const ps = `try { $p = Start-Process -FilePath ${
      q(denoBin)
    } -ArgumentList ${q(argLine)} -RedirectStandardOutput ${
      q(logFile)
    } -RedirectStandardError ${
      q(logFile + ".err")
    } -PassThru -WindowStyle Hidden -ErrorAction Stop; [IO.File]::WriteAllText(${
      q(logFile + ".pid")
    }, [string]$p.Id) } catch { [IO.File]::WriteAllText(${
      q(logFile + ".err")
    }, [string]$_); exit 1 }`;
    return {
      cmd: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", ps],
    };
  }
  const esc = (v: string) => "'" + v.replace(/'/g, "'\\''") + "'";
  const run = `nohup ${esc(denoBin)} ${denoArgs.map(esc).join(" ")} >${
    esc(logFile)
  } 2>&1`;
  return {
    cmd: "sh",
    args: [
      "-c",
      // Its OWN SESSION, not just nohup. nohup only ignores SIGHUP; the child
      // still sat in the caller's process group, so any runner that ends a
      // command by killing its group — CI steps, agent harnesses, a `timeout`
      // wrapper — took the app with it the moment `am start` returned (field
      // report cc §7: 4.5 minutes lost to an app that "kept dying").
      // `setsid` (util-linux, BusyBox) calls setsid(2) and execs IN PLACE when
      // the caller is not a group leader — a `sh -c` background job never is —
      // so `$!` is still the deno PID am records. Where there is no setsid
      // binary (macOS), nohup alone is what there was.
      `if command -v setsid >/dev/null 2>&1; then setsid ${run} & else ${run} & fi; echo $! >${
        esc(logFile + ".pid")
      }`,
    ],
  };
}

/** How long a launcher may take to hand back the pid. It only starts a
 *  process; seconds are generous, and it is a bound, not a wait on the app. */
export const LAUNCHER_TIMEOUT_MS = 30_000;

/** Run a {@linkcode detachedSpawnSpec} launcher and return the child's pid
 *  (the launcher's own when it wrote none — the old fallback).
 *
 *  The launcher gets NO pipe — stdin, stdout and stderr all null — so there is
 *  nothing for the app to inherit and nothing am waits on but the LAUNCHER's
 *  exit, bounded by `timeoutMs`; past it the launcher is killed and this
 *  throws, naming it. Never the app's lifetime. */
export async function launchDetached(
  spec: { cmd: string; args: string[] },
  logFile: string,
  opts: { cwd?: string; env?: Record<string, string>; clearEnv?: boolean } = {},
  timeoutMs = LAUNCHER_TIMEOUT_MS,
): Promise<number> {
  const pidFile = logFile + ".pid";
  try {
    Deno.removeSync(pidFile);
  } catch { /* aio-ok: no pid file left over from an earlier launch */ }
  const proc = new Deno.Command(spec.cmd, {
    args: spec.args,
    ...opts,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([
    proc.status.then(() => true),
    new Promise<false>((r) => timer = setTimeout(() => r(false), timeoutMs)),
  ]).finally(() => clearTimeout(timer));
  if (!done) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* aio-ok: the launcher ended between the timeout and the kill */
    }
    await proc.status;
    throw new Error(
      `the launcher (${spec.cmd}, pid ${proc.pid}) did not return within ` +
        `${timeoutMs / 1000} s — the app may or may not have started; ` +
        `check \`am status\` and ${logFile}`,
    );
  }
  let text = "";
  try {
    text = Deno.readTextFileSync(pidFile);
    Deno.removeSync(pidFile);
  } catch { /* aio-ok: no pid written — the launcher's pid, as before */ }
  const pid = parseInt(text.trim(), 10);
  return Number.isFinite(pid) ? pid : proc.pid;
}

/** A PowerShell single-quoted string.
 *
 *  PowerShell ends one at ANY of its quote characters, not only U+0027: the
 *  typographic ‘ ’ ‚ ‛ (U+2018/2019/201A/201B) close it too, so
 *  `--title=Don’t` ran whatever followed as PowerShell. Each is escaped the
 *  same way — doubled. */
export function psQuote(v: string): string {
  return "'" + v.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&") + "'";
}

// Child processes a test uses as PROPS, on every OS.
//
// `sleep 30` and `true` are Unix programs: on Windows `Deno.Command("sleep")`
// is "Failed to spawn 'sleep': entity not found". A test that needs "some live
// pid" or "a pid that names no process" asks for it here; the runtime that is
// running the test is the one program every OS is known to have.

import { fromFileUrl } from "@std/path";

/** Arguments (after `Deno.execPath()`) of a child that stays alive doing
 *  nothing — the portable `sleep 600`. For a fixture that builds its own
 *  command line. */
export const SLEEP_ARGS = ["eval", "setTimeout(() => {}, 600000)"];

/** A live child that does nothing until it is killed. */
export function sleeper(
  opts: Omit<Deno.CommandOptions, "args"> = {},
): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), { ...opts, args: SLEEP_ARGS })
    .spawn();
}

/** A child that exits 0 at once — the portable `true`. Await its `status`
 *  and its pid names no process. */
export function exits0(): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), { args: ["eval", ""] }).spawn();
}

/** Windows: hold `path` open with NO sharing — what an editor, an indexer or
 *  a virus scanner does there: the file cannot be replaced or removed while
 *  it is held ("os error 32"). (Deno opens every file fully shared, so a
 *  second program does it.) Resolves once the file is held; call the result
 *  to let go. */
export async function holdUnshared(
  path: string,
  // "ReadWrite": the file cannot even be READ meanwhile. (Measured: held for
  // "Read" alone, another reader still gets in; only replace/remove fail.)
  access: "Read" | "ReadWrite" = "Read",
): Promise<() => Promise<void>> {
  const p = new Deno.Command("powershell", {
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$f = [IO.File]::Open($env:AIO_HOLD, 'Open', '${access}', 'None'); ` +
      "[Console]::Out.WriteLine('held'); [Console]::In.ReadLine() | Out-Null; " +
      "$f.Close()",
    ],
    env: { AIO_HOLD: path },
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const r = p.stdout.getReader();
  const { value } = await r.read();
  const said = new TextDecoder().decode(value);
  if (!said.startsWith("held")) {
    await r.cancel();
    await p.stdin.close();
    await p.status;
    throw new Error(`holdUnshared: ${path} was not opened (${said})`);
  }
  return async () => {
    await p.stdin.close();
    await r.cancel();
    await p.status;
  };
}

/** Ask the aio app `pid` to stop, gracefully. SIGTERM where there is one.
 *  Windows has none to deliver (`kill` there is TerminateProcess: no handler
 *  runs, nothing drains), so the app is asked the way `am stop` asks it
 *  there — the shutdown request on its `port`, with the control credential
 *  it wrote to `keyFile` (`<data>/control.key`). */
export async function askToStop(
  pid: number,
  port: number,
  keyFile: string,
): Promise<void> {
  if (Deno.build.os !== "windows") return Deno.kill(pid, "SIGTERM");
  const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/shutdown`, {
    method: "POST",
    headers: {
      "X-AIO": "1",
      "X-Aio-Control": (await Deno.readTextFile(keyFile)).trim(),
    },
  });
  const said = await r.text();
  if (!r.ok) throw new Error(`stop refused: ${r.status} ${said}`);
}

/** Every process's pid and command line: `ps` — on Windows, which has none,
 *  CIM. */
export async function processList(): Promise<{ pid: number; cmd: string }[]> {
  const o = Deno.build.os === "windows"
    ? await new Deno.Command("powershell", {
      args: [
        "-NoProfile",
        "-Command",
        'Get-CimInstance Win32_Process | % { "$($_.ProcessId) $($_.CommandLine)" }',
      ],
      stdout: "piped",
      stderr: "null",
    }).output()
    : await new Deno.Command("ps", {
      args: ["-axo", "pid=,args="],
      stdout: "piped",
      stderr: "null",
    }).output();
  return new TextDecoder().decode(o.stdout).split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2]! }));
}

/** The Windows query both tree walks in tests/ use: one process per line,
 *  `<pid> <parent pid> <creation ticks>`. */
export const WINDOWS_PROCESS_QUERY =
  'Get-CimInstance Win32_Process | % { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.Ticks)" }';

/** pid → parent pid from `[pid, parent, born]` rows, with every tie that is
 *  not a family tie cut (parent 0).
 *
 *  Windows never re-parents and hands pids out again: a process whose parent
 *  DIED keeps that number, and the next process to get it is no relation. So
 *  a process is a child only when it was created at or after the process now
 *  holding its parent's pid. These helpers KILL by this tree, on a machine
 *  other people use: by parent pid alone, a long-lived program whose dead
 *  parent once had a test child's pid was "under" that child. An unknown
 *  creation time (NaN) proves nothing and ties nobody. Every pid stays a key
 *  — the map is also "which pids are live". Pure. */
export function familyTies(
  rows: readonly (readonly [number, number, number])[],
): Map<number, number> {
  const born = new Map(rows.map(([pid, , at]) => [pid, at]));
  return new Map(
    rows.map(([pid, parent, at]) => [
      pid,
      at >= born.get(parent)! ? parent : 0, // false for NaN on either side
    ]),
  );
}

/** {@linkcode WINDOWS_PROCESS_QUERY}'s output → rows. Pure. */
export function windowsProcessRows(
  listing: string,
): [number, number, number][] {
  return listing.split("\n").map((l) => l.trim().split(/\s+/))
    .filter(([pid, parent]) => pid && parent)
    .map(([pid, parent, at]) => [
      Number(pid),
      Number(parent),
      at ? Number(at) : NaN,
    ]);
}

/** Every live process's parent, pid → parent pid: `/proc` without `/proc`
 *  (`ps`; on Windows CIM, through {@linkcode familyTies}). A zombie is not
 *  live and is left out; so are the program that did the listing and
 *  whatever it started. */
export async function processParents(): Promise<Map<number, number>> {
  const windows = Deno.build.os === "windows";
  const lister = windows
    ? new Deno.Command("powershell", {
      args: ["-NoProfile", "-Command", WINDOWS_PROCESS_QUERY],
      stdout: "piped",
      stderr: "null",
    }).spawn()
    : new Deno.Command("ps", {
      args: ["-axo", "pid=,ppid=,stat="],
      stdout: "piped",
      stderr: "null",
    }).spawn();
  let parents = new Map<number, number>();
  const o = await lister.output();
  const text = new TextDecoder().decode(o.stdout);
  if (windows) parents = familyTies(windowsProcessRows(text));
  else {
    for (const line of text.split("\n")) {
      const [pid, ppid, stat] = line.trim().split(/\s+/);
      if (!ppid || stat?.startsWith("Z")) continue;
      parents.set(Number(pid), Number(ppid));
    }
  }
  for (const pid of [lister.pid, ...descendantsIn(parents, lister.pid)]) {
    parents.delete(pid);
  }
  return parents;
}

/** Everything under `root` in a {@linkcode processParents} listing. Pure. */
export function descendantsIn(
  parents: Map<number, number>,
  root: number,
): number[] {
  const out: number[] = [];
  const walk = (p: number) => {
    for (const [pid, ppid] of parents) {
      if (ppid === p && !out.includes(pid) && pid !== root) {
        out.push(pid), walk(pid);
      }
    }
  };
  walk(root);
  return out;
}

/** The environment in which a program in `bin` (a stand-in `ssh`) is the one
 *  git runs. First on PATH is enough where `git` is git. Git for Windows puts
 *  its own directories — `usr\\bin`, with the ssh it ships — AHEAD of PATH, and
 *  ahead of those only its exec-path, so there `bin` is named as that too. */
export function gitRunsFrom(bin: string): Record<string, string> {
  const win = Deno.build.os === "windows";
  const PATH = `${bin}${win ? ";" : ":"}${Deno.env.get("PATH") ?? ""}`;
  return win ? { PATH, GIT_EXEC_PATH: bin } : { PATH };
}

/** Last resort for a test that started real apps: SIGKILL whatever still runs
 *  a file under `dir`, so a stop that missed an instance does not leave it
 *  running after its home is deleted. */
export async function reapUnder(dir: string): Promise<void> {
  const under = dir + (Deno.build.os === "windows" ? "\\" : "/");
  for (const { pid, cmd } of await processList()) {
    if (!cmd.includes(under) || pid === Deno.pid) continue;
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* aio-ok: gone between the listing and the kill */ }
  }
}

/** Runs `body` — the inside of an async function, after the `imports` lines —
 *  in a child runtime whose environment is this process's with `env` laid over
 *  it (`undefined` removes a variable), and returns what it returned (JSON).
 *
 *  For a case about an INHERITED variable (`GIT_DIR` from a hook, a
 *  `GIT_ASKPASS`, a PATH with a stand-in `ssh`). Set with `Deno.env.set` it
 *  would be the whole PROCESS's for as long as the case runs: under
 *  `deno test --parallel` every other file's git saw it — a `GIT_WORK_TREE`
 *  failed every `git commit` in four unrelated files. */
export async function inChildEnv<T>(
  env: Record<string, string | undefined>,
  imports: string,
  body: string,
): Promise<T> {
  const merged: Record<string, string> = { ...Deno.env.toObject() };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const mark = "\u0000aio-child-result:";
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--ext=ts",
      `${imports}\nconst r = await (async () => {\n${body}\n})();\n` +
      `console.log(${JSON.stringify(mark)} + JSON.stringify(r ?? null));`,
    ],
    // The repo's deno.json — what the imported sources resolve `@std/…` by.
    cwd: fromFileUrl(new URL("..", import.meta.url)),
    clearEnv: true,
    env: merged,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  const at = text.lastIndexOf(mark);
  if (!out.success || at < 0) {
    throw new Error(
      `child runtime failed (exit ${out.code}):\n${text}\n${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
  return JSON.parse(text.slice(at + mark.length)) as T;
}

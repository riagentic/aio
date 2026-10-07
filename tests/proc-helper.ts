// Child processes a test uses as PROPS, on every OS.
//
// `sleep 30` and `true` are Unix programs: on Windows `Deno.Command("sleep")`
// is "Failed to spawn 'sleep': entity not found". A test that needs "some live
// pid" or "a pid that names no process" asks for it here; the runtime that is
// running the test is the one program every OS is known to have.

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
export async function holdUnshared(path: string): Promise<() => Promise<void>> {
  const p = new Deno.Command("powershell", {
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$f = [IO.File]::Open($env:AIO_HOLD, 'Open', 'Read', 'None'); " +
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

// The no-console spawn rule (src/server/no-console.ts): a `--no-terminal` GUI
// exe opened by double-click on Windows has no std handles, so inheriting them
// throws `Invalid handle`. Both production spawns that inherit — the Electron
// window and the update/restart relaunch — retry with the handles discarded.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  adoptHiddenConsole,
  hiddenConsoleHelper,
  neutralCwd,
  outlivingParent,
  spawnInheritingOrNull,
  startWindowless,
  windowsCommandLine,
  windowsEnvBlock,
} from "../src/server/no-console.ts";
import {
  _swapSpec,
  CLOSE_FDS_EXEC,
  CLOSE_FDS_EXEC_ALL,
  CLOSE_FDS_EXEC_BASH,
  relaunchOptions,
  spawnSwapHelper,
  swapHelperOptions,
} from "../src/server/updates-apply.ts";

/** A fake command whose `inherit` spawn fails the way Windows fails it. */
function fakeMake(failInherit: Error | null) {
  const tried: string[] = [];
  const make = (stdio: "inherit" | "null") => {
    tried.push(stdio);
    return {
      spawn: () => {
        if (stdio === "inherit" && failInherit) throw failInherit;
        return { stdio } as unknown as Deno.ChildProcess;
      },
    } as unknown as Deno.Command;
  };
  return { make, tried };
}

const invalidHandle = () =>
  new TypeError("Failed to spawn 'C:\\app\\app.exe': Invalid handle");

Deno.test("no-console: Windows' Invalid handle retries with the handles discarded", () => {
  const { make, tried } = fakeMake(invalidHandle());
  const child = spawnInheritingOrNull(make, "windows");
  assertEquals(tried, ["inherit", "null"]);
  assertEquals((child as unknown as { stdio: string }).stdio, "null");
});

Deno.test("no-console: a console-backed spawn inherits, and never retries", () => {
  const { make, tried } = fakeMake(null);
  spawnInheritingOrNull(make, "windows");
  assertEquals(tried, ["inherit"]);
});

Deno.test("no-console: any other failure is thrown, not retried into silence", () => {
  for (
    const [err, os] of [
      [new Error("Invalid handle"), "windows"], // not the TypeError spawn throws
      [new TypeError("No such file or directory"), "windows"],
      [invalidHandle(), "linux"], // the rule is Windows'
    ] as const
  ) {
    const { make, tried } = fakeMake(err);
    assertThrows(() => spawnInheritingOrNull(make, os));
    assertEquals(tried, ["inherit"]);
  }
});

Deno.test("adoptHiddenConsole: off Windows it does nothing, and it never throws", () => {
  assertEquals(adoptHiddenConsole("linux"), "not-windows");
  assertEquals(adoptHiddenConsole("darwin"), "not-windows");
  // Asked to act as Windows on a machine without kernel32: a reason string,
  // never a throw — boot must go on exactly as before.
  const r = adoptHiddenConsole("windows");
  assertEquals(typeof r, "string");
});

// Measured on Windows 11: a plain Deno child died WITH its parent, so every
// self-update installed the new build, exited, and relaunched nothing — the
// app simply closed. The successor and the swap helper must be detached there.
Deno.test("outliving children: the successor and the swap helper are detached on Windows", () => {
  assertEquals(outlivingParent("windows"), { detached: true });
  const win = relaunchOptions(
    ["--cdp=9", "--__aio-relaunch-after=1"],
    "null",
    "windows",
    42,
  );
  assertEquals(win.detached, true);
  assertEquals(win.args, ["--cdp=9", "--__aio-relaunch-after=42"]);
  assertEquals(
    swapHelperOptions(["-File", "x.ps1"], { cwd: "C:\\a" }, "windows").detached,
    true,
  );
});

Deno.test("outliving children: POSIX keeps the plain spawn (the terminal's Ctrl-C still reaches it)", () => {
  for (const os of ["linux", "darwin"] as const) {
    assertEquals(outlivingParent(os), {});
    assertEquals(relaunchOptions([], "inherit", os, 7).detached, undefined);
    assertEquals(swapHelperOptions([], undefined, os).detached, undefined);
  }
});

// Measured on Windows 11 (2026-09-27): a `detached` PowerShell has no console
// and exits 0 without running a line, and a plain child dies with its parent
// — so the swap helper ran NOTHING, and every directory update and in-app
// rollback was a silent no-op. It starts windowless (CreateProcessW), else
// through a detached cmd.exe, which gives PowerShell a console of its own.
Deno.test("swap helper (windows): started windowless, else through cmd.exe — never a detached PowerShell", () => {
  const args = ["-NoProfile", "-EncodedCommand", "QQBCAA=="];
  const extra = { env: { AIO_SWAP_CUR: "C:\\a b\\App" }, cwd: "C:\\a b" };
  const spawned: [string, Deno.CommandOptions][] = [];
  const lines: [string, Record<string, string>, string | undefined][] = [];
  spawnSwapHelper("powershell", args, extra, {
    os: "windows",
    // Each fake helper claims its start file, as the real script does first.
    windowless: (l, env, cwd) => (
      Deno.removeSync(env.AIO_SWAP_GO!), lines.push([l, env, cwd]), 4242
    ),
    spawn: (c, o) => void spawned.push([c, o]),
  });
  assertEquals(spawned, [], "windowless started it: nothing else runs");
  assertEquals(lines.length, 1);
  assertEquals(lines[0]![0], "powershell -NoProfile -EncodedCommand QQBCAA==");
  assertEquals(lines[0]![1].AIO_SWAP_CUR, "C:\\a b\\App");
  assertEquals(lines[0]![2], "C:\\a b");

  // The fallback, with the REAL helper spec: its encoded script is longer
  // than the 8191 characters cmd.exe accepts (measured: nothing ran), so the
  // script rides in the environment and a short bootstrap runs it.
  const spec = _swapSpec("windows", {
    pid: 1,
    current: "C:\\a b\\App",
    previous: "C:\\a b\\App.old-1",
    staged: "C:\\a b\\App.staged",
    launcher: "C:\\a b\\App\\run.bat",
    mark: "m",
    token: "t",
    failed: "f",
    waitS: 120,
    args: [],
  }, "");
  const script = spec.args[spec.args.indexOf("-EncodedCommand") + 1]!;
  spawnSwapHelper(spec.cmd, spec.args, { env: spec.env, cwd: spec.cwd }, {
    os: "windows",
    windowless: () => "no --allow-ffi",
    spawn: (c, o) => (
      Deno.removeSync(o.env!.AIO_SWAP_GO!), void spawned.push([c, o])
    ),
  });
  assertEquals(spawned.length, 1);
  const [cmd, o] = spawned[0]!;
  assertEquals(cmd, "cmd.exe");
  assertEquals(o.detached, true);
  assertEquals(o.cwd, spec.cwd);
  const line = windowsCommandLine(["cmd.exe", ...o.args!]);
  assert(line.length < 8191, `cmd.exe refuses ${line.length} characters`);
  assertEquals(o.args!.slice(0, 3), ["/d", "/c", "powershell"]);
  assertEquals(o.env!.AIO_SWAP_SCRIPT, script);
  assertEquals(o.env!.AIO_SWAP_CUR, "C:\\a b\\App");
  const boot = o.args![o.args!.indexOf("-EncodedCommand") + 1]!;
  const bytes = Uint8Array.from(atob(boot), (c) => c.charCodeAt(0));
  assertEquals(
    new TextDecoder("utf-16le").decode(bytes),
    "$s = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:AIO_SWAP_SCRIPT)); & ([scriptblock]::Create($s))",
  );
  // The script clears the variable it came in, like every AIO_SWAP_* one.
  assert(
    new TextDecoder("utf-16le").decode(
      Uint8Array.from(atob(script), (c) => c.charCodeAt(0)),
    ).includes("$_.Name -like 'AIO_SWAP_*'"),
  );
});

// AppLocker refuses PowerShell: CreateProcessW fails (1260). The cmd.exe
// fallback started, was refused the same PowerShell, and exited in silence —
// the app quit and nothing restarted it. The refusal is thrown, so the caller
// keeps (and restarts) the running version and logs "was NOT installed".
Deno.test("swap helper (windows): a PowerShell CreateProcessW refused is thrown, never retried through cmd.exe", () => {
  const spawned: string[] = [];
  assertThrows(
    () =>
      spawnSwapHelper("powershell", ["-EncodedCommand", "QQBCAA=="], {}, {
        os: "windows",
        windowless: () => "CreateProcessW failed (1260, then 1260)",
        spawn: (c) => void spawned.push(c),
      }),
    Error,
    "CreateProcessW failed (1260",
  );
  assertEquals(spawned, []);
});

// Started through cmd.exe (no --allow-ffi), a PowerShell that policy refuses
// (AppLocker, a script-block rule) exits in silence: the app quit and nothing
// swapped or restarted it. The helper's first act is to claim a start file;
// unclaimed within the bound, the start is thrown — the caller then keeps this
// version running and says so, as for a refused CreateProcessW.
Deno.test("swap helper (windows): a helper that never claims its start file is thrown, and a late one finds nothing to claim", () => {
  const claim = (env?: Record<string, string>) =>
    Deno.removeSync(env!.AIO_SWAP_GO!);
  let go = "";
  for (
    const windowless of [() => "no --allow-ffi" as const, () => 4242]
  ) {
    const e = assertThrows(
      () =>
        spawnSwapHelper("powershell", ["-EncodedCommand", "QQBCAA=="], {}, {
          os: "windows",
          windowless,
          spawn: (_c, o) => void (go = o.env!.AIO_SWAP_GO!),
          claimWaitMs: 150,
        }),
      Error,
    );
    assert(
      /PowerShell/.test(e.message) && /AppLocker/.test(e.message),
      e.message,
    );
  }
  assert(go !== "", "the helper was handed a start file");
  let gone = false;
  try {
    Deno.statSync(go);
  } catch {
    gone = true;
  }
  assert(gone, "an unclaimed start file is removed, so a late helper exits");
  // Claimed: started, whichever door.
  spawnSwapHelper("powershell", ["-EncodedCommand", "QQBCAA=="], {}, {
    os: "windows",
    windowless: () => "no --allow-ffi",
    spawn: (_c, o) => claim(o.env as Record<string, string>),
    claimWaitMs: 5_000,
  });
  spawnSwapHelper("powershell", ["-EncodedCommand", "QQBCAA=="], {}, {
    os: "windows",
    windowless: (_l, env) => (claim(env), 4242),
    spawn: () => {
      throw new Error("not reached");
    },
    claimWaitMs: 5_000,
  });
  // The script claims it FIRST — before it waits for this process to exit.
  const spec = _swapSpec("windows", {
    pid: 1,
    current: "C:\\App",
    previous: "C:\\App.old-1",
    staged: "C:\\App.staged",
    launcher: "C:\\App\\run.bat",
    mark: "m",
    token: "t",
    failed: "f",
    waitS: 120,
    args: [],
  }, "");
  const ps1 = new TextDecoder("utf-16le").decode(
    Uint8Array.from(
      atob(spec.args[spec.args.indexOf("-EncodedCommand") + 1]!),
      (c) => c.charCodeAt(0),
    ),
  );
  const claimAt = ps1.indexOf("[IO.File]::Move($go");
  assert(claimAt > 0, "the script claims its start file");
  assert(claimAt < ps1.indexOf("Get-Process -Id $p"), "before the pid wait");
  assert(ps1.includes("catch { exit 0 }"), "an unclaimable file ends it");
});

Deno.test("swap helper (posix): the plain spawn, never through a Windows launcher", () => {
  const spawned: [string, Deno.CommandOptions][] = [];
  spawnSwapHelper("/bin/sh", ["x.sh", "1"], undefined, {
    os: "darwin",
    windowless: () => {
      throw new Error("not on POSIX");
    },
    spawn: (c, o) => void spawned.push([c, o]),
  });
  assertEquals(spawned.map(([c, o]) => [c, o.args, o.detached]), [
    ["/bin/sh", ["x.sh", "1"], undefined],
  ]);
});

// The directory swap helper outlives this process and starts the new version:
// on Linux it drops every inherited descriptor first, exactly as the relaunch
// does (tests/relaunch-closes-inherited-fds.test.ts proves each shell closes
// them), so neither it nor the version it starts holds a pipe or mount alive.
Deno.test("swap helper (linux): started through the descriptor-closing shell, the helper as $0", () => {
  if (Deno.build.os !== "linux") return;
  const spawned: [string, Deno.CommandOptions][] = [];
  spawnSwapHelper("/bin/sh", ["x.sh", "1"], undefined, {
    os: "linux",
    spawn: (c, o) => void spawned.push([c, o]),
  });
  assertEquals(spawned.length, 1);
  const args = spawned[0]![1].args!;
  const script = args[args.indexOf("-c") + 1]!;
  assert(
    [CLOSE_FDS_EXEC, CLOSE_FDS_EXEC_ALL, CLOSE_FDS_EXEC_BASH].includes(script),
    `not the fd-closing exec: ${args.join(" ")}`,
  );
  assertEquals(args.slice(-3), ["/bin/sh", "x.sh", "1"]);
  assertEquals(spawned[0]![1].stdin, "null");
});

Deno.test("windowsCommandLine: MSVC quoting — spaces, quotes and trailing backslashes survive", () => {
  assertEquals(windowsCommandLine(["a", "b c", ""]), 'a "b c" ""');
  assertEquals(windowsCommandLine(['say "hi"']), '"say \\"hi\\""');
  assertEquals(windowsCommandLine(["C:\\a b\\"]), '"C:\\a b\\\\"');
  assertEquals(windowsCommandLine(["C:\\plain\\"]), "C:\\plain\\");
});

Deno.test("windowsEnvBlock: sorted case-blind, NUL after each pair and one more at the end", () => {
  assertEquals(
    windowsEnvBlock({ b: "2", A: "1", Path: "p" }),
    "A=1\0b=2\0Path=p\0\0",
  );
});

// The thread's last error is overwritten by the next call that sets one: read
// after the retry, it named the retry's failure at best, and whatever Deno
// itself called in between at worst. Each failure is read the moment it fails.
Deno.test("startWindowless: each failed CreateProcessW's error is read right after it", () => {
  let last = 0;
  const calls: string[] = [];
  const fake = {
    symbols: {
      CreateProcessW: () => (calls.push("create"), last = 5 + calls.length, 0),
      GetLastError: () => (calls.push(`error ${last}`), last),
      CloseHandle: () => 1,
    },
    close: () => {},
  } as unknown as Parameters<typeof startWindowless>[3] extends
    ((...a: never[]) => infer L) | undefined ? L : never;
  const why = startWindowless("x", {}, undefined, () => fake);
  assertEquals(calls, ["create", "error 6", "create", "error 8"]);
  assertEquals(why, "CreateProcessW failed (6, then 8)");
});

// Windows refuses to move a folder that is ANY process's working directory.
// A desktop app's is its install folder, every child inherits it, and the
// update swap moves that folder.
Deno.test("neutralCwd: the Windows directory on Windows, the inherited one elsewhere", () => {
  assertEquals(neutralCwd("windows", () => "D:\\WINNT"), "D:\\WINNT");
  assertEquals(neutralCwd("windows", () => undefined), "C:\\Windows");
  assertEquals(
    neutralCwd("windows", () => {
      throw new Deno.errors.NotCapable("env");
    }),
    "C:\\Windows",
  );
  // POSIX renames a directory under a process: nothing to change there.
  assertEquals(neutralCwd("linux", () => "D:\\WINNT"), undefined);
  assertEquals(neutralCwd("darwin", () => "D:\\WINNT"), undefined);
});

/** kernel32 as `adoptHiddenConsole` uses it, recording every call. */
function fakeConsoleKernel(
  { attachAfter = 0, hasConsole = false } = {},
) {
  const calls: string[] = [];
  const created: { cmdline: string; cwd: string | null; app: unknown }[] = [];
  const text = (b: Uint8Array | null) =>
    b === null
      ? null
      : new TextDecoder("utf-16le").decode(b).replace(/\0+$/, "");
  let attaches = 0;
  const HANDLE = 0x1234n, THREAD = 0x5678n, PID = 4242;
  const lib = {
    symbols: {
      GetConsoleProcessList: () => hasConsole ? 1 : 0,
      CreateProcessW: (
        app: unknown,
        cmdline: Uint8Array,
        _pa: unknown,
        _ta: unknown,
        _inherit: number,
        flags: number,
        _env: unknown,
        cwd: Uint8Array | null,
        _si: Uint8Array,
        pi: Uint8Array,
      ) => {
        calls.push(`create 0x${flags.toString(16)}`);
        created.push({ cmdline: text(cmdline)!, cwd: text(cwd), app });
        const dv = new DataView(pi.buffer);
        dv.setBigUint64(0, HANDLE, true);
        dv.setBigUint64(8, THREAD, true);
        dv.setUint32(16, PID, true);
        return 1;
      },
      AttachConsole: (pid: number) => (
        calls.push(`attach ${pid}`), ++attaches > attachAfter ? 1 : 0
      ),
      GetLastError: () => 6,
      Sleep: () => {},
      TerminateProcess: (h: Deno.PointerValue) => (
        calls.push(`terminate 0x${Deno.UnsafePointer.value(h).toString(16)}`), 1
      ),
      CloseHandle: (h: Deno.PointerValue) => (
        calls.push(`close 0x${Deno.UnsafePointer.value(h).toString(16)}`), 1
      ),
    },
    close: () => void calls.push("unload"),
  };
  type Open = NonNullable<
    NonNullable<Parameters<typeof adoptHiddenConsole>[1]>["open"]
  >;
  return { calls, created, open: (() => lib) as unknown as Open };
}

// Measured on Windows 11: the console's helper was `cmd.exe /c ping … >nul`,
// started with the app's working directory (the install folder). Ending cmd
// left PING.EXE running for ~29 s with that folder as ITS working directory,
// so an update clicked within half a minute of the app's start could not move
// the install: "the running version could not be moved aside".
Deno.test("adoptHiddenConsole: the helper is one process outside the install, and it is ended", () => {
  const k = fakeConsoleKernel({ attachAfter: 2 });
  const r = adoptHiddenConsole("windows", {
    open: k.open,
    isTerminal: () => false,
  });
  assertEquals(r, "adopted");
  assertEquals(k.created.length, 1);
  const { cmdline, cwd, app } = k.created[0]!;
  // No shell: whatever is started is the whole tree, so ending it ends all.
  assert(!/cmd(\.exe)?\b/i.test(cmdline), cmdline);
  assert(!/[>|&]/.test(cmdline), `a shell line: ${cmdline}`);
  const root = neutralCwd("windows")!;
  assertEquals(cmdline, `${root}\\System32\\PING.EXE -n 30 127.0.0.1`);
  assertEquals(app, null);
  // Its working directory is given, and it is not the app's.
  assertEquals(cwd, root);
  // Windowless, attached (retried until its console exists), then ended —
  // the process handle, not only closed.
  assertEquals(k.calls, [
    "create 0x8000000",
    "attach 4242",
    "attach 4242",
    "attach 4242",
    "terminate 0x1234",
    "close 0x1234",
    "close 0x5678",
    "unload",
  ]);
});

Deno.test("adoptHiddenConsole: a path with a space is one quoted program, by full path", () => {
  assertEquals(hiddenConsoleHelper("C:\\Win dows"), {
    cmdline: '"C:\\Win dows\\System32\\PING.EXE" -n 30 127.0.0.1',
    cwd: "C:\\Win dows",
  });
});

Deno.test("adoptHiddenConsole: a process that has a console starts nothing", () => {
  const term = fakeConsoleKernel();
  assertEquals(
    adoptHiddenConsole("windows", { open: term.open, isTerminal: () => true }),
    "has-console",
  );
  assertEquals(term.calls, [], "a terminal-started app needs no kernel32");
  const attached = fakeConsoleKernel({ hasConsole: true });
  assertEquals(
    adoptHiddenConsole("windows", {
      open: attached.open,
      isTerminal: () => false,
    }),
    "has-console",
  );
  assertEquals(attached.created, []);
  assertEquals(attached.calls, ["unload"]);
});

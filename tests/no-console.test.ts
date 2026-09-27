// The no-console spawn rule (src/server/no-console.ts): a `--no-terminal` GUI
// exe opened by double-click on Windows has no std handles, so inheriting them
// throws `Invalid handle`. Both production spawns that inherit — the Electron
// window and the update/restart relaunch — retry with the handles discarded.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  adoptHiddenConsole,
  outlivingParent,
  spawnInheritingOrNull,
  startWindowless,
  windowsCommandLine,
  windowsEnvBlock,
} from "../src/server/no-console.ts";
import {
  _swapSpec,
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
    windowless: (l, env, cwd) => (lines.push([l, env, cwd]), 4242),
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
    spawn: (c, o) => void spawned.push([c, o]),
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

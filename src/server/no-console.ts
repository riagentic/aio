/**
 * @module
 * The one rule for spawning a child from a process that may have NO console.
 *
 * A `deno compile --no-terminal` GUI exe opened by double-click on Windows has
 * no std handles, so `stdout: "inherit"` makes `spawn()` throw
 * `TypeError: Failed to spawn '…': Invalid handle`. Measured on real
 * Windows 11 (2026-09-17): every desktop app that spawned its window this way
 * opened nothing. Every production spawn that inherits stdio retries through
 * {@link spawnInheritingOrNull} rather than growing its own copy of the check.
 */

/** Whether a spawn failure is Windows' "the std handles I was given to inherit
 *  are not valid". Kept to a message match so the retry is the fallback, never
 *  the first move: a real failure that merely mentions a handle must not be
 *  retried into silence. `os` is injected so the rule is a unit test off
 *  Windows. */
export function isInvalidHandleError(
  e: unknown,
  os: typeof Deno.build.os = Deno.build.os,
): boolean {
  return os === "windows" &&
    e instanceof TypeError &&
    /invalid handle/i.test(e.message);
}

/** Spawn with inherited stdio, and — only when this process has no console to
 *  inherit from — again with the std handles discarded. `make` builds the
 *  command for either mode, so the caller keeps every other option. */
export function spawnInheritingOrNull(
  make: (stdio: "inherit" | "null") => Deno.Command,
  os: typeof Deno.build.os = Deno.build.os,
): Deno.ChildProcess {
  try {
    return make("inherit").spawn();
  } catch (e) {
    if (!isInvalidHandleError(e, os)) throw e;
    return make("null").spawn();
  }
}

/** Give a console-less Windows process ONE hidden console, so every console
 *  program it starts afterwards opens no window.
 *
 *  A GUI exe (`deno compile --no-terminal`, double-clicked) has no console, so
 *  Windows gives EACH console child a new one — on Windows 11 a Windows
 *  Terminal window that flashes up before the child's real work: a native
 *  file dialog appeared behind a PowerShell window, `openExternal` flashed a
 *  cmd window, an update flashed two. Measured on real Windows 11: neither
 *  `detached` nor `-WindowStyle Hidden` prevents it (the Terminal window is
 *  created before the child runs). What does: a helper started with
 *  CREATE_NO_WINDOW owns a console that has no window; this process attaches
 *  to it, the helper is ended, and the console lives on with us. Children
 *  inherit it — measured: PowerShell ×3, cmd, taskkill, zero windows, output
 *  intact.
 *
 *  Only when there is no console at all (a terminal-started app keeps its
 *  own). Never fatal: on any failure the app runs exactly as before, and the
 *  reason is returned for the caller to log. */
export function adoptHiddenConsole(
  os: typeof Deno.build.os = Deno.build.os,
): "adopted" | "has-console" | "not-windows" | string {
  if (os !== "windows") return "not-windows";
  // Started from a terminal: it has a console, and asking needs no FFI (a
  // terminal-run app without --allow-ffi must not be warned for nothing).
  try {
    if (Deno.stdout.isTerminal() || Deno.stderr.isTerminal()) {
      return "has-console";
    }
  } catch {
    // aio-ok: no std handles at all is the GUI case — kernel32 answers below
  }
  try {
    if (Deno.permissions.querySync({ name: "ffi" }).state !== "granted") {
      return "no --allow-ffi — console children may flash a window";
    }
  } catch {
    // aio-ok: no permissions API — the dlopen below answers instead
  }
  let k32: Deno.DynamicLibrary<typeof K32> | null = null;
  try {
    k32 = Deno.dlopen("kernel32.dll", K32);
    const one = new Uint32Array(1);
    if (k32.symbols.GetConsoleProcessList(one, 1) > 0) return "has-console";
    const si = new Uint8Array(104); // STARTUPINFOW, x64
    new DataView(si.buffer).setUint32(0, si.byteLength, true);
    const pi = new Uint8Array(24); // PROCESS_INFORMATION, x64
    const cmdline = utf16z("cmd.exe /d /c ping -n 30 127.0.0.1 >nul");
    const CREATE_NO_WINDOW = 0x08000000;
    if (
      !k32.symbols.CreateProcessW(
        null,
        cmdline,
        null,
        null,
        0,
        CREATE_NO_WINDOW,
        null,
        null,
        si,
        pi,
      )
    ) return `CreateProcessW failed (${k32.symbols.GetLastError()})`;
    const dv = new DataView(pi.buffer);
    const proc = Deno.UnsafePointer.create(dv.getBigUint64(0, true));
    const thread = Deno.UnsafePointer.create(dv.getBigUint64(8, true));
    const pid = dv.getUint32(16, true);
    try {
      // The helper's console exists a moment after CreateProcess returns
      // (measured: the first AttachConsole can fail with ERROR_INVALID_HANDLE).
      const until = Date.now() + 2000;
      let attached = 0;
      let code = 0;
      while (
        !(attached = k32.symbols.AttachConsole(pid)) &&
        ((code = k32.symbols.GetLastError()), Date.now() < until)
      ) {
        k32.symbols.Sleep(10);
      }
      return attached ? "adopted" : `AttachConsole failed (${code})`;
    } finally {
      // The console outlives the helper: this process is attached to it now.
      k32.symbols.TerminateProcess(proc, 0);
      k32.symbols.CloseHandle(proc);
      k32.symbols.CloseHandle(thread);
    }
  } catch (e) {
    return `hidden console unavailable: ${e instanceof Error ? e.message : e}`;
  } finally {
    k32?.close();
  }
}

const K32 = {
  GetConsoleProcessList: { parameters: ["buffer", "u32"], result: "u32" },
  AttachConsole: { parameters: ["u32"], result: "i32" },
  GetLastError: { parameters: [], result: "u32" },
  Sleep: { parameters: ["u32"], result: "void" },
  CreateProcessW: {
    parameters: [
      "pointer",
      "buffer",
      "pointer",
      "pointer",
      "i32",
      "u32",
      "pointer",
      "pointer",
      "buffer",
      "buffer",
    ],
    result: "i32",
  },
  TerminateProcess: { parameters: ["pointer", "u32"], result: "i32" },
  CloseHandle: { parameters: ["pointer"], result: "i32" },
} as const;

/** One Windows command line from an argv, by the MSVC rules every C runtime
 *  (and PowerShell) parses it with: an arg with no space, tab or quote goes
 *  as is; any other is quoted, a `"` escaped, and the backslashes before a
 *  `"` or the closing quote doubled. */
export function windowsCommandLine(argv: string[]): string {
  return argv.map((a) =>
    a !== "" && !/[\s"]/.test(a)
      ? a
      : '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"'
  ).join(" ");
}

/** A `CREATE_UNICODE_ENVIRONMENT` block: `K=V\0…\0\0`, sorted by name
 *  case-blind, as CreateProcessW documents it. */
export function windowsEnvBlock(env: Record<string, string>): string {
  return Object.keys(env)
    .sort((a, b) => {
      const x = a.toUpperCase(), y = b.toUpperCase();
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .map((k) => `${k}=${env[k]}\0`)
    .join("") + "\0";
}

/** Start a console program that OUTLIVES this process, with a console of its
 *  own that has no window. Returns its pid, or why it could not.
 *
 *  Measured on Windows 11 (2026-09-27, deno 2.9.6): Deno ends a plain child
 *  when the parent exits, and a `detached: true` child has NO console —
 *  PowerShell started so exits 0 without running a line. Neither shape can
 *  carry a helper that must work after this process is gone (the update
 *  swap). CreateProcessW with CREATE_NO_WINDOW gives it a windowless console,
 *  outside Deno's child job; CREATE_BREAKAWAY_FROM_JOB also leaves a job this
 *  process was started in (retried without it where that job forbids it).
 *  Needs --allow-ffi (a compiled app has it); the caller falls back. */
export function startWindowless(
  cmdline: string,
  env: Record<string, string>,
  cwd?: string,
  /** Test seam: kernel32. */
  open: (
    name: string,
    symbols: typeof K32_START,
  ) => Deno.DynamicLibrary<typeof K32_START> = Deno.dlopen,
): number | string {
  try {
    if (Deno.permissions.querySync({ name: "ffi" }).state !== "granted") {
      return "no --allow-ffi";
    }
  } catch {
    // aio-ok: no permissions API — the dlopen below answers instead
  }
  let k32: Deno.DynamicLibrary<typeof K32_START> | null = null;
  try {
    k32 = open("kernel32.dll", K32_START);
    const block = utf16z(windowsEnvBlock(env));
    const dir = cwd ? utf16z(cwd) : null;
    const CREATE_NO_WINDOW = 0x08000000;
    const CREATE_UNICODE_ENVIRONMENT = 0x400;
    const CREATE_NEW_PROCESS_GROUP = 0x200;
    const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    const base = CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT |
      CREATE_NEW_PROCESS_GROUP;
    // Read the moment a call fails: any later call may overwrite it.
    const codes: number[] = [];
    for (const flags of [base | CREATE_BREAKAWAY_FROM_JOB, base]) {
      const si = new Uint8Array(104); // STARTUPINFOW, x64
      new DataView(si.buffer).setUint32(0, si.byteLength, true);
      const pi = new Uint8Array(24); // PROCESS_INFORMATION, x64
      const ok = k32.symbols.CreateProcessW(
        null,
        utf16z(cmdline),
        null,
        null,
        0,
        flags,
        block,
        dir,
        si,
        pi,
      );
      if (!ok) {
        codes.push(k32.symbols.GetLastError());
        continue;
      }
      const dv = new DataView(pi.buffer);
      k32.symbols.CloseHandle(
        Deno.UnsafePointer.create(dv.getBigUint64(0, true)),
      );
      k32.symbols.CloseHandle(
        Deno.UnsafePointer.create(dv.getBigUint64(8, true)),
      );
      return dv.getUint32(16, true);
    }
    return `CreateProcessW failed (${codes.join(", then ")})`;
  } catch (e) {
    return `windowless start unavailable: ${
      e instanceof Error ? e.message : e
    }`;
  } finally {
    k32?.close();
  }
}

const K32_START = {
  GetLastError: { parameters: [], result: "u32" },
  CreateProcessW: {
    parameters: [
      "pointer",
      "buffer",
      "pointer",
      "pointer",
      "i32",
      "u32",
      "buffer",
      "buffer",
      "buffer",
      "buffer",
    ],
    result: "i32",
  },
  CloseHandle: { parameters: ["pointer"], result: "i32" },
} as const;

/** NUL-terminated UTF-16LE, as the W APIs take it (and may write into). */
function utf16z(s: string): Uint8Array<ArrayBuffer> {
  const b = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return new Uint8Array(b.buffer);
}

/** The spawn options for a child that must OUTLIVE this process — the
 *  successor an update or `aio.restart()` hands over to, and the helper that
 *  swaps an install after this process has gone.
 *
 *  Measured on Windows 11 (2026-09-26, a compiled `--no-terminal` exe spawning
 *  a copy of itself, then exiting): a plain `Deno.Command` child was ended
 *  WITH its parent — it started, and never finished — while `detached: true`
 *  ran to the end. So every self-update on Windows installed the new build,
 *  exited, and relaunched nothing: the app just closed. POSIX keeps the plain
 *  spawn: a child already outlives its parent there, and a relaunched app
 *  stays in its terminal's process group, where Ctrl-C still reaches it. */
export function outlivingParent(
  os: typeof Deno.build.os = Deno.build.os,
): { detached?: true } {
  return os === "windows" ? { detached: true } : {};
}

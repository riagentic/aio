// esbuild-shared.ts — the ONE authority for the esbuild version + JSX config
// shared by the dev transpiler and the prod bundler (B-6: a drift between the
// two means dev and prod compile with different toolchains — a parity bug the
// old copies could only warn about in comments).
//
// NOTE: src/build/build-bundle.ts must keep a LITERAL `npm:esbuild@…` import
// (a computed specifier would defeat deno's static prefetch for the build
// path). It cannot reference this constant syntactically, so
// tests/esbuild-version-pin.test.ts asserts the literal matches this value.

import { AIO_LIBRARY_ENTRIES } from "../entries.ts";

/** The pinned esbuild version — must equal deno.json's pin and the literal in
 *  build-bundle.ts (CI-enforced). */
export const ESBUILD_VERSION = "0.25.12";

/** Computed specifier — lazy (never statically prefetched); used by paths
 *  that must stay esbuild-free at install time (dev transpile, aiol). */
export const ESBUILD_SPEC: string = ["npm:esbuild", ESBUILD_VERSION].join("@");

// ── stopping the service ───────────────────────────────────────────────
//
// esbuild transpiles and bundles through a NATIVE CHILD PROCESS, and its
// `stop()` only sends the kill: it offers no way to await the exit. A caller
// that returns on `stop()` alone hands the child's exit to whatever runs next
// — in the test suite, to the next test, as a leaked subprocess plus a leaked
// "wait for a subprocess to exit" op. A fixed "allow it to terminate" wait is
// true on an idle machine and false under load (the parallel suite), which is
// the shape that made the Android bundle test fail in shard 4 and pass alone.
//
// So: take the service's pids first, then poll until they are reaped. Bounded
// — a stuck child must not hang a shutdown. Lives here, beside the version
// pin, because every esbuild caller needs it: the dev transpiler, the graph
// validator and each test that drives esbuild itself.

/** Is `pid` still in the process table (a zombie counts — it is not reaped)? */
function inProcTable(pid: number): boolean {
  try {
    Deno.statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

/** The pids listed in `/proc/self/task/<tid>/children`, over every thread.
 *
 *  Each task is read on its own: a thread can exit between the listing and
 *  its read (test-file workers, the blocking pool), and that read then fails.
 *  One vanished thread used to drop the WHOLE list — the caller saw "no
 *  children", skipped the wait for a live esbuild and returned on the fixed
 *  one, which is the leaked-subprocess failure this section exists to end.
 *  Pure: the lister and the reader are passed in. @internal */
export function _childPids(
  tasks: Iterable<string>,
  readChildren: (tid: string) => string,
): number[] {
  const kids: number[] = [];
  for (const tid of tasks) {
    let raw: string;
    try {
      raw = readChildren(tid);
    } catch {
      // aio-ok: that thread exited since the listing — skip IT. The other
      // threads' children are still true, and they are what the caller needs.
      continue;
    }
    for (const p of raw.trim().split(/\s+/)) if (p) kids.push(Number(p));
  }
  return kids;
}

/** Windows: this process's `esbuild.exe` children, from one toolhelp
 *  snapshot of the process table (kernel32, opened and closed here — nothing
 *  is held). By image name: a command line is not in the snapshot, and aio
 *  starts no other esbuild. Empty when FFI is not granted — asking would put
 *  a permission prompt in front of a stop. */
function winEsbuildChildPids(): number[] {
  if (Deno.permissions.querySync({ name: "ffi" }).state !== "granted") {
    return [];
  }
  const lib = Deno.dlopen("kernel32.dll", {
    CreateToolhelp32Snapshot: { parameters: ["u32", "u32"], result: "pointer" },
    Process32FirstW: { parameters: ["pointer", "buffer"], result: "i32" },
    Process32NextW: { parameters: ["pointer", "buffer"], result: "i32" },
    CloseHandle: { parameters: ["pointer"], result: "i32" },
  });
  try {
    const k = lib.symbols;
    const snap = k.CreateToolhelp32Snapshot(2, /* TH32CS_SNAPPROCESS */ 0);
    if (
      snap === null ||
      Deno.UnsafePointer.value(snap) === 0xffff_ffff_ffff_ffffn // INVALID_HANDLE_VALUE
    ) return [];
    try {
      // PROCESSENTRY32W (x64): dwSize@0, th32ProcessID@8,
      // th32ParentProcessID@32, szExeFile@44 (WCHAR[260]); 568 bytes.
      const entry = new Uint8Array(568);
      const view = new DataView(entry.buffer);
      view.setUint32(0, entry.length, true);
      const utf16 = new TextDecoder("utf-16le");
      const kids: number[] = [];
      for (
        let ok = k.Process32FirstW(snap, entry);
        ok;
        ok = k.Process32NextW(snap, entry)
      ) {
        if (view.getUint32(32, true) !== Deno.pid) continue;
        const exe = utf16.decode(entry.subarray(44, 564));
        if (exe.slice(0, exe.indexOf("\0")).toLowerCase() === "esbuild.exe") {
          kids.push(view.getUint32(8, true));
        }
      }
      return kids;
    } finally {
      k.CloseHandle(snap);
    }
  } finally {
    lib.close();
  }
}

/** The esbuild service processes this process started (Linux: `/proc`;
 *  Windows: the process table). Empty elsewhere, or when nothing can tell.
 *  @internal */
export function _esbuildChildPids(): number[] {
  if (Deno.build.os === "windows") return winEsbuildChildPids();
  if (Deno.build.os !== "linux") return [];
  try {
    const tasks = [...Deno.readDirSync("/proc/self/task")].map((t) => t.name);
    return _childPids(
      tasks,
      (tid) => Deno.readTextFileSync(`/proc/self/task/${tid}/children`),
    ).filter((pid) => {
      try {
        // The SERVICE, not anything named esbuild: `stop()` ends only that
        // one, and waiting on another child would be waiting for nothing.
        const cmd = Deno.readTextFileSync(`/proc/${pid}/cmdline`);
        return cmd.includes("esbuild") && cmd.includes("--service=");
      } catch {
        return false; // already gone
      }
    });
  } catch {
    return []; // no /proc — the fallback wait below
  }
}

/** How long a stopped service gets to leave the process table, for a caller
 *  with no budget of its own (a test, a script). The dev server passes what
 *  is left of ITS stop budget instead — see `stopEsbuild`. */
const STOP_REAP_MS = 2000;

/** Run esbuild's own `stop()` and return only once its child has EXITED.
 *
 *  Why there is a process-table scan here at all: the pinned npm build gives
 *  no handle on the exit. Its `stop()` destroys the pipes, sends the kill and
 *  returns `Promise.resolve()`; the child lives in a closure inside
 *  `ensureServiceIsRunning` and is never exported (lib/main.js). The only
 *  deterministic wait would be to patch `node:child_process.spawn`
 *  process-wide to capture it, which is a worse thing than the scan.
 *
 *  What this guarantees:
 *   - Linux: every esbuild service child this process had is REAPED — and its
 *     subprocess resource with it, the runtime closes it in the same turn —
 *     or, after `reapMs`, it is named on stderr and left behind.
 *   - Windows: the same wait, on the process table — see `_stillThere` for
 *     which exit it waits for. Without it the exit was left to "one loop
 *     turn", which is true on an idle machine and false under load (measured
 *     on Windows 11: 4 tests of one file failed for a leaked child process).
 *   - macOS: the kill has been sent and one loop turn has passed. The exit
 *     itself is NOT awaited there; nothing can tell.
 *
 *  Call it with nothing in flight: a transform still pending when the pipes
 *  are destroyed never settles (measured on 0.24.2 — neither resolved nor
 *  rejected). `stopEsbuild` in server-transpile.ts waits for its own first. */
/** The services among `pids` that `stop()` just ended: those whose stdin this
 *  process no longer holds. esbuild's `stop()` destroys the stdin pipe of ITS
 *  service — synchronously — and nothing else; a service whose pipe is still
 *  open here belongs to another live esbuild instance in this process (a
 *  worker's isolate, a second copy of the package), which was never asked to
 *  stop. Waiting on one of those cost every close the whole reap and named a
 *  process the stop had never touched (measured: one such service, then 2 s
 *  and a wrong `note:` on every dev-server close for the rest of the run).
 *  Pure: both readers are passed in; a pid whose stdin cannot be read is
 *  kept — waiting on it is the old behaviour, never a skipped wait. @internal */
export function _stoppedByUs(
  pids: number[],
  stdinOf: (pid: number) => string,
  heldHere: () => Set<string>,
): number[] {
  const held = heldHere();
  return pids.filter((pid) => {
    let pipe: string;
    try {
      pipe = stdinOf(pid);
    } catch {
      return true; // aio-ok: unreadable — wait on it, as before
    }
    return !held.has(pipe);
  });
}

/** Every file this process holds open, as `/proc/self/fd` names them. */
function heldHere(): Set<string> {
  const held = new Set<string>();
  try {
    for (const e of Deno.readDirSync("/proc/self/fd")) {
      try {
        held.add(Deno.readLinkSync(`/proc/self/fd/${e.name}`));
      } catch {
        // aio-ok: the fd that listed the directory itself, closed by now
      }
    }
  } catch {
    // aio-ok: no /proc — then no pid was listed either, nothing to judge
  }
  return held;
}

/** Which of the services a stop is waited on are still there.
 *
 *  Linux is told which service the stop ended (`_stoppedByUs`), so each of
 *  `pids` is asked for. Windows cannot be told — a process's handles are not
 *  readable there — so `pids` is every service this process had, and a stop
 *  ends at most ONE of them: the wait is over when any one has left. Waiting
 *  for all of them would wait out the whole reap on another isolate's live
 *  service, at every stop. Pure: the table is passed in. @internal */
export function _stillThere(
  pids: number[],
  os: typeof Deno.build.os,
  listed: (pid: number) => boolean,
): number[] {
  const left = pids.filter(listed);
  return os === "windows" && left.length < pids.length ? [] : left;
}

/** Windows: the services that were still there when a stop gave up on them —
 *  another esbuild instance's live one, since this process's own leaves in
 *  milliseconds. Not waited on again: a stop that ends nothing (its instance
 *  never started a service) would otherwise wait out the whole reap on them,
 *  every time (measured on Windows 11: 2.0 s and a note in a build that
 *  failed before it bundled). */
const _outlived = new Set<number>();

export async function stopEsbuildService(
  stop: () => void | Promise<void>,
  reapMs: number = STOP_REAP_MS,
): Promise<void> {
  const windows = Deno.build.os === "windows";
  const before = _esbuildChildPids();
  // A pid no longer listed is free to be reused — by a service of ours.
  for (const pid of _outlived) if (!before.includes(pid)) _outlived.delete(pid);
  await stop();
  // Only what this stop ended is waited for — see `_stoppedByUs`.
  const pids = windows
    ? before.filter((pid) => !_outlived.has(pid))
    : _stoppedByUs(
      before,
      (pid) => Deno.readLinkSync(`/proc/${pid}/fd/0`),
      heldHere,
    );
  const stillThere = () => {
    if (!windows) return _stillThere(pids, Deno.build.os, inProcTable);
    const now = new Set(pids.length > 0 ? _esbuildChildPids() : []);
    return _stillThere(pids, "windows", (pid) => now.has(pid));
  };
  const asked = Date.now();
  const deadline = asked + reapMs;
  while (stillThere().length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const stuck = stillThere();
  if (stuck.length > 0) {
    const waited = ((Date.now() - asked) / 1000).toFixed(1);
    console.warn(
      // Windows cannot tell whose service a pid is (see `_stillThere`): say
      // what is known — none left — and call no one of them the stopped one
      // (one pid is no different: it was another instance's when measured).
      windows
        ? `note: a stop of esbuild's service ended none of this process's ` +
          `esbuild services (pid ${stuck.join(", ")}) within ${waited} s — ` +
          `either it had none of its own left to stop, or that one is slow ` +
          `to exit; not waiting any longer.`
        : `note: esbuild's service process (pid ${stuck.join(", ")}) was ` +
          `told to stop and is still there ${waited} s later — not waiting ` +
          `any longer; it is left to exit by itself.`,
    );
    if (windows) { for (const pid of stuck) _outlived.add(pid); }
  }
  // One more turn, so the exit the runtime has just observed is delivered
  // (a turn, not a duration: any timer yields one).
  await new Promise((r) => setTimeout(r, 10));
}

/** JSX config every esbuild invocation must share (dev == prod). */
export const ESBUILD_JSX = {
  jsx: "automatic",
  jsxImportSource: "aio",
} as const;

/** THE map from an `aio*` import specifier to the framework module a BROWSER
 *  BUNDLE resolves it to, as a path from the framework's PACKAGE ROOT.
 *
 *  Two things live here that an app's own import map can never supply:
 *   - the BROWSER SUBSTITUTION — `aio` / `aio/air` resolve to the browser (or
 *     Android/WebView) entry, never to `mod.ts`, so the server module graph
 *     cannot enter the bundle;
 *   - `aio/renderer`, which the build's OWN generated entry imports and which
 *     is not a published export at all, so no app could declare it.
 *
 *  It is shared because there are TWO bundling paths that build their esbuild
 *  import map from different places: a local framework (a `dep/aio` checkout)
 *  maps file: paths, while a framework consumed from JSR is fetched over HTTP
 *  by {@link makeHttpPlugin}. esbuild cannot resolve `jsr:`/`npm:` specifiers,
 *  so every `aio*` entry in a JSR-pinned app's deno.json is DROPPED from the
 *  alias — and the remote path had no map of its own to put back. The result
 *  was total: `deno run -A jsr:@riagentic/aio/build --compile` in a JSR app
 *  died on `Could not resolve "aio/renderer"` before writing a byte, and no
 *  app-side change could fix it. One table, applied by both paths. */
export function bundleFrameworkEntries(
  standalone: boolean,
): Record<string, string> {
  const air = standalone ? "src/standalone-air.ts" : "src/browser-air.ts";
  return {
    ...AIO_LIBRARY_ENTRIES,
    "aio": air,
    "aio/air": air,
    "aio/renderer": "src/air/aio-renderer.ts",
  };
}

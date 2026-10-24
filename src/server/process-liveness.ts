// Process facts with no lock in them — this process's pid-namespace tag, is a
// pid alive, its start token/epoch, is a port or socket in use, and the
// descendant walk. A leaf: it imports none of the lock modules, so the
// constants they build at load (PID_TAG patterns) are always initialised.
// Split out of single-instance-lock.ts, which re-exports every name here, so
// no importer changes.

import { connectLocal } from "./local-listen.ts";

// ── Process Liveness ─────────────────────────────────────────

/** This process's pid namespace (the inode of Linux's `/proc/self/ns/pid`),
 *  or undefined where there is none to read. Two containers sharing one
 *  bind-mounted directory can both be pid 1: a pid means something only
 *  inside the namespace that wrote it. */
let _ownNs: number | undefined | null = null;
export function ownPidNs(): number | undefined {
  if (_ownNs === null) {
    _ownNs = undefined;
    try {
      const m = /\[(\d+)\]/.exec(Deno.readLinkSync("/proc/self/ns/pid"));
      const n = m ? Number(m[1]) : NaN;
      if (n > 0 && n <= 0xffffffff) _ownNs = n;
    } catch { /* aio-ok: no /proc (macOS, Windows) — no namespace to record */ }
  }
  return _ownNs;
}

/** How a file names the process it belongs to: `<pid>`, plus `d<ns, 8 hex>`
 *  where Linux has pid namespaces (see {@linkcode taggedOwnerGone}). */
export function ownPidTag(): string {
  const ns = ownPidNs();
  return `${Deno.pid}${
    ns === undefined ? "" : `d${ns.toString(16).padStart(8, "0")}`
  }`;
}

/** The `<pid>[d<ns>]` of {@linkcode ownPidTag}, as a regex source: groups
 *  pid, namespace hex. */
export const PID_TAG = String.raw`(\d+)(?:d([0-9a-f]{8}))?`;

/** Check if a process is alive via signal 0 */
export function isProcessAlive(pid: number): boolean {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the pid EXISTS but belongs to another user — that process
    // is alive. Conflating it with ESRCH ("no such process") made every
    // liveness guard (backup/restore live-writer refusal, lock takeover)
    // treat an app running under a different account as stopped.
    return e instanceof Deno.errors.PermissionDenied;
  }
}

/** A stamp the KERNEL controls that changes when a pid is recycled, or null
 *  when this platform cannot say.
 *
 *  Linux: field 22 of `/proc/<pid>/stat` — the process's start time in clock
 *  ticks since boot. (Field 2, `comm`, may contain spaces and parentheses, so
 *  it is cut at the LAST `)` before splitting — a bug every naive parse of
 *  this file has.) Windows: the process creation time, see {@linkcode
 *  winProcessStartToken}. macOS's identity is {@linkcode
 *  processStartEpoch} in its own field (`startEpoch`). Its token used to be
 *  `ps -o lstart=` TEXT, which varies with the reader's TZ and locale — a
 *  reader in another zone than the writer judged a live owner's pid
 *  "recycled", and a second instance opened the same state.db.
 *
 *  Pure read, no signal, no side effect. Returns null (rather than throwing)
 *  for a pid that is gone — the caller's liveness check owns that answer. */
export function processStartToken(pid: number): string | null {
  if (!(pid > 0)) return null;
  try {
    if (Deno.build.os === "linux") {
      const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
      const after = stat.slice(stat.lastIndexOf(")") + 2);
      const f = after.split(" ");
      // stat fields are 1-based and `after` begins at field 3, so field 22 is
      // index 19.
      const ticks = f[19];
      return ticks && /^\d+$/.test(ticks) ? ticks : null;
    }
    if (Deno.build.os === "windows") return winProcessStartToken(pid);
  } catch { /* no /proc entry, no permission — we simply cannot say */ }
  // macOS: see `processStartEpoch` / `LockData.startEpoch` — its token was
  // reader-locale text, so there is deliberately none any more.
  return null;
}

/** Windows: the process's CREATION time (`GetProcessTimes`, a FILETIME —
 *  100 ns ticks since 1601, UTC) as decimal text. The kernel sets it once, so
 *  it is the same for the process's whole life and for every reader, and a
 *  recycled pid has another one.
 *
 *  Null — "cannot say", exactly as an unreadable `/proc/<pid>` on Linux — for
 *  a pid that is gone, one this user may not open (a protected system
 *  process), or when FFI is not granted: asking would put a permission prompt
 *  in front of a lock check. kernel32 is opened and closed here, the way
 *  `esbuild-shared.ts` reads the process table: nothing is held, so no caller
 *  (and no test, under `--sanitize-resources`) is charged with a library. The
 *  process handle is closed on every path. */
function winProcessStartToken(pid: number): string | null {
  if (Deno.permissions.querySync({ name: "ffi" }).state !== "granted") {
    return null;
  }
  const lib = Deno.dlopen("kernel32.dll", {
    OpenProcess: { parameters: ["u32", "i32", "u32"], result: "pointer" },
    GetProcessTimes: {
      parameters: ["pointer", "buffer", "buffer", "buffer", "buffer"],
      result: "i32",
    },
    CloseHandle: { parameters: ["pointer"], result: "i32" },
  });
  try {
    const k = lib.symbols;
    const h = k.OpenProcess(
      0x1000,
      /* PROCESS_QUERY_LIMITED_INFORMATION */ 0,
      pid,
    );
    if (h === null) return null;
    try {
      const t = new BigUint64Array(4); // creation, exit, kernel, user
      const at = (i: number) => new Uint8Array(t.buffer, i * 8, 8);
      if (!k.GetProcessTimes(h, at(0), at(1), at(2), at(3))) return null;
      return t[0]! > 0n ? String(t[0]) : null;
    } finally {
      k.CloseHandle(h);
    }
  } finally {
    lib.close();
  }
}

const _MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `ps -o lstart=` output under `LC_ALL=C TZ=UTC` ("Tue Sep 23 07:45:12
 *  2026") → epoch seconds, or null for anything else. Pure. @internal */
export function parseLstartUtc(text: string): number | null {
  const m =
    /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/
      .exec(text);
  if (!m) return null;
  const mon = _MONTHS.indexOf(m[1]!);
  if (mon < 0) return null;
  const ms = Date.UTC(+m[6]!, mon, +m[2]!, +m[3]!, +m[4]!, +m[5]!);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** How `processStartEpoch` bounds `ps`. Mutable only as a test seam (a `ps`
 *  that hangs cannot be built portably otherwise). @internal */
export const PS_TIMEOUT = { perl: "perl", ps: "ps", seconds: 2 };

/** macOS: when `pid` started, in epoch seconds — identical for every reader
 *  (`ps` run with `LC_ALL=C`, `TZ=UTC`). Null elsewhere or when unknown. */
export function processStartEpoch(
  pid: number,
  // A seam: the bounded `ps` is exercised on Linux too (procps prints the
  // same C-locale `lstart`). @internal
  os: typeof Deno.build.os = Deno.build.os,
): number | null {
  if (!(pid > 0) || os !== "darwin") return null;
  // Bounded: this runs synchronously inside every liveness check, and a `ps`
  // that hangs (a wedged process table, a stuck NFS home) would hang `am`
  // and the boot with it. macOS has no `timeout(1)`; perl is the portable
  // sync bound — it runs `ps` in its OWN process group and, at the alarm,
  // kills the whole group (killing `ps` alone is not enough: a descendant
  // still holding the stdout pipe keeps the read open — measured on the
  // macOS VM). A timeout is "unknown" (null) → pid liveness decides.
  const args = ["-o", "lstart=", "-p", String(pid)];
  const run = (cmd: string, argv: string[]) =>
    new Deno.Command(cmd, {
      args: argv,
      env: { LC_ALL: "C", LANG: "C", TZ: "UTC" },
      stdout: "piped",
      stderr: "null",
    }).outputSync();
  try {
    let r: Deno.CommandOutput;
    try {
      r = run(PS_TIMEOUT.perl, [
        "-e",
        `my $p = fork; exit 125 unless defined $p;` +
        `if (!$p) { setpgrp(0, 0); exec @ARGV or exit 127 }` +
        `$SIG{ALRM} = sub { kill "KILL", -$p; exit 124 };` +
        `alarm ${PS_TIMEOUT.seconds}; waitpid($p, 0); exit($? >> 8);`,
        PS_TIMEOUT.ps,
        ...args,
      ]);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      r = run(PS_TIMEOUT.ps, args); // no perl: unbounded, as before
    }
    if (!r.success) return null;
    return parseLstartUtc(new TextDecoder().decode(r.stdout));
  } catch {
    return null; // aio-ok: no ps, no permission — we simply cannot say
  }
}

/** Check if a TCP port has something listening */
export async function isPortInUse(port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

/** Check if a local socket (Unix socket, or a named pipe on windows) has
 *  something listening — used to detect zombie socket-only instances
 *  (prod/electron skipHttp) whose process is alive but whose listener died.
 *  Mirrors isPortInUse for the socket transport. */
export async function isSocketAlive(socketPath: string): Promise<boolean> {
  try {
    const conn = await connectLocal(socketPath);
    conn.close();
    return true;
  } catch {
    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const KILL_GRACE_MS = 2000;
/** How often to re-check whether a signalled process has actually exited.
 *  Exported because `am`'s own kill loop polls the same fact — it had its own
 *  100 until they were found side by side. */
export const KILL_POLL_MS = 100;
export const KILL_REAP_MS = 300;

/** Kill a process: SIGTERM first, SIGKILL after grace period */
/** Every descendant of `pid`, shallowest first.
 *
 *  Asked BEFORE anything is killed, because once a parent dies its children are
 *  reparented to init and can no longer be found by walking down from it. */
export async function descendantPids(pid: number): Promise<number[]> {
  const out: number[] = [];
  const walk = async (p: number) => {
    const r = await new Deno.Command("pgrep", {
      args: ["-P", String(p)],
      stdout: "piped",
      stderr: "null",
    }).output().catch(() => null);
    if (!r?.success) return; // no pgrep (windows) — the parent is still killed
    for (const line of new TextDecoder().decode(r.stdout).trim().split("\n")) {
      const child = Number(line.trim());
      if (Number.isInteger(child) && child > 0) {
        out.push(child);
        await walk(child);
      }
    }
  };
  await walk(pid).catch(() => {});
  return out;
}

/** Parse `AIO_PARENT_PID`: decimal digits, integer > 0, else absent.
 *
 *  Same vocabulary as `--port` / `AIO_PORT` (`intArg` / `envPort`): `Number()`
 *  also accepts `0x1A2B`, `1e3`, `+42` and `0b101`, four spellings nobody types
 *  on purpose. A non-decimal value used to arm the parent watch against a
 *  surprising pid (or, on the Electron window, a *different* one from the
 *  server) — now both sides treat it as unset. Pure so a test can pin the
 *  refuse list without reloading the module.
 *
 *  @decider */
export function parentPidOf(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const s = raw.trim();
  const n = Number(s);
  if (!/^\d+$/.test(s) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

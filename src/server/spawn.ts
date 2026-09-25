// spawn.ts — a child process an app can actually cancel, pause and read.
//
// Requested by two field reports (a downloader and a GPU-pipeline app) and written from scratch by
// both. the GPU-pipeline app's version cost them a real user-visible bug, and it is the
// reason this module exists rather than a doc page:
//
//   `Deno.Command("kill", ["-STOP", "-1234"])` EXITS 0 AND DOES NOTHING.
//
// procps `kill` does not read a negative pid as a process group the way the
// shell builtin does; `Deno.kill(-pid, "SIGSTOP")` does. Measured: a
// three-process group signalled through the binary stayed in state `S`, the
// same group through `Deno.kill` went to `T`. Their kill-the-tree had
// therefore NEVER worked — it killed the parent and orphaned four Python
// workers holding GPU memory until reboot, and it looked correct in review
// with a confident comment above it.
//
// Two more things make that class of bug structural rather than careless:
//
//  • A negative-pid signal is only safe if the child is in a group OF ITS OWN.
//    Deno spawns children into the CALLER's process group, so `Deno.kill(-pid)`
//    on a plain `Deno.Command` child signals the app itself. Every child here
//    is launched through a session leader, or `spawn()` refuses to start.
//  • A SIGSTOPped process cannot handle SIGTERM. "Pause, then Stop" leaves a
//    paused tree alive forever unless the killer sends SIGCONT first.
//
// Server-only (`aio/server`): it spawns processes and sends signals.

import { log } from "../diagnostics/logger-api.ts";
import { _diagScopeNow } from "../diagnostics/diagnostic-bus.ts";

/** How a child process ended: its exit code, the signal that killed it (if
 *  any), and the success shorthand. */
export type SpawnStatus = {
  code: number;
  signal: Deno.Signal | null;
  success: boolean;
};

/** How to start a child: its arguments and environment, where its output
 *  goes, and what cancels it. */
export type SpawnOptions = {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Called for every complete line of child output, as it arrives.
   *
   *  `\r`-terminated lines count: a progress bar that rewrites one line
   *  (`ffmpeg`, `pip`, every CUDA tool) emits no `\n` for minutes, and a
   *  reader that splits on `\n` alone shows nothing until the job ends. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  /** Kill the whole tree when this aborts — hand it `s.$signal` and a
   *  `cancelOn` trigger becomes a killed subprocess with no plumbing. */
  signal?: AbortSignal;
  /** How long a killed tree may take to die before SIGKILL. Default 2000. */
  killGraceMs?: number;
  /** Open the child's stdin for writing — `handle.stdin`. OFF by default: a
   *  child that reads stdin when it is a pipe blocks until EOF, so a pipe
   *  nobody asked for is a hang nobody can explain. `"null"` is EOF at once. */
  stdin?: boolean;
};

/** The child's stdin, when `spawn(cmd, { stdin: true })` asked for it. */
export type SpawnStdin = {
  /** Write to the child. A string is UTF-8. Rejects after the child exited or
   *  `close()` ran — a write into a closed pipe is a lost message, and a lost
   *  message must not look like a sent one. */
  write(data: string | Uint8Array): Promise<void>;
  /** Send EOF. A child that reads until EOF (`cat`, `sort`, a REPL, most
   *  filters) does not exit until it gets one. Idempotent; the child's own
   *  exit closes the pipe too, so forgetting it leaks nothing. */
  close(): Promise<void>;
};

/** A running child and everything you can do to it — wait, pause, resume,
 *  kill (as a whole process group). */
export type SpawnHandle = {
  /** The child's process-group id — its own, never the app's. */
  readonly pid: number;
  /** Settles when the child has exited and its output has been read. A
   *  grandchild that outlives it stays in the group — `kill()` and shutdown's
   *  reaper still reach it. */
  readonly status: Promise<SpawnStatus>;
  /** SIGSTOP the whole group. Throws where that has no meaning (Windows). */
  pause(): void;
  /** SIGCONT the whole group. */
  resume(): void;
  /** SIGCONT (a stopped process cannot handle TERM), then SIGTERM, then
   *  SIGKILL after `killGraceMs` — to the GROUP, so nothing is orphaned. */
  kill(): Promise<SpawnStatus>;
  readonly paused: boolean;
  /** Present only when `{ stdin: true }` was passed. */
  readonly stdin?: SpawnStdin;
};

/** One writer for the pipe's life. The child's exit closes our end as well,
 *  so a forgotten `close()` is not a leaked resource — and a write after
 *  that says so instead of vanishing. */
function _stdin(
  stream: WritableStream<Uint8Array>,
  status: Promise<SpawnStatus>,
  cmd: string,
): SpawnStdin {
  const writer = stream.getWriter();
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await writer.close();
    } catch {
      // aio-ok: the child hung up first — there is nobody left to send EOF to
    }
  };
  status.then(close, close);
  return {
    async write(data) {
      if (closed) {
        throw new Error(
          `spawn("${cmd}"): stdin.write() after the child exited or stdin was ` +
            `closed — the data was not delivered.`,
        );
      }
      await writer.write(
        typeof data === "string" ? new TextEncoder().encode(data) : data,
      );
    },
    close,
  };
}

/** Marker the session-leader shim prints so we learn the GROUP id — the
 *  launcher's own pid is not it (`setsid --wait` forks). Stripped from the
 *  stream before any `onLine` sees it. */
const PGID_MARKER = "__aio_pgid:";

/** How a session leader is created, per platform, as a PURE spec — testable
 *  from any OS, like `detachedSpawnSpec` and `pickSpec`.
 *
 *  `setsid --wait` (util-linux) forks a new session and propagates the exit
 *  status; `perl` calls `POSIX::setsid()` in-process and `exec`s, so the
 *  process we spawned IS the child. macOS has perl and no setsid; minimal
 *  Linux containers have setsid and no perl. Hence a chain, not a choice. */
export function sessionLeaderSpec(
  launcher: "setsid" | "perl",
  cmd: string,
  args: string[],
): { cmd: string; args: string[] } {
  if (launcher === "setsid") {
    return {
      cmd: "setsid",
      args: [
        "--wait",
        "sh",
        "-c",
        `echo "${PGID_MARKER}$$"; exec "$0" "$@"`,
        cmd,
        ...args,
      ],
    };
  }
  return {
    cmd: "perl",
    args: [
      "-e",
      `use POSIX (); POSIX::setsid(); $| = 1; print "${PGID_MARKER}$$\\n"; ` +
      `exec @ARGV or die "aio spawn: cannot exec $ARGV[0]: $!\\n";`,
      "--",
      cmd,
      ...args,
    ],
  };
}

const LAUNCHERS: Array<"setsid" | "perl"> = Deno.build.os === "darwin"
  ? ["perl", "setsid"]
  : ["setsid", "perl"];

/**
 * Start a child process the app can stream, pause, resume and cancel — with
 * the whole process tree, not just the process you can see.
 *
 * ```ts
 * const job = await spawn("ffmpeg", {
 *   args: ["-i", input, out],
 *   onLine: (l) => { s.progress = parse(l) },
 *   signal: s.$signal,             // cancelOn kills the tree
 * });
 * job.pause(); job.resume();
 * const { code } = await job.status;
 * ```
 *
 * Resolves once the child is running in a process group of its own. Rejects if
 * no session leader is available — rather than falling back to an ungrouped
 * child, where `kill()` would orphan every grandchild exactly like the
 * hand-rolled versions did.
 */
export async function spawn(
  cmd: string,
  opts: SpawnOptions = {},
): Promise<SpawnHandle> {
  const args = opts.args ?? [];
  const grace = opts.killGraceMs ?? 2000;

  if (Deno.build.os === "windows") {
    // Tracked on Windows too — `taskkill /T` walks the tree there, and a
    // forgotten child is a forgotten child on every platform.
    return _track(_spawnWindows(cmd, args, opts, grace), cmd);
  }

  let child: Deno.ChildProcess | null = null;
  const tried: string[] = [];
  for (const launcher of LAUNCHERS) {
    const spec = sessionLeaderSpec(launcher, cmd, args);
    try {
      child = new Deno.Command(spec.cmd, {
        args: spec.args,
        cwd: opts.cwd,
        env: opts.env,
        // The session-leader shim execs the command, so fd 0 is inherited:
        // a pipe here is the CHILD's stdin.
        stdin: opts.stdin ? "piped" : "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      break;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        tried.push(launcher);
        continue;
      }
      throw e;
    }
  }
  if (!child) {
    throw new Error(
      `spawn("${cmd}"): no way to start a child in its own process group ` +
        `(tried ${tried.join(", ")}). Install util-linux (setsid) or perl. ` +
        `Refusing to spawn without one: kill() would then signal this app's ` +
        `own process group, or orphan every grandchild.`,
    );
  }

  const { pgid: pgidPromise, drained } = _readStreams(child, opts.onLine);
  // The marker races the child's own death: a launcher that fails (a missing
  // command, a cwd that does not exist) exits before printing anything, and a
  // spawn() that waited for a marker that will never come would hang forever.
  const status = _statusAfterDrain(child, drained);
  const pgid = await Promise.race([
    pgidPromise,
    status.then(() => null),
  ]);
  if (pgid === null) {
    const s = await status;
    throw new Error(
      `spawn("${cmd}"): the child exited immediately (code ${s.code}) — ` +
        `the command is probably missing or not executable.`,
    );
  }

  const stdin = opts.stdin ? _stdin(child.stdin, status, cmd) : undefined;
  return _track(
    _handle(pgid, status, child.status, grace, opts.signal, cmd, stdin),
    cmd,
  );
}

// ── The live-child registry ─────────────────────────────────────────────────
//
// EVERY child here is in a process group OF ITS OWN. That is what makes
// `kill()` reach the whole tree — and it is also why a child does NOT die with
// the app: a group of its own is a group the app's death does not signal. An
// app that spawns `ffmpeg` and exits leaves `ffmpeg` encoding, holding the GPU,
// with nothing left that knows its pid.
//
// `own.set(...)` is the documented way to tie a child to a cell's lifetime, and
// it works. But the failure of forgetting it is a leaked process, which is
// invisible from inside the app, survives the test suite, and accumulates on a
// developer's machine until something runs out. Silence is the wrong answer to
// that; so shutdown kills whatever is still running and SAYS SO, naming the
// command, and `own` remains the way to do it earlier and on purpose.
//
// Each child also remembers the APP that started it (`_diagScopeNow()` — the
// scope every `aio.run()` runs in). One process can host several apps, and a
// registry that did not know whose child was whose let app B's shutdown kill
// the transcode app A had just started, with A still running. A child started
// outside any app has no app to belong to and stays every app's, as before.
const _live = new Map<
  number,
  { cmd: string; handle: SpawnHandle; owner: object | undefined }
>();

/** Whether `owner`'s shutdown reaps this child: its own, or an unowned one.
 *  No owner asked for ⇒ every child (the process-wide form). */
function _reapedBy(
  v: { owner: object | undefined },
  owner: object | undefined,
): boolean {
  return owner === undefined || v.owner === undefined || v.owner === owner;
}

function _track(handle: SpawnHandle, cmd: string): SpawnHandle {
  const entry = { cmd, handle, owner: _diagScopeNow() };
  _live.set(handle.pid, entry);
  // The CHILD exiting is not the GROUP being gone: `sh -c "worker &"` exits at
  // once and leaves the worker running in the group. Forgetting the pid on the
  // child's exit let shutdown's reaper report "nothing left" over a live
  // worker. POSIX: the handle settles `_groupGoneOf` only once the leader has
  // exited AND no live member is left (see `_handle`); Windows (`taskkill /T`
  // walks the tree) has only the status.
  const forget = () => {
    if (_live.get(handle.pid) === entry) _live.delete(handle.pid);
  };
  (_groupGoneOf.get(handle) ?? handle.status).then(forget, forget);
  return handle;
}

/** POSIX handle → settles when its leader exited and its group is empty. */
const _groupGoneOf = new WeakMap<SpawnHandle, Promise<unknown>>();

/** How often a group whose leader exited is re-checked for survivors. */
const GROUP_POLL_MS = 250;

/** The two process-group operations `_handle` needs — injectable so the
 *  "group gone, pgid recycled" decision is testable without pid reuse.
 *  @internal */
export type GroupSys = {
  /** Does group `pgid` still have a LIVE (non-zombie) member? */
  alive(pgid: number): boolean;
  /** Deliver `sig` to the whole group. Throws like `Deno.kill`. */
  signal(pgid: number, sig: Deno.Signal): void;
};

const _posixSys: GroupSys = {
  alive: _groupAlive,
  signal: (pgid, sig) => Deno.kill(-pgid, sig),
};

/** Is any process of group `pgid` still alive? Signal 0 probes without
 *  delivering; EPERM means a member exists under another uid. Signal 0 also
 *  succeeds for a ZOMBIE, and a zombie is never reaped where nothing waits on
 *  orphans (Deno as PID 1 in a container) — so on Linux a group counts alive
 *  only if /proc shows a member that is not a zombie. */
function _groupAlive(pgid: number): boolean {
  try {
    Deno.kill(-pgid, 0);
  } catch (e) {
    if (e instanceof Deno.errors.PermissionDenied) return true;
    _liveHint.delete(pgid);
    return false;
  }
  return Deno.build.os === "linux" ? _procGroupHasLive(pgid) : true;
}

/** `/proc/<pid>/stat` → state and process group. `comm` may hold spaces and
 *  parens, so fields are counted from the LAST `)`. Pure. @internal */
export function _procStat(
  text: string,
): { state: string; pgrp: number } | null {
  const r = text.lastIndexOf(")");
  if (r < 0) return null;
  const f = text.slice(r + 2).split(" "); // state ppid pgrp …
  const pgrp = Number(f[2]);
  return f[0] && Number.isInteger(pgrp) && pgrp > 0
    ? { state: f[0], pgrp }
    : null;
}

/** Last live member seen per group: re-checked first, so polling a group that
 *  stays alive costs one read, not a /proc scan. */
const _liveHint = new Map<number, string>();

function _procMemberLive(pgid: number, pid: string): boolean {
  try {
    const st = _procStat(Deno.readTextFileSync(`/proc/${pid}/stat`));
    return st !== null && st.pgrp === pgid && st.state !== "Z" &&
      st.state !== "X";
  } catch {
    return false; // exited between the listing and the read
  }
}

function _procGroupHasLive(pgid: number): boolean {
  const hint = _liveHint.get(pgid);
  if (hint !== undefined && _procMemberLive(pgid, hint)) return true;
  _liveHint.delete(pgid);
  try {
    for (const e of Deno.readDirSync("/proc")) {
      const c = e.name.charCodeAt(0);
      if (c < 48 || c > 57) continue; // only the numeric (pid) entries
      if (_procMemberLive(pgid, e.name)) {
        _liveHint.set(pgid, e.name);
        return true;
      }
    }
  } catch {
    return true; // no /proc to look in (or no read permission): trust signal 0
  }
  return false;
}

/** Children spawned through `spawn()` that are still running, as
 *  `pid → command`. Empty is the healthy answer at shutdown. @internal */
export function _liveSpawned(owner?: object): Map<number, string> {
  return new Map(
    [..._live].filter(([, v]) => _reapedBy(v, owner)).map((
      [pid, v],
    ) => [pid, v.cmd]),
  );
}

/** Kill every child still running, as whole process groups. Called by
 *  shutdown's Phase 7 after `own` disposal has had its chance, so anything
 *  reaching here is a child nobody claimed. `owner` (an app scope) limits it
 *  to that app's children plus unowned ones; omitted, it is every child.
 *
 *  Returns how many it had to kill — zero on a tidy app, and the caller is
 *  expected to say so out loud when it is not. Never throws: a child that has
 *  already gone, or a signal the platform refuses, must not be the thing that
 *  stops a shutdown. */
export async function killAllSpawned(owner?: object): Promise<number> {
  const victims = [..._live].filter(([, v]) => _reapedBy(v, owner));
  if (victims.length === 0) return 0;
  await Promise.allSettled(victims.map(([, v]) => v.handle.kill()));
  for (const [pid] of victims) _live.delete(pid);
  return victims.length;
}

/** POSIX handle — every signal goes to `-pgid`, never to a bare pid.
 *  `exited` settles when the LEADER exits (before its output is drained).
 *  @internal */
export function _handle(
  pgid: number,
  status: Promise<SpawnStatus>,
  exited: Promise<unknown>,
  grace: number,
  signal: AbortSignal | undefined,
  cmd: string,
  stdin?: SpawnStdin,
  sys: GroupSys = _posixSys,
): SpawnHandle {
  let paused = false;
  let done = false;
  // Once the leader has exited AND the group has no live member, the pgid is
  // free for the kernel to hand to an UNRELATED process group — so from then
  // on nothing here may signal it again: kill()/abort/the SIGKILL timer all
  // become no-ops, and the abort listener and poll are dropped.
  let gone = false;
  let resolveGone!: () => void;
  const gonePromise = new Promise<void>((r) => resolveGone = r);
  const killers = new Set<ReturnType<typeof setTimeout>>();
  let poll: ReturnType<typeof setInterval> | undefined;
  let unwire = () => {};
  const markGone = () => {
    if (gone) return;
    gone = true;
    for (const t of killers) clearTimeout(t);
    killers.clear();
    clearInterval(poll);
    unwire();
    resolveGone();
  };
  /** Is there anything left to signal? A live leader holds the pgid; after it
   *  exits, only a live member does. */
  const reachable = (): boolean => {
    if (gone) return false;
    if (!done || sys.alive(pgid)) return true;
    markGone();
    return false;
  };
  const onExit = () => {
    done = true;
    if (!reachable()) return;
    // Survivors (`sh -c "worker &"`): re-check, unref'd so it never holds the
    // process open, until the group empties.
    poll = setInterval(reachable, GROUP_POLL_MS);
    Deno.unrefTimer(poll);
  };
  exited.then(onExit, onExit);

  // To the group regardless of the child: after the child exited, the group
  // can still hold the grandchildren it started — but never once it is gone.
  const toGroup = (sig: Deno.Signal) => {
    if (!reachable()) return;
    try {
      sys.signal(pgid, sig);
    } catch {
      // aio-ok: gone, or not ours to signal — nothing left to reach
    }
  };

  const send = (sig: Deno.Signal) => {
    if (done) return;
    try {
      // NEGATIVE pid = the whole group. This is the line the field report's
      // `Deno.Command("kill", ["-STOP", "-1234"])` could not do: procps kill
      // takes that as a flag, exits 0, and signals nothing.
      sys.signal(pgid, sig);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return; // already gone
      throw e;
    }
  };

  const handle: SpawnHandle = {
    pid: pgid,
    status,
    ...(stdin ? { stdin } : {}),
    get paused() {
      return paused;
    },
    pause() {
      send("SIGSTOP");
      paused = true;
    },
    resume() {
      send("SIGCONT");
      paused = false;
    },
    async kill() {
      // SIGCONT FIRST, always. A stopped process cannot handle SIGTERM, so
      // "pause, then stop" on a paused job leaves the tree alive and the app
      // waiting on a status that never comes.
      if (paused) {
        send("SIGCONT");
        paused = false;
      }
      if (!reachable()) return await status;
      // TERM reaches the survivors of an exited child too, and the SIGKILL
      // timer is NOT cancelled by the child's exit: a grandchild that ignores
      // TERM outlives its parent, and cancelling on the parent's exit orphaned
      // it exactly as the hand-rolled versions did. It IS cancelled once the
      // group is gone (markGone), since the pgid may then be someone else's.
      toGroup("SIGTERM");
      const killer = setTimeout(() => {
        killers.delete(killer);
        toGroup("SIGKILL");
      }, grace);
      killers.add(killer);
      const deadline = Date.now() + grace + 1000;
      try {
        const st = await status;
        while (reachable() && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20));
        }
        return st;
      } finally {
        clearTimeout(killer);
        killers.delete(killer);
      }
    },
  };

  unwire = _wireAbort(signal, handle, cmd);
  if (gone) unwire();
  _groupGoneOf.set(handle, gonePromise);
  return handle;
}

/** Kill `handle` when `signal` aborts — and AT ONCE when it is already
 *  aborted, since an `abort` listener added after the fact never fires. One
 *  copy for both platforms: the Windows branch carried only the listener, so
 *  a job spawned under an already-cancelled `$signal` ran to completion.
 *  Returns the remover for the listener (a no-op when none was added).
 *  @internal */
export function _wireAbort(
  signal: AbortSignal | undefined,
  handle: Pick<SpawnHandle, "kill">,
  cmd: string,
): () => void {
  const none = () => {};
  if (!signal) return none;
  const kill = () =>
    void handle.kill().catch((e) =>
      log.warn("spawn", `killing "${cmd}" after abort failed: ${e}`)
    );
  if (signal.aborted) {
    kill();
    return none;
  }
  signal.addEventListener("abort", kill, { once: true });
  return () => signal.removeEventListener("abort", kill);
}

/** Windows has no process groups or SIGSTOP. `taskkill /T` walks the tree, so
 *  cancel works; pause/resume THROW rather than pretending. */
function _spawnWindows(
  cmd: string,
  args: string[],
  opts: SpawnOptions,
  grace: number,
): SpawnHandle {
  const child = new Deno.Command(cmd, {
    args,
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const { drained } = _readStreams(child, opts.onLine);
  const status = _statusAfterDrain(child, drained);
  const stdin = opts.stdin ? _stdin(child.stdin, status, cmd) : undefined;
  const pid = child.pid;
  const unsupported = (op: string) => () => {
    throw new Error(
      `spawn: ${op}() is not supported on Windows — there is no SIGSTOP and ` +
        `no process group to send it to. Gate the feature on ` +
        `Deno.build.os !== "windows", or have the child implement pause itself.`,
    );
  };
  const handle: SpawnHandle = {
    pid,
    status,
    ...(stdin ? { stdin } : {}),
    paused: false,
    pause: unsupported("pause"),
    resume: unsupported("resume"),
    async kill() {
      // /T = tree, /F = force. Without /T this orphans grandchildren exactly
      // like a bare SIGTERM does on POSIX.
      try {
        await new Deno.Command("taskkill", {
          args: ["/PID", String(pid), "/T", "/F"],
          stdout: "null",
          stderr: "null",
        }).output();
      } catch { /* taskkill missing — fall through to the plain kill below */ }
      const killer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
      }, grace);
      try {
        return await status;
      } finally {
        clearTimeout(killer);
      }
    },
  };
  _wireAbort(opts.signal, handle, cmd);
  return handle;
}

const _toStatus = (s: Deno.CommandStatus): SpawnStatus => ({
  code: s.code,
  signal: s.signal ?? null,
  success: s.success,
});

/** Pump both streams into `onLine`, and resolve with the process-group id the
 *  shim printed. The marker is consumed here so it can never reach an app. */
function _readStreams(
  child: Deno.ChildProcess,
  onLine?: (line: string, stream: "stdout" | "stderr") => void,
): { pgid: Promise<number>; drained: Promise<unknown> } {
  let resolvePgid: (n: number) => void;
  const pgid = new Promise<number>((r) => {
    resolvePgid = r;
  });

  const pump = async (
    stream: ReadableStream<Uint8Array>,
    which: "stdout" | "stderr",
  ) => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += dec.decode(chunk, { stream: true });
      // `\r` ends a line too — a progress bar rewriting one line emits no
      // newline for the whole job.
      const parts = buf.split(/\r\n|\n|\r/);
      buf = parts.pop() ?? "";
      for (const line of parts) {
        if (which === "stdout" && line.startsWith(PGID_MARKER)) {
          const n = Number(line.slice(PGID_MARKER.length));
          if (Number.isInteger(n) && n > 0) resolvePgid(n);
          continue; // never surfaced: it is framework plumbing, not output
        }
        onLine?.(line, which);
      }
    }
    if (buf.length > 0) onLine?.(buf, which);
  };

  // Both pumps must run to completion even when nobody reads the handle's
  // streams, or a chatty child blocks forever on a full pipe.
  const drained = Promise.all([
    pump(child.stdout, "stdout").catch(() => {}),
    pump(child.stderr, "stderr").catch(() => {}),
  ]);
  return { pgid, drained };
}

/** The child's status, settled only once its output has been READ: `onLine`
 *  has seen the last line, and no pipe read is still open. Resolving on exit
 *  alone let a caller that awaited `status` (or `kill()`) miss the tail of
 *  the output, and — under load — end a test with both pipe reads still in
 *  flight (a leaked op). Bounded: a grandchild that inherited the pipe and
 *  outlives the child must not hold the status hostage. */
function _statusAfterDrain(
  child: Deno.ChildProcess,
  drained: Promise<unknown>,
): Promise<SpawnStatus> {
  return child.status.then(async (st) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      drained,
      new Promise((r) => timer = setTimeout(r, DRAIN_BOUND_MS)),
    ]);
    clearTimeout(timer);
    return _toStatus(st);
  });
}

/** How long a finished child's pipes may take to reach EOF. */
const DRAIN_BOUND_MS = 2000;

// spawn.ts — a child process an app can actually cancel, pause and read.
//
// Requested by two field reports (ayd, bw2col) and written from scratch by
// both. bw2col's version cost them a real user-visible bug, and it is the
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
};

/** A running child and everything you can do to it — wait, pause, resume,
 *  kill (as a whole process group). */
export type SpawnHandle = {
  /** The child's process-group id — its own, never the app's. */
  readonly pid: number;
  /** Settles when the child and everything it started are gone. */
  readonly status: Promise<SpawnStatus>;
  /** SIGSTOP the whole group. Throws where that has no meaning (Windows). */
  pause(): void;
  /** SIGCONT the whole group. */
  resume(): void;
  /** SIGCONT (a stopped process cannot handle TERM), then SIGTERM, then
   *  SIGKILL after `killGraceMs` — to the GROUP, so nothing is orphaned. */
  kill(): Promise<SpawnStatus>;
  readonly paused: boolean;
};

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

  if (Deno.build.os === "windows") return _spawnWindows(cmd, args, opts, grace);

  let child: Deno.ChildProcess | null = null;
  const tried: string[] = [];
  for (const launcher of LAUNCHERS) {
    const spec = sessionLeaderSpec(launcher, cmd, args);
    try {
      child = new Deno.Command(spec.cmd, {
        args: spec.args,
        cwd: opts.cwd,
        env: opts.env,
        stdin: "null",
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

  const pgidPromise = _readStreams(child, opts.onLine);
  // The marker races the child's own death: a launcher that fails (a missing
  // command, a cwd that does not exist) exits before printing anything, and a
  // spawn() that waited for a marker that will never come would hang forever.
  const status = child.status.then(_toStatus);
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

  return _handle(pgid, status, grace, opts.signal, cmd);
}

/** POSIX handle — every signal goes to `-pgid`, never to a bare pid. */
function _handle(
  pgid: number,
  status: Promise<SpawnStatus>,
  grace: number,
  signal: AbortSignal | undefined,
  cmd: string,
): SpawnHandle {
  let paused = false;
  let done = false;
  status.then(() => {
    done = true;
  }).catch(() => {
    done = true;
  });

  const send = (sig: Deno.Signal) => {
    if (done) return;
    try {
      // NEGATIVE pid = the whole group. This is the line the field report's
      // `Deno.Command("kill", ["-STOP", "-1234"])` could not do: procps kill
      // takes that as a flag, exits 0, and signals nothing.
      Deno.kill(-pgid, sig);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return; // already gone
      throw e;
    }
  };

  const handle: SpawnHandle = {
    pid: pgid,
    status,
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
      send("SIGTERM");
      const killer = setTimeout(() => send("SIGKILL"), grace);
      try {
        return await status;
      } finally {
        clearTimeout(killer);
      }
    },
  };

  if (signal) {
    if (signal.aborted) void handle.kill();
    else {
      signal.addEventListener("abort", () => {
        handle.kill().catch((e) =>
          log.warn("spawn", `killing "${cmd}" after abort failed: ${e}`)
        );
      }, { once: true });
    }
  }
  return handle;
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
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  void _readStreams(child, opts.onLine);
  const status = child.status.then(_toStatus);
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
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => void handle.kill(), {
      once: true,
    });
  }
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
): Promise<number> {
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
  void Promise.all([
    pump(child.stdout, "stdout").catch(() => {}),
    pump(child.stderr, "stderr").catch(() => {}),
  ]);
  return pgid;
}

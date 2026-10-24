// am kill — the last resort: which pids are locked or listening, refusing a
// stale or foreign pid, ask-then-kill, and the Windows path. Split out of
// am-cmd-process.ts, which re-exports every name here, so no importer
// changes.

import {
  foreignOwnerRefusal,
  instances,
  isLockOwnerAlive,
  isProcessAlive,
  KILL_POLL_MS,
  lockDir,
  readLaunchInfo,
} from "../server/single-instance-lock.ts";
import type { LockData } from "../server/single-instance-lock.ts";
import { dirname, join } from "@std/path";
import { appDirs } from "../server/app-dirs.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { holdLeftover, sweepIncomplete, sweptLine } from "./am-cmd-data.ts";
import {
  lockHasNoDoor,
  maintenanceOp,
  otherRootRefusal,
  readEntryConfig,
  removeLockKeyed,
  removePid,
  resolveAmAppId,
} from "./am-utils.ts";
import { trojanPost } from "./am-http.ts";
import { HEALTH_TIMEOUT_MS, QUICK_TIMEOUT_MS } from "./am-launch.ts";
import { noLockOnPortMessage, resolveLockTarget } from "./am-cmd-stop.ts";

/** `am kill [--stale]` — end a process the polite path cannot reach.
 *
 *  `am stop` asks the app to shut down and falls back to SIGTERM when it has a
 *  lock on the port. Neither helps against an ORPHAN: a run whose lock is gone
 *  but whose process kept the port and kept answering. A field report hit that
 *  three times in one session — `am status` said `stopped`, `am instances`
 *  listed nothing, and `am state` cheerfully served five-hour-old numbers,
 *  which they then reported to a user as current. A stale singleton silently
 *  serving old state is worse than a crash, because nothing about it looks
 *  wrong.
 *
 *  `--stale` finds them the only way that is reliable: ASK. Every port a lock
 *  or the app config names is probed; a responder that reports an `appId`/`pid`
 *  no live lock accounts for is an orphan, and its pid comes from its own
 *  health answer (which is why `/__aio/health` reports one).
 *
 *  Nothing is killed silently — every kill is named, and with no orphans the
 *  command says so. */
/** Every pid an aio lock names, anywhere on this machine — the default lock
 *  dir AND every `AIO_APPS_DIR`-scoped sibling beside it (`aio-<scope>`).
 *
 *  `instances()` only ever reads OUR scope. An app started under a different
 *  `AIO_APPS_DIR` was therefore invisible to it, so `am kill --stale`
 *  classified a perfectly healthy app as an orphan and SIGTERMed it. The lock
 *  files are right there; not reading them was the bug. */
export function lockedPidsEverywhere(): Map<
  number,
  { appId: string; dir: string }
> {
  const found = new Map<number, { appId: string; dir: string }>();
  const base = dirname(lockDir());
  const dirs = new Set<string>([lockDir()]);
  try {
    for (const e of Deno.readDirSync(base)) {
      if (e.isDirectory && /^aio(-|$)/.test(e.name)) {
        dirs.add(join(base, e.name));
      }
    }
  } catch {
    /* aio-ok: base unreadable — the default dir alone still applies */
  }
  for (const dir of dirs) {
    try {
      for (const e of Deno.readDirSync(dir)) {
        if (!e.isFile || !e.name.endsWith(".lock")) continue;
        try {
          const d = JSON.parse(Deno.readTextFileSync(join(dir, e.name))) as {
            pid?: number;
            appId?: string;
          };
          if (typeof d.pid === "number" && d.pid > 0) {
            found.set(d.pid, { appId: d.appId ?? "?", dir });
          }
        } catch { /* aio-ok: unreadable or half-written lock — skip it */ }
      }
    } catch { /* aio-ok: dir vanished */ }
  }
  return found;
}

/** The command line of `pid`, or null when this platform will not say. */
function pidCommandLine(pid: number): string | null {
  try {
    if (Deno.build.os === "linux") {
      const cmdline = Deno.readTextFileSync(`/proc/${pid}/cmdline`)
        .replaceAll("\0", " ").trim();
      if (cmdline) return cmdline;
      // EMPTY is not "no such process" — `/proc/<pid>/cmdline` is empty for a
      // kernel thread, for a zombie, and for the instant between fork and
      // execve. It used to be returned as-is, so the refusal below read
      // "…it is running: " and stopped mid-sentence: a message that names
      // nothing, on the exact path that decides whether to signal a stranger's
      // process. `comm` is populated for every live pid, so it answers when
      // cmdline cannot.
      const comm = Deno.readTextFileSync(`/proc/${pid}/comm`).trim();
      return comm || null;
    }
    if (Deno.build.os === "darwin") {
      const r = new Deno.Command("ps", {
        args: ["-o", "command=", "-p", String(pid)],
        stdout: "piped",
        stderr: "null",
      }).outputSync();
      return r.success
        ? new TextDecoder().decode(r.stdout).trim() || null
        : null;
    }
    if (Deno.build.os === "windows") {
      // The IMAGE name (`deno.exe`) is what Windows says without a privilege
      // or a second of PowerShell. With none, `am kill --stale` ended whatever
      // pid a loopback health answer named — the check below never ran.
      const r = new Deno.Command("tasklist", {
        args: ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        stdout: "piped",
        stderr: "null",
      }).outputSync();
      return r.success
        ? /^"([^"]+)"/.exec(new TextDecoder().decode(r.stdout))?.[1] ?? null
        : null;
    }
  } catch { /* aio-ok: gone, or not ours to read */ }
  return null;
}

/** Why `pid` must NOT be signalled as a stale aio app, or null when it may be.
 *
 *  `am kill --stale` used to SIGTERM whatever pid an unauthenticated loopback
 *  `/__aio/health` response reported ABOUT ITSELF, unverified. Two things
 *  follow, and both are real: a healthy app under a different `AIO_APPS_DIR`
 *  is invisible to `instances()` and so gets killed as an orphan; and anything
 *  listening on a candidate port can name ANY pid on the machine and have `am`
 *  SIGTERM it. A number that arrives over a socket is a claim, not a fact — so
 *  it is checked against the process table before any signal. */
export function stalePidRefusal(
  pid: number,
  locked: Map<number, { appId: string; dir: string }>,
  /** Does `pid` itself hold the listening socket that answered as an aio
   *  app? Asked only when its NAME does not say so ({@linkcode listenerPids}). */
  ownsPort: () => boolean = () => false,
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return `"${pid}" is not a pid`;
  if (pid === Deno.pid) return "that is am itself";
  const known = locked.get(pid);
  if (known) {
    return `pid ${pid} is a LOCKED aio instance (${known.appId} in ` +
      `${known.dir}) — running normally, just not in this scope ` +
      `(AIO_APPS_DIR). Not an orphan.`;
  }
  if (!isProcessAlive(pid)) return `pid ${pid} is already gone`;
  // Ours to signal at all? isProcessAlive counts EPERM as alive on purpose
  // (another user's process IS running), which is exactly the case to refuse.
  try {
    Deno.kill(pid, 0);
  } catch {
    return `pid ${pid} belongs to another user — not ours to signal`;
  }
  const cmd = pidCommandLine(pid);
  if (cmd === null) return null; // platform will not say; the pid is all there is
  // A COMPILED app runs under its own name (`notes`, `notes.exe`), so the
  // name alone spared every compiled app's orphan, for good. The name is not
  // widened: such a process is accepted only on evidence that it IS the aio
  // app that answered — the kernel says this very pid holds the listening
  // socket the aio health route was served from. A stranger whose pid a
  // listener merely NAMED does not hold that socket.
  if (!/\bdeno\b|aio/i.test(cmd) && !ownsPort()) {
    return `pid ${pid} is not an aio process — it is running: ${
      cmd.slice(0, 120)
    }`;
  }
  return null;
}

/** The pids holding a LISTENING TCP socket on `port` — what the OS says, not
 *  what anything on the port claims. Empty when it cannot be read (no tool,
 *  no permission): then nothing is proven and the caller's refusal stands.
 *  `run` is a seam so each OS's parsing is a test on any host. */
export function listenerPids(
  port: number,
  os: string = Deno.build.os,
  run: (cmd: string, args: string[]) => string | null = runForText,
  /** Linux: the kernel's name for `pid` (`/proc/<pid>/comm`), or null. */
  comm: (pid: number) => string | null = procComm,
): number[] {
  const pids = new Set<number>();
  if (os === "linux") {
    // `LISTEN 0 511 127.0.0.1:8123 0.0.0.0:* users:(("notes",pid=4242,fd=9))`
    const out = run("ss", ["-H", "-ltnp", `sport = :${port}`]) ?? "";
    // The process NAME is in that text too, and a name is anything its owner
    // likes (`pid=1`, `",pid=1,fd=3`): a pid counts only as part of a whole
    // `("<its own name>",pid=N,fd=M)` entry — one character more than a name
    // can hold (15), so no name can contain one.
    for (const m of out.matchAll(/,pid=(\d+),fd=\d+\)/g)) {
      const name = comm(Number(m[1]));
      if (name !== null && out.includes(`("${name}"${m[0]}`)) {
        pids.add(Number(m[1]));
      }
    }
  } else if (os === "darwin") {
    const out = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]) ??
      "";
    for (const l of out.split("\n")) if (/^\d+$/.test(l.trim())) pids.add(+l);
  } else if (os === "windows") {
    // `  TCP    127.0.0.1:8123    0.0.0.0:0    LISTENING    4242`
    // Not by the state word: netstat translates it (`ABHÖREN`, `ÉCOUTE`), so
    // on a non-English Windows nothing matched. A listener is the row whose
    // FOREIGN end is port 0 — the same in every language.
    const out = run("netstat", ["-ano", "-p", "TCP"]) ?? "";
    for (const l of out.split("\n")) {
      const f = l.trim().split(/\s+/);
      if (
        f.length === 5 && f[0] === "TCP" && f[1]!.endsWith(`:${port}`) &&
        f[2]!.endsWith(":0")
      ) pids.add(Number(f[4]));
    }
  }
  return [...pids].filter((p) => Number.isInteger(p) && p > 0);
}

function procComm(pid: number): string | null {
  try {
    return Deno.readTextFileSync(`/proc/${pid}/comm`).replace(/\n$/, "");
  } catch {
    return null; // aio-ok: gone, or not readable — then it is not proven
  }
}

function runForText(cmd: string, args: string[]): string | null {
  try {
    const r = new Deno.Command(cmd, { args, stdout: "piped", stderr: "null" })
      .outputSync();
    return r.success ? new TextDecoder().decode(r.stdout) : null;
  } catch {
    return null; // aio-ok: no such tool here — nothing is proven, and the caller refuses
  }
}

/** `am kill` on Windows, where the POSIX branch's SIGTERM is TerminateProcess.
 *
 *  An APP is asked to stop first ({@linkcode askThenKill}) and the answer says
 *  whether it stopped cleanly or was ended hard. An `am backup` / `am restore`
 *  holding the lock has no door to ask through and cannot catch anything: it
 *  is terminated, and — being provably dead then — the incomplete copy its
 *  lock names is removed HERE, with its lock. The POSIX sentence ("it removes
 *  its partial copy and exits 143") is a promise that op cannot keep on this
 *  OS. */
async function killOnWindows(
  appId: string,
  pf: LockData,
  mode: import("./am-types.ts").OutputMode,
): Promise<void> {
  const alive = () => isLockOwnerAlive(pf);
  const kill = () => {
    try {
      Deno.kill(pf.pid, "SIGTERM");
    } catch { /* aio-ok: raced us to the exit */ }
  };
  const op = maintenanceOp(pf);
  if (op) {
    const how = await askThenKill({
      ask: () => Promise.resolve(false),
      alive,
      kill,
    });
    if (how === "alive") {
      outError(`${op} on ${appId} (pid ${pf.pid}) is still alive`, mode);
      Deno.exit(1);
    }
    const ended = how === "gone"
      ? `${op} on ${appId} (pid ${pf.pid}) was not running any more — ` +
        `nothing was ended here; what it left`
      : `ended ${op} on ${appId} (pid ${pf.pid}) hard — Windows has no ` +
        `signal it could catch, so it did not clean up itself`;
    const data = join(pf.home ?? appDirs(appId).home, "data");
    const isThere = (p: string) => {
      try {
        Deno.lstatSync(p);
        return true;
      } catch {
        return false; // aio-ok: the answer — reported below
      }
    };
    const dataThere = isThere(data);
    const left = holdLeftover(pf, data);
    const swept = left ? sweepIncomplete(left) : null;
    removeLockKeyed(pf);
    const copy = swept
      ? sweptLine(swept)
      : left && isThere(left)
      ? `${left} is still there and does not say it is this op's copy — ` +
        `check it, then delete it`
      : `it left no copy behind`;
    const dataSaid = dataThere
      ? `data/ is in place`
      : `data/ is MISSING — the kill landed between the two renames of the ` +
        `swap: the previous data is in ${data}.replaced-*; rename it back ` +
        `to ${data}`;
    out(
      mode === "pretty" ? `${ended}: ${copy}; ${dataSaid}` : {
        appId,
        pid: pf.pid,
        killed: how === "hard",
        op,
        how,
        ...(swept
          ? { partial: swept.path, partialRemoved: swept.removed }
          : {}),
        dataPresent: dataThere,
      },
      mode,
    );
    if (!dataThere || (swept && !swept.removed)) Deno.exit(1);
    return;
  }
  const how = await askThenKill({
    // A lock with no door (still booting) has nobody to ask.
    ask: async () =>
      !lockHasNoDoor(pf) &&
      (await trojanPost(
        pf.port,
        "shutdown",
        undefined,
        appId,
        QUICK_TIMEOUT_MS,
        pf.pid,
      )).ok,
    alive,
    kill,
  });
  if (how === "alive") {
    outError(
      `${appId} (pid ${pf.pid}) is still alive after it was terminated — ` +
        `not killed`,
      mode,
    );
    Deno.exit(1);
  }
  removePid(appId, pf);
  out(
    mode === "pretty"
      ? killSaid(appId, pf.pid, how)
      : { appId, pid: pf.pid, killed: how !== "gone", how },
    mode,
  );
}

/** What `am kill` on Windows says about an APP, per outcome. Pure. */
export function killSaid(
  appId: string,
  pid: number,
  how: "clean" | "hard" | "gone",
): string {
  return how === "clean"
    ? `stopped ${appId} cleanly (pid ${pid}) — it was asked first, ` +
      `because Windows has no signal an app can catch`
    : how === "gone"
    ? `${appId} (pid ${pid}) was not running any more — nothing was ` +
      `stopped or killed; its lock is removed`
    : `killed ${appId} (pid ${pid}) — ${ENDED_HARD}`;
}

/** How long `am kill` on Windows waits for an app that ACCEPTED the stop to
 *  be gone before it ends it the hard way. Short: this is `kill`, not `stop`. */
const KILL_ASK_WAIT_MS = 3000;

/** End a process where there is no signal it could catch (Windows: `kill` is
 *  TerminateProcess — no handler, no `onStop`, no final flush). So it is
 *  ASKED first, through the same keyed stop `am stop` uses, for a short
 *  bound; only then ended the hard way — and the answer says which happened,
 *  because "killed" alone hid a lost last write.
 *
 *  Every effect is handed in, so the three outcomes are a test on any host:
 *  `"clean"` — it accepted the stop and exited; `"hard"` — it was terminated;
 *  `"gone"` — it never accepted anything and was not running any more (it
 *  had crashed, or somebody else ended it): nothing is known about HOW it
 *  ended, so neither of the other two is said; `"alive"` — it survived even
 *  the termination. */
export async function askThenKill(o: {
  /** The keyed stop. True when the app accepted it. */
  ask: () => Promise<boolean>;
  alive: () => boolean;
  kill: () => void;
  waitMs?: number;
  pollMs?: number;
}): Promise<"clean" | "hard" | "gone" | "alive"> {
  const gone = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (o.alive()) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, o.pollMs ?? KILL_POLL_MS));
    }
    return true;
  };
  const waitMs = o.waitMs ?? KILL_ASK_WAIT_MS;
  const asked = await o.ask();
  if (asked && await gone(waitMs)) return "clean";
  // Gone between the bound and this look: clean only if it had accepted.
  if (!o.alive()) return asked ? "clean" : "gone";
  o.kill();
  return await gone(waitMs) ? "hard" : "alive";
}

/** What `am kill` / `am stop` say about HOW an app ended, when that was not
 *  a clean shutdown. Pure. */
export const ENDED_HARD = "ended hard: onStop and the last flush did not run";

export async function cmdKill(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const live = instances();

  if (!flags.stale) {
    // The blunt form: end THIS app now. `am stop` is the polite one.
    // Same target resolver as `stop` and `restart`: `--port=N` names the app,
    // and a `--port` that names no lock is refused rather than quietly
    // ignored — `am kill --port=1` used to SIGTERM the cwd's app.
    const t = resolveLockTarget(flags);
    if (t.kind === "probe") {
      outError(noLockOnPortMessage(t.port), mode);
      Deno.exit(1);
    }
    // Not running: exit 1, and the document carries `error` like every other
    // failed `--json` answer (additive — `killed: false` stays), so a script
    // keyed on `error` does not read a kill that found nothing as a success.
    if (t.kind === "none") {
      const appId = resolveAmAppId(flags.app);
      out(
        mode === "pretty"
          ? `${appId}: not running`
          : { appId, killed: false, error: `${appId} is not running` },
        mode,
      );
      Deno.exit(1);
    }
    const appId = t.target.appId;
    const pf = t.target.pf; // wherever the instance's home is
    if (!pf || !isLockOwnerAlive(pf)) {
      out(
        mode === "pretty"
          ? `${appId}: not running`
          : { appId, killed: false, error: `${appId} is not running` },
        mode,
      );
      Deno.exit(1);
    }
    const foreign = foreignOwnerRefusal(pf) ?? otherRootRefusal("kill", pf);
    if (foreign) {
      outError(foreign, mode);
      Deno.exit(1);
    }
    if (Deno.build.os === "windows") {
      await killOnWindows(appId, pf, mode);
      return;
    }
    try {
      Deno.kill(pf.pid, "SIGTERM");
    } catch { /* aio-ok: raced us to the exit */ }
    // `am backup` / `am restore` holding the lock: the SIGTERM interrupts THE
    // OP, not an app — say so. And leave its lock alone: the op releases it
    // itself once it has cleaned up (removing it here let an app start while
    // a restore was still putting data/ in place).
    const op = maintenanceOp(pf);
    if (op) {
      out(
        mode === "pretty"
          ? `interrupted ${op} on ${appId} (pid ${pf.pid}) — it stops at the ` +
            `next file, removes its partial copy and exits 143; data/ is left ` +
            `as it was`
          : { appId, pid: pf.pid, killed: true, op },
        mode,
      );
      return;
    }
    removePid(appId, pf);
    out(
      mode === "pretty"
        ? `killed ${appId} (pid ${pf.pid})`
        : { appId, pid: pf.pid, killed: true },
      mode,
    );
    return;
  }

  // Candidate ports: everything a lock names, plus the port this project's
  // config asks for — the one an orphan of THIS app is most likely holding.
  const accounted = new Map<number, { appId: string; pid: number }>();
  for (const i of live) accounted.set(i.port, { appId: i.appId, pid: i.pid });
  const candidates = new Set<number>(accounted.keys());
  const cfgPort = readEntryConfig().port;
  if (cfgPort) candidates.add(cfgPort);
  if (flags.port) candidates.add(flags.port);
  // …plus the port THIS app was last launched with. An orphan usually holds
  // the same port its predecessor did, and `am start` recorded it even though
  // the lock is gone.
  const launched = readLaunchInfo(resolveAmAppId(flags.app));
  for (const f of launched?.flags ?? []) {
    const m = /^--port=(\d+)$/.exec(f);
    if (m) candidates.add(Number(m[1]));
  }

  const orphans: Array<{ appId: string; pid: number; port: number }> = [];
  /** Ports that answered but whose pid this refuses to signal — reported, not
   *  swallowed: "nothing happened" and "I would not do that" are different
   *  answers, and only one of them is actionable. */
  const spared: Array<{ port: number; pid: number; why: string }> = [];
  const lockedPids = lockedPidsEverywhere();
  for (const port of candidates) {
    let health: { appId?: string; pid?: number } | null = null;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/__aio/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      health = r.ok ? await r.json() : null;
    } catch { /* nothing there — not an orphan, just a closed port */ }
    if (!health?.pid) continue;
    const known = accounted.get(port);
    // Accounted for by a live lock, and the SAME process — this is the app.
    if (known && known.pid === health.pid) continue;
    // The pid arrived over an unauthenticated loopback socket. Check it.
    const claimed = health.pid;
    const refusal = stalePidRefusal(
      claimed,
      lockedPids,
      () => listenerPids(port).includes(claimed),
    );
    if (refusal) {
      spared.push({ port, pid: health.pid, why: refusal });
      continue;
    }
    orphans.push({
      appId: health.appId ?? "unknown",
      pid: health.pid,
      port,
    });
  }

  if (orphans.length === 0) {
    out(
      mode === "pretty"
        ? `no stale aio processes (checked ports: ${
          [...candidates].sort((a, b) => a - b).join(", ") || "none"
        })` +
          spared.map((sp) =>
            `\n  left pid ${sp.pid} on port ${sp.port} alone — ${sp.why}`
          ).join("") +
          `\n  an orphan on a port nothing records is invisible here — ` +
          `name it with --port=N`
        : { killed: [], checked: [...candidates], spared },
      mode,
    );
    return;
  }

  for (const o of orphans) {
    try {
      Deno.kill(o.pid, "SIGTERM");
    } catch { /* already gone */ }
  }
  out(
    mode === "pretty"
      ? orphans
        .map((o) =>
          `killed stale ${o.appId} (pid ${o.pid}, port ${o.port}) — it was ` +
          `serving with no lock, so every am command was reading past it`
        )
        .join("\n") +
        spared.map((sp) =>
          `\nleft pid ${sp.pid} on port ${sp.port} alone — ${sp.why}`
        ).join("")
      : { killed: orphans, spared },
    mode,
  );
}

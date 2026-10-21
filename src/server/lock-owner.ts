// Judging a lock's owner — is the process that wrote a record still that
// process, is it ours, may we touch it; the hold files; endpoint probes and
// the zombie verdict; and asking or forcing an instance to stop. Split out
// of single-instance-lock.ts, which re-exports every name here, so no
// importer changes.

import { dirname, isAbsolute, resolve } from "@std/path";
import { connectLocal, isPipePath } from "./local-listen.ts";
import { appsDirEnv } from "./app-dirs.ts";
import { EXIT_WAIT_MS } from "./shutdown-budget.ts";
import { appKeyPath, readControlKey } from "./app-key.ts";
import { udsRequest } from "./local-request.ts";
import { STARTUP_GRACE_MS, STUCK_STARTING_MS } from "./single-instance-lock.ts";
import type { LockData } from "./single-instance-lock.ts";
import {
  delay,
  descendantPids,
  isProcessAlive,
  KILL_GRACE_MS,
  KILL_POLL_MS,
  KILL_REAP_MS,
  ownPidNs,
  ownPidTag,
  processStartEpoch,
  processStartToken,
} from "./process-liveness.ts";
import {
  _nonce,
  ageSince,
  lockAgeMs,
  pauseSync,
  printable,
  readLockRaw,
  sameFile,
} from "./lock-file.ts";
import { _lockDirParts, remakeLockDir } from "./lock-dir.ts";

/** The identity fields a lock records for its owner `pid`: Linux's kernel
 *  start ticks or Windows' creation time (`startToken`), macOS's UTC start
 *  second (`startEpoch`),
 *  nothing where neither is available. */
export function ownerIdentity(
  pid: number,
): Pick<LockData, "startToken" | "startEpoch" | "ns"> {
  // `pid` is this process or a child it spawned: our namespace either way.
  const ns = ownPidNs();
  const where = ns === undefined ? {} : { ns };
  const token = processStartToken(pid);
  if (token !== null) return { startToken: token, ...where };
  const epoch = processStartEpoch(pid);
  return epoch !== null ? { startEpoch: epoch, ...where } : where;
}

/** Is the process this lock names still THE process the lock was written for?
 *
 *  `isProcessAlive` answers "does some process have this pid", which is a
 *  different question and the one every kill site used to ask. A lock that
 *  survived a reboot names a pid the kernel has since handed to somebody
 *  else, and SIGTERM does not ask who it is talking to.
 *
 *  Fails SAFE in the only direction that is safe: when either token is
 *  unavailable (an old lock, no FFI on Windows, a pid we cannot read) this falls back to
 *  liveness — which is exactly the old behaviour, never worse. When both are
 *  known and they DIFFER, the pid was recycled and the answer is no.
 *  @decider */
export function isLockOwnerAlive(
  lock: {
    pid: number;
    startToken?: string;
    startEpoch?: number;
    ns?: number;
    hold?: string;
    startedAt?: number;
  },
): boolean {
  // Written in another pid namespace: its pid says nothing here. Its hold
  // file does — the kernel released it if the owner died. Without one (a
  // placeholder `am start` or a dev supervisor filed for a child that has
  // not booted yet): alive until a boot that long would be reclaimed as
  // stuck anyway (`STUCK_STARTING_MS`, `am`'s rule for a booting app).
  if (lock.ns !== undefined && lock.ns !== ownPidNs()) {
    const held = lock.hold && isAbsolute(lock.hold)
      ? holdIsHeld(lock.hold)
      : null;
    return held ?? (typeof lock.startedAt === "number" &&
      ageSince(lock.startedAt) < STUCK_STARTING_MS);
  }
  if (!isProcessAlive(lock.pid)) return false;
  return ownerMatches(lock, {
    token: lock.startToken ? processStartToken(lock.pid) : null,
    epoch: typeof lock.startEpoch === "number"
      ? processStartEpoch(lock.pid)
      : null,
  });
}

/** Does a LIVE pid's current identity (`now`) match what its lock recorded?
 *  Only a known-and-different value says no: an absent, unreadable or legacy
 *  record (macOS's old locale text `startToken`, which no reader derives any
 *  more — `now.token` is null there) is "unknown", which falls back to pid
 *  liveness. Pure. @internal */
export function ownerMatches(
  lock: { startToken?: string; startEpoch?: number },
  now: { token: string | null; epoch: number | null },
): boolean {
  if (lock.startToken && now.token !== null && now.token !== lock.startToken) {
    return false;
  }
  if (
    typeof lock.startEpoch === "number" && now.epoch !== null &&
    now.epoch !== lock.startEpoch
  ) return false;
  return true;
}

/** Does `lock` name THIS process (or `pid`, a child of ours)? The pid AND
 *  the namespace: a container sharing the lock dir is pid 7 too, and treating
 *  its live lock as ours deleted it (take-over of "our" placeholder, exit
 *  cleanup, release) or overwrote it (update). A lock with no namespace
 *  recorded (older, or no namespaces here): the pid, as before. */
export function isOwnLock(
  lock: { pid: number; ns?: number },
  pid: number = Deno.pid,
): boolean {
  return lock.pid === pid &&
    (lock.ns === undefined || lock.ns === ownPidNs());
}

/** Why the owner `lock` names cannot be SIGNALLED from here — it runs in
 *  another pid namespace (a container sharing this lock dir), where its pid
 *  is not the one this process would hit — or null when it can. Every kill
 *  site asks this first: signalling "pid 7" here reaches a stranger or
 *  nothing. */
export function foreignOwnerRefusal(
  lock: { pid: number; ns?: number },
): string | null {
  if (lock.ns === undefined || lock.ns === ownPidNs()) return null;
  return `refusing to signal pid ${lock.pid}: it runs in another pid ` +
    `namespace (a container sharing this lock dir), so that pid means a ` +
    `different process here.\n  fix: stop it where it runs (inside that ` +
    `container), or with \`am stop\` there.`;
}

/** The apps root the owner of `lock` was started under, when that is ANOTHER
 *  `AIO_APPS_DIR` than `appsDir` whose lock folder has the same name
 *  ({@linkcode _lockDirParts}) — else null.
 *
 *  Two such roots share one lock dir, so an `am` under one lists the other's
 *  apps and, reading `<appId>.lock`, took the other root's app for its own:
 *  `am stop` there stopped it. The root is read from the record's `home`
 *  (`<root>/<appId>`, `<root>/<appId>-<profile>`), and only a root with THIS
 *  lock folder's name counts — an app whose folder is fixed elsewhere
 *  (`aio.run({ appDir })`, `--home`) is this scope's, wherever its data is.
 *  Null on missing data, never a guess: no `AIO_APPS_DIR` here, or a record
 *  with no `home` (written before alpha66). Pure but for the link look. */
export function otherAppsRootOf(
  lock: { home?: string },
  appsDir: string | undefined = appsDirEnv(),
): string | null {
  if (!appsDir || !lock.home) return null;
  const root = dirname(resolve(lock.home));
  if (root === resolve(appsDir)) return null;
  if (_lockDirParts(root).scope !== _lockDirParts(resolve(appsDir)).scope) {
    return null;
  }
  // One directory under two spellings (a link in the path) is one root.
  try {
    if (Deno.realPathSync(root) === Deno.realPathSync(appsDir)) return null;
  } catch { /* aio-ok: one of them is gone — the paths differ, as compared */ }
  return root;
}

/** Is the hold file at `path` OS-locked by a live process? False when it is
 *  gone (its owner released it, or it was swept as a dead owner's) or
 *  lockable (the kernel dropped a dead owner's lock). A lock another reader
 *  holds for the microseconds of this same check looks held, so a failed try
 *  is retried briefly; an owner holds it for its whole life. Null: this file
 *  system cannot say. */
function holdIsHeld(path: string): boolean | null {
  let f: Deno.FsFile;
  try {
    f = Deno.openSync(path, { read: true });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    return null; // aio-ok: unreadable here — the caller's fallback judges
  }
  try {
    for (let i = 0; i < 3; i++) {
      if (f.tryLockSync(true)) return false;
      pauseSync(2);
    }
    return true;
  } catch {
    return null; // aio-ok: no OS locks on this file system — fallback judges
  } finally {
    f.close();
  }
}

/** Create and OS-lock this process's hold file for the lock at `lockFile`
 *  (see {@linkcode LockData} `hold`). Null where there are no pid namespaces
 *  (the pid decides there) or the file system cannot lock. The file is
 *  locked BEFORE any record names it, and a sweep that unlinked it before our
 *  lock landed is caught by `sameFile` — retried. */
export function takeHold(
  lockFile: string,
): { f: Deno.FsFile; path: string } | null {
  if (ownPidNs() === undefined) return null;
  for (let i = 0; i < 3; i++) {
    const path = `${lockFile}.${ownPidTag()}.${_nonce()}.hold`;
    const open = () =>
      Deno.openSync(path, { write: true, createNew: true, mode: 0o600 });
    let f: Deno.FsFile;
    try {
      f = open();
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) return null; // aio-ok: unwritable — the pid rule stays
      try {
        remakeLockDir(dirname(path));
        f = open();
      } catch {
        return null; // aio-ok: unwritable lock dir — the pid rule stays
      }
    }
    let ok = false;
    try {
      ok = f.tryLockSync(true) && sameFile(f, path);
    } catch { /* aio-ok: no OS locks here — no hold, the pid rule stays */ }
    if (ok) return { f, path };
    f.close();
    try {
      Deno.removeSync(path);
    } catch { /* aio-ok: swept already */ }
  }
  return null;
}

/** What one connection attempt to a holder's endpoint found.
 *  `up`: something accepted. `gone`: NOTHING listens there — the address
 *  refused, or the socket/pipe does not exist. `busy`: something is there
 *  and did not take this connection (every pipe instance in use, access
 *  denied, a timeout) — a listener that is busy is a listener. */
export type EndpointProbe = { state: "up" | "busy" | "gone"; why?: string };

/** Where a lock record says its holder listens — its local socket when it
 *  has one, else the TCP address it BOUND (`host` + `port`). A wildcard bind
 *  is reached on loopback: `0.0.0.0` at `127.0.0.1`; `::`, which binds both
 *  families on most systems, at `::1` AND `127.0.0.1`. Null: the record
 *  names no endpoint — it has no door, or it was written by an aio that
 *  recorded the port without the address, which says nothing about where to
 *  connect. Pure. */
export function endpointOf(
  l: Pick<LockData, "socketPath" | "port" | "host">,
): { socket: string } | { hostnames: string[]; port: number } | null {
  if (l.socketPath) return { socket: l.socketPath };
  if (!(l.port > 0) || typeof l.host !== "string" || !l.host) return null;
  const h = l.host.replace(/^\[|\]$/g, "");
  const hostnames = h === "0.0.0.0"
    ? ["127.0.0.1"]
    : h === "::"
    ? ["::1", "127.0.0.1"]
    : [h];
  return { hostnames, port: l.port };
}

/** The OS steps of {@linkcode probeEndpoint}. `value`-style seam: replaced
 *  by its test, to answer as a machine without an IPv6 loopback does. */
export const _probeDeps = {
  connect: (o: { hostname: string; port: number }): Promise<Deno.Conn> =>
    Deno.connect(o),
};

/** An answer that says nothing about the listener: this machine cannot
 *  reach that address at all (no IPv6 loopback — EADDRNOTAVAIL, an
 *  unreachable network). Pure. */
function noRoute(e: unknown): boolean {
  return e instanceof Deno.errors.AddrNotAvailable ||
    (e instanceof Error &&
      /\(os error (99|101|10049|10051|49|51)\)/.test(e.message));
}

/** One connection attempt to the endpoint a lock record NAMES
 *  ({@linkcode endpointOf}) — never to an address guessed from its port.
 *  Null: the record names nothing to probe. Several addresses (a `::` bind):
 *  any accept is `up`; `gone` only when every address that could be reached
 *  refused, at least one did, and none was `busy`; an address this machine
 *  cannot reach at all counts for nothing — and when NO address gave a
 *  definite answer, the probe is `busy`, the safe side.
 *  @internal */
export async function probeEndpoint(
  l: Pick<LockData, "socketPath" | "port" | "host">,
): Promise<EndpointProbe | null> {
  const at = endpointOf(l);
  if (!at) return null;
  const one = async (
    open: () => Promise<{ close(): void }>,
  ): Promise<EndpointProbe & { noRoute?: true }> => {
    try {
      (await open()).close();
      return { state: "up" };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (noRoute(e)) return { state: "busy", why, noRoute: true };
      // ENOTSOCK: macOS's answer for a plain file at a socket path (Linux
      // says ECONNREFUSED) — not a socket, so nothing listens there.
      const nothingThere = e instanceof Deno.errors.NotFound ||
        e instanceof Deno.errors.ConnectionRefused ||
        (e as { code?: unknown }).code === "ENOTSOCK";
      return { state: nothingThere ? "gone" : "busy", why };
    }
  };
  if ("socket" in at) {
    const { state, why } = await one(() => connectLocal(at.socket));
    return why === undefined ? { state } : { state, why };
  }
  const all = [];
  for (const hostname of at.hostnames) {
    all.push(await one(() => _probeDeps.connect({ hostname, port: at.port })));
  }
  if (all.some((p) => p.state === "up")) return { state: "up" };
  const definite = all.filter((p) => !p.noRoute);
  const busy = definite.find((p) => p.state === "busy");
  if (busy) return { state: "busy", why: busy.why };
  if (definite.length > 0) return { state: "gone", why: definite[0]!.why };
  return { state: "busy", why: all[0]?.why };
}

/** How many connection attempts, and how far apart, before a LIVE process is
 *  called a zombie: six over 2.5 s. Taking the lock of a live process is the
 *  most dangerous thing the lock does — one refused connect is not evidence
 *  (a listener binds a moment after its record says `started`; a named pipe
 *  refuses between two accepts). */
export const ZOMBIE_PROBES = 6;
export const ZOMBIE_PROBE_GAP_MS = 500;

/** The steps of the zombie verdict a test replaces. @internal */
export const _zombieDeps = {
  probe: probeEndpoint,
  delay: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
  /** Ms since the lock file last changed. */
  recordAge: (key: string): number => lockAgeMs(key),
  /** End the process `l` names — ask, wait, then force — and say whether it
   *  is gone. False also when it is not this user's to signal. */
  async end(l: LockData): Promise<boolean> {
    try {
      await killProcess(l.pid, undefined, l);
    } catch {
      return false; // aio-ok: not ours to signal — the caller refuses, by name
    }
    return !isProcessAlive(l.pid);
  },
};

/** What the zombie verdict found: how many attempts, over how long, and the
 *  last answer. */
export type ZombieVerdict = { tries: number; ms: number; why: string };

/** THE verdict "this LIVE process is a zombie" — one rule for a launch that
 *  would take its lock and for `am start`, which would end it.
 *
 *  Taking over from a live process is the most dangerous thing the lock
 *  does, so it needs sustained evidence, never one probe. One refused
 *  connect called a healthy app a zombie — measured on Windows, 10 of 60
 *  double-click pairs: the holder's record said `started` 56 ms before its
 *  pipe was bound, and the losing launch took its lock and opened the same
 *  database. So:
 *   · a holder still inside its startup grace is not judged;
 *   · a record that CHANGED within the grace is not judged either — its
 *     owner wrote it a moment ago, which a wedged process does not do;
 *   · the endpoint must answer "nothing is here" to every one of
 *     ZOMBIE_PROBES attempts spread over seconds — an accept, or an endpoint
 *     that is there but busy, ends it: alive;
 *   · and the record must be the same bytes at the end as at the start
 *     (`"moved"`: judge what is there now).
 *  Null: alive, or nothing to ask. */
export async function zombieVerdict(
  key: string,
  existing: LockData,
  raw: string | null = readLockRaw(key),
): Promise<ZombieVerdict | "moved" | null> {
  const pastStartup = existing.status !== "starting" ||
    ageSince(existing.startedAt) > STARTUP_GRACE_MS;
  if (!pastStartup || !(_zombieDeps.recordAge(key) > STARTUP_GRACE_MS)) {
    return null;
  }
  const t0 = performance.now();
  for (let n = 1;; n++) {
    const p = await _zombieDeps.probe(existing);
    if (p === null || p.state !== "gone") return null;
    if (readLockRaw(key) !== raw) return "moved";
    if (n === ZOMBIE_PROBES) {
      return {
        tries: n,
        ms: Math.round(performance.now() - t0),
        why: p.why ?? "refused",
      };
    }
    await _zombieDeps.delay(ZOMBIE_PROBE_GAP_MS);
  }
}

/** What a refused `am` verb says when `acquire` answered `held`: the owner
 *  is gone, its file is not — never "running". Pure. */
export function heldLockLine(appId: string, existing: LockData, why: string) {
  return `"${printable(appId)}" is not running — its previous run (pid ` +
    `${existing.pid}) is gone, but its lock file cannot be removed ` +
    `(${printable(why)}): another program has it open. Try again in a moment.`;
}

/** The line for a zombie verdict on `l`: what was seen. */
export function zombieLine(l: LockData, v: ZombieVerdict): string {
  const at = endpointOf(l);
  const where = !at
    ? `port ${l.port}`
    : "socket" in at
    ? `socket ${printable(at.socket)}`
    : `${printable(at.hostnames.join(" and "))} port ${at.port}`;
  // Said as what it is: the file is not there. A cleaner of the runtime
  // directory removes it from under a LIVE app too, which then dies here —
  // its own tick has said so in its log since (`lockTick`).
  let noFile = "";
  if (at && "socket" in at && !isPipePath(at.socket)) {
    try {
      Deno.lstatSync(at.socket);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        noFile = " (the socket file is gone — its listener ended, or the " +
          "file was removed from under it)";
      }
    }
  }
  return `pid ${l.pid} is alive but nothing listens on ${where}${noFile} — ` +
    `${v.tries} connection attempts over ${v.ms} ms were all refused (${
      printable(v.why)
    }), and its lock record has not changed for more than ` +
    `${STARTUP_GRACE_MS / 1000} s`;
}

/** Ask the instance `l` names to stop, through the request `am stop` sends:
 *  `POST /__aio/trojan/shutdown` with the instance's per-boot control
 *  credential (`<data>/control.key`, which production answers too), at the
 *  endpoint its record names — the socket (a pipe on Windows), else the
 *  control port. The app's shared key only when the app asks for it (401/403),
 *  as `am` does. True when it accepted. @internal */
export async function askToStop(
  l: LockData,
  timeout = ASK_TIMEOUT_MS,
): Promise<boolean> {
  const control = readControlKey(l.appId, l.home);
  if (control.error !== undefined) return false;
  const headers: Record<string, string> = {
    "X-AIO": "1",
    "X-Aio-Control": control.key,
    // So the old app's log says a takeover ended it, not `am stop`.
    "X-Aio-Stop-By": "takeover",
  };
  const path = "/__aio/trojan/shutdown";
  const send = async (h: Record<string, string>): Promise<number | null> => {
    if (l.socketPath) {
      const r = await udsRequest(l.socketPath, path, {
        method: "POST",
        headers: h,
      }, timeout);
      return "error" in r ? null : r.status;
    }
    const port = l.trojanPort ?? l.port;
    if (!(port > 0)) return null;
    const at = endpointOf({ ...l, port });
    const host = at && "hostnames" in at ? at.hostnames[0]! : "127.0.0.1";
    try {
      const r = await fetch(
        `http://${host.includes(":") ? `[${host}]` : host}:${port}${path}`,
        { method: "POST", headers: h, signal: AbortSignal.timeout(timeout) },
      );
      await r.body?.cancel();
      return r.status;
    } catch {
      return null; // aio-ok: no answer — the caller ends it as before
    }
  };
  let status = await send(headers);
  if (status === 401 || status === 403) {
    try {
      const key = Deno.readTextFileSync(appKeyPath(l.appId, l.home)).trim();
      if (key) {
        status = await send({ ...headers, Authorization: `Bearer ${key}` });
      }
    } catch { /* aio-ok: no shared key — the refusal stands */ }
  }
  return status !== null && status >= 200 && status < 300;
}

/** How long {@linkcode askToStop} waits for the instance to answer. */
const ASK_TIMEOUT_MS = 3_000;

/** The steps of {@linkcode stopInstance} a test replaces. @internal */
export const _stopDeps = { ask: askToStop };

/** THE way a launch ends a HEALTHY instance (`--takeover`): ask it to stop,
 *  give it the whole teardown budget (`EXIT_WAIT_MS`) to end itself, and only
 *  then force it ({@linkcode killProcess}). Asking first is what makes the
 *  stop graceful on Windows, where the signal `killProcess` sends is
 *  TerminateProcess — no `onStop`, no final save. An instance that does not
 *  answer (a zombie, a build before the stop request existed) gets
 *  `killProcess` as before. */
export async function stopInstance(
  l: LockData,
  grace = EXIT_WAIT_MS,
): Promise<void> {
  // Not ours to end — asking included (see `killProcess`).
  const foreign = foreignOwnerRefusal(l);
  if (foreign) throw new Error(foreign);
  if (await _stopDeps.ask(l)) {
    const until = Date.now() + grace;
    while (Date.now() < until && isLockOwnerAlive(l)) {
      await delay(KILL_POLL_MS);
    }
    if (!isLockOwnerAlive(l)) return;
    // Asked, and still there after the whole budget: force it, now.
    return await killProcess(l.pid, 0, l);
  }
  await killProcess(l.pid, grace, l);
}

/** THE process killer: SIGTERM, a grace period, then SIGKILL — and then any
 *  descendant the app left behind.
 *
 *  This used to exist TWICE, near-identically, and neither copy knew about
 *  child processes. That mattered most for the case it was written for: an aio
 *  app owns an Electron window, and a graceful stop closes it (`shutdown.ts`
 *  has an "electron" phase). But a HUNG app never reaches its shutdown, so the
 *  SIGKILL below orphaned the window — leaving a desktop app on screen with no
 *  server behind it, and a developer killing processes by hand before their
 *  next run would start.
 *
 *  The graceful path is unchanged and still preferred: when the app shuts down
 *  properly it reaps its own children, and the sweep below finds nothing. */
export async function killProcess(
  pid: number,
  grace = KILL_GRACE_MS,
  expect?: { startToken?: string; startEpoch?: number; ns?: number },
): Promise<void> {
  const foreign = expect && foreignOwnerRefusal({ pid, ns: expect.ns });
  if (foreign) throw new Error(foreign);
  if (!isProcessAlive(pid)) return;
  // `expect` is the lock that named this pid. If it recorded a start token and
  // the live process's does not match, the pid was RECYCLED: signalling it
  // would kill whatever the user happens to be running now. Refusing is the
  // only safe answer, and it is loud — a caller that wanted a process gone has
  // to know it is not gone.
  if (
    (expect?.startToken || expect?.startEpoch !== undefined) &&
    !isLockOwnerAlive({
      pid,
      startToken: expect.startToken,
      startEpoch: expect.startEpoch,
    })
  ) {
    throw new Error(
      `refusing to signal pid ${pid}: it is no longer the process that ` +
        `recorded this lock (the pid was reused — the lock outlived a reboot, ` +
        `which happens whenever XDG_RUNTIME_DIR is unset and the lock dir is ` +
        `under /tmp).\n` +
        `  fix: the lock is stale — remove it (am stop --stale) rather than ` +
        `killing pid ${pid}, which now belongs to something else.`,
    );
  }
  // Ask first, kill second.
  const kids = await descendantPids(pid);
  try {
    Deno.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + grace;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await delay(KILL_POLL_MS);
  }
  if (isProcessAlive(pid)) {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* ok */ }
    await delay(KILL_REAP_MS);
  }
  // Deepest first, so a parent cannot spawn a replacement on its way out.
  // Anything already gone (the graceful case) is a no-op.
  for (const kid of kids.reverse()) {
    if (!isProcessAlive(kid)) continue;
    try {
      Deno.kill(kid, "SIGKILL");
    } catch { /* already gone, or not ours to signal */ }
  }
}

/**
 * @module
 * Local peer identity — WHO is on the other end of a same-machine socket.
 *
 * A Unix socket inside a `0700` directory, or a Windows named pipe with an
 * owner-only security descriptor, already answers one question: *is this
 * ANOTHER USER?* The kernel refuses anyone but the owner. It cannot answer the
 * other one: *is this the process this app spawned?* A second application run
 * by the SAME user is the owner too, and walks in through the same door — and
 * the transport served it the app's state and dispatched its methods.
 *
 * The kernel knows the peer's pid and uid unforgeably, and can be asked:
 *   - Linux: `getsockopt(fd, SOL_SOCKET, SO_PEERCRED)`    → `struct ucred`
 *   - macOS: `getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID)`   → pid
 *            `getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED)`  → uid
 *   - Windows: `GetNamedPipeClientProcessId(handle)`      → pid (see win-pipe.ts)
 *
 * A same-uid process cannot forge its pid to equal the live window's. That is
 * the whole boundary this module provides, and it is the only one that holds
 * against the same-user case: a file-based secret (`control.key`), an env
 * value, or a PIN are all readable by the attacker, and an OS credential store
 * is not available to a framework process.
 *
 * FAIL CLOSED. When the platform cannot report the peer (no FFI permission, an
 * unknown OS) the refusal is a refusal, never a pass — `peerRefusal` never
 * returns null from an UNKNOWN identity when a pid is required. The one
 * exception is stated where it happens (`selfUid` unknown on a platform whose
 * uid is not knowable).
 */

/** The kernel's view of a same-machine peer. `null` members are "not knowable
 *  here", never "fine" — {@linkcode peerRefusal} decides what that means. */
export type PeerIdentity = {
  pid: number | null;
  uid: number | null;
  gid: number | null;
};

/** The identity a transport cannot read. Frozen so a caller cannot mutate the
 *  one shared "unknown" into something that looks verified. */
export const UNKNOWN_PEER: PeerIdentity = Object.freeze({
  pid: null,
  uid: null,
  gid: null,
});

/** What a door requires of a peer. */
export type LocalPeerPolicy = {
  /** The uid the app itself runs as, or null when it cannot be read. */
  selfUid: number | null;
  /** The ONLY pid allowed (the spawned window), or null while unarmed. */
  allowedPid: number | null;
  /** Whether a pid is required at all. True for the production lockdown. */
  requirePid: boolean;
  /** The window's process START stamp, taken when it was armed, or null/absent
   *  when this platform cannot say (then the pid alone decides, and the gate
   *  is disarmed the moment the window exits). A pid is a number the kernel
   *  hands out again; pid + start time is a process. */
  allowedStart?: string | null;
  /** Reads a live pid's start stamp — `processStartToken`
   *  (single-instance-lock.ts). Consulted only when `allowedStart` is set. */
  startOf?: (pid: number) => string | null;
};

/** The refusal for this peer, or null to allow — the ONE decider, pure.
 *
 *  Order matters and is deliberate: "another user" is a strictly better
 *  diagnosis than "not this window", and a missing identity outranks both
 *  because it means the check could not be performed at all. */
export function peerRefusal(
  peer: PeerIdentity | null,
  policy: LocalPeerPolicy,
): string | null {
  if (peer === null) return "its identity could not be read";
  if (
    policy.selfUid !== null && peer.uid !== null && peer.uid !== policy.selfUid
  ) {
    return `it belongs to another user (uid ${peer.uid}; this app runs as uid ` +
      `${policy.selfUid})`;
  }
  if (!policy.requirePid) return null;
  if (peer.pid === null) {
    // Not only "this platform cannot say": macOS answers LOCAL_PEERPID only
    // while the peer is still connected (ENOTCONN after — measured), so a
    // peer that connected and hung up at once reads exactly like this.
    return "no pid could be read for it (it had already disconnected, or " +
      "this platform reports none)";
  }
  if (policy.allowedPid === null) {
    return "this app's window has not registered its process yet";
  }
  if (peer.pid !== policy.allowedPid) {
    return `it is not this app's window (it is pid ${peer.pid}; the window is ` +
      `${policy.allowedPid})`;
  }
  if (
    policy.allowedStart != null &&
    policy.startOf?.(peer.pid) !== policy.allowedStart
  ) {
    return `it has the window's pid (${peer.pid}) but is not the process ` +
      `that was launched — the pid was reused after the window exited`;
  }
  return null;
}

// ── The gate: ONE decider instance for every local door of an app ────────────

/** One app's local-peer gate. The NDJSON socket, the HTTP socket and their
 *  Windows pipe twins all ask THIS object — a door that keeps its own copy of
 *  "who is the window" is a door that is armed late, or never. */
export type LocalPeerGate = {
  /** Trust this process (the window the app just spawned) and nothing else. */
  arm(pid: number): void;
  /** The window exited: trust no one. A no-op unless `pid` is the armed one,
   *  so a late exit of an OLD window cannot disarm its successor. */
  disarm(pid: number): void;
  /** Run `fn` each time the gate IS disarmed. Refusing new connections is
   *  half of "trust no one": a session accepted while the window lived stays
   *  open for whoever still holds its descriptor (a child the window forked),
   *  so each door closes its trusted connections here. */
  onDisarm(fn: () => void): void;
  /** The refusal for the process on the other end of `conn`, or null when it
   *  is this app's window. A refusal is LOGGED here, with its reason, at most
   *  once a minute per peer pid and door — `door` names the socket and `note`
   *  what the refused peer is still given there.
   *
   *  `asked` is the door saying whether the refused peer wanted anything: it
   *  settles `true` at its first byte — or, on a door where the server speaks
   *  first, once it has stayed connected for {@linkcode PROBE_GRACE_MS} —
   *  and `false` when it hung up before either. With it the line waits for
   *  that answer — a peer that asked for something is the warning it always
   *  was; one that connected and left is a liveness probe (a second launch
   *  of this very app does exactly that, and so does `am`), said at debug
   *  level and not as an intrusion — once a minute per door; more than
   *  {@linkcode PROBE_FLOOD} of them in a minute is one warning. The
   *  REFUSAL does not wait and does not depend on it: this returns at once,
   *  and the peer is given nothing either way. Without `asked` the line is
   *  written immediately, as before. */
  refusal(
    conn: { peerIdentity?(): PeerIdentity },
    door: string,
    note?: string,
    asked?: Promise<boolean>,
  ): string | null;
};

/** How long a refused peer may stay connected, silent, and still be taken for
 *  a liveness probe. A probe is `connect(); close()` — measured 0.2 ms; a
 *  peer still there after this is waiting to be told something, and is said
 *  as loudly as one that sent a request. A probe read late by a stalled
 *  server costs one warning, never a missed one. */
export const PROBE_GRACE_MS = 1_000;

/** How many silent connect-and-close probes one door may see in a minute
 *  before it says so at the default level. Measured: a second launch makes
 *  one, an `am` command at most two — twenty in a minute is neither. */
export const PROBE_FLOOD = 20;

/** How long one peer pid stays quiet, per door, after a refusal line. */
const REFUSAL_LOG_EVERY_MS = 60_000;
/** Peers remembered for that — a process that respawns to flood the log gets
 *  a line per pid until this many, then the memory is dropped and starts over. */
const REFUSAL_LOG_PIDS = 256;

/** Is `pid` a descendant of `ancestor`? Linux only (`/proc/<pid>/stat` field
 *  4), bounded; false when it cannot be read. Used ONLY to word a refusal —
 *  a descendant is refused like any other process (a browser the window
 *  opened is one too). */
function _descendsFrom(pid: number, ancestor: number): boolean {
  if (Deno.build.os !== "linux") return false;
  try {
    for (let p = pid, hops = 0; p > 1 && hops < 16; hops++) {
      const stat = Deno.readTextFileSync(`/proc/${p}/stat`);
      // `comm` (field 2) may hold spaces and parentheses: cut at the LAST `)`.
      p = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (p === ancestor) return true;
    }
  } catch { /* aio-ok: the process is gone or unreadable — no hint to add */ }
  return false;
}

/** Build an app's gate. `selfUid` and `startOf` are passed in (dir-permissions
 *  / single-instance-lock own them) so this module stays import-free. */
export function createLocalPeerGate(deps: {
  selfUid: number | null;
  startOf: (pid: number) => string | null;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  /** Where a peer that connected and left without a byte is noted. */
  debug?: (msg: string) => void;
  now?: () => number;
}): LocalPeerGate {
  let allowedPid: number | null = null;
  let allowedStart: string | null = null;
  /** Has the armed process itself ever been served? Until it has, a refused
   *  CHILD of it is most likely the window behind a wrapper (see below). */
  let served = false;
  const lastLogged = new Map<string, number>();
  /** Per door: the silent probes of the current minute. */
  const probes = new Map<string, { since: number; n: number }>();
  const disarmed: (() => void)[] = [];
  const now = deps.now ?? Date.now;
  return {
    arm(pid) {
      allowedPid = pid;
      allowedStart = deps.startOf(pid);
      served = false;
    },
    disarm(pid) {
      if (allowedPid !== pid) return;
      allowedPid = null;
      allowedStart = null;
      for (const fn of disarmed) fn();
    },
    onDisarm(fn) {
      disarmed.push(fn);
    },
    refusal(conn, door, note, asked) {
      const peer = conn.peerIdentity?.() ?? null;
      const why = peerRefusal(peer, {
        selfUid: deps.selfUid,
        allowedPid,
        allowedStart,
        startOf: deps.startOf,
        requirePid: true,
      });
      if (why === null) {
        served = true;
        return null;
      }
      const pid = peer?.pid ?? null;
      const say = () => {
        const t = now();
        // The reason is part of the key: it names the peer's pid, and a peer
        // refused first as "not registered yet" and then as "not the window"
        // has been refused for two different things.
        const key = `${door}|${why}`;
        const last = lastLogged.get(key);
        if (last === undefined || t - last >= REFUSAL_LOG_EVERY_MS) {
          if (lastLogged.size >= REFUSAL_LOG_PIDS) lastLogged.clear();
          lastLogged.set(key, t);
          const line = `local-peer lockdown: refused a process on ${door} — ` +
            `${why}.${note ? ` ${note}` : ""}`;
          // The app's OWN window, launched through something that did not
          // become it: the armed pid is the wrapper, the window is its child,
          // and nothing will ever render. An error, with the way out. (Once the
          // armed process has been served it IS the window, and a child of it
          // is just another process.)
          if (
            !served && pid !== null && allowedPid !== null &&
            pid !== allowedPid && _descendsFrom(pid, allowedPid)
          ) {
            deps.error(
              `${line} It is a CHILD of the process this app launched as its ` +
                `window (${allowedPid}), which has not connected itself: the ` +
                `window was started through a wrapper that did not \`exec\` ` +
                `Electron, so the window itself is refused and stays blank. ` +
                `Point $ELECTRON_PATH at the real Electron binary, or make the ` +
                `wrapper \`exec\` it.`,
            );
          } else deps.warn(line);
        }
      };
      if (!asked) say();
      else {
        asked.then((sent) => {
          if (sent) return say();
          // A probe. One is ordinary and worth a debug note; a stream of
          // them is not a second launch, and must leave a trace at the
          // default level — once a minute per door, whatever the volume.
          const t = now();
          let p = probes.get(door);
          if (!p || t - p.since >= REFUSAL_LOG_EVERY_MS) {
            probes.set(door, p = { since: t, n: 0 });
          }
          p.n++;
          if (p.n === 1) {
            deps.debug?.(
              `local-peer lockdown: a process connected to ${door} and hung ` +
                `up without sending anything — a liveness probe (a second ` +
                `launch of this app, \`am\`) does exactly this. It was not ` +
                `served: ${why}. (Noted once a minute.)`,
            );
          } else if (p.n === PROBE_FLOOD + 1) {
            deps.warn(
              `local-peer lockdown: more than ${PROBE_FLOOD} connections to ` +
                `${door} within a minute were closed by their peer before ` +
                `it sent anything. A second launch of this app or an \`am\` ` +
                `command does that once or twice; this many is something ` +
                `polling or scanning the socket. None was served.`,
            );
          }
        });
      }
      return why;
    },
  };
}

// ── The control plane an UNTRUSTED local peer is left with ───────────────────

/** May a process that is not this app's window make this `ctl` request?
 *
 *  An allow-list of TWO. `GET /__aio/health` is what `am health`, `am`'s
 *  identity check and the packaged-app door test ask a production app, and it
 *  is answered through {@linkcode foreignHealthView}. `POST
 *  /__aio/trojan/shutdown` is `am stop`: it only passes the door — the server
 *  answers it solely to a caller presenting this boot's owner-only control
 *  credential (`armLocalControl`), and 404s anyone else, exactly as over TCP.
 *  Without it the only stop left is a signal, which on Windows is
 *  `TerminateProcess` (no `onStop`, no final flush). A same-user process can
 *  read that file — and could kill this process anyway: a clean stop is less
 *  than it already had, and the state, the actions and the page stay the
 *  window's. Everything else — the
 *  app's own `routes`, `/__aio/vitals`, `/__aio/metrics`, the page — belongs
 *  to the window. Pure. */
export function foreignCtlAllowed(method: string, path: string): boolean {
  const p = path.split("?")[0];
  return (method === "GET" && p === "/__aio/health") ||
    (method === "POST" && p === "/__aio/trojan/shutdown");
}

/** `/__aio/health` as an untrusted local peer may read it: is it up, and is
 *  it the app the caller meant — `status` and `appId`, nothing else. The full
 *  document carries the pid, the cell names and their last error, memory and
 *  the persist verdict, which are the window's and the operator's. Pure; a
 *  body that is not the health document (an app route shadowing the path)
 *  yields `{}`. */
export function foreignHealthView(body: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return "{}"; // aio-ok: not JSON ⇒ not the health document ⇒ nothing passes
  }
  const d = (doc !== null && typeof doc === "object" ? doc : {}) as Record<
    string,
    unknown
  >;
  return JSON.stringify({
    ...(typeof d.status === "string" ? { status: d.status } : {}),
    ...(typeof d.appId === "string" ? { appId: d.appId } : {}),
  });
}

// ── FFI: peer credentials from a connected socket's fd (unix) ────────────────

/** The dlopen'd C symbols, as callables. Typed by hand because the linux and
 *  darwin symbol sets differ (only linux has `prctl`). */
type PeerLib = {
  getsockopt: (
    fd: number,
    level: number,
    optname: number,
    optval: Uint8Array,
    optlen: Uint8Array,
  ) => number;
  prctl?: (
    option: number,
    arg2: number,
    arg3: number,
    arg4: number,
    arg5: number,
  ) => number;
};

let _lib: PeerLib | null = null;
let _libTried = false;
/** Why the library could not be opened — said by {@linkcode requireLocalPeer}. */
let _libError: unknown = null;

/** The C library, or null when it cannot be opened (no `--allow-ffi`, an
 *  unknown platform). Null means "peer identity is not knowable here", which
 *  callers treat as a refusal when a pid is required. */
function libc(): PeerLib | null {
  if (_libTried) return _lib;
  _libTried = true;
  // macOS has no `libc.so`; the symbols live in libSystem.
  const name = Deno.build.os === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
  try {
    _lib = Deno.dlopen(name, {
      getsockopt: {
        parameters: ["i32", "i32", "i32", "buffer", "buffer"],
        result: "i32",
      },
      ...(Deno.build.os === "linux"
        ? {
          prctl: {
            parameters: ["i32", "usize", "usize", "usize", "usize"],
            result: "i32",
          },
        }
        : {}),
    }).symbols as unknown as PeerLib;
  } catch (e) {
    _lib = null; // no FFI ⇒ identity unknown ⇒ callers refuse
    _libError = e;
  }
  return _lib;
}

/** A gate that REQUIRES peer identity is about to be built: make sure this
 *  process can read one, or refuse to build it.
 *
 *  Without the library every connection is "identity unknown" and is refused —
 *  the app's own window included. That used to boot anyway: a server that
 *  logged "only this app's own window may connect" and then served no one, a
 *  blank window with nothing saying why. So it throws here, at construction,
 *  with the flag that fixes it. Windows reads the pid off the pipe handle
 *  (win-pipe.ts) and needs nothing from this module. */
export function requireLocalPeer(
  os: typeof Deno.build.os = Deno.build.os,
): void {
  if (os === "windows" || libc() !== null) return;
  throw new Error(
    "local-peer lockdown cannot start: a production Electron app serves its " +
      "local socket only to its own window, verified by the kernel's peer " +
      "credentials, and this process cannot read them — " +
      (_libError instanceof Deno.errors.NotCapable ||
          _libError instanceof Deno.errors.PermissionDenied
        ? "it was started without `--allow-ffi`"
        : `the C library could not be opened (${_libError})`) +
      ". Without the check the socket would serve every process of this " +
      "user, so the app does not start. Fix: add `--allow-ffi` to the " +
      "`deno run` flags (a compiled build already has it) — or, for an app " +
      "that WANTS other local processes to connect, set " +
      "`electron: { allowLocalPeers: true }`.",
  );
}

/** `SOL_SOCKET` / `SO_PEERCRED`, spelled once. Linux only. */
const SOL_SOCKET = 1;
const SO_PEERCRED = 17;
/** `SOL_LOCAL`, and the two macOS options. */
const SOL_LOCAL = 0;
const LOCAL_PEERCRED = 0x0001;
const LOCAL_PEERPID = 0x0002;

/** Read the peer's pid/uid/gid from a connected unix socket's OS fd.
 *
 *  Returns {@linkcode UNKNOWN_PEER} on any failure — a call that errors, a
 *  platform this build does not know, or no FFI. A caller that requires a pid
 *  therefore refuses, which is the safe direction. */
export function unixPeerIdentity(
  fd: number,
  os: typeof Deno.build.os = Deno.build.os,
): PeerIdentity {
  const lib = libc();
  if (lib === null || !Number.isInteger(fd) || fd < 0) return UNKNOWN_PEER;
  try {
    if (os === "darwin") {
      return {
        pid: _darwinPid(lib, fd),
        uid: _darwinUid(lib, fd),
        gid: null,
      };
    }
    // Linux: `struct ucred { pid_t pid; uid_t uid; gid_t gid }` — 12 bytes.
    const buf = new Uint8Array(12);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, buf.length, true);
    if (lib.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, buf, len) !== 0) {
      return UNKNOWN_PEER;
    }
    const v = new DataView(buf.buffer);
    return {
      pid: v.getInt32(0, true),
      uid: v.getUint32(4, true),
      gid: v.getUint32(8, true),
    };
  } catch {
    // aio-ok: a failed probe is an unknown peer, and callers refuse those
    return UNKNOWN_PEER;
  }
}

/** macOS `LOCAL_PEERPID` → `pid_t` (4 bytes), or null. */
function _darwinPid(lib: PeerLib, fd: number): number | null {
  const buf = new Uint8Array(4);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, buf.length, true);
  if (lib.getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, buf, len) !== 0) return null;
  return new DataView(buf.buffer).getInt32(0, true);
}

/** macOS `LOCAL_PEERCRED` → `struct xucred`. `cr_uid` sits at byte 4 — the
 *  `u_short cr_version` is padded to a 4-byte `uid_t` after it. */
function _darwinUid(lib: PeerLib, fd: number): number | null {
  const buf = new Uint8Array(76); // version(2)+pad(2) + uid(4) + ngroups(2)+pad(2) + groups(16*4)
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, buf.length, true);
  if (lib.getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, buf, len) !== 0) {
    return null;
  }
  return new DataView(buf.buffer).getUint32(4, true);
}

// ── Hardening: stop a same-user process from reading this one's memory ───────

/** `PR_SET_DUMPABLE = 4`; `0` makes `/proc/<pid>/mem` and `ptrace` from another
 *  process fail for a non-root caller. */
const PR_SET_DUMPABLE = 4;

/** Make THIS process non-dumpable where the OS allows it — the memory half of
 *  "no other app may read the conversation". Pairs with the pid gate: the pid
 *  gate denies the socket, this denies the process memory behind it.
 *
 *  Linux only, and only when FFI is permitted; returns whether it took. macOS
 *  gets the equivalent from the Hardened Runtime + code signing (no
 *  `get-task-allow`), and Windows from a restricted process DACL or a higher
 *  integrity level — neither of which a plain Deno process can set for itself
 *  here, so those are the app's own hardening, not this call's. */
export function hardenLocalPeer(
  os: typeof Deno.build.os = Deno.build.os,
): boolean {
  if (os !== "linux") return false;
  const lib = libc();
  if (lib?.prctl === undefined) return false;
  try {
    return lib.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) === 0;
  } catch {
    return false; // aio-ok: hardening is best-effort; the pid gate is the door
  }
}

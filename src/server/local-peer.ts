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
    return "this platform reported no pid for it";
  }
  if (policy.allowedPid === null) {
    return "this app's window has not registered its process yet";
  }
  if (peer.pid !== policy.allowedPid) {
    return `it is not this app's window (it is pid ${peer.pid}; the window is ` +
      `${policy.allowedPid})`;
  }
  return null;
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
  } catch {
    _lib = null; // aio-ok: no FFI ⇒ identity unknown ⇒ callers refuse
  }
  return _lib;
}

/** Open the peer-credential library NOW, before the first connection. Wired at
 *  gate construction (`createUDSListener` with `peer.required`) so a platform
 *  that cannot read peer credentials fails EARLY and in one place, and so the
 *  library is not opened lazily inside a request. Idempotent. */
export function primeLocalPeer(): void {
  libc();
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

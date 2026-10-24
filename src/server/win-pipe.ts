/**
 * @module
 * Windows named pipes, hosted by Deno — the `win-pipe` backend of
 * `local-listen.ts`.
 *
 * Deno has no Unix-socket listener on Windows, so the local transport there is
 * a named pipe (`\\.\pipe\aio-<lockKey>`) driven through Win32 directly:
 * `CreateNamedPipeW` + overlapped `ReadFile`/`WriteFile`. Same NDJSON
 * protocol, same control plane, same HTTP-over-socket path as unix — only
 * where the bytes come from differs. Electron (libuv) and `am` connect to the
 * pipe natively; there is no filesystem entry and no port.
 *
 * Shape of the I/O: every operation is started synchronously (it returns at
 * once with `ERROR_IO_PENDING`), every completion arrives through ONE I/O
 * completion port, and the RESULT is read back with a synchronous
 * `GetOverlappedResult(bWait=FALSE)` on the main thread, so `GetLastError()`
 * (thread-local) is read on the thread that owns the error. The event loop
 * never stalls. Back-pressure: one outstanding read per connection (the
 * `ReadableStream` pulls one chunk at a time), writes serialized by the
 * `WritableStream`.
 *
 * ONE PARKED THREAD, whatever the connection count. This used to be one
 * `nonblocking: true` `WaitForSingleObject` per PENDING OPERATION, and every
 * open connection always has a pending read — so N connections parked N
 * threads of Deno's blocking pool, which is capped (4×cores on Windows). Past
 * the cap every further nonblocking FFI call AND every async fs op queued
 * behind waits that could only be released by work that was itself queued:
 * the whole app froze, permanently, and a compiled app on Windows 11 did
 * exactly that on a page with 58 unread `<img>` responses (field report §13 —
 * status-bar clock stopped, both processes at 0% CPU, server threads 42, a
 * fresh pipe connection accepted by the kernel and never answered). The port
 * replaces that with a completion QUEUE: one parked
 * `GetQueuedCompletionStatusEx`, resolving operations by their OVERLAPPED
 * address, running only while something is pending.
 *
 * The other unbounded wait was `drain()` — `FlushFileBuffers` returns when the
 * PEER has read what we wrote, i.e. never, for a response nobody reads. It is
 * bounded now (`PIPE_DRAIN_TIMEOUT_MS`), and a peer that stops reading costs a
 * closed connection instead of a thread for the life of the process.
 *
 * Fail loud: every Win32 failure throws an Error naming the call, the
 * GetLastError code and the path. A peer that went away is the ONE thing that
 * is not an error — it is end-of-stream, exactly as on unix.
 *
 * The DLLs are opened lazily, on the first listen/connect, so this module can
 * be imported (and its pure helpers unit-tested) on any OS. `local-listen.ts`
 * still only imports it on windows.
 */

import type { LocalConn, LocalListener } from "./local-listen.ts";
import type { PeerIdentity } from "./local-peer.ts";
import { log } from "../diagnostics/logger-api.ts";
import { type HandleSlot, HandleTable } from "./handle-table.ts";

// ── Win32 constants ───────────────────────────────────────────────────────

export const ERROR_FILE_NOT_FOUND = 2;
export const ERROR_ACCESS_DENIED = 5;
export const ERROR_INVALID_HANDLE = 6;
export const ERROR_HANDLE_EOF = 38;
export const ERROR_BROKEN_PIPE = 109;
export const ERROR_PIPE_BUSY = 231;
export const ERROR_NO_DATA = 232;
export const ERROR_PIPE_NOT_CONNECTED = 233;
export const ERROR_MORE_DATA = 234;
export const ERROR_PIPE_CONNECTED = 535;
export const ERROR_OPERATION_ABORTED = 995;
export const ERROR_IO_PENDING = 997;

export const PIPE_ACCESS_DUPLEX = 0x00000003;
export const FILE_FLAG_OVERLAPPED = 0x40000000;
export const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
export const PIPE_TYPE_BYTE = 0x00000000;
export const PIPE_READMODE_BYTE = 0x00000000;
export const PIPE_WAIT = 0x00000000;
export const PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
export const PIPE_UNLIMITED_INSTANCES = 255;
export const PIPE_BUFFER_BYTES = 64 * 1024;

export const GENERIC_READ = 0x80000000;
export const GENERIC_WRITE = 0x40000000;
export const OPEN_EXISTING = 3;
export const INFINITE = 0xFFFFFFFF;
export const SDDL_REVISION_1 = 1;

/** How long a server connection waits for the peer to READ what was written
 *  to it before it is torn down anyway.
 *
 *  `drain` exists because a server pipe closed with unread bytes can lose
 *  them, and `FlushFileBuffers` is the documented way to wait; the wait ends
 *  when the CLIENT reads, which for a body nobody reads is never. A real
 *  client empties a 64 KB pipe buffer in microseconds — it reads into its own
 *  buffers whether or not anything consumes them — so seconds here are
 *  generous for every live peer and a bound for every dead one. */
export const PIPE_DRAIN_TIMEOUT_MS = 3000;
/** After the peer has taken our bytes: how long its own unfinished upload is
 *  waited for before the close. The unix side's `LINGER_MS`, restated here
 *  because `local-listen.ts` imports this module, not the other way round. */
export const PIPE_LINGER_MS = 2000;

/** How many instances of a hosted pipe wait for a client at once. Each
 *  connection takes one, and the next is created only when JS hears of it —
 *  with a single one, every client of a burst but the first met
 *  ERROR_PIPE_BUSY in that gap. */
export const PIPE_SPARE_INSTANCES = 4;
/** How long a client keeps asking a pipe whose every instance is taken
 *  (ERROR_PIPE_BUSY) before it says so. A bound in TIME: it was a count of
 *  tries, five, and 14 simultaneous `connectLocal` calls ran out of them on
 *  Windows 11 against a server that was merely busy accepting the others. */
export const PIPE_BUSY_WAIT_MS = 2000;
/** How many instances of one hosted pipe exist that its consumer was not
 *  handed yet — waiting for a client, or connected and waiting to be
 *  accepted. A unix socket's backlog, for a pipe: past it a client meets
 *  ERROR_PIPE_BUSY (and waits, {@linkcode PIPE_BUSY_WAIT_MS}) instead of the
 *  host making one more kernel object for every connect a consumer that is
 *  busy — or stuck — has not taken. */
export const PIPE_BACKLOG = 128;

/** The way out of a pipe name somebody else holds — the same words wherever
 *  the name is refused. The namespace is one per MACHINE: not per user, not
 *  per session, and an unscoped name carries neither. */
const PIPE_TAKEN = "the pipe name is taken: another instance of this app, " +
  "another Windows user running it (a pipe name is machine-wide), or " +
  "another process on this machine holds it — and an app whose id is this " +
  "one's with `-http` added or removed asks for the same name. Stop the " +
  "other one, give this app a distinct appId, or run with `--transport=ws` " +
  "for a loopback port instead of a pipe";

/** How many completion packets one `GetQueuedCompletionStatusEx` may take. */
export const IOCP_BATCH = 64;

/** `OVERLAPPED_ENTRY`, x64: 32 bytes.
 *  | 0 lpCompletionKey | 8 lpOverlapped | 16 Internal | 24 bytes transferred | */
export const OVERLAPPED_ENTRY_SIZE = 32;

/** `(HANDLE)-1`. */
export const INVALID_HANDLE_VALUE = 0xFFFFFFFFFFFFFFFFn;

/** The DACL of every pipe aio creates: full access for the object's OWNER
 *  (the creating user — `OW` is the OWNER RIGHTS SID) and LocalSystem, and
 *  nothing else. `P` = protected, so no inherited ACE widens it. The Win32
 *  DEFAULT pipe descriptor grants read access to Everyone, which would let any
 *  local account open the pipe and receive the state broadcast — the exact
 *  door a `0700` socket directory closes on unix. */
export const PIPE_SDDL = "D:P(A;;GA;;;OW)(A;;GA;;;SY)";

/** Human names for the codes a reader of a boot log will meet. */
const ERROR_NAMES: Record<number, string> = {
  [ERROR_FILE_NOT_FOUND]: "ERROR_FILE_NOT_FOUND",
  [ERROR_ACCESS_DENIED]: "ERROR_ACCESS_DENIED",
  [ERROR_INVALID_HANDLE]: "ERROR_INVALID_HANDLE",
  [ERROR_HANDLE_EOF]: "ERROR_HANDLE_EOF",
  [ERROR_BROKEN_PIPE]: "ERROR_BROKEN_PIPE",
  [ERROR_PIPE_BUSY]: "ERROR_PIPE_BUSY",
  [ERROR_NO_DATA]: "ERROR_NO_DATA",
  [ERROR_PIPE_NOT_CONNECTED]: "ERROR_PIPE_NOT_CONNECTED",
  [ERROR_MORE_DATA]: "ERROR_MORE_DATA",
  [ERROR_PIPE_CONNECTED]: "ERROR_PIPE_CONNECTED",
  [ERROR_OPERATION_ABORTED]: "ERROR_OPERATION_ABORTED",
  [ERROR_IO_PENDING]: "ERROR_IO_PENDING",
};

// ── Pure helpers (unit-tested on every OS) ────────────────────────────────

/** One Win32 failure, named: the call, the code (with its symbolic name when
 *  known) and the pipe path. */
export function winError(call: string, code: number, path: string): Error {
  const name = ERROR_NAMES[code] ? ` ${ERROR_NAMES[code]}` : "";
  const e = new Error(
    `${call} failed on ${path} — Win32 error ${code}${name}`,
  );
  (e as Error & { code: number }).code = code;
  return e;
}

/** The codes that mean "the peer is gone" on a read or write — end-of-stream,
 *  not a failure. Everything else on an I/O path IS a failure and throws. */
export function isPeerGoneError(code: number): boolean {
  return code === ERROR_BROKEN_PIPE || code === ERROR_PIPE_NOT_CONNECTED ||
    code === ERROR_NO_DATA || code === ERROR_HANDLE_EOF ||
    code === ERROR_OPERATION_ABORTED || code === ERROR_INVALID_HANDLE;
}

/** A NUL-terminated UTF-16LE string, as Win32's `W` calls take it. */
export function wstr(s: string): Uint8Array {
  const out = new Uint8Array((s.length + 1) * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) {
    view.setUint16(i * 2, s.charCodeAt(i), true);
  }
  return out;
}

/** The `lpOverlapped` of entry `i` in a completion batch — the address that
 *  says WHICH operation finished, and the only thing the port loop needs to
 *  resolve one. Pure. */
export function entryOverlapped(entries: Uint8Array, i: number): bigint {
  return new DataView(entries.buffer, entries.byteOffset)
    .getBigUint64(i * OVERLAPPED_ENTRY_SIZE + 8, true);
}

/** An `OVERLAPPED` struct, x64 layout (32 bytes):
 *
 *  | offset | field                              |
 *  | ------ | ---------------------------------- |
 *  |  0     | Internal      (ULONG_PTR, 8)       |
 *  |  8     | InternalHigh  (ULONG_PTR, 8)       |
 *  | 16     | Offset / OffsetHigh (DWORD + DWORD, the Pointer union) |
 *  | 24     | hEvent        (HANDLE, 8)          |
 *
 *  Everything but `hEvent` is zero: a pipe has no file position, and the
 *  system owns `Internal`/`InternalHigh`. Fresh per operation — the kernel
 *  writes into it while the operation is pending, so one struct must never be
 *  shared by two in-flight operations.
 *
 *  `hEvent` is NULL for every operation this module starts: the handle is
 *  bound to the completion port, which is where the completion is delivered.
 *  It must also stay EVEN — a set low bit tells the kernel to skip the port,
 *  and the operation would then complete into nothing. */
export function overlappedBytes(hEvent: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  new DataView(buf.buffer).setBigUint64(24, hEvent, true);
  return buf;
}

/** The code a `ConnectNamedPipe` that returned FALSE would have given, from
 *  two facts about the instance that need no `GetLastError`.
 *
 *  `GetLastError()` is a second FFI call, and the thread's last error does
 *  not always survive until it: a real Windows 11 run answered FALSE with
 *  code 0 once (2026-10-13, under a full suite; 0 of 300,000 when idle). Code
 *  0 is none of the three answers the call has, so the listener was closed
 *  for good — the app deaf on its pipe — over an instance that was fine.
 *
 *  Measured on that Windows, for an overlapped instance:
 *
 *  | the instance              | `PeekNamedPipe` | `GetNamedPipeClientProcessId` | code |
 *  | ------------------------- | --------------- | ----------------------------- | ---- |
 *  | waits for a client        | fails           | fails                         | 997  |
 *  | a client is connected     | succeeds        | succeeds                      | 535  |
 *  | a client came and left    | fails           | succeeds                      | 232  |
 */
export function connectCodeFromFacts(
  readable: boolean,
  hadClient: boolean,
): number {
  if (readable) return ERROR_PIPE_CONNECTED;
  return hadClient ? ERROR_NO_DATA : ERROR_IO_PENDING;
}

/** The NTSTATUS a finished operation left in its `OVERLAPPED`'s `Internal`
 *  (documented: "the status code for the completed request") — written by
 *  the kernel, so unlike `GetLastError()` it cannot be lost between two FFI
 *  calls. */
export function overlappedStatus(buf: Uint8Array): number {
  return new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
}

/** `hEvent` back out of an `OVERLAPPED` (the inverse of the encoder). */
// aio-ok(dead-wiring): the encoder's inverse, for the ABI round-trip test
export function overlappedEvent(buf: Uint8Array): bigint {
  return new DataView(buf.buffer, buf.byteOffset).getBigUint64(24, true);
}

/** A `SECURITY_ATTRIBUTES` struct, x64 layout (24 bytes): `nLength` (DWORD,
 *  padded to 8), `lpSecurityDescriptor` (pointer), `bInheritHandle` (BOOL,
 *  padded to 8). */
export function securityAttributesBytes(descriptor: bigint): Uint8Array {
  const buf = new Uint8Array(24);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 24, true);
  v.setBigUint64(8, descriptor, true);
  v.setInt32(16, 0, true);
  return buf;
}

/** A bitmask as Win32 takes it: JS `|` yields a SIGNED int32, and
 *  `GENERIC_READ | GENERIC_WRITE` is -1073741824 — Deno FFI refuses that for a
 *  `u32` before the call is even made. Every mask crosses here. */
export function u32(mask: number): number {
  return mask >>> 0;
}

export function readU32(buf: Uint8Array): number {
  return new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
}

export function readU64(buf: Uint8Array): bigint {
  return new DataView(buf.buffer, buf.byteOffset).getBigUint64(0, true);
}

// ── FFI ───────────────────────────────────────────────────────────────────

type Handle = Deno.PointerValue;

const K32_SYMBOLS = {
  CreateNamedPipeW: {
    parameters: ["buffer", "u32", "u32", "u32", "u32", "u32", "u32", "pointer"],
    result: "pointer",
  },
  ConnectNamedPipe: { parameters: ["pointer", "buffer"], result: "i32" },
  WriteFile: {
    parameters: ["pointer", "buffer", "u32", "buffer", "buffer"],
    result: "i32",
  },
  GetOverlappedResult: {
    parameters: ["pointer", "buffer", "buffer", "i32"],
    result: "i32",
  },
  // The completion port: created once, every pipe handle bound to it, and
  // ONE parked wait for the whole process (`IoPort`).
  CreateIoCompletionPort: {
    parameters: ["pointer", "pointer", "usize", "u32"],
    result: "pointer",
  },
  // THE blocking wait — on a pool thread, never the event loop, and exactly
  // one of them no matter how many operations are in flight.
  GetQueuedCompletionStatusEx: {
    parameters: ["pointer", "buffer", "u32", "buffer", "u32", "i32"],
    result: "i32",
    nonblocking: true,
  },
  CloseHandle: { parameters: ["pointer"], result: "i32" },
  CancelIoEx: { parameters: ["pointer", "pointer"], result: "i32" },
  // Blocks until every byte written has been READ by the client (or the peer
  // disconnects) — so for a response nobody reads it blocks forever, which is
  // why `PipeConn#drain` races it against PIPE_DRAIN_TIMEOUT_MS and closes. It has
  // no overlapped form, so this one call still costs a pool thread; the
  // timeout is what bounds how long.
  FlushFileBuffers: {
    parameters: ["pointer"],
    result: "i32",
    nonblocking: true,
  },
  CreateFileW: {
    parameters: ["buffer", "u32", "u32", "pointer", "u32", "u32", "pointer"],
    result: "pointer",
  },
  // The peer's pid, for the local-peer gate. Windows has no uid to compare —
  // the pipe DACL already keeps other users out — so pid is the whole check.
  GetNamedPipeClientProcessId: {
    parameters: ["pointer", "buffer"],
    result: "i32",
  },
  // Asked only for its yes/no — see `connectCodeFromFacts`.
  PeekNamedPipe: {
    parameters: ["pointer", "pointer", "u32", "pointer", "buffer", "pointer"],
    result: "i32",
  },
  GetLastError: { parameters: [], result: "u32" },
  LocalFree: { parameters: ["pointer"], result: "pointer" },
} as const;

const ADVAPI_SYMBOLS = {
  ConvertStringSecurityDescriptorToSecurityDescriptorW: {
    parameters: ["buffer", "u32", "buffer", "buffer"],
    result: "i32",
  },
  // Read back what a secret file was actually given (`writeOwnerOnlyFile`).
  GetNamedSecurityInfoW: {
    parameters: [
      "buffer",
      "u32",
      "u32",
      "buffer",
      "buffer",
      "buffer",
      "buffer",
      "buffer",
    ],
    result: "u32",
  },
  ConvertSecurityDescriptorToStringSecurityDescriptorW: {
    parameters: ["pointer", "u32", "u32", "buffer", "buffer"],
    result: "i32",
  },
} as const;

const NTDLL_SYMBOLS = {
  // A finished operation's NTSTATUS (`overlappedStatus`) as the Win32 code
  // `GetOverlappedResult` would have set — returned, not thread-local.
  RtlNtStatusToDosError: { parameters: ["u32"], result: "u32" },
  // Every overlapped read/write is STARTED here, not through kernel32: the
  // NTSTATUS comes back as the result (see `startIo`). FileHandle, Event,
  // ApcRoutine, ApcContext, IoStatusBlock, Buffer, Length, ByteOffset, Key.
  NtReadFile: {
    parameters: [
      "pointer",
      "pointer",
      "pointer",
      "pointer",
      "buffer",
      "buffer",
      "u32",
      "pointer",
      "pointer",
    ],
    result: "u32",
  },
  NtWriteFile: {
    parameters: [
      "pointer",
      "pointer",
      "pointer",
      "pointer",
      "buffer",
      "buffer",
      "u32",
      "pointer",
      "pointer",
    ],
    result: "u32",
  },
} as const;

let _nt: Deno.DynamicLibrary<typeof NTDLL_SYMBOLS>["symbols"] | null = null;

function ntdll(): Deno.DynamicLibrary<typeof NTDLL_SYMBOLS>["symbols"] {
  _nt ??= Deno.dlopen("ntdll.dll", NTDLL_SYMBOLS).symbols;
  return _nt;
}

let _k32: Deno.DynamicLibrary<typeof K32_SYMBOLS>["symbols"] | null = null;
let _adv:
  | Deno.DynamicLibrary<typeof ADVAPI_SYMBOLS>["symbols"]
  | null = null;

function k32(): Deno.DynamicLibrary<typeof K32_SYMBOLS>["symbols"] {
  if (!_k32) {
    if (Deno.build.os !== "windows") {
      throw new Error(
        `win-pipe: named pipes are a Windows transport, and this is ${Deno.build.os}`,
      );
    }
    _k32 = Deno.dlopen("kernel32.dll", K32_SYMBOLS).symbols;
  }
  return _k32;
}

function advapi(): Deno.DynamicLibrary<typeof ADVAPI_SYMBOLS>["symbols"] {
  _adv ??= Deno.dlopen("advapi32.dll", ADVAPI_SYMBOLS).symbols;
  return _adv;
}

// The libraries are opened when this module LOADS, not at the first call.
// They are held for the life of the process either way; opened lazily, the
// first caller is charged with them — and under `deno test` that caller is
// whichever test first asked who owns a lock or how a directory is protected.
// Measured on a real Windows 11: `--sanitize-resources` failed 167 test files
// with "A dynamic library was loaded during the test, but not unloaded", none
// of which had opened anything. Only where FFI is already granted: asking
// here would put a permission prompt in front of an app that never uses a
// pipe. A refusal stays the lazy path's to report, at the call that needs it.
if (
  Deno.build.os === "windows" &&
  Deno.permissions.querySync({ name: "ffi" }).state === "granted"
) {
  try {
    k32();
    advapi();
    ntdll();
  } catch { /* aio-ok: the first real call opens it again and throws there */ }
}

function handleValue(h: Handle): bigint {
  return h === null ? 0n : BigInt(Deno.UnsafePointer.value(h));
}

function isInvalidHandle(h: Handle): boolean {
  return h === null || handleValue(h) === INVALID_HANDLE_VALUE;
}

function closeHandle(h: Handle): void {
  if (h !== null) k32().CloseHandle(h);
}

/** Who owns which handle VALUE right now — see `handle-table.ts`.
 *
 *  Windows recycles a handle value the instant it is closed, so every path
 *  that captured a value and acts on it LATER is acting on a number that may
 *  already belong to something else in this process. There are three such
 *  paths here, and all three are reachable:
 *
 *   • `PipeConn#drain`'s timeout — a JS timer that fires up to
 *     PIPE_DRAIN_TIMEOUT_MS after it was armed, and closes;
 *   • `#read`'s `GetOverlappedResult`, which runs after awaiting a completion
 *     packet — and `close()` may have run during that await, because the
 *     WritableStream's `abort`, the ReadableStream's `cancel` and the
 *     server's shutdown all call it;
 *   • `#write`'s, identically.
 *
 *  MEASURED, on real Windows 11 / Deno 2.9.6, because the first version of
 *  this comment claimed the two read paths could return a STRANGER's byte
 *  count and they cannot: with `bWait=FALSE`, `GetOverlappedResult` ignores
 *  its handle argument entirely — the count comes from the OVERLAPPED's own
 *  `InternalHigh`, and each `PipeConn` owns its `#rovl`/`#wovl`, kept alive
 *  by the frame awaiting it. A closed value, another live handle and
 *  `0xDEAD` all returned the owning operation's own 11111 bytes.
 *
 *  So what the slot gate actually buys, in order of how real it is: a
 *  deferred `CancelIoEx`/`CloseHandle` never acts on a value the table has
 *  since handed out; every one of the three paths ends as a clean
 *  end-of-stream instead of on a number; and the rule is already in place for
 *  any future deferred path that DOES read through its handle (`bWait=TRUE`,
 *  a raw `ReadFile`/`WriteFile`), where the hazard is real. A 400-connection
 *  storm with the FFI pool measured at exactly 32 — so ~368 flushes were
 *  genuinely queued as their timers fired — produced no corruption and no
 *  ownership warnings, with this table AND against pre-fix HEAD.
 *
 *  The residual that JS cannot reach is documented on `drain` itself. */
const handles = new HandleTable((msg) => log.warn("pipe", msg));

/** A handle plus the claim that says it is still ours. */
type Owned = { h: Handle; slot: HandleSlot };

/** Take ownership of a handle the kernel just returned. */
function own(h: Handle, label: string): Owned {
  return { h, slot: handles.claim(handleValue(h), label) };
}

/** Close it — at most once ever, and never a value the table has since
 *  given to someone else. `false` means this caller did not own it and
 *  therefore closed nothing, which is the only safe answer. */
function closeOwned(o: Owned): boolean {
  if (!handles.release(o.slot)) return false;
  closeHandle(o.h);
  return true;
}

/** THE completion port — one for the process, one parked wait for all of it.
 *
 *  Every pipe handle is bound to it at creation (`attach`), so every
 *  overlapped operation started on that handle completes as a packet on this
 *  queue. `completion(ovl)` resolves when the packet carrying that
 *  OVERLAPPED's address arrives. The loop runs only while something is
 *  pending: an idle process parks nothing and holds the event loop open with
 *  nothing, exactly as before.
 *
 *  Cost: ONE blocking-pool thread, for any number of connections. That is the
 *  whole point — see the module doc for what one-thread-per-operation did to
 *  a real app. */
class IoPort {
  #h: Handle = null;
  #waiting = new Map<
    bigint,
    { done: () => void; fail: (e: Error) => void }
  >();
  #entries = new Uint8Array(OVERLAPPED_ENTRY_SIZE * IOCP_BATCH);
  #removed = new Uint8Array(4);
  #pumping = false;
  #idleWaiters: (() => void)[] = [];

  /** Resolve once no operation is pending on the port and its one parked
   *  wait has returned. `close()` is synchronous but a cancelled operation
   *  still COMPLETES, as a packet, a moment later — this is where a caller
   *  that must not outlive its own I/O (a test under `--sanitize-ops`) waits
   *  for that. Never resolves while a connection is left open and reading. */
  async idle(): Promise<void> {
    while (this.#pumping) {
      await new Promise<void>((r) => this.#idleWaiters.push(r));
    }
  }

  #port(): Handle {
    if (this.#h === null) {
      const h = k32().CreateIoCompletionPort(
        Deno.UnsafePointer.create(INVALID_HANDLE_VALUE),
        null,
        0n,
        0,
      );
      if (isInvalidHandle(h)) {
        throw winError(
          "CreateIoCompletionPort",
          k32().GetLastError(),
          "the aio pipe completion port",
        );
      }
      this.#h = h;
    }
    return this.#h;
  }

  /** Bind one pipe handle to the port. Once, at creation — the association is
   *  permanent and a second one fails. */
  attach(h: Handle, path: string): void {
    if (isInvalidHandle(k32().CreateIoCompletionPort(h, this.#port(), 0n, 0))) {
      throw winError(
        "CreateIoCompletionPort (binding the pipe to it)",
        k32().GetLastError(),
        path,
      );
    }
  }

  /** Resolve when the operation using `ovl` completes. Registered BEFORE the
   *  loop can dequeue anything (JS is single-threaded and the caller starts
   *  the operation, then calls this, with no await between), so a packet can
   *  never arrive for an address nobody is waiting on. */
  completion(ovl: Uint8Array): Promise<void> {
    const key = pointerOf(ovl);
    if (this.#waiting.has(key)) {
      throw new Error(
        `win-pipe: two operations share one OVERLAPPED (${key}) — the kernel ` +
          `writes into it while an operation is pending, so this would ` +
          `corrupt both`,
      );
    }
    return new Promise<void>((done, fail) => {
      this.#waiting.set(key, { done, fail });
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    void (async () => {
      try {
        while (this.#waiting.size > 0) {
          const ok = await k32().GetQueuedCompletionStatusEx(
            this.#port(),
            this.#entries,
            IOCP_BATCH,
            this.#removed,
            INFINITE,
            0,
          );
          if (!ok) {
            // INFINITE rules out a timeout, so this is the port itself: a
            // handle that cannot be waited on. Every pending operation is
            // unresolvable — fail them all, loudly, rather than leave the
            // app parked on promises nothing will ever settle.
            throw new Error(
              "win-pipe: GetQueuedCompletionStatusEx failed on the aio pipe " +
                "completion port — every pending pipe operation is now failed",
            );
          }
          const n = readU32(this.#removed);
          for (let i = 0; i < n; i++) {
            const w = this.#waiting.get(entryOverlapped(this.#entries, i));
            // Nobody waits on it: a connect whose code was lost and which
            // was then found connected (`connectCodeFromFacts`). Otherwise
            // unreachable — see `completion`.
            if (w === undefined) continue;
            this.#waiting.delete(entryOverlapped(this.#entries, i));
            w.done();
          }
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        for (const w of [...this.#waiting.values()]) w.fail(err);
        this.#waiting.clear();
      } finally {
        // Synchronous with the loop's exit: a `completion()` registered after
        // this restarts the loop, one registered before kept it running.
        this.#pumping = false;
        for (const wake of this.#idleWaiters.splice(0)) wake();
      }
    })();
  }
}

const ioPort = new IoPort();

/** See {@linkcode IoPort.idle}: every pipe operation of this process has
 *  completed. */
// aio-ok: a test seam — the product closes and moves on; a test under the op sanitizer has to wait for the cancelled I/O (tests/local-endpoint-helper.ts)
export function pipeIoIdle(): Promise<void> {
  return ioPort.idle();
}

/** The address of a buffer, as the kernel will report it back. */
function pointerOf(buf: Uint8Array): bigint {
  const p = Deno.UnsafePointer.of(buf);
  if (p === null) throw new Error("win-pipe: an OVERLAPPED with no address");
  return BigInt(Deno.UnsafePointer.value(p));
}

/** Wait for one started overlapped operation to finish; return the byte count
 *  or the Win32 error code. Never throws for an operation OUTCOME — the caller
 *  decides what a code means on its path (a read's BROKEN_PIPE is EOF, a
 *  connect's is a failure). A failure of the completion PORT is not an
 *  outcome, and has no meaning any caller could act on, so it throws. */
async function finishOverlapped(
  o: Owned,
  ovl: Uint8Array,
): Promise<{ ok: true; bytes: number } | { ok: false; code: number }> {
  await ioPort.completion(ovl);
  // The await is the window: `close()` can have run while this frame was
  // parked (the abort, the cancel and the shutdown paths all call it). The
  // byte count itself is safe — `bWait=FALSE` reads the OVERLAPPED, not the
  // handle (measured; see the note on `handles` above) — but a connection
  // whose handle is gone has no stream left to feed, and continuing to slice
  // a buffer for it would hand the caller bytes from a torn-down connection.
  // The operation is over either way, so the honest outcome is the one
  // `close()` produces anyway.
  if (!handles.isLive(o.slot)) {
    return { ok: false, code: ERROR_OPERATION_ABORTED };
  }
  const bytes = new Uint8Array(4);
  // bWait=FALSE: the port already said it is done. A FALSE's code is the one
  // the operation itself left in the OVERLAPPED — the thread's last error, a
  // second FFI call later, read 0 once on a real Windows, and a read failing
  // with "error 0" closed a live connection.
  const ok = k32().GetOverlappedResult(o.h, ovl, bytes, 0);
  if (!ok) {
    return {
      ok: false,
      code: ntdll().RtlNtStatusToDosError(overlappedStatus(ovl)),
    };
  }
  return { ok: true, bytes: readU32(bytes) };
}

/** Whether a started read/write's NTSTATUS is a synchronous FAILURE: only an
 *  NT_ERROR (severity 3). A failure at start queues no completion packet and
 *  writes nothing into the OVERLAPPED; success, a warning (BUFFER_OVERFLOW)
 *  and STATUS_PENDING all complete through the port. */
export function ntStartFailed(status: number): boolean {
  return (status >>> 30) === 3;
}

/** Start one overlapped read or write on `ovl`; `null` = its packet will
 *  come, a number = the Win32 code it failed with at start (nothing to wait
 *  for).
 *
 *  Through ntdll, exactly as kernel32 starts it (the OVERLAPPED is the
 *  IO_STATUS_BLOCK and the ApcContext the port hands back, its `Offset` the
 *  ByteOffset), because the status is RETURNED. kernel32's FALSE needed
 *  `GetLastError()`, a second FFI call whose thread-local code was lost once
 *  on a real Windows (`connectCodeFromFacts`); a lost code with a live peer
 *  was read as pending — and a synchronous failure (ERROR_NOT_ENOUGH_QUOTA on
 *  a big write) queues no packet, so that write waited for ever, silently. */
function startIo(
  op: "NtReadFile" | "NtWriteFile",
  h: Handle,
  buf: Uint8Array,
  ovl: Uint8Array,
): number | null {
  const p = Deno.UnsafePointer.of(ovl);
  if (p === null) throw new Error("win-pipe: an OVERLAPPED with no address");
  const status = ntdll()[op](
    h,
    null,
    null,
    p,
    ovl,
    buf,
    buf.length,
    Deno.UnsafePointer.offset(p, 16),
    null,
  );
  return ntStartFailed(status) ? ntdll().RtlNtStatusToDosError(status) : null;
}

// ── Connection ────────────────────────────────────────────────────────────

class PipeConn implements LocalConn {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly remoteAddr: Deno.Addr;
  /** The client process's pid, read from the connected instance — present on
   *  server-side connections only. See local-peer.ts. */
  readonly peerIdentity?: () => PeerIdentity;
  /** The handle AND the claim on its value. Never the bare value: see
   *  {@linkcode handles}. */
  #o: Owned;
  #closed = false;
  /** One OVERLAPPED per DIRECTION — a read and a write may be in flight at
   *  once, never two of either (the streams serialize each side). The kernel
   *  writes into it while the operation is pending, and the port resolves by
   *  its address, so these two buffers are this connection's identity on the
   *  queue. No event handles: the completion goes to the port. */
  #rovl = overlappedBytes(0n);
  #wovl = overlappedBytes(0n);
  #buf = new Uint8Array(PIPE_BUFFER_BYTES);

  constructor(o: Owned, readonly path: string, readonly server: boolean) {
    this.#o = o;
    this.remoteAddr = { transport: "unix", path };
    if (server) {
      // Read ONCE, at accept: the instance's client cannot change, and a
      // failed query is `null`, which the gate refuses.
      const pidBuf = new Uint8Array(4);
      const pid = k32().GetNamedPipeClientProcessId(o.h, pidBuf)
        ? readU32(pidBuf)
        : null;
      this.peerIdentity = () => ({ pid, uid: null, gid: null });
    }
    this.readable = new ReadableStream<Uint8Array>({
      pull: async (ctrl) => {
        const chunk = await this.#read();
        if (chunk === null) ctrl.close();
        else ctrl.enqueue(chunk);
      },
      cancel: () => this.close(),
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => this.#write(chunk),
      close: () => this.close(),
      abort: () => this.close(),
    });
  }

  /** One read. `null` = the peer is gone. One outstanding at a time — the
   *  stream's `pull` guarantees it. */
  async #read(): Promise<Uint8Array | null> {
    if (this.#closed) return null;
    // The count is read back through GetOverlappedResult in every case, so
    // the synchronous-completion and the pending path are ONE path — and a
    // handle bound to a completion port queues a packet for BOTH, so both
    // are also one wait. A hard failure at START queues no packet.
    const code = startIo("NtReadFile", this.#o.h, this.#buf, this.#rovl);
    if (code !== null) return this.#readFailed(code);
    const r = await finishOverlapped(this.#o, this.#rovl);
    if (!r.ok) return this.#readFailed(r.code);
    if (r.bytes === 0) return null;
    return this.#buf.slice(0, r.bytes);
  }

  #readFailed(code: number): null {
    if (this.#closed || isPeerGoneError(code)) return null;
    throw winError("ReadFile", code, this.path);
  }

  /** Wait for the peer to have READ everything already written.
   *
   *  A server-side named pipe that is disconnected with unread bytes in its
   *  buffer DISCARDS them: `DisconnectNamedPipe` is documented to terminate
   *  the connection "after all data ... has been read by the client" only for
   *  a CLEAN shutdown, and in practice the close path raced ahead of the
   *  client's read. Measured on real Windows 11 (2026-09-17): Electron's very
   *  FIRST page request over the pipe answered `read EPIPE` after a 200 whose
   *  body was buffered and never delivered — the window then failed
   *  `did-fail-load`, while a Unix socket (which flushes on close) was fine.
   *  `FlushFileBuffers` on the server handle blocks exactly until the client
   *  has consumed the bytes, so it is the documented way to close cleanly; the
   *  FFI call is `nonblocking`, so the wait lives on a pool thread and the
   *  event loop keeps serving. A peer already gone is not an error here.
   *  Not sufficient alone: it can return while the client still has a
   *  buffer's worth to read, which is why `close` never disconnects.
   *
   *  BOUNDED, because "until the client has consumed the bytes" is forever
   *  for a client that never will. A page with 58 `<img>` tags answered 404
   *  took 58 pool threads this way and never gave one back — the app froze
   *  for good (field report §13). The timeout closes the connection instead,
   *  which is what a peer that stopped reading has earned, and closing the
   *  handle releases the flush. Said out loud: a dropped response body is a
   *  fact about the app, not a detail. Nothing on this recovery path needs
   *  the pool — a JS timer and a synchronous `CloseHandle` — so it still runs
   *  when the pool is the thing that is jammed.
   *
   *  THE HANDLE VALUE, AND WHAT IS AND IS NOT FIXED HERE. The timeout below
   *  fires up to PIPE_DRAIN_TIMEOUT_MS after it was armed, and on Windows a
   *  handle VALUE is recycled the instant it is closed. Two hazards follow,
   *  and only one of them is JS's to solve:
   *
   *   • The timeout closing a value this connection no longer owns —
   *     `close()` having already run from the abort, cancel or shutdown path
   *     while this frame was parked, and the number having gone to a handle
   *     someone else just opened. That is a cancel-and-close of an unrelated
   *     object, and it is what `closeOwned`/{@linkcode handles} prevent: the
   *     claim, not the number, decides whether there is anything to close.
   *
   *   • The FFI call above binds the raw value at call time and runs on a
   *     POOL thread. When the pool is saturated — exactly the condition this
   *     timeout exists for — the call is still QUEUED when the timer fires,
   *     so it can reach `FlushFileBuffers` after the value has been closed
   *     and reissued. JS cannot reach that argument, and the obvious remedy
   *     is worse than the defect: `DuplicateHandle` would give the flush its
   *     own reference, but a duplicate keeps the pipe INSTANCE alive, so the
   *     flush the timeout exists to bound would never return and the pool
   *     thread would be parked for good — field report §13, reintroduced.
   *     Bounding it the other way (`DisconnectNamedPipe` to release a flush
   *     blocked on a duplicate) is undocumented for a blocked non-overlapped
   *     flush and cannot be measured anywhere but on Windows. So it stays,
   *     stated rather than hidden, until it can be measured on the OS it
   *     belongs to. */
  async drain(): Promise<void> {
    if (!this.server || this.#closed) return;
    // Take what the peer is still SENDING while it is given what we wrote.
    // A route that answers without reading a large upload leaves the client
    // blocked in its own write — the pipe's buffer is full and nobody reads —
    // so it never gets to our answer, the flush below waits out its timeout,
    // and the close then fails the client's write (ERROR_NO_DATA): the window
    // showed `write EPIPE` / a 502 in place of the route's 401. Measured on
    // Windows 11 with a 400,000-byte POST; 1 KB fits the buffer and was fine.
    // The unix side has always done this (`lingerUnix`). Started before the
    // flush is awaited, because the flush is what it unblocks.
    const input = this.#discardInput();
    const flush = k32().FlushFileBuffers(this.#o.h).catch(() => {
      // aio-ok(silent-catch): FlushFileBuffers fails only when the peer is
      // already gone — the case this drain exists to tolerate, never to report.
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), PIPE_DRAIN_TIMEOUT_MS);
    });
    try {
      if (
        await Promise.race([flush.then(() => "flushed"), timeout]) !== "timeout"
      ) {
        // Our bytes are with the peer. Its own may still be on the way, and a
        // close under an unfinished write fails that write — so wait for it
        // to finish and close, as the unix side does, and no longer than that
        // side does. Only for a peer that WAS still sending: one that sent
        // its whole request and reads to our close (a close-delimited body)
        // would otherwise wait out the linger on every response — a pipe has
        // no half-close to tell it we are done. A blocked sender is always
        // seen: the flush cannot finish before its bytes were taken.
        clearTimeout(timer);
        if (!input.took()) return;
        const linger = new Promise<void>((r) => {
          timer = setTimeout(r, PIPE_LINGER_MS);
        });
        await Promise.race([input.done, linger]);
        return;
      }
    } finally {
      clearTimeout(timer);
      input.stop();
    }
    log.warn(
      "pipe",
      `a peer stopped reading: ${PIPE_DRAIN_TIMEOUT_MS} ms after the response was ` +
        `written, ${this.path} still holds bytes it has not taken. Closing ` +
        `the connection — the rest of that body is lost, and nothing else ` +
        `waits on it.`,
    );
    this.close();
  }

  /** Read and drop whatever the peer still sends, until it closes, the
   *  connection does, or `stop()`. Through the connection's own stream, so
   *  "one outstanding read" stays the stream's to guarantee; a stream some
   *  reader still holds is left alone (`done` is then already settled). */
  #discardInput(): {
    done: Promise<void>;
    stop: () => void;
    /** Whether the peer sent anything since this began. */
    took: () => boolean;
  } {
    if (this.readable.locked) {
      return { done: Promise.resolve(), stop() {}, took: () => false };
    }
    const reader = this.readable.getReader();
    let stopped = false;
    let took = false;
    const done = (async () => {
      try {
        while (!stopped && !(await reader.read()).done) took = true;
      } catch {
        // aio-ok: a read that fails is a connection that ended — what is awaited
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* aio-ok: a read still pending when the connection closed */
        }
      }
    })();
    return {
      done,
      stop() {
        stopped = true;
      },
      took: () => took,
    };
  }

  /** One write, complete: WriteFile until every byte is accepted. Serialized
   *  by the WritableStream. */
  async #write(chunk: Uint8Array): Promise<void> {
    let off = 0;
    while (off < chunk.length) {
      if (this.#closed) {
        throw winError("WriteFile", ERROR_BROKEN_PIPE, this.path);
      }
      // A copy: the buffer must stay alive and unmoved until the operation
      // completes, and a caller's view may be a subarray of something reused.
      const data = chunk.slice(off);
      const code = startIo("NtWriteFile", this.#o.h, data, this.#wovl);
      if (code !== null) throw winError("WriteFile", code, this.path);
      const r = await finishOverlapped(this.#o, this.#wovl);
      if (!r.ok) throw winError("WriteFile", r.code, this.path);
      if (r.bytes === 0) throw winError("WriteFile", ERROR_NO_DATA, this.path);
      off += r.bytes;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Release FIRST, and act only if this connection is the thing that still
    // owns the value. A close that has already happened — or a value this
    // connection lost — closes nothing here, because closing a recycled value
    // would cancel and close whatever the process opened in the meantime.
    if (!handles.release(this.#o.slot)) return;
    const h = this.#o.h;
    // Cancel what is in flight, then close: the pending operations complete
    // onto the port with OPERATION_ABORTED, which is end-of-stream, so every
    // waiter is released rather than left parked on a promise. Nothing else
    // needs closing — the OVERLAPPEDs are plain buffers, kept alive by the
    // frames awaiting them.
    //
    // A server end is CLOSED, never `DisconnectNamedPipe`d. Disconnect
    // discards what the client has not read yet and fails its next read with
    // ERROR_PIPE_NOT_CONNECTED — `read EPIPE` in Node, `net::ERR_FAILED` in
    // Electron — even after `drain`: measured on real Windows 11 (2026-09-18),
    // a 9 MB `app.js` read at Chromium's pace lost its last ~64 KB and the
    // window stayed blank. Closing the handle leaves the buffered bytes to the
    // client, whose next read after them is ERROR_BROKEN_PIPE: a clean EOF.
    // Each connection is its own pipe instance, so there is nothing to reuse.
    k32().CancelIoEx(h, null);
    closeHandle(h);
  }
}

// ── Server ────────────────────────────────────────────────────────────────

/** The pipe's security attributes — a descriptor from {@linkcode PIPE_SDDL},
 *  freed after the pipe is created (the kernel copies it). */
function withSecurityAttributes<T>(path: string, f: (sa: Uint8Array) => T): T {
  const sdOut = new Uint8Array(8);
  const sizeOut = new Uint8Array(4);
  const ok = advapi().ConvertStringSecurityDescriptorToSecurityDescriptorW(
    wstr(PIPE_SDDL),
    SDDL_REVISION_1,
    sdOut,
    sizeOut,
  );
  if (!ok) {
    throw winError(
      `ConvertStringSecurityDescriptorToSecurityDescriptorW("${PIPE_SDDL}")`,
      k32().GetLastError(),
      path,
    );
  }
  const sd = readU64(sdOut);
  try {
    return f(securityAttributesBytes(sd));
  } finally {
    k32().LocalFree(Deno.UnsafePointer.create(sd));
  }
}

function createInstance(path: string, first: boolean): Owned {
  const name = wstr(path);
  return withSecurityAttributes(path, (sa) => {
    const h = k32().CreateNamedPipeW(
      name,
      u32(
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED |
          (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
      ),
      u32(
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
          PIPE_REJECT_REMOTE_CLIENTS,
      ),
      PIPE_UNLIMITED_INSTANCES,
      PIPE_BUFFER_BYTES,
      PIPE_BUFFER_BYTES,
      0,
      Deno.UnsafePointer.of(sa),
    );
    if (isInvalidHandle(h)) {
      const code = k32().GetLastError();
      throw winError(
        first && code === ERROR_ACCESS_DENIED
          ? `CreateNamedPipeW (${PIPE_TAKEN})`
          : "CreateNamedPipeW",
        code,
        path,
      );
    }
    // Owned from the moment the kernel hands the value over, and BEFORE
    // anything can close it — a claim taken later is a window in which the
    // value is untracked.
    const o = own(h, `pipe instance ${path}`);
    // Bound to the port before the first operation (the connect) starts.
    try {
      ioPort.attach(h, path);
    } catch (e) {
      closeOwned(o);
      throw e;
    }
    return o;
  });
}

/** Pipes bound ahead of their listener — see {@linkcode reservePipe}. */
const reserved = new Map<string, Owned>();

/** Take the pipe NAME now, synchronously, for the `listenPipe(path)` that
 *  follows — or throw.
 *
 *  The app's listeners reach `listenPipe` through a dynamic import
 *  (`local-listen.ts`), so their bind lands a few turns after boot moved on,
 *  and a bind that failed was an `accept loop error` line in the log of an app
 *  that kept running without its door: it printed `running`, and its window
 *  was served by whoever DID hold the name (measured on Windows 11 — another
 *  instance's state in this one's window). A unix bind throws where it is
 *  made; this is that, for a pipe. Boot calls it before anything is announced.
 *
 *  Without `--allow-ffi` there is no pipe at all, and that too is said here,
 *  in one line with the flag, not as a `NotCapable … advapi32.dll` after the
 *  app said it was up. */
export function reservePipe(path: string): void {
  // Twice in one process — two apps of one appId, `singleton: false` — is
  // two apps asking for one door: said here, not as the second one's
  // `accept loop error` a few turns later.
  if (reserved.has(path)) {
    throw new Error(
      `the local pipe ${path} is already reserved in this process — ` +
        PIPE_TAKEN,
    );
  }
  try {
    reserved.set(path, createInstance(path, true));
  } catch (e) {
    if (
      e instanceof Deno.errors.NotCapable ||
      e instanceof Deno.errors.PermissionDenied
    ) {
      throw new Error(
        `the local pipe ${path} cannot be opened: on Windows a local ` +
          "Electron app is served over a named pipe, which needs FFI, and " +
          "this process was started without `--allow-ffi`. Fix: add " +
          "`--allow-ffi` to the `deno run` flags (a compiled build already " +
          "has it) — or run with `--transport=ws` for a loopback port.",
      );
    }
    throw e;
  }
}

/** {@linkcode reservePipe} for every name of one app, or for none: when one
 *  cannot be taken the ones before it are given back, and the refusal is
 *  thrown. A name left reserved is a name hosted by an instance nobody will
 *  ever accept on — its clients hang, a liveness probe says "alive", and the
 *  next process to ask is refused. */
export function reservePipes(paths: readonly string[]): void {
  const taken: string[] = [];
  try {
    for (const p of paths) {
      reservePipe(p);
      taken.push(p);
    }
  } catch (e) {
    releasePipes(taken);
    throw e;
  }
}

/** Give back the names {@linkcode reservePipe} took that no `listenPipe`
 *  has claimed — for a boot that failed after reserving, in a process that
 *  lives on (library mode, a caller that catches `aio.run`, a test). A name
 *  a listener already serves is not touched. */
export function releasePipes(paths: readonly string[]): void {
  for (const p of paths) {
    const o = reserved.get(p);
    if (o === undefined) continue;
    reserved.delete(p);
    closeOwned(o);
  }
}

/** Host `path`. The first instance is created HERE, synchronously, with
 *  FILE_FLAG_FIRST_PIPE_INSTANCE — so "already running" fails at the bind, as
 *  a unix socket does (or was, by {@linkcode reservePipe}). Each accepted
 *  connection is one pipe instance, and {@linkcode PIPE_SPARE_INSTANCES} more
 *  wait for a client at any moment: a replacement is created the moment a
 *  connection is HEARD of, not when it is handed out, so a burst no larger
 *  than that never meets ERROR_PIPE_BUSY and a larger one meets it briefly
 *  (`connectPipe` waits it out) — up to {@linkcode PIPE_BACKLOG} instances the
 *  consumer has not taken. */
export function listenPipe(path: string): LocalListener {
  const first = reserved.get(path) ?? createInstance(path, true);
  reserved.delete(path);
  let closed = false;
  let started = false;
  /** Instances with a ConnectNamedPipe pending — what a client can open. */
  const listening = new Set<Owned>([first]);
  /** Connected, not handed out yet. */
  const ready: Owned[] = [];
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const signal = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  /** Start the connect on `o`. Its OVERLAPPED belongs to that connect and to
   *  nothing else; the closure keeps it alive until the port reports it. */
  function listen(o: Owned): void {
    listening.add(o);
    const connected = () => {
      listening.delete(o);
      ready.push(o);
      refill();
      signal();
    };
    const failed = (code: number) => {
      listening.delete(o);
      if (code === ERROR_NO_DATA) {
        // A client opened this instance and closed it again before the
        // connect was started on it — a liveness probe does exactly that to
        // the instance `reservePipe` made, long before the first accept.
        // Nobody is there to serve and nothing is wrong with the pipe: this
        // instance is spent, the next one takes its place. Made BEFORE this
        // one is closed — the last instance closing is the name going away.
        try {
          if (!closed) listen(createInstance(path, false));
        } catch (e) {
          fail(e instanceof Error ? e : new Error(String(e)));
        }
        closeOwned(o);
        return;
      }
      closeOwned(o);
      fail(winError("ConnectNamedPipe", code, path));
    };
    const ovl = overlappedBytes(0n);
    if (k32().ConnectNamedPipe(o.h, ovl)) return connected();
    let code = k32().GetLastError();
    // FALSE with "no error" is a code that was lost on the way here, not an
    // answer: ask the instance itself. A connect that was pending and
    // finished in between reads as connected — its packet then arrives for
    // an OVERLAPPED nobody waits on, which the port skips.
    if (code === 0) {
      code = connectCodeFromFacts(
        k32().PeekNamedPipe(o.h, null, 0, null, new Uint8Array(4), null) !== 0,
        k32().GetNamedPipeClientProcessId(o.h, new Uint8Array(4)) !== 0,
      );
    }
    // ERROR_PIPE_CONNECTED means the client got in first: no packet is
    // queued for it, and there is nothing to wait for.
    if (code === ERROR_PIPE_CONNECTED) return connected();
    if (code !== ERROR_IO_PENDING) return failed(code);
    finishOverlapped(o, ovl).then((r) => {
      // Gated on the CLAIM, not on `closed` alone: `close()` below releases
      // and closes this very instance while the connect is parked, and asking
      // a value that now belongs to someone else for this connect's result is
      // the same use-after-free the reads have.
      if (closed || !handles.isLive(o.slot)) return;
      if (!r.ok && r.code !== ERROR_PIPE_CONNECTED) failed(r.code);
      else connected();
    }, (e) => {
      listening.delete(o);
      closeOwned(o);
      fail(e instanceof Error ? e : new Error(String(e)));
    });
  }

  /** The listener cannot wait for a client any more. Every instance nobody
   *  was handed goes with it: one left hosted is a door that opens onto
   *  nothing — its client hangs, and a liveness probe calls the app alive.
   *  Closed, they get "no pipe"; the consumer gets `e` from its accept. */
  function fail(e: Error): void {
    if (failure !== null || closed) return;
    failure = e;
    log.error("pipe", `${path} is closed, it can no longer listen — ${e}`);
    drop();
    signal();
  }

  /** Cancel every pending ConnectNamedPipe (its wait returns ABORTED) and
   *  drop the instances nobody was handed. Accepted connections are
   *  untouched — each one owns its own claim, and this releases only ours. */
  function drop(): void {
    for (const o of [...listening, ...ready.splice(0)]) {
      if (handles.release(o.slot)) {
        k32().CancelIoEx(o.h, null);
        closeHandle(o.h);
      }
    }
    listening.clear();
  }

  /** Keep {@linkcode PIPE_SPARE_INSTANCES} instances waiting — while the
   *  consumer is no more than {@linkcode PIPE_BACKLOG} behind. */
  function refill(): void {
    try {
      while (
        !closed && failure === null &&
        listening.size < PIPE_SPARE_INSTANCES &&
        listening.size + ready.length < PIPE_BACKLOG
      ) listen(createInstance(path, false));
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async function accept(): Promise<LocalConn | null> {
    if (!started && !closed) {
      started = true;
      listen(first);
      refill();
    }
    while (ready.length === 0) {
      if (closed) return null;
      // For good: a listener that cannot wait for a client is not one
      // (`fail` closed what it had).
      if (failure !== null) throw failure;
      await new Promise<void>((r) => wake = r);
    }
    if (closed) return null;
    // Ownership passes to the connection, which is now the only thing that
    // closes it — and its place in the backlog is free.
    const o = ready.shift()!;
    refill();
    return new PipeConn(o, path, true);
  }

  return {
    path,
    close() {
      if (closed) return;
      closed = true;
      drop();
      signal();
    },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        const c = await accept();
        if (c === null) return;
        yield c;
      }
    },
  };
}

// ── Secret files ──────────────────────────────────────────────────────────

const CREATE_NEW = 1;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const SE_FILE_OBJECT = 1;
const DACL_SECURITY_INFORMATION = 4;

/** Create `path` (it must not exist) with {@linkcode PIPE_SDDL}'s owner-only,
 *  protected DACL — given AT CREATION, so the file is never, at any instant,
 *  readable through an inherited ACE of a shared directory — write
 *  `contents`, and return the DACL Windows actually holds for it, as SDDL,
 *  for the caller to judge (`_ownerOnlyDaclRefusal` in app-key.ts). Windows'
 *  `Deno.stat().mode` says nothing about who can read a file; this does.
 *  Throws, naming the call, on any failure (no `--allow-ffi` included). */
export function writeOwnerOnlyFile(path: string, contents: string): string {
  const name = wstr(path);
  const h = withSecurityAttributes(path, (sa) =>
    k32().CreateFileW(
      name,
      u32(GENERIC_WRITE),
      0,
      Deno.UnsafePointer.of(sa),
      CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL,
      null,
    ));
  if (isInvalidHandle(h)) {
    throw winError("CreateFileW", k32().GetLastError(), path);
  }
  const o = own(h, `secret file ${path}`);
  try {
    const bytes = new TextEncoder().encode(contents);
    const written = new Uint8Array(4);
    if (
      !k32().WriteFile(h, bytes, bytes.length, written, null) ||
      readU32(written) !== bytes.length
    ) {
      throw winError("WriteFile", k32().GetLastError(), path);
    }
  } finally {
    closeOwned(o);
  }
  const sdOut = new Uint8Array(8);
  const rc = advapi().GetNamedSecurityInfoW(
    name,
    SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION,
    null,
    null,
    null,
    null,
    sdOut,
  );
  if (rc !== 0) throw winError("GetNamedSecurityInfoW", rc, path);
  const sd = Deno.UnsafePointer.create(readU64(sdOut));
  try {
    const strOut = new Uint8Array(8);
    const lenOut = new Uint8Array(4);
    if (
      !advapi().ConvertSecurityDescriptorToStringSecurityDescriptorW(
        sd,
        SDDL_REVISION_1,
        DACL_SECURITY_INFORMATION,
        strOut,
        lenOut,
      )
    ) {
      throw winError(
        "ConvertSecurityDescriptorToStringSecurityDescriptorW",
        k32().GetLastError(),
        path,
      );
    }
    const str = Deno.UnsafePointer.create(readU64(strOut));
    try {
      const view = new Deno.UnsafePointerView(str!);
      let out = "";
      for (let i = 0;; i += 2) {
        const c = view.getUint16(i);
        if (c === 0) break;
        out += String.fromCharCode(c);
      }
      return out;
    } finally {
      k32().LocalFree(str);
    }
  } finally {
    k32().LocalFree(sd);
  }
}

// ── Client ────────────────────────────────────────────────────────────────

/** Whether a failed client `CreateFileW` is asked again: the pipe is busy —
 *  or its code was LOST. `GetLastError()` is a second FFI call and the
 *  thread's code does not always survive until it (see
 *  `connectCodeFromFacts`): a client under a full Windows suite read 0, which
 *  no failed open answers, and threw "Win32 error 0" at a pipe that was only
 *  busy. Asked again within the same bound, it gets a real answer. Pure.
 *  @internal exported for its test */
export function _askAgain(code: number): boolean {
  return code === ERROR_PIPE_BUSY || code === 0;
}

/** Open `path` as a client. Throws `Deno.errors.NotFound` when nothing hosts
 *  the pipe (the unix `connect` on a missing socket throws the same), so a
 *  caller's "the app is not running" branch reads the same on both OSs. A
 *  busy pipe (every instance taken, the server not yet back with the next) is
 *  asked again for {@linkcode PIPE_BUSY_WAIT_MS}, then it is an error that
 *  says so. A timer between tries, never `WaitNamedPipeW`: that parks one
 *  blocking-pool thread per waiting client, and the pool is what the
 *  completion port's own wait runs on (see the module doc). */
export async function connectPipe(
  path: string,
  /** Test seam: the busy bound (default {@linkcode PIPE_BUSY_WAIT_MS}). */
  busyWaitMs = PIPE_BUSY_WAIT_MS,
): Promise<LocalConn> {
  const name = wstr(path);
  const until = performance.now() + busyWaitMs;
  for (let pause = 1;; pause = Math.min(pause * 2, 20)) {
    const h = k32().CreateFileW(
      name,
      u32(GENERIC_READ | GENERIC_WRITE),
      0,
      null,
      u32(OPEN_EXISTING),
      u32(FILE_FLAG_OVERLAPPED),
      null,
    );
    if (!isInvalidHandle(h)) {
      const o = own(h, `pipe client ${path}`);
      // Bound to the port before the first read or write starts on it.
      try {
        ioPort.attach(h, path);
      } catch (e) {
        closeOwned(o);
        throw e;
      }
      return new PipeConn(o, path, false);
    }
    const code = k32().GetLastError();
    if (code === ERROR_FILE_NOT_FOUND) {
      throw new Deno.errors.NotFound(
        `no pipe at ${path} (Win32 error ${code} ERROR_FILE_NOT_FOUND)`,
      );
    }
    if (!_askAgain(code)) throw winError("CreateFileW", code, path);
    if (performance.now() >= until) {
      throw winError(
        `CreateFileW (every instance of the pipe stayed taken for ${busyWaitMs} ms — its host is not accepting)`,
        code,
        path,
      );
    }
    await new Promise((r) => setTimeout(r, pause));
  }
}

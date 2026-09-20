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
import { log } from "../diagnostics/logger-api.ts";

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

/** `hEvent` back out of an `OVERLAPPED` (the inverse of the encoder). */
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
  ReadFile: {
    parameters: ["pointer", "buffer", "u32", "buffer", "buffer"],
    result: "i32",
  },
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
  WaitNamedPipeW: {
    parameters: ["buffer", "u32"],
    result: "i32",
    nonblocking: true,
  },
  GetLastError: { parameters: [], result: "u32" },
  LocalFree: { parameters: ["pointer"], result: "pointer" },
} as const;

const ADVAPI_SYMBOLS = {
  ConvertStringSecurityDescriptorToSecurityDescriptorW: {
    parameters: ["buffer", "u32", "buffer", "buffer"],
    result: "i32",
  },
} as const;

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

function handleValue(h: Handle): bigint {
  return h === null ? 0n : BigInt(Deno.UnsafePointer.value(h));
}

function isInvalidHandle(h: Handle): boolean {
  return h === null || handleValue(h) === INVALID_HANDLE_VALUE;
}

function closeHandle(h: Handle): void {
  if (h !== null) k32().CloseHandle(h);
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
            if (w === undefined) continue; // see `completion`: unreachable
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
      }
    })();
  }
}

const ioPort = new IoPort();

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
  h: Handle,
  ovl: Uint8Array,
): Promise<{ ok: true; bytes: number } | { ok: false; code: number }> {
  await ioPort.completion(ovl);
  const bytes = new Uint8Array(4);
  // bWait=FALSE: the port already said it is done, and this runs on the main
  // thread so the GetLastError below is the one that belongs to this call.
  const ok = k32().GetOverlappedResult(h, ovl, bytes, 0);
  if (!ok) return { ok: false, code: k32().GetLastError() };
  return { ok: true, bytes: readU32(bytes) };
}

// ── Connection ────────────────────────────────────────────────────────────

class PipeConn implements LocalConn {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly remoteAddr: Deno.Addr;
  #h: Handle;
  #closed = false;
  /** One OVERLAPPED per DIRECTION — a read and a write may be in flight at
   *  once, never two of either (the streams serialize each side). The kernel
   *  writes into it while the operation is pending, and the port resolves by
   *  its address, so these two buffers are this connection's identity on the
   *  queue. No event handles: the completion goes to the port. */
  #rovl = overlappedBytes(0n);
  #wovl = overlappedBytes(0n);
  #buf = new Uint8Array(PIPE_BUFFER_BYTES);

  constructor(h: Handle, readonly path: string, readonly server: boolean) {
    this.#h = h;
    this.remoteAddr = { transport: "unix", path };
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
    // lpNumberOfBytesRead is NULL for overlapped I/O (the documented shape):
    // the count is read back through GetOverlappedResult in every case, so
    // the synchronous-completion and the pending path are ONE path — and a
    // handle bound to a completion port queues a packet for BOTH, so both
    // are also one wait.
    const ok = k32().ReadFile(
      this.#h,
      this.#buf,
      this.#buf.length,
      null,
      this.#rovl,
    );
    if (!ok) {
      const code = k32().GetLastError();
      if (code !== ERROR_IO_PENDING && code !== ERROR_MORE_DATA) {
        // A hard failure at START queues no packet: nothing to wait for.
        return this.#readFailed(code);
      }
    }
    const r = await finishOverlapped(this.#h, this.#rovl);
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
   *  when the pool is the thing that is jammed. */
  async drain(): Promise<void> {
    if (!this.server || this.#closed) return;
    const flush = k32().FlushFileBuffers(this.#h).catch(() => {
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
      ) return;
    } finally {
      clearTimeout(timer);
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
      const ok = k32().WriteFile(
        this.#h,
        data,
        data.length,
        null,
        this.#wovl,
      );
      if (!ok) {
        const code = k32().GetLastError();
        if (code !== ERROR_IO_PENDING) {
          throw winError("WriteFile", code, this.path);
        }
      }
      const r = await finishOverlapped(this.#h, this.#wovl);
      if (!r.ok) throw winError("WriteFile", r.code, this.path);
      if (r.bytes === 0) throw winError("WriteFile", ERROR_NO_DATA, this.path);
      off += r.bytes;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const h = this.#h;
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

function createInstance(path: string, first: boolean): Handle {
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
          ? "CreateNamedPipeW (pipe already exists — another instance of this app is running?)"
          : "CreateNamedPipeW",
        code,
        path,
      );
    }
    // Bound to the port before the first operation (the connect) starts.
    try {
      ioPort.attach(h, path);
    } catch (e) {
      closeHandle(h);
      throw e;
    }
    return h;
  });
}

/** Host `path`. The first instance is created HERE, synchronously, with
 *  FILE_FLAG_FIRST_PIPE_INSTANCE — so "already running" fails at the bind, as
 *  a unix socket does. Each accepted connection is one pipe instance; the
 *  next instance is created before the current one is yielded, so a client
 *  never meets ERROR_PIPE_BUSY. */
export function listenPipe(path: string): LocalListener {
  let next: Handle = createInstance(path, true);
  let closed = false;

  async function accept(): Promise<LocalConn | null> {
    if (closed) return null;
    const h = next;
    // This OVERLAPPED belongs to the pending connect and to nothing else; the
    // frame below keeps it alive until the port reports it.
    const ovl = overlappedBytes(0n);
    const ok = k32().ConnectNamedPipe(h, ovl);
    if (!ok) {
      const code = k32().GetLastError();
      if (code === ERROR_IO_PENDING) {
        const r = await finishOverlapped(h, ovl);
        if (closed) return null;
        if (!r.ok && r.code !== ERROR_PIPE_CONNECTED) {
          throw winError("ConnectNamedPipe", r.code, path);
        }
      } else if (code !== ERROR_PIPE_CONNECTED) {
        // ERROR_PIPE_CONNECTED means the client got in first: no packet is
        // queued for it, and there is nothing to wait for.
        throw winError("ConnectNamedPipe", code, path);
      }
    }
    if (closed) return null;
    // Pre-create the next instance BEFORE handing this one out.
    next = createInstance(path, false);
    return new PipeConn(h, path, true);
  }

  return {
    path,
    close() {
      if (closed) return;
      closed = true;
      // Cancel the pending ConnectNamedPipe (its wait returns ABORTED) and
      // drop the unconnected instance. Accepted connections are untouched.
      const h = next;
      next = null;
      if (h !== null) {
        k32().CancelIoEx(h, null);
        closeHandle(h);
      }
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

// ── Client ────────────────────────────────────────────────────────────────

/** Open `path` as a client. Throws `Deno.errors.NotFound` when nothing hosts
 *  the pipe (the unix `connect` on a missing socket throws the same), so a
 *  caller's "the app is not running" branch reads the same on both OSs. A
 *  busy pipe (every instance mid-connect) is waited on, briefly, then retried. */
export async function connectPipe(path: string): Promise<LocalConn> {
  const name = wstr(path);
  for (let attempt = 0;; attempt++) {
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
      // Bound to the port before the first read or write starts on it.
      try {
        ioPort.attach(h, path);
      } catch (e) {
        closeHandle(h);
        throw e;
      }
      return new PipeConn(h, path, false);
    }
    const code = k32().GetLastError();
    if (code === ERROR_FILE_NOT_FOUND) {
      throw new Deno.errors.NotFound(
        `no pipe at ${path} (Win32 error ${code} ERROR_FILE_NOT_FOUND)`,
      );
    }
    if (code === ERROR_PIPE_BUSY && attempt < 5) {
      // Every instance is between CreateFile and ConnectNamedPipe; the server
      // pre-creates instances so this is rare. Wait up to 2s for one.
      await k32().WaitNamedPipeW(name, 2000);
      continue;
    }
    throw winError("CreateFileW", code, path);
  }
}

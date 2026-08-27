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
 * once with `ERROR_IO_PENDING`), the WAIT for it is a `nonblocking: true` FFI
 * call — `WaitForSingleObject` on the operation's own event, on a pool
 * thread — and the RESULT is read back with a synchronous
 * `GetOverlappedResult(bWait=FALSE)` on the main thread, so `GetLastError()`
 * (thread-local) is read on the thread that owns the error. The event loop
 * never stalls. Back-pressure: one outstanding read per connection (the
 * `ReadableStream` pulls one chunk at a time), writes serialized by the
 * `WritableStream`.
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
export const WAIT_OBJECT_0 = 0;
export const SDDL_REVISION_1 = 1;

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
 *  shared by two in-flight operations. */
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
  DisconnectNamedPipe: { parameters: ["pointer"], result: "i32" },
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
  // THE blocking wait — on a pool thread, never the event loop.
  WaitForSingleObject: {
    parameters: ["pointer", "u32"],
    result: "u32",
    nonblocking: true,
  },
  CreateEventW: {
    parameters: ["pointer", "i32", "i32", "pointer"],
    result: "pointer",
  },
  CloseHandle: { parameters: ["pointer"], result: "i32" },
  CancelIoEx: { parameters: ["pointer", "pointer"], result: "i32" },
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

/** A manual-reset event for one operation's OVERLAPPED. Manual-reset is what
 *  the overlapped-I/O contract wants: the system resets it when an operation
 *  starts and sets it on completion. */
function createEvent(path: string): { h: Handle; ovl: Uint8Array } {
  const h = k32().CreateEventW(null, 1, 0, null);
  if (isInvalidHandle(h)) {
    throw winError("CreateEventW", k32().GetLastError(), path);
  }
  return { h, ovl: overlappedBytes(handleValue(h)) };
}

function closeHandle(h: Handle): void {
  if (h !== null) k32().CloseHandle(h);
}

/** Did the blocking wait itself fail?
 *
 *  `INFINITE` rules out `WAIT_TIMEOUT`, so anything other than `WAIT_OBJECT_0`
 *  means the wait machinery failed (a closed or invalid event handle) — not an
 *  outcome of the I/O the caller started. The distinction is the whole point:
 *  the return value used to be discarded, so a failed wait fell through to
 *  `GetOverlappedResult` on an operation that had never completed and reported
 *  whatever `GetLastError` happened to hold, under the WRONG call's name. This
 *  file's rule is that every Win32 failure throws an Error naming the call that
 *  failed. */
export function waitFailed(rc: number): boolean {
  return rc !== WAIT_OBJECT_0;
}

/** Wait for one started overlapped operation to finish; return the byte count
 *  or the Win32 error code. Never throws for an operation OUTCOME — the caller
 *  decides what a code means on its path (a read's BROKEN_PIPE is EOF, a
 *  connect's is a failure). A failure of the WAIT is not an outcome, and has no
 *  meaning any caller could act on, so it throws. */
async function finishOverlapped(
  h: Handle,
  ev: { h: Handle; ovl: Uint8Array },
): Promise<{ ok: true; bytes: number } | { ok: false; code: number }> {
  const rc = await k32().WaitForSingleObject(ev.h, INFINITE);
  if (waitFailed(rc)) {
    throw winError(
      "WaitForSingleObject",
      k32().GetLastError(),
      `overlapped event (rc=0x${rc.toString(16)})`,
    );
  }
  const bytes = new Uint8Array(4);
  const ok = k32().GetOverlappedResult(h, ev.ovl, bytes, 0);
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
  #rev: { h: Handle; ovl: Uint8Array };
  #wev: { h: Handle; ovl: Uint8Array };
  #inFlight = new Set<Promise<unknown>>();
  #buf = new Uint8Array(PIPE_BUFFER_BYTES);

  constructor(h: Handle, readonly path: string, readonly server: boolean) {
    this.#h = h;
    this.#rev = createEvent(path);
    this.#wev = createEvent(path);
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

  #track<T>(p: Promise<T>): Promise<T> {
    this.#inFlight.add(p);
    p.finally(() => this.#inFlight.delete(p)).catch(() => {});
    return p;
  }

  /** One read. `null` = the peer is gone. One outstanding at a time — the
   *  stream's `pull` guarantees it. */
  async #read(): Promise<Uint8Array | null> {
    if (this.#closed) return null;
    // lpNumberOfBytesRead is NULL for overlapped I/O (the documented shape):
    // the count is read back through GetOverlappedResult in every case, so
    // the synchronous-completion and the pending path are ONE path.
    const ok = k32().ReadFile(
      this.#h,
      this.#buf,
      this.#buf.length,
      null,
      this.#rev.ovl,
    );
    if (!ok) {
      const code = k32().GetLastError();
      if (code !== ERROR_IO_PENDING && code !== ERROR_MORE_DATA) {
        return this.#readFailed(code);
      }
    }
    const r = await this.#track(finishOverlapped(this.#h, this.#rev));
    if (!r.ok) return this.#readFailed(r.code);
    if (r.bytes === 0) return null;
    return this.#buf.slice(0, r.bytes);
  }

  #readFailed(code: number): null {
    if (this.#closed || isPeerGoneError(code)) return null;
    throw winError("ReadFile", code, this.path);
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
        this.#wev.ovl,
      );
      if (!ok) {
        const code = k32().GetLastError();
        if (code !== ERROR_IO_PENDING) {
          throw winError("WriteFile", code, this.path);
        }
      }
      const r = await this.#track(finishOverlapped(this.#h, this.#wev));
      if (!r.ok) throw winError("WriteFile", r.code, this.path);
      if (r.bytes === 0) throw winError("WriteFile", ERROR_NO_DATA, this.path);
      off += r.bytes;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const h = this.#h;
    // Cancel what is in flight, then close: the pending waits wake up (the
    // event is signalled on cancellation) and read back OPERATION_ABORTED,
    // which is end-of-stream. The events are closed only after every wait
    // has returned — a handle closed under a waiter is undefined behaviour.
    k32().CancelIoEx(h, null);
    if (this.server) k32().DisconnectNamedPipe(h);
    closeHandle(h);
    const rev = this.#rev, wev = this.#wev;
    Promise.allSettled([...this.#inFlight]).then(() => {
      closeHandle(rev.h);
      closeHandle(wev.h);
    });
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
    const ev = createEvent(path);
    try {
      const ok = k32().ConnectNamedPipe(h, ev.ovl);
      if (!ok) {
        const code = k32().GetLastError();
        if (code === ERROR_IO_PENDING) {
          const r = await finishOverlapped(h, ev);
          if (closed) return null;
          if (!r.ok && r.code !== ERROR_PIPE_CONNECTED) {
            throw winError("ConnectNamedPipe", r.code, path);
          }
        } else if (code !== ERROR_PIPE_CONNECTED) {
          throw winError("ConnectNamedPipe", code, path);
        }
      }
    } finally {
      closeHandle(ev.h);
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
    if (!isInvalidHandle(h)) return new PipeConn(h, path, false);
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

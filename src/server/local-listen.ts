/**
 * @module
 * The local-socket seam — ONE listen/connect pair for "a same-machine,
 * portless, user-only door", on every OS.
 *
 * Linux/macOS: a Unix domain socket, wrapping `Deno.Conn` 1:1 (the streams
 * ARE the connection's own). Windows: a named pipe (`\\.\pipe\aio-<lockKey>`)
 * hosted by Deno through `win-pipe.ts`. Everything above this seam — the
 * NDJSON framing in `uds.ts`, the control plane, the HTTP handler over the
 * socket, `am`'s client — sees the same `LocalConn` on both, which is what
 * lets a Linux test and a Wine run prove the same code.
 *
 * `win-pipe.ts` is loaded ONLY on windows (dynamic import) so Linux/macOS never
 * touch FFI. A path that cannot be bound or opened is THROWN — on unix at the
 * call site, on windows from the first accept (the import is asynchronous) —
 * never logged and forgotten.
 */

/** A pipe path — the one spelling (`\\.\pipe\…`) that is NOT a filesystem
 *  path: never `Deno.remove`d, never `Deno.stat`ed, never chmod'ed. */
export const PIPE_PREFIX = "\\\\.\\pipe\\";

/** True for a Windows named-pipe path. Every socket-file cleanup in the
 *  codebase is gated on this — a pipe vanishes when its last handle closes. */
export function isPipePath(p: string): boolean {
  return p.startsWith(PIPE_PREFIX);
}

export interface LocalConn {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  /** Idempotent. */
  close(): void;
  /** `{ transport: "unix", path }` on BOTH OSs — server.ts treats it as the
   *  unix peer (a same-machine, same-user caller) and the gate reads exactly
   *  that. A pipe peer is the same claim, so it carries the same shape. */
  readonly remoteAddr: Deno.Addr;
}

export interface LocalListener extends AsyncIterable<LocalConn> {
  readonly path: string;
  /** Stops the accept loop; open connections are unaffected. Idempotent. */
  close(): void;
}

/** The pipe backend, resolved once. Loaded lazily and only on windows: the
 *  module dlopens kernel32/advapi32 at import time, which Linux must never do. */
let _winPipe: Promise<typeof import("./win-pipe.ts")> | null = null;
function winPipe(): Promise<typeof import("./win-pipe.ts")> {
  _winPipe ??= import("./win-pipe.ts");
  return _winPipe;
}

/** Wrap a `Deno.Conn` 1:1 — the unix branch is a pure re-labelling. */
function wrapUnixConn(conn: Deno.Conn): LocalConn {
  let closed = false;
  return {
    readable: conn.readable,
    writable: conn.writable,
    remoteAddr: conn.remoteAddr,
    close() {
      if (closed) return;
      closed = true;
      try {
        conn.close();
      } catch { /* already closed by the stream side */ }
    },
  };
}

/** Listen on a local socket path. Unix: `Deno.listen({ transport: "unix" })`,
 *  synchronously bound, so a path in use throws HERE. Windows: the backend is
 *  a dynamic import, so the bind starts immediately but lands asynchronously —
 *  the first pipe instance is created with FILE_FLAG_FIRST_PIPE_INSTANCE (a
 *  second app instance fails the way a unix bind does) and a bind or load
 *  failure is thrown from the FIRST `next()` of the iterator, which the accept
 *  loop calls at boot. */
export function listenLocal(path: string): LocalListener {
  if (isPipePath(path)) {
    if (Deno.build.os !== "windows") {
      throw new Error(
        `listenLocal: ${path} is a Windows named-pipe path, and this is ${Deno.build.os}`,
      );
    }
    return listenPipeLazy(path);
  }
  const l = Deno.listen({ transport: "unix", path });
  let closed = false;
  return {
    path,
    close() {
      if (closed) return;
      closed = true;
      try {
        l.close();
      } catch { /* already closed */ }
    },
    async *[Symbol.asyncIterator]() {
      for await (const c of l) yield wrapUnixConn(c);
    },
  };
}

/** Windows: the backend is a dynamic import, so the listener is a thin
 *  forwarder. `close()` before the import lands is remembered and applied. */
function listenPipeLazy(path: string): LocalListener {
  let closed = false;
  // Bind NOW, not on first iteration: the pipe name is taken at boot, exactly
  // when the unix branch takes its path.
  const bound = winPipe().then((mod) => {
    const inner = mod.listenPipe(path);
    if (closed) inner.close();
    return inner;
  });
  bound.catch(() => {}); // reported by the iterator, not as an unhandled rejection
  return {
    path,
    close() {
      closed = true;
      bound.then((inner) => inner.close(), () => {});
    },
    async *[Symbol.asyncIterator]() {
      const inner = await bound;
      if (closed) return;
      yield* inner;
    },
  };
}

/** Connect to a local socket path. Unix: `Deno.connect({ transport: "unix" })`.
 *  Windows: `CreateFileW` on the pipe with overlapped I/O — the SAME
 *  connection code the server side uses, so there is one read/write path to
 *  prove, not two. (`Deno.open` on a pipe path was not chosen: whether it is
 *  duplex is exactly the kind of thing that differs between Wine and Windows,
 *  and a client that half-works is worse than one implementation.) */
export async function connectLocal(path: string): Promise<LocalConn> {
  if (isPipePath(path)) {
    if (Deno.build.os !== "windows") {
      throw new Error(
        `connectLocal: ${path} is a Windows named-pipe path, and this is ${Deno.build.os}`,
      );
    }
    const mod = await winPipe();
    return await mod.connectPipe(path);
  }
  return wrapUnixConn(await Deno.connect({ transport: "unix", path }));
}

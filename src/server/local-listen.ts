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

import {
  type PeerIdentity,
  unixPeerIdentity,
  UNKNOWN_PEER,
} from "./local-peer.ts";

export interface LocalConn {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  /** Wait until everything already written has been READ by the peer, before
   *  the connection is torn down. Windows-only in practice: a server pipe
   *  torn down with unread bytes in its buffer can DISCARD them
   *  (real Windows 11, 2026-09-17 — Electron's first page request answered
   *  `read EPIPE`), where a Unix socket flushes on close. Optional: unix has
   *  nothing to do, so it is absent there rather than a no-op implementation. */
  drain?(): Promise<void>;
  /** The kernel's answer to "WHO is on the other end", when this transport can
   *  give one. Unix: `SO_PEERCRED` / `LOCAL_PEERPID`. Windows: the pipe's
   *  client pid (win-pipe.ts). ABSENT when the backend cannot say — the plain
   *  `Deno.listen` unix path — which a required gate treats as a refusal.
   *  Read once per connection, at accept. */
  peerIdentity?(): PeerIdentity;
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

/** Options for {@linkcode listenLocal}. */
export interface ListenLocalOpts {
  /** Attach peer credentials to every accepted connection. Unix takes an
   *  fd-bearing listener built on `node:net` (the plain path exposes no OS fd,
   *  so `SO_PEERCRED` cannot be read from it); a Windows pipe reports them
   *  natively. This only makes `peerIdentity` available — the accept loop,
   *  the framing and the callers are otherwise unchanged. */
  peer?: boolean;
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
export function listenLocal(
  path: string,
  opts?: ListenLocalOpts,
): LocalListener {
  if (isPipePath(path)) {
    if (Deno.build.os !== "windows") {
      throw new Error(
        `listenLocal: ${path} is a Windows named-pipe path, and this is ${Deno.build.os}`,
      );
    }
    return listenPipeLazy(path);
  }
  // Peer credentials need the connection's OS fd, which `Deno.listen` does not
  // expose. The fd-bearing backend is taken ONLY when a caller asks (the
  // production local-peer lockdown); every other unix listener is byte-for-byte
  // the path it always was.
  if (opts?.peer) return listenUnixPeer(path);
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

/** A unix listener whose accepted connections carry `peerIdentity`.
 *
 *  `Deno.listen` gives no OS fd, so `SO_PEERCRED`/`LOCAL_PEERPID` cannot be
 *  read from its connections. `node:net` hands the accepted socket a real fd
 *  (`socket._handle.fd`), and `node:stream`'s `toWeb` turns it back into the
 *  exact stream pair every caller already consumes — the same NDJSON frames,
 *  the same HTTP-over-socket bytes, one implementation for both.
 *
 *  LAZY, like the Windows pipe backend, for two reasons: `node:net`/`node:stream`
 *  load only when a gate asks for them, and a bind failure surfaces from the
 *  first `next()` rather than at the call (node binds asynchronously), which is
 *  exactly where every accept loop already reports it. */
function listenUnixPeer(path: string): LocalListener {
  let closed = false;
  const queue: LocalConn[] = [];
  let wake: (() => void) | null = null;
  let failure: Error | null = null;
  let server: { close(cb?: () => void): void } | null = null;

  const ready = (async () => {
    const [net, { Readable, Writable }] = await Promise.all([
      import("node:net"),
      import("node:stream"),
    ]);
    const wrap = (sock: import("node:net").Socket): LocalConn => {
      // The fd is read ONCE, here: `_handle` is a node internal, and a socket
      // that is already destroyed by the time a gate asks would have none.
      const fd = (sock as unknown as { _handle?: { fd?: number } })._handle
        ?.fd;
      let done = false;
      return {
        readable: Readable.toWeb(sock) as ReadableStream<Uint8Array>,
        writable: Writable.toWeb(sock) as WritableStream<Uint8Array>,
        remoteAddr: { transport: "unix", path },
        peerIdentity: () =>
          typeof fd === "number" ? unixPeerIdentity(fd) : UNKNOWN_PEER,
        close() {
          if (done) return;
          done = true;
          try {
            sock.destroy();
          } catch { /* aio-ok: already destroyed — the close is idempotent */ }
        },
      };
    };
    const srv = net.createServer((sock) => {
      queue.push(wrap(sock));
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    });
    // A later error (not the bind) must end the accept loop, not crash the
    // process: park it and let the iterator throw it where accept errors are
    // already handled.
    srv.on("error", (e: Error) => {
      failure = e;
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    });
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(path, () => {
        srv.off("error", reject);
        resolve();
      });
    });
    if (closed) srv.close();
    server = srv;
  })();
  // Reported by the iterator, never as an unhandled rejection.
  ready.catch(() => {
    // aio-ok: the bind failure is re-thrown from the first `next()`, so it is
    // surfaced where accept errors are handled — not dropped here.
  });

  return {
    path,
    close() {
      if (closed) return;
      closed = true;
      ready.then(() => server?.close(), () => {});
      for (const c of queue.splice(0)) {
        try {
          c.close();
        } catch { /* aio-ok: already closed */ }
      }
    },
    async *[Symbol.asyncIterator]() {
      await ready; // a bind failure throws HERE, like the PipeConn path
      while (!closed) {
        if (failure !== null) throw failure;
        const c = queue.shift();
        if (c !== undefined) {
          yield c;
          continue;
        }
        await new Promise<void>((r) => {
          wake = r;
        });
      }
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

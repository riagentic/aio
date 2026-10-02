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
 * `win-pipe.ts` is loaded ONLY on windows here (dynamic import) so Linux/macOS
 * never touch FFI. (`app-key.ts` imports its secret-file writer statically;
 * the libraries are opened only when a function is CALLED, on Windows.) A path that cannot be bound or opened is THROWN — on unix at the
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
  /** The same bytes WITHOUT the stream pair, where the backend can: read up
   *  to `into.length` bytes into `into` (the count, or `null` at the end of
   *  input), and write all of `bytes`. A server that answers thousands of
   *  small requests pays for a `ReadableStream` read with a fresh 64 KB
   *  buffer and a queue per chunk; these cost one buffer per connection. A
   *  connection is read and written through these OR through its streams,
   *  never both. Absent on a backend that has only streams (the Windows
   *  pipe) — the caller then uses those. */
  read?(into: Uint8Array): Promise<number | null>;
  write?(bytes: Uint8Array): Promise<void>;
  /** Finish the conversation before the connection is torn down: everything
   *  already written reaches the peer, and nothing the peer is still sending
   *  is left unread. Windows: a server pipe torn down with unread bytes in
   *  its buffer can DISCARD them (real Windows 11, 2026-09-17 — Electron's
   *  first page request answered `read EPIPE`). Unix: a socket closed with
   *  unread INPUT resets the peer, whose next write fails `EPIPE` before it
   *  has read the answer — so the write side is half-closed and the input
   *  discarded until the peer closes ({@linkcode LINGER_MS} at most). The
   *  caller has released `readable` and `writable`. */
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

/** How long a finished unix connection waits for its peer to stop sending
 *  and close. A peer that takes longer is cut off, as before. */
export const LINGER_MS = 2000;

/** Where input that is only read to be thrown away lands — one buffer for
 *  every connection. A read through `conn.readable` allocates 64 KB each
 *  time, which a server that lingers on every connection pays per request. */
const DISCARD = new Uint8Array(64 * 1024);

/** The unix `drain`: half-close the write side (the peer reads the answer to
 *  its end), then `discard` input until the peer closes or `LINGER_MS` pass. */
async function lingerUnix(
  halfClose: () => void | Promise<void>,
  discard: () => Promise<void>,
): Promise<void> {
  try {
    await halfClose();
  } catch {
    return; // aio-ok: already closed or failed — there is no peer to wait for
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<void>((r) => timer = setTimeout(r, LINGER_MS));
  const peerClosed = discard().catch(() => {
    // aio-ok: a read that fails is a connection that ended — what is awaited
  });
  await Promise.race([peerClosed, gaveUp]);
  clearTimeout(timer);
}

/** Wrap a `Deno.Conn` 1:1 — the unix branch is a pure re-labelling. The
 *  streams are the connection's own and, like them, built when first asked
 *  for. */
function wrapUnixConn(conn: Deno.Conn): LocalConn {
  let closed = false;
  return {
    get readable() {
      return conn.readable;
    },
    get writable() {
      return conn.writable;
    },
    read: (into) => conn.read(into),
    async write(bytes) {
      for (let off = 0; off < bytes.length;) {
        off += await conn.write(bytes.subarray(off));
      }
    },
    remoteAddr: conn.remoteAddr,
    drain: () =>
      lingerUnix(() => conn.closeWrite(), async () => {
        while ((await conn.read(DISCARD)) !== null) { /* discard */ }
      }),
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

/** `ioctl` request: set close-on-exec on a descriptor (`<sys/ioctl.h>`). */
const FIOCLEX = Deno.build.os === "darwin" ? 0x20006601n : 0x5451n;

/** Mark `fd` close-on-exec, so no process this one spawns inherits it.
 *
 *  `Deno.listen` does this itself. A `node:net` server's LISTENING socket is
 *  created without the flag (Deno 2.9), and every child — the app's own
 *  window first — held the app's bound sockets open: after the server died
 *  the window still had them, a connect was accepted by nobody instead of
 *  refused, and "is an instance running" answered yes.
 *
 *  The library is opened and closed here: this runs once per listener, and a
 *  handle kept open would be one more resource for every caller to account
 *  for. The request takes no third argument, so the two-parameter call is the
 *  C call. Throws when it cannot be done — a listener that leaks is not
 *  handed out. */
function closeOnExec(fd: number): void {
  const lib = Deno.dlopen(
    Deno.build.os === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
    { ioctl: { parameters: ["i32", "u64"], result: "i32" } },
  );
  try {
    if (lib.symbols.ioctl(fd, FIOCLEX) !== 0) {
      throw new Error(`ioctl(FIOCLEX) failed on fd ${fd}`);
    }
  } finally {
    lib.close();
  }
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
      // The fd — and the identity behind it — is read ONCE, here, at accept:
      // `_handle` is a node internal, a socket already destroyed by the time a
      // gate asks would have none, and an fd number read later may by then
      // name a DIFFERENT connection (the kernel reuses them).
      const fd = (sock as unknown as { _handle?: { fd?: number } })._handle
        ?.fd;
      const identity = typeof fd === "number"
        ? unixPeerIdentity(fd)
        : UNKNOWN_PEER;
      let done = false;
      // A socket error with no listener is thrown at the process. It is not
      // lost here: the read then ends and the write's callback is told.
      sock.on("error", () => {});
      let readable: ReadableStream<Uint8Array> | undefined;
      let writable: WritableStream<Uint8Array> | undefined;
      // The socket's own paused-mode read: what it has buffered, or a wait
      // for `readable`. What does not fit `into` goes back to the socket.
      const read = async (into: Uint8Array): Promise<number | null> => {
        while (true) {
          const chunk = sock.read() as Uint8Array | null;
          if (chunk !== null) {
            const n = Math.min(chunk.length, into.length);
            into.set(chunk.subarray(0, n));
            if (n < chunk.length) sock.unshift(chunk.subarray(n));
            return n;
          }
          if (sock.readableEnded || sock.destroyed) return null;
          await new Promise<void>((resolve) => {
            const wake = () => {
              sock.off("readable", wake);
              sock.off("end", wake);
              sock.off("close", wake);
              resolve();
            };
            sock.on("readable", wake);
            sock.on("end", wake);
            sock.on("close", wake);
          });
        }
      };
      return {
        get readable() {
          return readable ??= Readable.toWeb(sock) as ReadableStream<
            Uint8Array
          >;
        },
        get writable() {
          return writable ??= Writable.toWeb(sock) as WritableStream<
            Uint8Array
          >;
        },
        read,
        write: (bytes) =>
          new Promise<void>((resolve, reject) => {
            // The callback runs once the bytes are handed to the kernel —
            // awaiting it is the backpressure.
            sock.write(bytes, (e) => e ? reject(e) : resolve());
          }),
        remoteAddr: { transport: "unix", path },
        peerIdentity: () => identity,
        drain: () =>
          lingerUnix(() => {
            if (!sock.destroyed) sock.end();
          }, async () => {
            while ((await read(DISCARD)) !== null) { /* discard */ }
          }),
        close() {
          if (done) return;
          done = true;
          const destroy = () => {
            try {
              sock.destroy();
            } catch {
              /* aio-ok: already destroyed — the close is idempotent */
            }
          };
          // A handle closed while its SHUTDOWN is in flight is never let go
          // of by the runtime (Deno 2.9: the socket, and everything hanging
          // off it, stays for the life of the process — 1.5 to 8 KB of heap
          // per connection the client ended). The shutdown is in flight once
          // the write side was ended and has nothing left to send; it
          // completes within a turn, and the handle is closed then. With
          // bytes still unsent (a peer that stopped reading) no shutdown has
          // begun, and the connection is cut at once.
          if (
            sock.writableEnded && !sock.writableFinished &&
            sock.writableLength === 0 && !sock.destroyed
          ) {
            sock.once("finish", destroy);
            sock.once("error", destroy);
          } else destroy();
        },
      };
    };
    // `allowHalfOpen`: the end of a client's input does not end this side —
    // a client that half-closed behind its request is still answered, and
    // the write side is ended by `drain`, never by a read.
    const srv = net.createServer({ allowHalfOpen: true }, (sock) => {
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
      const fail = (why: string) => {
        srv.off("error", reject);
        srv.close();
        reject(
          new Error(
            `the listener on ${path} could not be kept from child ` +
              `processes — ${why}`,
          ),
        );
      };
      /** Mark the listening socket close-on-exec; false when the server has
       *  no descriptor (yet) to mark. */
      const guard = (): boolean => {
        const fd = (srv as unknown as { _handle?: { fd?: unknown } })._handle
          ?.fd;
        if (typeof fd !== "number") return false;
        try {
          closeOnExec(fd);
        } catch (e) {
          fail((e as Error).message);
        }
        return true;
      };
      let guarded = false;
      srv.listen(path, () => {
        srv.off("error", reject);
        // Bound, and still nothing to mark: `_handle.fd` is the runtime's
        // internal, and a runtime that moved it would bring the inherited
        // listener back unsaid. Then the listener is not handed out.
        if (!guarded && !guard()) {
          return fail("the runtime gives no descriptor for it");
        }
        resolve();
      });
      // In the same turn as the bind — nothing can be spawned in between.
      guarded = guard();
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
      // Wake the accept loop: parked on an empty queue it would otherwise
      // wait for a connection that can no longer arrive, and whoever awaits
      // the loop's end (`serveHttpOverLocal().close()`) would wait with it.
      if (wake) {
        const w = wake;
        wake = null;
        w();
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

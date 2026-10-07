// A local endpoint a test can listen on and connect to, on every OS.
//
// A test that writes `join(tmp, "x.sock")` and opens it with
// `Deno.connect({ transport: "unix" })` names a Unix socket, which Windows
// does not have ("op_net_connect_unix not supported on non-unix platforms").
// The product's own local transport (`src/server/local-listen.ts`) is a named
// pipe there, so the test asks for its endpoint HERE and opens it with
// `connectLocal` / `listenLocal` — the same code the product runs.
import {
  connectLocal,
  listenLocal,
  type LocalConn,
  type LocalListener,
  PIPE_PREFIX,
} from "../src/server/local-listen.ts";

/** The endpoint for `socketPath` on this OS: the path itself on unix; on
 *  Windows the pipe named after it (a pipe name is not a file path, so the
 *  separators go — a path in a fresh temp dir stays a unique name). Pure. */
export function localEndpoint(socketPath: string): string {
  if (Deno.build.os !== "windows") return socketPath;
  return `${PIPE_PREFIX}aio-test-${socketPath.replace(/[\\/:]+/g, "-")}`;
}

/** A `LocalConn` whose `read`/`write` are there on every OS. */
export type RWConn = LocalConn & Required<Pick<LocalConn, "read" | "write">>;

/** `connectLocal`, for a test that drives the connection with `read(buf)` /
 *  `write(bytes)` the way it drove a `Deno.Conn`. Unix has both natively; the
 *  Windows pipe has only its streams, so there they are put over those (one
 *  reader, one writer, taken on first use — such a test does not also take
 *  `readable`/`writable`). */
export async function connectRW(path: string): Promise<RWConn> {
  const c = await connectLocal(path);
  if (c.read && c.write) return c as RWConn;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let rest: Uint8Array = new Uint8Array(0);
  return {
    get readable() {
      return c.readable;
    },
    get writable() {
      return c.writable;
    },
    remoteAddr: c.remoteAddr,
    close: () => c.close(),
    async read(into) {
      if (rest.length === 0) {
        const { value, done } = await (reader ??= c.readable.getReader())
          .read();
        if (done) return null;
        rest = value;
      }
      const n = Math.min(rest.length, into.length);
      into.set(rest.subarray(0, n));
      rest = rest.subarray(n);
      return n;
    },
    write: (bytes) => (writer ??= c.writable.getWriter()).write(bytes),
  };
}

/** Wait until the local transport has nothing in flight. Called last in a
 *  test, after every connection and listener it opened is closed: a Windows
 *  pipe's `close()` returns before its cancelled read has completed, and
 *  `--sanitize-ops` fails the test (or the NEXT one) for the completion that
 *  arrives late. A unix socket's close is synchronous — nothing to wait for. */
export async function localIdle(): Promise<void> {
  if (Deno.build.os !== "windows") return;
  await (await import("../src/server/win-pipe.ts")).pipeIoIdle();
}

/** `listenLocal`, BOUND when this resolves. A unix listener is bound when
 *  `listenLocal` returns; the Windows pipe's backend is a dynamic import, so
 *  there the name exists a few turns later — soon enough for the product,
 *  whose clients retry, and too late for a test client that connects once
 *  (`node:http`: "connect ENOENT"). */
export async function listenBound(path: string): Promise<LocalListener> {
  if (Deno.build.os !== "windows") return listenLocal(path);
  return (await import("../src/server/win-pipe.ts")).listenPipe(path);
}

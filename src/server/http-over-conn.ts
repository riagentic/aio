/**
 * @module
 * A minimal HTTP/1.1 server over a `LocalListener` — the page/route handler
 * on a local socket where `Deno.serve({ path })` does not exist (Windows named
 * pipes).
 *
 * One request per connection (`Connection: close`): the Electron shell's
 * `http.request({ socketPath })` and `am` both open a connection per request,
 * so keep-alive would buy nothing and cost a parser state machine. What DOES
 * matter is streaming: a route body is written to the socket chunk by chunk
 * as the handler's `ReadableStream` produces it — a 100 MB response is never
 * held in memory — and a request body arrives the same way.
 *
 * Unix keeps `Deno.serve({ path })`; this module is exercised on unix by the
 * test suite over a unix `LocalListener`, so the parity that lets a Wine run
 * prove the Windows half is a Linux test, not a belief.
 *
 * Errors: a malformed request is answered 400 and the connection closed; a
 * handler that throws is answered 500 (and logged) — never a hung socket.
 */

import type { LocalConn, LocalListener } from "./local-listen.ts";
import { log } from "../diagnostics/logger-api.ts";

/** Header block ceiling — a peer that never sends the blank line cannot grow
 *  the buffer without bound. Matches the common server default. */
export const MAX_HEADER_BYTES = 64 * 1024;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The handler's info is `Deno.ServeHandlerInfo`-shaped (`remoteAddr` plus a
 *  `completed` that settles when the response has been written), so the very
 *  same `handleRequest` serves both `Deno.serve` and this. */
export type HttpOverLocalHandler = (
  req: Request,
  info: { remoteAddr: Deno.Addr; completed: Promise<void> },
) => Response | Promise<Response>;

/** A parsed request head. Pure — unit-tested on its own. */
export interface RequestHead {
  method: string;
  target: string;
  version: string;
  headers: Headers;
}

/** Parse the request line + header lines (everything before the blank line).
 *  Throws on anything that is not HTTP/1.x — the caller turns that into 400. */
export function parseRequestHead(text: string): RequestHead {
  const lines = text.split("\r\n");
  const first = lines.shift() ?? "";
  const m = /^([A-Z]+) (\S+) HTTP\/(1\.[01])$/.exec(first);
  if (!m) throw new Error(`malformed request line: ${JSON.stringify(first)}`);
  const headers = new Headers();
  for (const line of lines) {
    if (line === "") continue;
    const i = line.indexOf(":");
    if (i <= 0) {
      throw new Error(`malformed header line: ${JSON.stringify(line)}`);
    }
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      throw new Error(`malformed header name: ${JSON.stringify(name)}`);
    }
    headers.append(name, value);
  }
  return { method: m[1]!, target: m[2]!, version: m[3]!, headers };
}

/** Encode one chunk in `Transfer-Encoding: chunked` framing. Pure. */
export function chunkFrame(chunk: Uint8Array): Uint8Array {
  const head = enc.encode(chunk.length.toString(16) + "\r\n");
  const out = new Uint8Array(head.length + chunk.length + 2);
  out.set(head, 0);
  out.set(chunk, head.length);
  out.set([13, 10], head.length + chunk.length);
  return out;
}

export const CHUNKED_END = enc.encode("0\r\n\r\n");

/** Statuses that carry no body by definition (RFC 9110 §6.4.1). */
export function statusHasNoBody(status: number): boolean {
  return status === 204 || status === 304 || (status >= 100 && status < 200);
}

/** The response head bytes: status line + headers + blank line. `headers` is
 *  written as given; the framing headers are decided by the caller. Pure. */
export function responseHeadBytes(
  status: number,
  statusText: string,
  headers: Headers,
): Uint8Array {
  let out = `HTTP/1.1 ${status} ${statusText || reasonPhrase(status)}\r\n`;
  for (const [k, v] of headers) out += `${k}: ${v}\r\n`;
  return enc.encode(out + "\r\n");
}

function reasonPhrase(status: number): string {
  return REASONS[status] ?? "";
}
const REASONS: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  413: "Content Too Large",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

// ── Byte source: a buffered reader over the connection ────────────────────

class ByteSource {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buf: Uint8Array = new Uint8Array(0);
  #eof = false;
  constructor(readable: ReadableStream<Uint8Array>) {
    this.#reader = readable.getReader();
  }
  get buffered(): number {
    return this.#buf.length;
  }
  /** Pull one more chunk into the buffer; false at EOF. */
  async fill(): Promise<boolean> {
    if (this.#eof) return false;
    const { value, done } = await this.#reader.read();
    if (done || !value) {
      this.#eof = true;
      return false;
    }
    if (this.#buf.length === 0) this.#buf = value;
    else {
      const next = new Uint8Array(this.#buf.length + value.length);
      next.set(this.#buf, 0);
      next.set(value, this.#buf.length);
      this.#buf = next;
    }
    return true;
  }
  /** Take up to `n` buffered bytes (the caller `fill`s first). */
  take(n: number): Uint8Array {
    const out = this.#buf.subarray(0, n);
    this.#buf = this.#buf.subarray(n);
    return out;
  }
  /** Read exactly `n` bytes, or null at a premature EOF. */
  async exactly(n: number): Promise<Uint8Array | null> {
    while (this.#buf.length < n) if (!(await this.fill())) return null;
    return this.take(n).slice();
  }
  /** Read a CRLF-terminated line (without the CRLF), or null at EOF. */
  async line(limit = MAX_HEADER_BYTES): Promise<string | null> {
    while (true) {
      const i = indexOfCRLF(this.#buf);
      if (i !== -1) {
        const s = dec.decode(this.#buf.subarray(0, i));
        this.take(i + 2);
        return s;
      }
      if (this.#buf.length > limit) throw new Error("line exceeds limit");
      if (!(await this.fill())) return null;
    }
  }
  /** Read the request head (everything before the blank line). `null` when
   *  the peer closed before sending any byte — a probe connect
   *  (`isSocketAlive` does exactly this) is not an error. Throws on an
   *  incomplete or oversized head. */
  async head(): Promise<string | null> {
    while (true) {
      const i = indexOfHeadEnd(this.#buf);
      if (i !== -1) {
        const s = dec.decode(this.#buf.subarray(0, i));
        this.take(i + 4);
        return s;
      }
      if (this.#buf.length > MAX_HEADER_BYTES) {
        throw new Error("request head exceeds limit");
      }
      if (!(await this.fill())) {
        if (this.#buf.length === 0) return null;
        throw new Error("incomplete request head");
      }
    }
  }
  release(): void {
    try {
      this.#reader.releaseLock();
    } catch { /* already released */ }
  }
}

function indexOfCRLF(buf: Uint8Array): number {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}

function indexOfHeadEnd(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (
      buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 &&
      buf[i + 3] === 10
    ) return i;
  }
  return -1;
}

// ── Request body streams ──────────────────────────────────────────────────

function contentLengthBody(
  src: ByteSource,
  length: number,
): ReadableStream<Uint8Array> {
  let remaining = length;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (remaining === 0) return ctrl.close();
      if (src.buffered === 0 && !(await src.fill())) {
        return ctrl.error(new Error("request body ended early"));
      }
      const chunk = src.take(Math.min(remaining, src.buffered)).slice();
      remaining -= chunk.length;
      ctrl.enqueue(chunk);
      if (remaining === 0) ctrl.close();
    },
  });
}

function chunkedBody(src: ByteSource): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const sizeLine = await src.line();
      if (sizeLine === null) {
        return ctrl.error(new Error("chunked body ended early"));
      }
      const size = parseInt((sizeLine.split(";")[0] ?? "").trim(), 16);
      if (!Number.isFinite(size) || size < 0) {
        return ctrl.error(new Error(`malformed chunk size ${sizeLine}`));
      }
      if (size === 0) {
        // Trailers (if any) up to the blank line.
        while (true) {
          const t = await src.line();
          if (t === null || t === "") break;
        }
        return ctrl.close();
      }
      const data = await src.exactly(size + 2);
      if (data === null) return ctrl.error(new Error("chunk ended early"));
      ctrl.enqueue(data.subarray(0, size));
    },
  });
}

// ── One connection ────────────────────────────────────────────────────────

async function serveConn(
  conn: LocalConn,
  handler: HttpOverLocalHandler,
  listenerPath: string,
): Promise<void> {
  const src = new ByteSource(conn.readable);
  const writer = conn.writable.getWriter();
  let bodyStream: ReadableStream<Uint8Array> | null = null;
  let done!: () => void;
  const completed = new Promise<void>((r) => done = r);
  try {
    let head: RequestHead;
    try {
      const text = await src.head();
      if (text === null) return; // peer closed without a request
      head = parseRequestHead(text);
    } catch (e) {
      await writeSimple(writer, 400, `bad request: ${(e as Error).message}\n`);
      return;
    }
    const te = head.headers.get("transfer-encoding");
    const cl = head.headers.get("content-length");
    if (te && te.toLowerCase() !== "chunked") {
      await writeSimple(writer, 400, `unsupported transfer-encoding ${te}\n`);
      return;
    }
    if (te) bodyStream = chunkedBody(src);
    else if (cl !== null) {
      const n = Number(cl);
      if (!Number.isInteger(n) || n < 0) {
        await writeSimple(writer, 400, `malformed content-length ${cl}\n`);
        return;
      }
      bodyStream = n === 0 ? null : contentLengthBody(src, n);
    }
    const method = head.method;
    if ((method === "GET" || method === "HEAD") && bodyStream) {
      // Fetch's Request refuses a body on GET/HEAD; drain it instead.
      await bodyStream.pipeTo(new WritableStream()).catch(() => {});
      bodyStream = null;
    }
    // The URL the handler sees: `http://app<target>` — what the Electron
    // shell's `aio://app/...` becomes on unix too.
    const url = /^[a-z]+:\/\//i.test(head.target)
      ? head.target
      : `http://app${head.target.startsWith("/") ? "" : "/"}${head.target}`;
    const req = new Request(url, {
      method,
      headers: head.headers,
      body: bodyStream,
      // Required by the spec for a stream body (half-duplex request).
      ...({ duplex: "half" } as Record<string, unknown>),
    });
    let res: Response;
    try {
      res = await handler(req, { remoteAddr: conn.remoteAddr, completed });
    } catch (e) {
      log.error(
        "http",
        `handler threw for ${method} ${head.target} over ${listenerPath} — ${e}`,
      );
      await writeSimple(writer, 500, "internal error\n");
      return;
    }
    await writeResponse(writer, res, method === "HEAD");
  } catch (e) {
    // A write to a peer that went away mid-response is not a server fault.
    log.debug(`http-over-local: connection ended — ${e}`);
  } finally {
    try {
      writer.releaseLock();
    } catch { /* fine */ }
    src.release();
    conn.close();
    done();
  }
}

async function writeSimple(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  status: number,
  text: string,
): Promise<void> {
  const body = enc.encode(text);
  const h = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(body.length),
    connection: "close",
  });
  await writer.write(responseHeadBytes(status, "", h));
  await writer.write(body);
}

/** Write a `Response` to the wire: Content-Length when known, else chunked;
 *  the body streamed chunk by chunk, never buffered. */
async function writeResponse(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  res: Response,
  isHead: boolean,
): Promise<void> {
  const headers = new Headers(res.headers);
  headers.set("connection", "close");
  const noBody = isHead || statusHasNoBody(res.status) || res.body === null;
  const declared = headers.get("content-length");
  let chunked = false;
  if (noBody) {
    headers.delete("transfer-encoding");
    if (!isHead && !statusHasNoBody(res.status) && declared === null) {
      headers.set("content-length", "0");
    }
  } else if (declared === null) {
    chunked = true;
    headers.set("transfer-encoding", "chunked");
  } else {
    headers.delete("transfer-encoding");
  }
  await writer.write(responseHeadBytes(res.status, res.statusText, headers));
  if (noBody) {
    await res.body?.cancel().catch(() => {});
    return;
  }
  const reader = res.body!.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.length === 0) continue; // a zero chunk would END a chunked body
      await writer.write(chunked ? chunkFrame(value) : value);
    }
    if (chunked) await writer.write(CHUNKED_END);
  } finally {
    reader.releaseLock();
  }
}

// ── The server ────────────────────────────────────────────────────────────

/** Serve `handler` over every connection `listener` accepts. `close()` stops
 *  accepting, closes open connections, and resolves once the loop is done. */
export function serveHttpOverLocal(
  listener: LocalListener,
  handler: HttpOverLocalHandler,
): { close(): Promise<void>; finished: Promise<void> } {
  const open = new Set<LocalConn>();
  let closed = false;
  const finished = (async () => {
    for await (const conn of listener) {
      if (closed) {
        conn.close();
        break;
      }
      open.add(conn);
      serveConn(conn, handler, listener.path)
        .catch((e) => log.error("http", `connection failed — ${e}`))
        .finally(() => open.delete(conn));
    }
  })().catch((e) => {
    if (!closed) throw e;
  });
  return {
    finished,
    async close() {
      if (closed) return;
      closed = true;
      listener.close();
      for (const c of open) c.close();
      await finished.catch(() => {});
    },
  };
}

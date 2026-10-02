/**
 * @module
 * A minimal HTTP/1.1 server over a `LocalListener` — the page/route handler
 * on a local socket: a Windows named pipe (where `Deno.serve({ path })` does
 * not exist) and a Unix socket (where `Deno.serve` hands the handler no
 * connection to ask "who is this", which the local-peer lockdown must).
 *
 * `Deno.serve` is the REFERENCE. Whatever a route could observe through it —
 * `req.url`, header bytes, `req.signal`, a body it reads late or never, what
 * a throw or a non-Response becomes — is the same here, and
 * `tests/http-over-conn-differential.test.ts` runs one handler under both
 * servers and compares the answers. The differences that remain are
 * deliberate, and each is a named row of that test:
 *
 *   - a connection serves request after request, as under `Deno.serve`,
 *     with two exceptions: one with request body bytes still on it when the
 *     answer is written is closed after the answer where `Deno.serve` reads
 *     them away and keeps it (an unread chunked body, a cancelled one, a
 *     body on GET/HEAD), and an HTTP/1.0 client is never kept, even one that
 *     asks to be (`Connection: keep-alive`);
 *   - no WebSocket upgrade (501): the window speaks NDJSON on the app's own
 *     socket, never WebSocket on this one. Any other `Upgrade` offer is
 *     ignored and the request served, as `Deno.serve` does. HTTP/1.1 only:
 *     the HTTP/2 preface is a 400 (`Deno.serve` speaks HTTP/2 to it);
 *   - refused where `Deno.serve` serves: `CONNECT`/`TRACE`/`TRACK` (501 — a
 *     `Request` cannot carry them), a method with a lowercase letter (a
 *     `Request` would rename `get` to `GET`), a repeated `Content-Length`,
 *     one — or a chunk size — above 2^53 − 1, a `Host` or an absolute target
 *     no URL can be made of, and a line of the head ended by LF alone (400,
 *     as soon as it is seen);
 *   - answered where `Deno.serve` says nothing: a malformed chunked body
 *     (400; it closes the connection), and a head that has begun and does
 *     not complete within {@linkcode HEAD_DEADLINE_MS} (408). Every refusal
 *     says why in its body;
 *   - `req.url` is the URL a `Request` parses the target into (dot segments
 *     resolved, what a URL escapes escaped), not the raw target;
 *   - header names are written lowercase: the handler's as a `Headers`
 *     iterates them (sorted), then this server's own — not in the handler's
 *     spelling and order;
 *   - the status line is always HTTP/1.1, and a body that is ONE chunk,
 *     complete when the handler returns it (a one-part `Blob`, a stream
 *     filled and closed at once) is sent with its `Content-Length` — its
 *     real length, whatever the handler declared — where `Deno.serve` sends
 *     it chunked;
 *   - an upload the handler does not read is NOT read into memory: it is
 *     read ahead a bounded amount and otherwise left with the sender, so a
 *     client that leaves behind more unread upload than that is noticed at
 *     the response's next write rather than at once;
 *   - a client that half-closed and is answered with a stream gets the
 *     response head before the close (`Deno.serve` writes nothing);
 *   - `close()` waits for the requests being answered only for
 *     {@linkcode CLOSE_DRAIN_MS}; `Deno.serve`'s shutdown waits for a stream
 *     that never ends for as long as its caller lets it — and fails the read
 *     of an upload still arriving, which here is let finish inside the bound.
 *     Neither starts a request once the closing has begun.
 *
 * What is NOT on that list is refused as `Deno.serve` refuses it — being the
 * more permissive of the two about framing is the unsafe direction.
 *
 * Bodies STREAM both ways: a route body is written to the socket chunk by
 * chunk as the handler's `ReadableStream` produces it, and a request body is
 * handed to the handler as it arrives, whatever its chunk sizes — neither is
 * ever held whole in memory.
 *
 * Errors: a malformed request is answered 400 as soon as it is known to be
 * one, and the connection closed; a head that never completes, 408; a
 * handler that throws, 500 (and logged) — never a hung socket. Only a client
 * that ended its side in the middle of a head is written nothing: it asked
 * nothing.
 */

import type { LocalConn, LocalListener } from "./local-listen.ts";
import { log } from "../diagnostics/logger-api.ts";

/** Header block ceiling — a peer that never sends the blank line cannot grow
 *  the buffer without bound. Matches the common server default. */
export const MAX_HEADER_BYTES = 64 * 1024;

/** How long a request head may take: a connection's FIRST from the connect
 *  (the Electron main writes it with the connect, so this only ever ends a
 *  connection that was never going to ask anything), a later one from its
 *  first byte. Between requests a kept connection may idle, as under
 *  `Deno.serve`. */
export const HEAD_DEADLINE_MS = 30_000;

/** How long a peer the gate REFUSED is waited on for a request head before it
 *  is told so — long enough that its 403 lands after its request rather than
 *  on top of it, short enough that holding connections open costs it more
 *  than it costs this process. */
export const REFUSED_HEAD_MS = 2_000;

/** How far ahead of the handler the connection is read. Reading ahead is what
 *  notices a client that left (EOF) while the handler is still working or its
 *  response stream is idle; the bound is what keeps an unread upload in the
 *  kernel's buffer, on the sender's side, instead of in this process. */
const READ_AHEAD_BYTES = 256 * 1024;

/** How long `close()` waits for the requests already being answered.
 *  `Deno.serve`'s shutdown finishes them, so this does — but the server is
 *  closed late in an app's teardown, out of the one budget the databases
 *  closed after it share (`TEARDOWN_TIMEOUT_MS`, 5 s): a response stream that
 *  never ends may take 2 s of it, never all of it. */
export const CLOSE_DRAIN_MS = 2_000;

/** How many microtask turns a body read may take and still count as "already
 *  there". A body the Response was built with (a string, bytes, JSON) is read
 *  in two; a stream that waits for anything outside this turn of the event
 *  loop takes none of them. */
const PEEK_TURNS = 16;

const enc = new TextEncoder();
const utf8 = new TextDecoder();

/** Header bytes are latin1 on the wire (RFC 9110 §5.5), one byte per code
 *  unit — never UTF-8, which would refuse a request header byte ≥ 0x80 and
 *  write a response header's `é` as two. (`TextDecoder("latin1")` is
 *  windows-1252, which is not this.) */
function latin1Decode(bytes: Uint8Array): string {
  // All ASCII — nearly every head — is the same text in UTF-8, and the native
  // decoder reads it thirty times faster than a code unit at a time.
  let ascii = true;
  for (let i = 0; i < bytes.length && ascii; i++) ascii = bytes[i]! < 0x80;
  if (ascii) return utf8.decode(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + 8192) as unknown as number[],
    );
  }
  return s;
}

/** The inverse. `Headers` and a `Response`'s status text only hold byte
 *  strings, so every code unit here is already ≤ 0xFF. */
function latin1Encode(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The handler's info is `Deno.ServeHandlerInfo`-shaped (`remoteAddr` plus a
 *  `completed` that settles when the response has been written), so the very
 *  same `handleRequest` serves both `Deno.serve` and this. */
export type HttpOverLocalHandler = (
  req: Request,
  info: { remoteAddr: Deno.Addr; completed: Promise<void> },
) => Response | Promise<Response>;

/** A request's header lines, in the order sent, names lowercased. Answers
 *  `get` as a `Headers` would (a repeated name's values joined by `", "`)
 *  without being one: the `Request` builds its `Headers` from `pairs`, and a
 *  second one here — validated and sorted again per request — was a third of
 *  this server's time. */
export class HeaderLines {
  constructor(readonly pairs: [string, string][]) {}
  /** `name` in lowercase. */
  get(name: string): string | null {
    let out: string | null = null;
    for (const [k, v] of this.pairs) {
      if (k === name) out = out === null ? v : `${out}, ${v}`;
    }
    return out;
  }
}

/** A parsed request head. Pure — unit-tested on its own. */
export interface RequestHead {
  method: string;
  target: string;
  version: string;
  headers: HeaderLines;
}

// ── Wire text ─────────────────────────────────────────────────────────────
//
// A head is decoded one byte per code unit, so a JS string here is BYTES, and
// JS's own notion of whitespace is wrong for it: `trim()` and `\s` also take
// 0xA0 (the last byte of a UTF-8 `à`), VT, FF. Whitespace on the wire is SP
// and HTAB (RFC 9110 §5.6.3), and every edge is cut through `trimOws`.

/** `s` without the SP / HTAB at its edges — and nothing else. Pure. */
export function trimOws(s: string): string {
  let a = 0, b = s.length;
  while (a < b && (s[a] === " " || s[a] === "\t")) a++;
  while (b > a && (s[b - 1] === " " || s[b - 1] === "\t")) b--;
  return s.slice(a, b);
}

/** The members of a comma-separated header value, lowercased. Pure. */
function listTokens(value: string | null): string[] {
  return value === null
    ? []
    : value.split(",").map((t) => trimOws(t).toLowerCase());
}

/** How many header lines a request may carry — `Deno.serve`'s own limit. */
const MAX_HEADER_LINES = 128;

/** One header (or trailer) line as `[name, value]`, the name lowercased.
 *  Refused, as `Deno.serve` refuses them: whitespace before the name (an
 *  obs-fold line would otherwise become a header of its own) or between the
 *  name and the colon, a name that is not a token, a control byte in the
 *  value. A front end and this server must never read two different sets of
 *  framing headers out of the same bytes. */
function headerLine(line: string): [string, string] {
  const i = line.indexOf(":");
  const name = line.slice(0, i);
  if (i <= 0 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new Error(`malformed header line: ${JSON.stringify(line)}`);
  }
  const value = trimOws(line.slice(i + 1));
  if (!/^[\t\x20-\x7e\x80-\xff]*$/.test(value)) {
    throw new Error(`control character in header ${name}`);
  }
  return [name.toLowerCase(), value];
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Is `target` in the form its method may use (RFC 9112 §3.2)? Origin-form
 *  (`/…`) or absolute-form (`scheme://…`) for every method but `CONNECT`,
 *  which takes the authority-form and nothing else; `*` for `OPTIONS` alone.
 *  As `Deno.serve` holds them to it: a target in no form is a 400 there, not
 *  a path with a `/` put in front of it. Pure. */
export function targetFormOk(method: string, target: string): boolean {
  const origin = target.startsWith("/");
  const absolute = /^[A-Za-z][A-Za-z0-9+.\-]*:\/\/./.test(target);
  if (method === "CONNECT") return !origin && !absolute && target !== "*";
  return origin || absolute || (target === "*" && method === "OPTIONS");
}

/** Parse the request line + header lines (everything before the blank line).
 *  Throws on anything that is not HTTP/1.x — the caller turns that into 400. */
export function parseRequestHead(text: string): RequestHead {
  const lines = text.split("\r\n");
  const first = lines.shift() ?? "";
  // A method is any token (RFC 9110 §5.6.2 — `M-SEARCH` is one) without a
  // lowercase letter; a target is visible ASCII or UTF-8, never a control
  // byte or a space.
  const m =
    /^([!#$%&'*+\-.^_`|~0-9A-Z]+) ([\x21-\x7e\x80-\xff]+) HTTP\/(1\.[01])$/
      .exec(first);
  if (!m || !targetFormOk(m[1]!, m[2]!)) {
    throw new Error(`malformed request line: ${JSON.stringify(first)}`);
  }
  if (/[\x80-\xff]/.test(m[2]!)) {
    try {
      strictUtf8.decode(latin1Encode(m[2]!));
    } catch {
      throw new Error("the request target is not UTF-8");
    }
  }
  const pairs: [string, string][] = [];
  for (const line of lines) {
    if (line === "") continue;
    pairs.push(headerLine(line));
  }
  if (pairs.length > MAX_HEADER_LINES) {
    throw new Error(`more than ${MAX_HEADER_LINES} header lines`);
  }
  return {
    method: m[1]!,
    target: m[2]!,
    version: m[3]!,
    headers: new HeaderLines(pairs),
  };
}

/** How the request body is framed: `null` (none), a byte count, or
 *  `"chunked"`. Throws on a framing a strict server refuses — the caller
 *  answers 400. Pure.
 *
 *  `Number()` and `parseInt` read `+3`, `0x3`, `3.0` and an empty value as
 *  lengths; two parsers that disagree about where a body ends is how a
 *  request is smuggled past one of them, so only decimal digits are a
 *  length, and a request that names both framings is refused. */
export function bodyFraming(
  headers: { get(name: string): string | null },
  version = "1.1",
): number | "chunked" | null {
  const te = headers.get("transfer-encoding");
  const cl = headers.get("content-length");
  if (te !== null && cl !== null) {
    throw new Error("both transfer-encoding and content-length");
  }
  if (te !== null) {
    // The LAST coding frames the message, and is `chunked` once; the ones
    // before it are the handler's to undo, and none of them is empty or
    // `identity`. HTTP/1.0 has no chunking. All as `Deno.serve` reads it.
    const codings = listTokens(te);
    if (
      version !== "1.1" || codings.at(-1) !== "chunked" ||
      codings.indexOf("chunked") !== codings.length - 1 ||
      codings.includes("") || codings.includes("identity")
    ) {
      throw new Error(`unsupported transfer-encoding ${te}`);
    }
    return "chunked";
  }
  if (cl === null) return null;
  // Digits only, and a count this runtime can hold exactly.
  const length = /^\d+$/.test(cl) ? Number(cl) : NaN;
  if (!Number.isSafeInteger(length)) {
    throw new Error(`malformed content-length ${cl}`);
  }
  return length;
}

/** A chunk-size line's byte count, or a throw: hex digits only (`parseInt`
 *  would read `0x3` and `3zz`), spaces around them, an optional `;extension`
 *  of visible bytes ignored — the line `Deno.serve` accepts. Pure. */
export function chunkSize(line: string): number {
  const m = /^ *([0-9a-fA-F]+) *(?:;[\x20-\x7e\x80-\xff]*)?$/.exec(line);
  const size = m ? parseInt(m[1]!, 16) : NaN;
  if (!Number.isSafeInteger(size)) {
    throw new Error(`malformed chunk size ${JSON.stringify(line)}`);
  }
  return size;
}

/** The URL a handler sees for `target`.
 *
 *  On a Unix socket it is exactly what `Deno.serve({ path })` builds —
 *  `http+unix://<Host header>/…`, or the percent-encoded socket path when the
 *  request names no host (no `Host`, or an empty one) — because that is what
 *  an app's routes were handed on this socket before this server took it
 *  over. On a named pipe, which `Deno.serve` never served, it is
 *  `http://app/…`, as it always was. An absolute-form target is the URL on
 *  both. Pure. */
export function requestUrl(
  target: string,
  host: string | null,
  socketPath: string,
  unix: boolean,
): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return target;
  const path = (target.startsWith("/") ? "" : "/") + target;
  if (!unix) return `http://app${path}`;
  const authority = host ||
    Array.from(
      enc.encode(socketPath),
      (b) =>
        (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122)
          ? String.fromCharCode(b)
          : "%" + b.toString(16).toUpperCase().padStart(2, "0"),
    ).join("");
  return `http+unix://${authority}${path}`;
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
const CONTINUE = enc.encode("HTTP/1.1 100 Continue\r\n\r\n");

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
  return latin1Encode(out + "\r\n");
}

function reasonPhrase(status: number): string {
  return REASONS[status] ?? "";
}
/** The registered reason phrases — what `Deno.serve` writes for a status,
 *  whatever `statusText` the Response carries. */
const REASONS: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  510: "Not Extended",
  511: "Network Authentication Required",
};

// ── Byte source: a buffered reader over the connection ────────────────────

const EMPTY = new Uint8Array(0);

/** The size a connection's read buffer grows to — one read's worth of an
 *  upload — and the size it starts at, which holds a request head. A buffer
 *  is as large as its connection has shown it needs: 64 KB for each of a
 *  burst of connections that ask little or nothing was 400 MB for 6000. */
const READ_BYTES = 64 * 1024;
const FIRST_READ_BYTES = 4 * 1024;

class ByteSource {
  #conn: LocalConn;
  /** The connection's stream reader, when it can only be read as a stream. */
  #reader: ReadableStreamDefaultReader<Uint8Array> | null;
  /** Where `LocalConn.read` reads into — one buffer for many reads, not one
   *  per read; replaced by a larger one after a read that filled it. */
  #room: Uint8Array | null = null;
  #roomBytes = FIRST_READ_BYTES;
  #buf: Uint8Array = EMPTY;
  #eof = false;
  /** The read in flight. ONE at a time: the read-ahead and a body's `pull`
   *  both ask for more, and two reads would hand them the bytes out of order. */
  #filling: Promise<boolean> | null = null;
  /** Bytes of `#buf` already searched for the head's blank line — a head that
   *  arrives a byte at a time is scanned once, not once per byte. */
  #scanned = 0;
  constructor(conn: LocalConn) {
    this.#conn = conn;
    this.#reader = conn.read ? null : conn.readable.getReader();
  }
  get buffered(): number {
    return this.#buf.length;
  }
  /** The connection's input has ended (or failed). */
  get eof(): boolean {
    return this.#eof;
  }
  /** Pull one more chunk into the buffer; false at EOF, or when the
   *  connection failed — the peer is gone either way. */
  fill(): Promise<boolean> {
    if (this.#eof) return Promise.resolve(false);
    return this.#filling ??= this.#read().finally(() => {
      this.#filling = null;
    });
  }
  async #read(): Promise<boolean> {
    let value: Uint8Array | undefined;
    try {
      if (this.#reader) value = (await this.#reader.read()).value;
      else {
        const room = this.#room ??= new Uint8Array(this.#roomBytes);
        // What is left of the last read moves out before the next one lands.
        if (this.#buf.buffer === room.buffer) this.#buf = this.#buf.slice();
        const n = await this.#conn.read!(room);
        if (n !== null) value = room.subarray(0, n);
        if (n === room.length && n < READ_BYTES) {
          // More was waiting than fits: the next read gets a larger buffer
          // (this one stays with the bytes it holds).
          this.#room = null;
          this.#roomBytes = Math.min(READ_BYTES, n * 4);
        }
      }
    } catch {
      /* aio-ok: a failed read is the end of this connection's input */
    }
    if (!value) {
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
  /** Take up to `n` buffered bytes (the caller `fill`s first). The bytes are
   *  the caller's own: a view into a larger buffer is copied, so nothing the
   *  handler does with a body chunk can reach the bytes behind it. */
  take(n: number): Uint8Array {
    const out = this.#buf.subarray(0, n);
    this.#drop(n);
    // (The read buffer is read into again — even all of it is a view.)
    return out.byteLength === out.buffer.byteLength &&
        out.buffer !== this.#room?.buffer
      ? out
      : out.slice();
  }
  #drop(n: number): void {
    this.#buf = this.#buf.subarray(n);
    this.#scanned = 0;
  }
  /** Read a CRLF-terminated line (without the CRLF), or null at EOF. */
  async line(limit = MAX_HEADER_BYTES): Promise<string | null> {
    while (true) {
      const i = indexOfSeq(this.#buf, CRLF, 0, limit + 2);
      if (i !== -1) {
        const s = latin1Decode(this.#buf.subarray(0, i));
        this.#drop(i + 2);
        return s;
      }
      if (this.#buf.length > limit) throw new Error("line exceeds limit");
      if (!(await this.fill())) return null;
    }
  }
  /** True once a byte is buffered; false when the input ended first. */
  async some(): Promise<boolean> {
    while (this.#buf.length === 0) {
      if (!(await this.fill())) return false;
    }
    return true;
  }
  /** Read the request head (everything before the blank line). `null` when
   *  the peer closed before completing one — a probe connect (`isSocketAlive`
   *  does exactly this), a client that left mid-head: nobody is there to
   *  answer, and `Deno.serve` writes nothing either. Throws on a head with a
   *  bare LF in it, or an oversized one. `unread` is for a peer the gate
   *  refused: its bytes are only counted up to the blank line, never looked
   *  at, so what it gets and when cannot depend on what it sent. */
  async head(unread = false): Promise<string | null> {
    while (true) {
      // Empty lines before the request line are skipped (RFC 9112 §2.2).
      let skip = 0;
      const b = this.#buf;
      while (b[skip] === 10 || (b[skip] === 13 && b[skip + 1] === 10)) {
        skip += b[skip] === 10 ? 1 : 2;
      }
      if (skip > 0) {
        this.#buf = b.subarray(skip);
        this.#scanned = 0;
      }
      const from = Math.max(0, this.#scanned - 3);
      const i = indexOfSeq(this.#buf, HEAD_END, from, MAX_HEADER_BYTES + 4);
      // A line ended by LF alone. Refused as soon as it is seen, not when the
      // blank line arrives: a head written with bare LFs has no CRLF CRLF,
      // and waiting for one would leave its sender without any answer.
      const headBytes = i !== -1 ? i : this.#buf.length;
      for (let k = Math.max(1, from); !unread && k < headBytes; k++) {
        if (this.#buf[k] === 10 && this.#buf[k - 1] !== 13) {
          throw new Error("a line of the request head ends in a bare LF");
        }
      }
      if (i !== -1) {
        const s = latin1Decode(this.#buf.subarray(0, i));
        this.#drop(i + 4);
        return s;
      }
      this.#scanned = this.#buf.length;
      if (this.#buf.length > MAX_HEADER_BYTES) {
        throw new Error("request head exceeds limit");
      }
      if (!(await this.fill())) return null;
    }
  }
  release(): void {
    this.#eof = true;
    try {
      this.#reader?.releaseLock();
    } catch { /* already released */ }
  }
}

const CRLF = [13, 10];
const HEAD_END = [13, 10, 13, 10];

/** First index of `seq` in `buf[from, to)`, or -1. */
function indexOfSeq(
  buf: Uint8Array,
  seq: number[],
  from: number,
  to: number,
): number {
  const end = Math.min(buf.length, to) - seq.length;
  outer: for (let i = from; i <= end; i++) {
    for (let j = 0; j < seq.length; j++) {
      if (buf[i + j] !== seq[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// ── Request body streams ──────────────────────────────────────────────────

/** What a body stream tells its connection. */
type BodyHooks = {
  /** Bytes left the buffer: there is room to read ahead again. */
  taken(): void;
  /** The body's FRAMING was wrong — the request is at fault, not the app. */
  malformed(): void;
  /** The body was read to its end: the next bytes are the next request's. */
  done(): void;
};

/** What a route reading an upload is told when the client left mid-body —
 *  `Deno.serve`'s own error, so a route cannot tell the two apart. */
function cutShort(): Error {
  return new Deno.errors.BadResource(
    "Cannot read body as underlying resource unavailable",
  );
}

function contentLengthBody(
  src: ByteSource,
  length: number,
  hooks: BodyHooks,
): ReadableStream<Uint8Array> {
  let remaining = length;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (src.buffered === 0 && !(await src.fill())) {
        return ctrl.error(cutShort());
      }
      const chunk = src.take(Math.min(remaining, src.buffered));
      remaining -= chunk.length;
      hooks.taken();
      ctrl.enqueue(chunk);
      if (remaining === 0) {
        hooks.done();
        ctrl.close();
      }
    },
  });
}

/** A chunked body, de-chunked AS IT ARRIVES: a chunk's data is handed on in
 *  the pieces the connection delivers, never collected first — the Electron
 *  shell uploads chunked, and a chunk is as large as the sender likes. */
function chunkedBody(
  src: ByteSource,
  hooks: BodyHooks,
): ReadableStream<Uint8Array> {
  /** Data bytes still owed by the current chunk. */
  let remaining = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        if (remaining === 0) {
          const sizeLine = await src.line();
          if (sizeLine === null) throw new Error("chunked body ended early");
          remaining = chunkSize(sizeLine);
          if (remaining === 0) {
            // Trailers (if any) up to the blank line — header lines, or the
            // body is malformed: what follows a `0` line with no blank line
            // behind it is the next request, not this one's trailers.
            while (true) {
              const t = await src.line();
              if (t === null) throw new Error("chunked body ended early");
              if (t === "") break;
              headerLine(t);
            }
            hooks.taken();
            hooks.done();
            return ctrl.close();
          }
        }
        if (src.buffered === 0 && !(await src.fill())) {
          throw new Error("chunk ended early");
        }
        const chunk = src.take(Math.min(remaining, src.buffered));
        remaining -= chunk.length;
        if (remaining === 0 && (await src.line(2)) !== "") {
          throw new Error("chunk data is not followed by CRLF");
        }
        hooks.taken();
        ctrl.enqueue(chunk);
      } catch (e) {
        // Input that is still flowing and does not parse is a malformed
        // request; input that stopped is a client that left.
        if (!src.eof) hooks.malformed();
        ctrl.error(src.eof ? cutShort() : e);
      }
    },
  });
}

// ── One connection ────────────────────────────────────────────────────────

/** `Deno.serve`'s own abort reason, so a route cannot tell the two apart. */
function cancelled(): DOMException {
  return new DOMException("The request has been cancelled.", "AbortError");
}

/** The reason every request that simply ended is aborted with. One for all:
 *  an exception captures a stack, and a fresh one per request was a tenth of
 *  what a request cost. */
const REQUEST_OVER = cancelled();

type ConnOpts = {
  path: string;
  unixUrls: boolean;
  headDeadlineMs: number;
  refusedHeadMs: number;
  refusal?: (conn: LocalConn) => string | null;
};

const TIMED_OUT = Symbol("head deadline");
const CANCELLED = Symbol("ended from outside");

type Write = (bytes: Uint8Array) => Promise<void>;

/** Serve one connection: the gate, then request after request until either
 *  side ends it. */
async function serveConn(
  conn: LocalConn,
  handler: HttpOverLocalHandler,
  o: ConnOpts,
  /** Handed the way to end this connection's WAIT (for a request head), for
   *  whoever closes the connection from outside — and `null` while it waits
   *  for nothing: a request of its is with the handler. */
  onWait: (cancel: (() => void) | null) => void,
): Promise<void> {
  const src = new ByteSource(conn);
  // Straight to the connection where it can be written so, else through its
  // stream (the Windows pipe).
  const writer = conn.write ? null : conn.writable.getWriter();
  const write: Write = writer
    ? (bytes) => writer.write(bytes)
    : (bytes) => conn.write!(bytes);
  const respond = (status: number, text: string) =>
    writeSimple(write, status, text);

  try {
    // THE GATE, at accept. A peer the door refuses never reaches the handler
    // — not the page, not a route, not `/ws` — and is never parsed. It is
    // given a bounded moment to send its request so the 403 and its reason
    // arrive as an answer (when the refused peer is the app's own
    // mis-launched window, that text is what it shows); a peer that sends
    // nothing is told anyway and closed, so no connection is held open by a
    // process this door does not serve. A gate that THROWS has not allowed
    // anyone: the connection is refused, and the fault is said.
    let refused: string | null;
    try {
      refused = o.refusal?.(conn) ?? null;
    } catch (e) {
      log.error("http", `the peer gate of ${o.path} failed — ${e}`);
      refused = "its identity could not be checked";
    }
    for (let first = true;; first = false) {
      let end!: (why: typeof TIMED_OUT | typeof CANCELLED) => void;
      const ended = new Promise<typeof TIMED_OUT | typeof CANCELLED>((r) =>
        end = r
      );
      // Ended from outside — `close()`, a disarm. A FLAG, read where a
      // request would be started: a head that is already in the buffer (one
      // pipelined behind the request just answered) settles its read before
      // `ended` can win a race, and the handler must not be handed a request
      // on a connection that is closed.
      let stopped = false;
      onWait(() => {
        stopped = true;
        end(CANCELLED);
      });
      // The deadline is for a head that has BEGUN: a connection's first — the
      // proof it was opened to ask something — and any later one from its
      // first byte. Between requests a connection may idle, as under
      // `Deno.serve`, until its peer, a disarm or `close()` ends it.
      if (!first && (await Promise.race([src.some(), ended])) !== true) {
        return; // the peer closed, or it was ended from outside
      }
      const timer = setTimeout(
        () => end(TIMED_OUT),
        refused === null ? o.headDeadlineMs : o.refusedHeadMs,
      );
      let text: string | null | typeof TIMED_OUT | typeof CANCELLED;
      let headError: Error | null = null;
      try {
        text = await Promise.race([src.head(refused !== null), ended]);
      } catch (e) {
        text = null;
        headError = e as Error;
      } finally {
        clearTimeout(timer);
      }
      if (stopped || text === CANCELLED) return;
      if (refused !== null) {
        if (text === null && headError === null) return; // it left by itself
        await respond(
          403,
          `Forbidden — local-peer lockdown: this socket serves only this ` +
            `app's own window, and ${refused}.\n`,
        );
        return;
      }
      if (headError !== null) {
        await respond(400, `bad request: ${headError.message}\n`);
        return;
      }
      if (text === null) return; // peer closed, between requests or before one
      if (text === TIMED_OUT) {
        await respond(408, "no request arrived on this connection in time\n");
        return;
      }
      onWait(null);
      if (!(await serveRequest(conn, src, write, text, handler, o))) return;
    }
  } catch (e) {
    // A write to a peer that went away mid-response is not a server fault.
    log.debug(`http-over-local: connection ended — ${e}`);
  } finally {
    try {
      writer?.releaseLock();
    } catch { /* fine */ }
    src.release();
    // Nothing of this connection is with the handler any more: `close()`
    // ends it at once, and does not wait out its linger.
    onWait(() => {});
    // Give the peer every byte, and take what it is still sending, before
    // tearing the connection down. A Windows server pipe that closes with
    // unread bytes buffered DISCARDS them (`read EPIPE` after a 200 —
    // measured on the FIRST page request of a packaged app, real Windows 11,
    // 2026-09-17), and a Unix socket closed with unread INPUT resets the
    // peer mid-upload, so a route that answered without reading a large body
    // reached the window as `write EPIPE` instead of its response. Awaited,
    // and bounded inside `drain`.
    await conn.drain?.().catch(() => {
      // aio-ok(silent-catch): a peer gone mid-drain is what `drain` tolerates;
      // the `close` below is the real teardown and cannot fail loudly.
    });
    conn.close();
  }
}

/** Serve the request whose head is `text`. True when the connection can take
 *  another: the answer was written whole, said nothing of closing, and the
 *  request's body was read to its end. */
async function serveRequest(
  conn: LocalConn,
  src: ByteSource,
  write: Write,
  text: string,
  handler: HttpOverLocalHandler,
  o: ConnOpts,
): Promise<boolean> {
  const ac = new AbortController();
  let done!: () => void;
  const completed = new Promise<void>((r) => done = r);
  /** This request is over: EOF is no longer news to it. */
  let ended = false;
  let malformed = false;
  let cancelBody: (() => void) | null = null;
  /** Body bytes of this request are still on the connection, where the next
   *  request's head would be looked for. */
  let unread = false;
  /** The response is a stream being written. */
  let streaming = false;

  // The client left. `Deno.serve` tells the route two ways and so does this:
  // `req.signal` aborts, and the response stream it is producing is cancelled
  // — at once, not at the next write, or a quiet SSE / long-poll route would
  // run on for a client that is gone.
  const clientGone = () => {
    if (ended || ac.signal.aborted) return;
    ac.abort(cancelled());
    cancelBody?.();
  };
  // Read ahead of the handler, within a bound: EOF is the only way a closed
  // connection announces itself. Stops when the buffer is full and is
  // restarted by whichever body stream empties it.
  //
  // It starts when somebody is WAITING — a handler that has not answered by
  // the end of this turn of the event loop, a response that is a stream —
  // and not before. A request answered at once is never read past its head:
  // a client that half-closed behind it (`printf … | nc -U`) gets its
  // answer, as under `Deno.serve`. Started with the request, the read would
  // report an EOF that is already there before a route with awaits of its
  // own has answered, and the client would be taken for gone.
  //
  // And not while the request's BODY is unfinished and the route has not
  // answered: those bytes are the route's to read, and the end of input in
  // the middle of them is the route's to be told (its read fails) and to
  // answer — `Deno.serve` writes that answer, a 500 for a route that let the
  // failure through.
  let watch: ReturnType<typeof setTimeout> | undefined;
  let pumping = false;
  const pump = async () => {
    if (pumping || (unread && !streaming)) return;
    pumping = true;
    try {
      while (!ended && src.buffered < READ_AHEAD_BYTES) {
        if (!(await src.fill())) return clientGone();
      }
    } finally {
      pumping = false;
    }
  };
  /** A refusal: said, and the connection ends with it. */
  const refuse = async (status: number, why: string): Promise<false> => {
    await writeSimple(write, status, why);
    return false;
  };

  try {
    let head: RequestHead;
    let framing: number | "chunked" | null;
    try {
      head = parseRequestHead(text);
      framing = bodyFraming(head.headers, head.version);
    } catch (e) {
      return await refuse(400, `bad request: ${(e as Error).message}\n`);
    }
    // This server cannot hand the connection over to another protocol. Said,
    // rather than left to whatever the handler's own upgrade attempt throws —
    // the window speaks NDJSON on the app's socket, never WebSocket on this
    // one. Any other offer (`curl --http2` sends `h2c`) is the server's to
    // ignore: the request is served as HTTP/1.1.
    const upgrade = head.headers.get("upgrade") ?? "";
    if (listTokens(upgrade).includes("websocket")) {
      return await refuse(
        501,
        `Not Implemented — no protocol upgrade (${upgrade}) over this local socket.\n`,
      );
    }
    const method = head.method;
    // The methods a `Request` refuses to carry. Answered, not dropped: the
    // constructor's throw used to close the connection without a word.
    if (method === "CONNECT" || method === "TRACE" || method === "TRACK") {
      return await refuse(
        501,
        `Not Implemented — ${method} is not served over this local socket.\n`,
      );
    }
    unread = !!framing;
    const hooks: BodyHooks = {
      taken: () => void pump(),
      malformed: () => malformed = true,
      done: () => {
        unread = false;
        // From here a client that leaves is looked for — a turn later, as
        // for a request that had no body.
        if (!ended && !streaming) {
          clearTimeout(watch);
          watch = setTimeout(() => void pump(), 0);
        }
      },
    };
    // Fetch's Request refuses a body on GET/HEAD, and `Deno.serve` hands the
    // handler none; whatever was sent is discarded with the connection.
    const body = method === "GET" || method === "HEAD" || !framing
      ? null
      : framing === "chunked"
      ? chunkedBody(src, hooks)
      : contentLengthBody(src, framing, hooks);
    let req: Request;
    try {
      req = new Request(
        requestUrl(
          // The head was decoded as latin1 for its header values; a target
          // with unescaped bytes ≥ 0x80 is UTF-8, as `Deno.serve` reads it.
          /[\x80-\xff]/.test(head.target)
            ? utf8.decode(latin1Encode(head.target))
            : head.target,
          head.headers.get("host"),
          o.path,
          o.unixUrls,
        ),
        {
          method,
          headers: head.headers.pairs,
          body,
          signal: ac.signal,
          // Required by the spec for a stream body (half-duplex request).
          ...({ duplex: "half" } as Record<string, unknown>),
        },
      );
    } catch (e) {
      return await refuse(400, `bad request: ${(e as Error).message}\n`);
    }
    // A client that asked first is told to send its body as the request
    // reaches the handler, as under `Deno.serve`.
    if (
      body !== null &&
      head.headers.get("expect")?.toLowerCase() === "100-continue"
    ) await write(CONTINUE);
    watch = setTimeout(() => void pump(), 0);
    let res: Response;
    try {
      res = await handler(req, { remoteAddr: conn.remoteAddr, completed });
      // `Deno.serve`'s two checks, in its words.
      if (!(res instanceof Response)) {
        throw new TypeError(
          "Return value from serve handler must be a response or a promise " +
            "resolving to a response",
        );
      }
      if (res.bodyUsed) {
        throw new TypeError(
          "The body of the Response returned from the serve handler has " +
            "already been consumed",
        );
      }
    } catch (e) {
      // A body whose framing was wrong fails the handler that read it; the
      // fault is the request's.
      if (malformed) {
        return await refuse(400, "bad request: malformed chunked body\n");
      }
      log.error(
        "http",
        `handler threw for ${method} ${head.target} over ${o.path} — ${e}`,
      );
      // `Deno.serve`'s default answer, byte for byte (bytes, so no
      // Content-Type is invented for it).
      res = new Response(enc.encode("Internal Server Error"), { status: 500 });
    }
    clearTimeout(watch);
    // The connection is kept for another request when the client's version
    // keeps it by default and it did not ask otherwise (as `Deno.serve`), and
    // nothing of this request's body is left on it — decided as the head is
    // written, so that a connection about to end says so and the client's
    // agent does not reuse it. (A server that is closing ends the connection
    // after the answer without saying so, as `Deno.serve` does.)
    const keep = () =>
      head.version === "1.1" && !unread &&
      !listTokens(head.headers.get("connection")).includes("close");
    return await writeResponse(write, res, head, ac.signal, keep, (c) => {
      cancelBody = c;
      streaming = true;
      void pump();
    });
  } finally {
    ended = true;
    clearTimeout(watch);
    // `Deno.serve` aborts the request's signal when the request is over,
    // however it ended (its documented legacy behaviour) — a route that
    // cleans up on `abort` must be cleaned up here too.
    if (!ac.signal.aborted) ac.abort(REQUEST_OVER);
    done();
  }
}

async function writeSimple(
  write: Write,
  status: number,
  text: string,
): Promise<void> {
  const body = enc.encode(text);
  const h = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(body.length),
    connection: "close",
  });
  await write(responseHeadBytes(status, "", h));
  await write(body);
}

/** `p`'s result when it settles within this turn of the event loop
 *  ({@linkcode PEEK_TURNS}), else `undefined` — `p` is still the caller's to
 *  await. */
async function already<T>(p: Promise<T>): Promise<T | undefined> {
  let v: T | undefined;
  p.then((x) => v = x, () => {
    // aio-ok: a read that fails is not "already there" — whoever awaits `p` next is told
  });
  for (let i = 0; i < PEEK_TURNS && v === undefined; i++) await null;
  return v;
}

/** Write a `Response` to the wire, framed as `Deno.serve` frames it: with a
 *  `Content-Length` when the whole body is already there (a string, bytes,
 *  JSON — and for a `HEAD` of one) or the handler declared one for its
 *  stream, else chunked (close-delimited for an HTTP/1.0 client, which knows
 *  no chunking) and streamed chunk by chunk, never buffered. `onStream` is handed the way to
 *  cancel a streamed body from outside — the client left — and `gone` says it
 *  has. */
async function writeResponse(
  write: Write,
  res: Response,
  head: RequestHead,
  gone: AbortSignal,
  keep: () => boolean,
  onStream: (cancel: () => void) => void,
): Promise<boolean> {
  const reader = res.body?.getReader();
  const cancel = () => {
    reader?.cancel().catch(() => {
      // aio-ok: the stream already errored — there is nothing left to cancel
    });
  };
  // The client left while the handler worked: nobody is there to answer.
  if (gone.aborted) {
    cancel();
    return false;
  }
  const isHead = head.method === "HEAD";
  const status = res.status;
  // The handler's headers, read ONCE (a `Headers` sorts itself for every
  // look): its lines as they will be written, and the three this server
  // decides about.
  let lines = "";
  let declared: string | null = null;
  let coded = false;
  let dated = false;
  for (const [k, v] of res.headers) {
    if (k === "content-length") declared = v;
    else if (k === "transfer-encoding") coded = true;
    else {
      if (k === "date") dated = true;
      lines += `${k}: ${v}\r\n`;
    }
  }
  /** The reads made to learn the length, for the body loop to start from. */
  const peeked: Promise<ReadableStreamReadResult<Uint8Array>>[] = [];
  /** The whole body, when it is one chunk that is already there. */
  let whole: Uint8Array | null = null;
  if (reader && !statusHasNoBody(status)) {
    peeked.push(reader.read());
    const first = await already(peeked[0]!);
    if (first?.done) whole = EMPTY;
    else if (first) {
      peeked.push(reader.read());
      if ((await already(peeked[1]!))?.done) whole = first.value;
    }
  }
  const noBody = isHead || statusHasNoBody(status) || !reader;
  /** The body's real length is known. */
  const known = whole !== null || !reader;
  // The framing is this server's to say, as it is `Deno.serve`'s: a
  // `Transfer-Encoding` the handler set asks for a chunked body and is
  // otherwise rewritten, and a body that is already whole carries its real
  // length whatever the handler declared.
  let length = declared;
  let chunked = false;
  if (statusHasNoBody(status) || status === 205) {
    // A status that has no content to count.
  } else if (isHead) {
    if (declared === null && known) length = String(whole?.length ?? 0);
  } else if (coded && reader && head.version === "1.1") {
    chunked = true;
    length = null;
  } else if (known) {
    length = String(whole?.length ?? 0);
  } else if (declared === null && head.version === "1.1") {
    chunked = true;
  }
  const stay = keep();
  // The handler's headers as a `Headers` iterates them, then this server's
  // own, in `Deno.serve`'s order. The registered reason phrase, never
  // `res.statusText` — as `Deno.serve`.
  let text = `HTTP/1.1 ${status} ${reasonPhrase(status)}\r\n${lines}`;
  if (length !== null) text += `content-length: ${length}\r\n`;
  if (chunked) text += "transfer-encoding: chunked\r\n";
  if (!dated) text += `date: ${new Date().toUTCString()}\r\n`;
  if (!stay) text += "connection: close\r\n";
  const headBytes = latin1Encode(text + "\r\n");
  if (noBody || (whole && !chunked)) {
    cancel(); // nothing more is wanted of it
    await write(headBytes);
    if (!noBody && whole!.length > 0) await write(whole!);
    return stay;
  }
  onStream(cancel);
  if (gone.aborted) cancel(); // it left while the body was looked at
  /** Bytes a declared length still allows: a stream is cut at the length its
   *  handler declared for it, as under `Deno.serve`, never written past it. */
  let left = chunked || declared === null ? Infinity : Number(declared);
  let sent = false;
  try {
    await write(headBytes);
    while (left > 0) {
      const { value, done } = await (peeked.shift() ?? reader!.read());
      if (done) break;
      if (value.length === 0) continue; // a zero chunk would END a chunked body
      const part = value.length > left ? value.subarray(0, left) : value;
      left -= part.length;
      await write(chunked ? chunkFrame(part) : part);
    }
    if (left === 0) cancel(); // whatever follows was declared away
    // A body that ended because it was cancelled is not a complete one.
    if (gone.aborted) return false;
    if (chunked) await write(CHUNKED_END);
    sent = true;
    // A stream that ended short of the length declared for it has left the
    // client waiting for the rest: only closing tells it there is none.
    return stay && (left === 0 || left === Infinity);
  } finally {
    // The peer went away mid-body (or never took the head): CANCEL the
    // handler's stream, as `Deno.serve` does. Released without it, a
    // long-lived body (an SSE route) went on producing into a stream nobody
    // would ever read.
    if (!sent) cancel();
    reader!.releaseLock();
  }
}

// ── The server ────────────────────────────────────────────────────────────

/** Serve `handler` over every connection `listener` accepts. `close()` stops
 *  accepting, closes the connections that have asked nothing, lets the
 *  requests being answered finish ({@linkcode CLOSE_DRAIN_MS} at most), and
 *  resolves once the loop is done; `dropConnections()` closes every open
 *  connection at once and keeps accepting (the window they were trusted for
 *  has exited).
 *
 *  `refusal` is the door's peer gate (`LocalPeerGate.refusal`): asked once per
 *  connection, AT ACCEPT, and a refused peer is answered 403 without the
 *  handler ever seeing its request. */
export function serveHttpOverLocal(
  listener: LocalListener,
  handler: HttpOverLocalHandler,
  refusal?: (conn: LocalConn) => string | null,
  opts: {
    /** Build `req.url` as `Deno.serve({ path })` does on a Unix socket
     *  (see {@linkcode requestUrl}). Off by default: the pipe's
     *  `http://app/…`. */
    unixUrls?: boolean;
    /** Override {@linkcode HEAD_DEADLINE_MS} / {@linkcode REFUSED_HEAD_MS}. */
    headDeadlineMs?: number;
    refusedHeadMs?: number;
    /** Override {@linkcode CLOSE_DRAIN_MS}. */
    closeDrainMs?: number;
  } = {},
): {
  close(): Promise<void>;
  dropConnections(): void;
  finished: Promise<void>;
} {
  /** Each open connection: the way to end its wait for a request head (`null`
   *  once its request is with the handler), and its end. */
  const open = new Map<
    LocalConn,
    {
      cancelWait: (() => void) | null;
      served: Promise<void>;
      dropped: boolean;
    }
  >();
  let closed = false;
  /** `close()`'s: called whenever a connection stops being with the handler. */
  let onIdle: (() => void) | null = null;
  const o: ConnOpts = {
    path: listener.path,
    unixUrls: opts.unixUrls ?? false,
    headDeadlineMs: opts.headDeadlineMs ?? HEAD_DEADLINE_MS,
    refusedHeadMs: opts.refusedHeadMs ?? REFUSED_HEAD_MS,
    ...(refusal ? { refusal } : {}),
  };
  const dropConnections = () => {
    for (const [c, entry] of open) {
      // Its request in flight, if any, ends with the connection — and the
      // next one, already sent behind it, is never started.
      entry.dropped = true;
      entry.cancelWait?.();
      c.close();
    }
  };
  const finished = (async () => {
    for await (const conn of listener) {
      if (closed) {
        conn.close();
        break;
      }
      const entry = {
        cancelWait: (() => {}) as (() => void) | null,
        served: Promise.resolve(),
        dropped: false,
      };
      open.set(conn, entry);
      entry.served = serveConn(conn, handler, o, (c) => {
        entry.cancelWait = c;
        if (c === null) return;
        if (entry.dropped) c();
        onIdle?.();
      })
        .catch((e) => log.error("http", `connection failed — ${e}`))
        .finally(() => {
          open.delete(conn);
          onIdle?.();
        });
    }
  })().catch((e) => {
    if (!closed) throw e;
  });
  return {
    finished,
    dropConnections,
    async close() {
      if (closed) return;
      closed = true;
      listener.close();
      // A connection is ended the moment no request of its is with the
      // handler — waiting for a head, or lingering behind its answer — and
      // the ones that are, are waited for: until the last of them is
      // answered, or the bound.
      const ending = new Set<Promise<void>>();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          resolve,
          opts.closeDrainMs ?? CLOSE_DRAIN_MS,
        );
        onIdle = () => {
          let busy = false;
          for (const [c, { cancelWait, served }] of open) {
            if (cancelWait === null) busy = true;
            else {
              cancelWait();
              c.close();
              ending.add(served);
            }
          }
          if (!busy) {
            clearTimeout(timer);
            resolve();
          }
        };
        onIdle();
      });
      onIdle = null;
      dropConnections();
      // (Not the ones cut at the bound: a handler that never returns would
      // hold this for ever.)
      await Promise.all(ending);
      await finished.catch(() => {
        // aio-ok: close only waits for the loop to end — its failure is `finished`'s to report
      });
    },
  };
}

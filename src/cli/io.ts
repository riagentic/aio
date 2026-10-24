// io.ts — the ONE seam between the toolkit and the process.
//
// Every function in aio/cli reads, writes, asks "is this a terminal?" and
// exits through a `CliIO`, never through `Deno.*` directly. That is what makes
// the toolkit testable without a TTY (`testIO()` is a CliIO over strings) and
// what keeps colour, TTY-ness and exit in ONE object instead of four globals
// each read at a different moment.

import { colorEnabled } from "../diagnostics/color.ts";

/** Streams + terminal facts a toolkit call runs against. Injectable. */
export type CliIO = {
  /** Read bytes from stdin; `null` at EOF (the `Deno.stdin.read` shape). */
  read(buf: Uint8Array): Promise<number | null>;
  /** Write to stdout. */
  out(text: string): void;
  /** Write to stderr. */
  err(text: string): void;
  /** Interactive: stdin AND stdout are terminals. */
  tty: boolean;
  /** stderr is a terminal — decides whether progress/spinner (on stderr)
   *  redraw in place. Absent: {@link CliIO.tty} decides, as before. */
  errTty?: boolean;
  /** ANSI escapes allowed — the framework's decider (`NO_COLOR`, `FORCE_COLOR`, TTY). */
  color: boolean;
  /** Raw mode (no echo, no line buffering) — for `password()`. */
  setRaw(on: boolean): void;
  /** End the process. `testIO` throws {@link CliExit} instead. */
  exit(code: number): never;
};

/** Thrown by `testIO().exit()` so a test sees the exit code instead of dying. */
export class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = "CliExit";
  }
}

const enc = new TextEncoder();

let _default: CliIO | undefined;

/** The real process: `Deno.stdin/stdout/stderr`, real TTY facts, real exit. */
export function defaultIO(): CliIO {
  return _default ??= {
    read: (buf) => Deno.stdin.read(buf),
    out: (t) => writeAll(Deno.stdout, t),
    err: (t) => writeAll(Deno.stderr, t),
    tty: isTerm(Deno.stdin) && isTerm(Deno.stdout),
    errTty: isTerm(Deno.stderr),
    color: colorEnabled,
    setRaw: (on) => Deno.stdin.setRaw(on),
    exit: (code) => Deno.exit(code),
  };
}

/** Exit code when the reader of our output went away — 128 + SIGPIPE, what
 *  a C tool killed by the signal reports (`yes | head -1` → 141). */
export const EXIT_BROKEN_PIPE = 141;

/** Write ALL of `text` (`writeSync` may write fewer bytes than asked on a
 *  pipe). A reader that closed (`tool --watch | head -1`) ends the process
 *  quietly with {@link EXIT_BROKEN_PIPE}, the way every unix tool does — it
 *  used to crash with "Uncaught BrokenPipe" and a stack trace on stderr.
 *  @internal exported for the test */
export function writeAll(
  w: { writeSync(p: Uint8Array): number },
  text: string,
  exit: (code: number) => never = Deno.exit,
): void {
  let buf = enc.encode(text);
  try {
    while (buf.length > 0) buf = buf.subarray(w.writeSync(buf));
  } catch (e) {
    if (e instanceof Deno.errors.BrokenPipe) exit(EXIT_BROKEN_PIPE);
    throw e;
  }
}

function isTerm(s: { isTerminal?: () => boolean }): boolean {
  try {
    return s.isTerminal?.() ?? false;
  } catch {
    // aio-ok: a closed or non-standard handle is "not a terminal", not a crash
    return false;
  }
}

/** A `CliIO` whose stdout/stderr are captured strings — for tests. Nothing
 *  ever waits on it: an exhausted `input` reads as EOF, never as a hang. */
export type TestIO = CliIO & {
  /** Everything written to stdout so far. */
  readonly stdout: string;
  /** Everything written to stderr so far. */
  readonly stderr: string;
  /** Raw-mode toggles, in order. */
  readonly raw: boolean[];
};

/** Build a `TestIO`. `input` is what stdin will yield (one chunk per element,
 *  so a test can prove chunk boundaries do not matter); `tty` defaults to true
 *  so prompts run, `color` to false so assertions read plain text; no `errTty`,
 *  so `tty` decides progress redraw (set `io.errTty` to split them). */
export function testIO(
  opts: { input?: string | string[]; tty?: boolean; color?: boolean } = {},
): TestIO {
  const chunks = (typeof opts.input === "string" ? [opts.input] : opts.input ??
    []).map((c) => enc.encode(c));
  let stdout = "", stderr = "";
  const raw: boolean[] = [];
  return {
    read(buf) {
      const c = chunks[0];
      if (!c) return Promise.resolve(null);
      const n = Math.min(buf.length, c.length);
      buf.set(c.subarray(0, n));
      if (n === c.length) chunks.shift();
      else chunks[0] = c.subarray(n);
      return Promise.resolve(n);
    },
    out: (t) => {
      stdout += t;
    },
    err: (t) => {
      stderr += t;
    },
    tty: opts.tty ?? true,
    color: opts.color ?? false,
    setRaw: (on) => {
      raw.push(on);
    },
    exit: (code) => {
      throw new CliExit(code);
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    raw,
  };
}

/** Read one line (without its newline) from `io`; `null` at EOF. Bytes past
 *  the newline are kept for the next call, so chunking is invisible. */
export async function readLine(io: CliIO): Promise<string | null> {
  const buf = new Uint8Array(1024);
  const dec = new TextDecoder();
  let pending = pendingOf(io);
  for (;;) {
    const nl = pending.indexOf(10);
    if (nl !== -1) {
      const line = dec.decode(pending.subarray(0, nl)).replace(/\r$/, "");
      _pending.set(io, pending.subarray(nl + 1));
      return line;
    }
    const n = await io.read(buf);
    if (n === null) {
      _pending.set(io, new Uint8Array(0));
      return pending.length ? dec.decode(pending) : null;
    }
    const next = new Uint8Array(pending.length + n);
    next.set(pending);
    next.set(buf.subarray(0, n), pending.length);
    pending = next;
  }
}

const _pending = new WeakMap<CliIO, Uint8Array>();
function pendingOf(io: CliIO): Uint8Array {
  return _pending.get(io) ?? new Uint8Array(0);
}

/** Hand bytes BACK: what a raw reader read past its own line end belongs to
 *  the next reader, exactly as `readLine` keeps it. */
export function putBackPending(io: CliIO, bytes: Uint8Array): void {
  const rest = pendingOf(io);
  const merged = new Uint8Array(bytes.length + rest.length);
  merged.set(bytes, 0);
  merged.set(rest, bytes.length);
  _pending.set(io, merged);
}

/** Bytes `readLine` read past its newline and has not handed out yet. A raw
 *  reader (`password`) must drain these BEFORE touching `io.read`, or the
 *  first keystrokes of the secret are the tail of the previous answer. */
export function takePending(io: CliIO): Uint8Array {
  const p = pendingOf(io);
  _pending.set(io, new Uint8Array(0));
  return p;
}

// logger-format.ts — Plain text formatter and ANSI console pretty-printer

import type { LogEntry } from "./logger-types.ts";
import { colorEnabled as USE_COLOR, paint } from "./color.ts";
import { kv, style } from "./fmt.ts";

// ── Untrusted text: ONE decider for every sink ────────────────────────
//
// Everything a log line is made of arrives from a caller, and a lot of those
// callers are relaying a REMOTE string: a rejected WS action type, a protocol
// mismatch from a client's own handshake, a sync op's cell name, a method name
// a browser made up. A raw "\n" in any of them wrote a SECOND line into
// app.log / warning.log / error.log / debug.log — starting at column 0, in the
// exact shape of a real entry — so a client could forge
// `2026-09-02 00:00:00.000 ERROR [auth] admin login ok` into the file an
// operator reads after an incident. A raw "\r" did it to the CONSOLE without
// even needing a newline (it rewinds the cursor over the timestamp), and a raw
// "\x1b" repainted the terminal from inside a message.
//
// The fix belongs HERE, at the rendering boundary both sinks pass through, not
// at the (five, and counting) call sites that relay remote text —
// `src/server/client-log.ts` already sanitised its own input, which is exactly
// the per-instance patch that left every other door open.
//
// Continuation lines are INDENTED rather than collapsed. The property that
// matters is "a line at column 0 is a real log entry, always" — indenting
// gives that, and keeps the framework's own deliberate multi-line reports
// (`doctor`, the config error block) readable instead of turning them into a
// row of literal `\n`s. Field VALUES are collapsed outright: `k=v` is a
// one-line shape and nothing legitimate spans lines inside it.

/** Characters that must never reach a terminal or a log file verbatim: the
 *  C0 set minus tab (newlines are handled first, by the caller), DEL, and the
 *  C1 range.
 *
 *  COLOUR IS NOT IN IT. A log message routinely paints part of itself — a
 *  refused value, the one word that matters in a boot failure — and escaping
 *  `\x1b` wholesale turned those into literal `\x1b[31m` in the terminal, which
 *  is how the sanitiser first shipped. What must not survive is an escape that
 *  MOVES or REPAINTS: cursor motion, erase-display, a title change, and `\r`,
 *  which rewinds over the timestamp. So exactly one form is allowed through —
 *  SGR, `ESC [ … m`, which only sets colour and weight and cannot leave its
 *  own line. Untrusted text can therefore be colourful; it still cannot forge
 *  an entry, because the line it sits on is not at column 0 and it has no way
 *  to reach one. */
// deno-lint-ignore no-control-regex
const SGR = /\x1b\[[0-9;]{0,32}m/g;
// deno-lint-ignore no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const escapeByte = (c: string) =>
  "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0");
const escapeControls = (s: string) => {
  // Split on the allowed form, escape everything between the pieces. A lone
  // `\x1b` that starts nothing (or starts something else) is escaped like any
  // other control byte, because it did not match.
  let out = "", last = 0;
  for (const m of s.matchAll(SGR)) {
    const i = m.index ?? 0;
    out += s.slice(last, i).replace(CONTROL, escapeByte) + m[0];
    last = i + m[0].length;
  }
  return out + s.slice(last).replace(CONTROL, escapeByte);
};

/** A continuation line, guaranteed not to start at column 0 — and otherwise
 *  left exactly as it was written. The first sanitiser indented every one of
 *  them by four spaces, which pushed the framework's own aligned blocks (the
 *  config error list, the graph report, `doctor`) four columns right and broke
 *  the alignment their authors had counted. A line that already begins with
 *  whitespace is ALREADY not at column 0, so it needs nothing; only a line
 *  that would start hard against the margin gets a single space. */
const offMargin = (line: string) => /^\S/.test(line) ? " " + line : line;

/** One log line's share of the message. `AioLogger.MAX_LINE` caps the RENDERED
 *  line for the file sinks; this caps the untrusted part before it is
 *  rendered, so the console (which has no line cap at all) is bounded too. */
const MAX_TEXT = 8192;
const cap = (s: string) =>
  s.length <= MAX_TEXT
    ? s
    : s.slice(0, MAX_TEXT) + ` \u2026 [truncated ${s.length - MAX_TEXT} chars]`;

/** A log MESSAGE, made safe: no continuation line ever starts at column 0, no
 *  escape sequence ever reaches the terminal, never unbounded. Exported for
 *  the tests that pin the property. */
export function _safeMsg(s: string): string {
  const [first, ...rest] = cap(String(s)).split(/\r\n?|\n/);
  return [
    escapeControls(first ?? ""),
    ...rest.map((l) => offMargin(escapeControls(l))),
  ].join("\n");
}

/** A log FIELD value, made safe: exactly one line, always. */
export function _safeValue(v: unknown): string {
  const s = typeof v === "object" && v !== null ? safeStringify(v) : String(v);
  return escapeControls(cap(s).replace(/\r\n?|\n/g, "\\n"));
}

// ── Plain text formatter ──────────────────────────────────────────────

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function formatText(e: LogEntry): string {
  const lvl = (typeof e.lvl === "string" ? e.lvl : "debug").toUpperCase()
    .padEnd(5);
  const cat = _safeValue(e.cat).padEnd(10);
  const data = e.data
    ? "  " +
      Object.entries(e.data).map(([k, v]) =>
        `${_safeValue(k)}=${_safeValue(v)}`
      ).join(" ")
    : "";
  const dur = e.dur !== undefined ? `  ${e.dur}ms` : "";
  const src = e.src ? `  (${_safeValue(e.src)})` : "";
  return `${e.ts}  ${lvl}  ${cat}  ${_safeMsg(e.msg)}${data}${dur}${src}`;
}

// ── Console pretty-printer (ANSI colors) ──────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  lime: "\x1b[92m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  lightGray: "\x1b[37m",
  magenta: "\x1b[35m",
  white: "\x1b[97m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
} as const;

const LEVEL_COLOR: Record<string, string> = {
  trace: C.gray,
  debug: C.cyan,
  info: C.lime,
  warn: C.yellow,
  error: C.red,
  perf: C.magenta,
};

// Keyword colorization for console output
const KEYWORD_COLORS: [RegExp, string][] = [
  [/\bstarted\b/i, C.green],
  [/\bready\b/i, C.green],
  [/\bdone\b/i, C.green],
  [/\brecovered\b/i, C.green],
  [/\bstopped\b/i, C.yellow],
  [/\bfailed\b/i, C.red],
  [/\berror\b/i, C.red],
  [/\btimeout\b/i, C.red],
  [/\bexceeded\b/i, C.magenta],
  [/\bheartbeat\b/i, C.cyan],
];

function colorizeMsg(msg: string, lvl: string): string {
  if (!USE_COLOR) return msg;
  // Error messages: entire message in red+bold
  if (lvl === "error") return `${C.red}${C.bold}${msg}${C.reset}`;
  // Apply keyword highlighting
  let out = msg;
  for (const [re, color] of KEYWORD_COLORS) {
    out = out.replace(re, (m) => `${color}${m}${C.reset}`);
  }
  return out;
}

/** How many `key=value` pairs still read as a tail on one line. Past this,
 *  the fields ARE the message and belong in an aligned block under it — the
 *  boot report is 26 of them, and inline that is one 900-character line (it
 *  was worse before: 26 separate entries, each restating the same timestamp,
 *  level and category, so 1000 characters of prefix carried 26 facts). */
const INLINE_FIELDS = 4;

export function printConsole(e: LogEntry): void {
  const lvlStr = (typeof e.lvl === "string" ? e.lvl : "debug").toUpperCase()
    .padEnd(5);
  const color = LEVEL_COLOR[e.lvl] ?? C.gray;
  const ts = paint(e.ts, C.lightGray);
  const lvl = paint(lvlStr, color, C.bold);
  const cat = paint(_safeValue(e.cat).padEnd(10), C.white);
  const entries = e.data ? Object.entries(e.data) : [];
  const cell = _safeValue;

  // The prefix is a fixed ~40 columns of timestamp + level + category, and a
  // message longer than what is left ran off the right edge. Wrap it under
  // itself, so a paragraph of advice reads as a paragraph.
  // The message is NOT wrapped, and that is a decision, not an omission.
  // A log line is a stream people and tools grep: `deno task dev | grep
  // "looks secret"` and twenty of this project's own gate tests match a PHRASE
  // against it, and a soft-wrap inserted mid-phrase breaks every one of them
  // (28 did, the first time this wrapped). The terminal soft-wraps a long line
  // by itself and loses nothing; a hard wrap loses the grep. Blocks — `am`,
  // the build, the error report — wrap, because they are read, not matched.
  const gutter = "    ";
  const msg = colorizeMsg(_safeMsg(e.msg), e.lvl);

  const data = entries.length > 0 && entries.length <= INLINE_FIELDS
    ? "  " +
      entries.map(([k, v]) =>
        `${paint(_safeValue(k), C.dim)}=${paint(cell(v), C.cyan)}`
      )
        .join(" ")
    : "";
  const dur = e.dur !== undefined ? `  ${paint(`${e.dur}ms`, C.magenta)}` : "";
  // A wide field set becomes an aligned block under the line: dim labels,
  // plain values, ONE timestamp for the lot. The app.log still receives them
  // as structured data — this is only how the console draws them.
  const bulk = entries.length > INLINE_FIELDS
    ? "\n" +
      kv(
        entries.map(([k, v]) => ({ label: _safeValue(k), value: cell(v) })),
        {
          indent: gutter,
          style,
        },
      )
    : "";
  const line = `${ts}  ${lvl}  ${cat}  ${msg}${data}${dur}${bulk}`;
  // The level decides the STREAM, not just the word. A warning printed on
  // stdout cannot be separated by `2>`, a wrapper cannot tell it from output,
  // and anything watching console.warn/console.error — a test, a host app, the
  // browser's own console forwarding — never sees it. Every level went through
  // console.log, which is how a framework's warnings became indistinguishable
  // from its chatter.
  // …and the CONSOLE METHOD matches too, so a host app, a browser devtools
  // filter, or a test that watches `console.info` sees the same level the line
  // claims. Every level used to go through console.log.
  if (e.lvl === "error") console.error(line);
  else if (e.lvl === "warn") console.warn(line);
  else if (e.lvl === "info") console.info(line);
  else if (e.lvl === "debug" || e.lvl === "trace") console.debug(line);
  else console.log(line);
}

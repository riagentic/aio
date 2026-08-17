// logger-format.ts — Plain text formatter and ANSI console pretty-printer

import type { LogEntry } from "./logger-types.ts";
import { colorEnabled as USE_COLOR, paint } from "./color.ts";

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
  const cat = e.cat.padEnd(10);
  const data = e.data
    ? "  " +
      Object.entries(e.data).map(([k, v]) =>
        `${k}=${typeof v === "object" ? safeStringify(v) : v}`
      ).join(" ")
    : "";
  const dur = e.dur !== undefined ? `  ${e.dur}ms` : "";
  const src = e.src ? `  (${e.src})` : "";
  return `${e.ts}  ${lvl}  ${cat}  ${e.msg}${data}${dur}${src}`;
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

export function printConsole(e: LogEntry): void {
  const lvlStr = (typeof e.lvl === "string" ? e.lvl : "debug").toUpperCase()
    .padEnd(5);
  const color = LEVEL_COLOR[e.lvl] ?? C.gray;
  const ts = paint(e.ts, C.lightGray);
  const lvl = paint(lvlStr, color, C.bold);
  const cat = paint(e.cat.padEnd(10), C.white);
  const msg = colorizeMsg(e.msg, e.lvl);
  const data = e.data
    ? "  " +
      Object.entries(e.data).map(([k, v]) =>
        `${paint(k, C.dim)}=${
          paint(
            String(typeof v === "object" ? safeStringify(v) : v),
            C.cyan,
          )
        }`
      ).join(" ")
    : "";
  const dur = e.dur !== undefined ? `  ${paint(`${e.dur}ms`, C.magenta)}` : "";
  const line = `${ts}  ${lvl}  ${cat}  ${msg}${data}${dur}`;
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

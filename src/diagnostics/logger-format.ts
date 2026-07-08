// logger-format.ts — Plain text formatter and ANSI console pretty-printer

import type { LogEntry } from "./logger-types.ts";

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
  const ts = `${C.lightGray}${e.ts}${C.reset}`;
  const lvl = `${color}${C.bold}${lvlStr}${C.reset}`;
  const cat = `${C.white}${e.cat.padEnd(10)}${C.reset}`;
  const msg = colorizeMsg(e.msg, e.lvl);
  const data = e.data
    ? "  " +
      Object.entries(e.data).map(([k, v]) =>
        `${C.dim}${k}${C.reset}=${C.cyan}${
          typeof v === "object" ? safeStringify(v) : v
        }${C.reset}`
      ).join(" ")
    : "";
  const dur = e.dur !== undefined ? `  ${C.magenta}${e.dur}ms${C.reset}` : "";
  console.log(`${ts}  ${lvl}  ${cat}  ${msg}${data}${dur}`);
}

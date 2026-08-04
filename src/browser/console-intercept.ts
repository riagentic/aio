// console-intercept.ts — Wraps console.* and forwards output to server via send.
// Original console methods still work. Fire-and-forget; drops silently on failure.

import { enc } from "../protocol/envelope.ts";
import type { ClientLogEntry } from "../air/dom-inspector-types.ts";

export type SendFn = (msg: string) => void;

const MAX_MSG_LEN = 4096;
const MAX_STACK_LEN = 2048;

let _send: SendFn | null = null;
let _installed = false;
let _forwarding = false;

/** Update the send function (e.g. after reconnect). Pass null to disable. */
export function setConsoleSend(send: SendFn | null): void {
  _send = send;
}

/** Stringify console args, joined with space, truncated to MAX_MSG_LEN. */
export function _serialize(args: unknown[]): string {
  const parts = args.map((a) => {
    if (typeof a === "string") return a;
    // Errors JSON-stringify to "{}" (no enumerable props) WITHOUT throwing, so
    // the catch below never ran — a forwarded `console.error(err)` showed "{}".
    // Render them readably up front.
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try {
      return JSON.stringify(a);
    } catch {
      // Circular refs, BigInt, etc — extract useful info
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (a && typeof a === "object" && "constructor" in a) {
        return `[${a.constructor?.name ?? "Object"} (circular)]`;
      }
      return String(a);
    }
  });
  const full = parts.join(" ");
  return full.length > MAX_MSG_LEN ? full.slice(0, MAX_MSG_LEN) : full;
}

function _stackFrom(e: unknown): string | undefined {
  if (e instanceof Error && typeof e.stack === "string") {
    const s = e.stack;
    return s.length > MAX_STACK_LEN ? s.slice(0, MAX_STACK_LEN) : s;
  }
  return undefined;
}

/** Build a ClientLogEntry and forward it over the send channel. */
export function _forward(
  level: ClientLogEntry["level"],
  args: unknown[],
): void {
  if (!_send || _forwarding) return;
  // Diagnostic events already reach client.log server-side (the diagnostic
  // bus writes every error/warning it broadcasts); the console fallback
  // printing them (`_deliverDiag`, marked "[aio:diag]") must not loop them
  // back as a log frame or every diagnostic lands in the file twice.
  if (typeof args[0] === "string" && args[0].startsWith("[aio:diag]")) return;
  _forwarding = true;
  try {
    const entry: ClientLogEntry = {
      level,
      msg: _serialize(args),
      ts: Date.now(),
    };
    _send(enc("log", entry));
  } catch {
    // Drop silently — transport may be down.
  } finally {
    _forwarding = false;
  }
}

/**
 * Install console interceptor. Wraps console.log/info/warn/error/debug and
 * global error/unhandledrejection events. Idempotent — only installs once.
 */
// Named handlers for cleanup
let _errorHandler: ((ev: ErrorEvent) => void) | null = null;
let _rejectionHandler: ((ev: PromiseRejectionEvent) => void) | null = null;
let _origConsole: {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
} | null = null;

export function installConsoleIntercept(send: SendFn): void {
  _send = send;
  if (_installed) return;
  _installed = true;

  _origConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  const orig = _origConsole;

  console.log = (...args: unknown[]) => {
    orig.log(...args);
    _forward("info", args);
  };
  console.info = (...args: unknown[]) => {
    orig.info(...args);
    _forward("info", args);
  };
  console.warn = (...args: unknown[]) => {
    orig.warn(...args);
    _forward("warn", args);
  };
  console.error = (...args: unknown[]) => {
    orig.error(...args);
    _forward("error", args);
  };
  console.debug = (...args: unknown[]) => {
    orig.debug(...args);
    _forward("debug", args);
  };

  _errorHandler = (ev: ErrorEvent) => {
    const stack = _stackFrom(ev.error);
    const msg = "[uncaught] " + (ev.message ?? String(ev.error));
    _forward("error", stack ? [msg, stack] : [msg]);
  };
  _rejectionHandler = (ev: PromiseRejectionEvent) => {
    const reason = ev.reason;
    const stack = _stackFrom(reason);
    const msg = "[unhandled rejection] " +
      (reason instanceof Error ? reason.message : String(reason));
    _forward("error", stack ? [msg, stack] : [msg]);
  };

  globalThis.addEventListener("error", _errorHandler as EventListener);
  globalThis.addEventListener(
    "unhandledrejection",
    _rejectionHandler as EventListener,
  );
}

/** Remove interceptors and restore original console methods. */
export function uninstallConsoleIntercept(): void {
  if (!_installed) return;
  _send = null;
  if (_origConsole) {
    console.log = _origConsole.log;
    console.info = _origConsole.info;
    console.warn = _origConsole.warn;
    console.error = _origConsole.error;
    console.debug = _origConsole.debug;
    _origConsole = null;
  }
  if (_errorHandler) {
    globalThis.removeEventListener("error", _errorHandler as EventListener);
    _errorHandler = null;
  }
  if (_rejectionHandler) {
    globalThis.removeEventListener(
      "unhandledrejection",
      _rejectionHandler as EventListener,
    );
    _rejectionHandler = null;
  }
  _installed = false;
}

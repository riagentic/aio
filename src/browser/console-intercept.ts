// console-intercept.ts — Wraps console.* and forwards output to server via send.
// Original console methods still work. Fire-and-forget; drops silently on failure.

import { enc } from "../protocol/envelope.ts";
import { degraded } from "../diagnostics/degraded.ts";
import { upstreamRendererNoise } from "../diagnostics/upstream-noise.ts";
import type { ClientLogEntry } from "../air/dom-inspector-types.ts";

/** Returns whether the frame reached the wire, when the transport can say.
 *
 *  It could not, and that made the health tracker below structurally unable to
 *  fire: `_sendRaw` CATCHES its own throw and returns false, so the `try` here
 *  never saw a failure and `ok()` ran on every drop. Measured: a socket
 *  refusing every write forwarded 0 of 200 console lines while
 *  `degraded("client:log-forward")` stayed clean and `/__aio/health` reported
 *  the channel healthy. This is the channel the browser reports its own errors
 *  on — when it dies for good the page goes quiet in exactly the way that
 *  looks like "no errors", which is the case the tracker exists for.
 *
 *  `void` is still accepted: a transport that cannot tell is treated as
 *  delivered, which is where things stood. */
export type SendFn = (msg: string) => void | boolean;

const MAX_MSG_LEN = 4096;
const MAX_STACK_LEN = 2048;

let _send: SendFn | null = null;
let _hasChannel: () => boolean = () => true;
let _installed = false;
let _forwarding = false;

/** How deep {@linkcode _render} descends before printing `[Object]`/`[Array]`
 *  — the same shape Node's `console.log` uses for a deep value. */
const MAX_DEPTH = 6;

/** A NESTED value as JSON would print it, except where JSON prints a
 *  different word or nothing: `{ total: NaN, cb: undefined }` became
 *  `{"total":null}` — the NaN read as null and the key vanished — so the line
 *  in `am logs` said something the page's own console never did. Here NaN,
 *  ±Infinity, `undefined`, functions, symbols and bigints keep their console
 *  words, a cycle is `[Circular]` (JSON threw and the WHOLE argument became
 *  "[Object (circular)]"), depth is bounded, and output stops once `budget`
 *  characters are spent, so a huge object costs no more than the line it fits
 *  in. Plain data (strings, finite numbers, arrays, objects, `toJSON`) prints
 *  byte-for-byte as JSON did. */
function _render(
  v: unknown,
  depth: number,
  ancestors: readonly object[],
  budget: { left: number },
): string {
  if (budget.left <= 0) return "…";
  const out = (s: string) => {
    budget.left -= s.length;
    return s;
  };
  if (typeof v === "string") return out(JSON.stringify(v));
  if (typeof v === "bigint") return out(`${v}n`);
  if (typeof v === "function") {
    return out(`[Function ${v.name || "anonymous"}]`);
  }
  if (v === null || typeof v !== "object") return out(String(v));
  if (v instanceof Error) return out(JSON.stringify(`${v.name}: ${v.message}`));
  if (ancestors.includes(v)) return out("[Circular]");
  const toJSON = (v as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    return _render(toJSON.call(v), depth, [...ancestors, v], budget);
  }
  const isArr = Array.isArray(v);
  if (depth >= MAX_DEPTH) return out(isArr ? "[Array]" : "[Object]");
  const inner = [...ancestors, v];
  const items: string[] = [];
  budget.left -= 2;
  // Arrays by index, never a keys array: a million-element array stops at
  // the budget without first allocating a million keys.
  const keys = isArr ? null : Object.keys(v);
  const n = keys ? keys.length : (v as unknown[]).length;
  for (let i = 0; i < n; i++) {
    if (budget.left <= 0) {
      items.push("…");
      break;
    }
    const k = keys ? keys[i]! : i;
    const val = _render(
      (v as Record<string | number, unknown>)[k],
      depth + 1,
      inner,
      budget,
    );
    items.push(keys ? `${out(JSON.stringify(k))}:${val}` : val);
  }
  return isArr ? `[${items.join(",")}]` : `{${items.join(",")}}`;
}

/** Stringify console args, joined with space, truncated to MAX_MSG_LEN. */
export function _serialize(args: unknown[]): string {
  const budget = { left: MAX_MSG_LEN };
  const parts = args.map((a) => {
    if (typeof a === "string") return a;
    // Errors JSON-stringify to "{}" (no enumerable props) WITHOUT throwing, so
    // a forwarded `console.error(err)` showed "{}". Render them readably.
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    // What JSON turns into a DIFFERENT word, or into nothing at all: `NaN` /
    // `Infinity` read as "null", and `undefined` / a function / a symbol
    // stringify to `undefined`, which `join` prints as "" — so
    // `console.log("total:", NaN)` arrived in `am logs` as "total: null" and
    // `console.log("got", undefined)` as "got ". Say what the console says —
    // at the top level and nested (see `_render`).
    if (typeof a === "function") return `[Function ${a.name || "anonymous"}]`;
    if (a === null || typeof a !== "object") return String(a);
    try {
      return _render(a, 0, [], budget);
    } catch {
      // A throwing getter / toJSON / Proxy trap — say what it was.
      return `[${
        (a as { constructor?: { name?: string } }).constructor?.name ??
          "Object"
      }]`;
    }
  });
  const full = parts.join(" ");
  return full.length > MAX_MSG_LEN ? full.slice(0, MAX_MSG_LEN) : full;
}

/** The first frame OUTSIDE this file — where the `console.*` call was written.
 *
 *  Every forwarded line used to arrive attributed to the interceptor:
 *
 *      [gate] start, mouth led by 0ms   (aio://app/__aio/browser/console-intercept.ts:73)
 *      [capture] camera off — captions … (aio://app/__aio/browser/console-intercept.ts:73)
 *
 *  Always the same location, whatever emitted it. Plain devtools, Vite, Next
 *  and every Node logger report the CALLER's file and line; the interception is
 *  a genuine feature — a field report calls renderer logs reaching the server
 *  log the best thing in the framework — and it traded away the one piece of
 *  metadata that makes a log line actionable. That report ended up prefixing
 *  every message by hand (`[gate]`, `[capture]`, `[decode]`) to recover what
 *  the runtime already knew and threw away.
 *
 *  Best-effort by construction: `Error.stack` is not standardised, so an engine
 *  that formats it differently yields nothing and the line is exactly what it
 *  was before. Never throws, never costs more than one Error construction. */
function _callSite(): string | undefined {
  try {
    const lines = (new Error().stack ?? "").split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("at ")) continue;
      // Skip this file's own frames — `_callSite`, `_forward`, and the console
      // wrapper installed below all live here.
      if (line.includes("console-intercept")) continue;
      const m = /\(?((?:https?|file|aio):\/\/[^\s)]+)\)?$/.exec(line);
      const at = m?.[1];
      if (!at) continue;
      // The tail is what a reader uses — a full `aio://app/...` URL with a
      // query string is noise around `app.js:12:5`.
      return at.length > 120 ? at.slice(-120) : at;
    }
  } catch {
    // aio-ok: a stack we cannot parse is the ABSENCE of an improvement, not a
    // fault — the line still carries everything it carried before.
  }
  return undefined;
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
  // No channel is not a failed write. Before the client connects — and in a
  // harness, where it never does — the transport answers `false` for every
  // line, exactly as it does for a socket that refused one, and each console
  // call was counted as a transport failure: five `console.warn`s in a clean
  // `testUI` test escalated `client:log-forward` to degraded. The line still
  // printed locally (the wrapper calls the original first); there was simply
  // nowhere to forward it yet, and a tracker for a channel that does not exist
  // yet can only raise a false alarm. Neither ok() nor fail(): no evidence.
  if (!_hasChannel()) return;
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
      ...(_callSite() ? { source: _callSite() } : {}),
    };
    const delivered = _send(enc("log", entry));
    // …and a line that got through ENDS the episode. `degraded()`'s contract
    // is "call ok() on every success, not only the first", and this call site
    // only ever called `fail`: five dropped lines spread across a whole
    // session — each followed by thousands of successful ones — escalated and
    // then reported a permanently degraded client on /__aio/health, for the
    // life of the page. A false alarm that outlives its cause is worse than
    // no alarm, which is the argument the broadcaster already makes.
    if (delivered === false) {
      // The transport refused the write and said so instead of throwing.
      degraded("client:log-forward").fail(
        new Error("the transport refused the write — this log line was lost"),
      );
    } else {
      degraded("client:log-forward").ok();
    }
  } catch (e) {
    // A single drop is expected — the transport reconnects and the next line
    // gets through. What must not be silent is the PERMANENT case: this is the
    // channel the browser reports its own errors on, so if it dies for good
    // the page goes quiet in exactly the way that looks like "no errors".
    // `degraded` distinguishes the two by repetition and escalates to health.
    degraded("client:log-forward").fail(e);
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
let _cspHandler: ((ev: Event) => void) | null = null;
/** The eval hint is said once per install — the same eval usually runs in a
 *  loop, and one explanation is help while fifty is the noise this project
 *  refuses. */
let _saidEvalHint = false;
let _origConsole: {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
} | null = null;

export function installConsoleIntercept(
  send: SendFn,
  /** Is there a channel to forward on at all? Absent → assume there is (a
   *  transport that cannot tell is judged by `send`'s answer alone). */
  hasChannel?: () => boolean,
): void {
  // The send channel is refreshed on every call, BEFORE the idempotence guard
  // below — so a re-install after a reconnect re-points the forwarder even
  // though the console wrappers are only installed once.
  //
  // There is no separate `setConsoleSend`: there was one, documented "e.g.
  // after reconnect", and nothing ever called it. Nothing needed to. The one
  // caller (`browser-air-transport.ts`) passes `_sendRaw`, a module-level
  // function that resolves the CURRENT socket/IPC channel at call time, so a
  // reconnect never leaves a stale send pinned here. A setter for a problem
  // that does not exist reads as a problem that is being handled.
  _send = send;
  _hasChannel = hasChannel ?? (() => true);
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
    // An error the RUNTIME threw and the page cannot prevent is forwarded at
    // INFO, annotated with the upstream issue. Not dropped: the line still
    // reaches the app log and `am logs`, so anyone who looks finds it and its
    // explanation. What it must not do is tick `errors=N` — an error count
    // that is permanently non-zero for something the app did not do is the
    // fail-loud rule inverted, and it trains people to ignore the number.
    const known = upstreamRendererNoise(ev.message, ev.filename);
    if (known) {
      _forward("info", [`[uncaught] ${known.annotated}`]);
      return;
    }
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

  // aio's CSP withholds `'unsafe-eval'`, and the browser's refusal names
  // neither aio nor the way back. THE BETA PROMISE (.katana/goals.md) is that
  // a change announces itself at the site: "a break discovered by debugging is
  // a broken promise." An app that loads a template engine, an expression
  // evaluator or a plugin host would otherwise meet only
  //
  //     Refused to evaluate a string as JavaScript because 'unsafe-eval' is
  //     not an allowed source of script
  //
  // and have nothing to search for. Said ONCE — the same eval usually runs in
  // a loop — and observe-only, so prod behaves exactly as dev does: the
  // browser still refuses the eval either way, this only explains it.
  _cspHandler = (ev: Event) => {
    const e = ev as Event & {
      violatedDirective?: string;
      blockedURI?: string;
    };
    if (e.violatedDirective !== "script-src" || e.blockedURI !== "eval") return;
    if (_saidEvalHint) return;
    _saidEvalHint = true;
    _forward("warn", [
      "[aio] this page just tried to run `eval` / `new Function`, and aio's " +
      "Content-Security-Policy withholds `'unsafe-eval'` — every other " +
      "script source a page could use is still allowed. If your app needs " +
      "it (a template engine, an expression evaluator, a plugin host), opt " +
      'out by name: security: { cspDirectives: { "script-src": false } }.',
    ]);
  };

  globalThis.addEventListener("error", _errorHandler as EventListener);
  globalThis.addEventListener(
    "unhandledrejection",
    _rejectionHandler as EventListener,
  );
  globalThis.addEventListener("securitypolicyviolation", _cspHandler);
}

/** Remove interceptors and restore original console methods. */
export function uninstallConsoleIntercept(): void {
  if (!_installed) return;
  _send = null;
  _hasChannel = () => true;
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
  if (_cspHandler) {
    globalThis.removeEventListener("securitypolicyviolation", _cspHandler);
    _cspHandler = null;
  }
  _saidEvalHint = false;
  _installed = false;
}

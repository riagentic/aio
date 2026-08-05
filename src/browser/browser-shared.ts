// Shared browser utilities — used by both browser.ts (React) and browser-air.ts (AIR)
// Extracted from duplicated inline copies (AIO-47)

import type { Frame } from "../protocol/envelope.ts";
import {
  negotiateProtocol,
  parseProtoHello,
  protoHello,
  stampedVersion,
} from "../protocol/protocol-version.ts";

/** Creates { type, payload } action/effect objects.
 *
 *  RE-EXPORTED, not re-implemented. It was an inlined copy, and a copy of a
 *  fact is a fact that can drift; `msg` is trivial enough that it never did,
 *  but the module it lived beside (`schedule`) drifted badly. Neither of these
 *  pulls a single Deno-only dependency into the bundle, so there is no reason
 *  for a second copy to exist. */
export { msg } from "../state/msg.ts";

// deno-lint-ignore no-explicit-any
type _Creators = Record<string, (...args: any[]) => any>;
type _LowerFirst<S extends string> = S extends `${infer C}${infer Rest}`
  ? `${Lowercase<C>}${Rest}`
  : S;
type _FactoryResult<T extends _Creators> =
  & { readonly [K in keyof T]: K }
  & {
    readonly [K in keyof T as _LowerFirst<K & string>]: (
      ...args: Parameters<T[K]>
    ) => { type: K; payload: ReturnType<T[K]> };
  };
function _lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
function _factory<T extends _Creators>(creators: T): _FactoryResult<T> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(creators)) {
    result[key] = key;
    result[_lowerFirst(key)] = (...args: unknown[]) => ({
      type: key,
      payload: creators[key]!(...args) ?? {},
    });
  }
  return result as _FactoryResult<T>;
}
export { _factory as actions, _factory as effects };

// ── schedule (browser-compatible — pure effect creators, no timers) ──
//
// A stub rather than a re-export of `src/state/schedule.ts`, and for exactly
// ONE reason: that module pulls in `blocking.ts`, a Deno worker pool, which has
// no business in the page bundle. Every OTHER creator here is a pure function
// of its arguments and MUST behave identically to the server's — client-scoped
// cell methods and CRDT optimistic replay execute method bodies in the browser,
// so a creator that is missing or subtly different is a production-only crash.
//
// `tests/browser-shared-inline-parity.test.ts` is what keeps that true: it
// asserts key-set EQUALITY with the real `schedule` and fuzzes every creator's
// output against it. Add a creator there and the gate fails until it exists
// here too. (It was written because this copy had silently lost `backoff`,
// `poll`, `next` and `blocking`, and dropped `every`'s `skipIfRunning`.)

type _SchedResult = {
  type: string;
  kind: string;
  id: string;
  // deno-lint-ignore no-explicit-any
  [k: string]: any;
};

type _SchedAction = { type: string; payload?: unknown };

const _schedEffect = (
  kind: string,
  id: string,
  // deno-lint-ignore no-explicit-any
  extra: Record<string, any> = {},
): _SchedResult => ({ type: "__schedule", kind, id, ...extra });

/** setTimeout's int32 ceiling — see MAX_TIMER_DELAY in src/state/schedule.ts.
 *  The parity gate fuzzes `backoff`/`poll` past this bound, so a wrong value
 *  here is a red test, not a silently different clamp. */
const _MAX_TIMER_DELAY = 2_147_483_647;

/** Blocking work needs a Deno worker pool; a browser has none. Absent, it read
 *  as `schedule.blocking is not a function` at the call site — present and
 *  loud, it names the platform and the fix. */
const _blocking = (id: string): never => {
  throw new Error(
    `[aio] schedule.blocking is server-only (task id: ${id}) — it runs a Deno ` +
      `worker pool, which does not exist in a browser/WebView runtime. Call ` +
      `it from a server-side method and let the client read the result from ` +
      `state.`,
  );
};
_blocking.cancel = (id: string): never => _blocking(id);
_blocking.disposeIdle = (): never => _blocking("disposeIdle");
_blocking.dispose = (): never => _blocking("dispose");

export const schedule: {
  after(id: string, ms: number, action: _SchedAction): _SchedResult;
  every(
    id: string,
    ms: number,
    action: _SchedAction,
    opts?: { skipIfRunning?: boolean },
  ): _SchedResult;
  at(id: string, time: string, action: _SchedAction): _SchedResult;
  cron(id: string, pattern: string, action: _SchedAction): _SchedResult;
  backoff(
    id: string,
    attempt: number,
    opts: { base: number; max?: number; factor?: number },
    action: _SchedAction,
  ): _SchedResult;
  poll(
    id: string,
    attempt: number,
    opts: { every: number; backoff?: number; max?: number },
    action: _SchedAction,
  ): _SchedResult;
  next(id: string, action: _SchedAction): _SchedResult;
  cancel(id: string): _SchedResult;
  blocking: typeof _blocking;
} = {
  after: (id: string, ms: number, action: _SchedAction): _SchedResult =>
    _schedEffect("after", id, { ms, action }),
  every: (
    id: string,
    ms: number,
    action: _SchedAction,
    opts?: { skipIfRunning?: boolean },
  ): _SchedResult =>
    _schedEffect("every", id, {
      ms,
      action,
      ...(opts?.skipIfRunning ? { skipIfRunning: true } : {}),
    }),
  at: (id: string, time: string, action: _SchedAction): _SchedResult =>
    _schedEffect("at", id, { time, action }),
  cron: (id: string, pattern: string, action: _SchedAction): _SchedResult =>
    _schedEffect("cron", id, { pattern, action }),
  backoff: (
    id: string,
    attempt: number,
    opts: { base: number; max?: number; factor?: number },
    action: _SchedAction,
  ): _SchedResult => {
    const factor = opts.factor ?? 2;
    const max = opts.max ?? _MAX_TIMER_DELAY;
    const ms = Math.min(
      opts.base * Math.pow(factor, Math.max(0, attempt)),
      max,
    );
    return _schedEffect("after", id, {
      ms: Math.max(1, Math.round(ms)),
      action,
    });
  },
  poll: (
    id: string,
    attempt: number,
    opts: { every: number; backoff?: number; max?: number },
    action: _SchedAction,
  ): _SchedResult => {
    const factor = opts.backoff ?? 1;
    const max = opts.max ?? _MAX_TIMER_DELAY;
    const ms = attempt <= 0
      ? opts.every
      : Math.min(opts.every * Math.pow(factor, attempt), max);
    return _schedEffect("after", id, {
      ms: Math.max(1, Math.round(ms)),
      action,
    });
  },
  next: (id: string, action: _SchedAction): _SchedResult =>
    _schedEffect("after", id, { ms: 1, action }),
  cancel: (id: string): _SchedResult => _schedEffect("cancel", id),
  blocking: _blocking,
};

// ── own ──────────────────────────────────────────────────────────────
// Cell modules import `own` at module top; the browser loads them for typed
// action creators, so the import must resolve. It is the REAL `own` — pure
// effect creators plus a Map, no Deno API, nothing to gain from a second copy.
export { own } from "../state/own.ts";

// ── Transport helpers (shared between browser.ts and browser-air.ts) ──

/** IPC bridge type — exposed by Electron preload as window.__aioIPC */
export type AioIPCBridge = {
  send(d: string): void;
  onMessage(fn: (line: string) => void): void;
  onOpen(fn: () => void): void;
  onClose(fn: () => void): void;
  ready(): void;
  print?(): void;
  /** Open an http/https link in the system browser (main-process allowlisted). */
  openExternal?(url: string): void;
};

/** Detect Electron IPC bridge from window.__aioIPC */
export function detectIPC(): AioIPCBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as Record<string, unknown>).__aioIPC as
    | AioIPCBridge
    | undefined ?? null;
}

/** Build WebSocket URL from current page location */
export function buildWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const tokenParam = new URLSearchParams(location.search).get("token");
  return proto + "//" + location.host + "/ws" +
    (tokenParam ? "?token=" + encodeURIComponent(tokenParam) : "");
}

/** Refresh all same-origin stylesheets (cache-bust with ?t=timestamp) */
export function refreshCSS(): void {
  document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
    const el = link as HTMLLinkElement;
    if (el.href.startsWith(location.origin)) {
      el.href = el.href.split("?")[0] + "?t=" + Date.now();
    }
  });
}

/**
 * Handle control frames common to both WS and IPC transports (v2 envelope).
 * Returns true if the frame was handled (caller should return early).
 * The caller decodes — one `dec()` per line, at the transport's front door.
 */
/** Late-bound sink for the server's "cfg" frame — browser-protocol registers
 *  the applier (it owns sync adoption), this module stays import-cycle-free. */
export const _cfgSink: {
  apply: ((cfg: Record<string, unknown>) => void) | null;
} = { apply: null };

export function handleControlFrame(
  f: Frame,
  bootId: { current: string | null },
  /** Called for a TERMINAL protocol failure. A version gap means the two sides
   *  cannot read each other's frames, so the transport must stop — retrying
   *  cannot fix it. Without this the IPC path logged the mismatch and left the
   *  connection open, trading frames neither side could interpret, against an
   *  envelope contract that says a mismatch "closes the socket with code 4505
   *  — loudly, never silently". */
  onFatal?: (reason: string) => void,
): boolean {
  switch (f.t) {
    case "reload":
      location.reload();
      return true;
    case "cfg": {
      // Runtime config handshake: a shell templated at BUILD time (electron
      // UDS, android assets) cannot embed compose-time decisions — the server
      // sends them as an early frame instead. Shell-injected values win
      // per-key (they are the same values, delivered earlier).
      const cfg = f.d as Record<string, unknown> | undefined;
      if (cfg && typeof cfg === "object") _cfgSink.apply?.(cfg);
      return true;
    }
    case "css":
      refreshCSS();
      return true;
    case "boot": {
      const id = (f.d as { id?: string } | undefined)?.id ?? "";
      if (bootId.current && bootId.current !== id) {
        location.reload();
        return true;
      }
      bootId.current = id;
      return true;
    }
    case "graph-error":
    case "graph-clear":
      // Dev overlay owns these; a bundle without the overlay reloads to
      // pick up the corrected build.
      location.reload();
      return true;
    // A3: version hellos on transports without their own handler (IPC —
    // client and server ship in one bundle, a real mismatch is a packaging
    // bug).
    case "proto": {
      const theirs = parseProtoHello(f.d);
      if (theirs) {
        const result = negotiateProtocol(protoHello(stampedVersion()), theirs);
        if (!result.ok) {
          console.error(`[aio] protocol version mismatch: ${result.reason}`);
          onFatal?.(result.reason);
        }
      }
      return true;
    }
    case "proto-err": {
      const reason = (f.d as { reason?: string } | undefined)?.reason ?? "?";
      console.error(`[aio] server rejected protocol version: ${reason}`);
      onFatal?.(reason);
      return true;
    }
    default:
      return false;
  }
}

// Shared browser utilities — used by both browser.ts (React) and browser-air.ts (AIR)
// Extracted from duplicated inline copies (AIO-47)

import type { Frame } from "../protocol/envelope.ts";
import {
  negotiateProtocol,
  parseProtoHello,
  protoHello,
  stampedVersion,
} from "../protocol/protocol-version.ts";

/** Creates { type, payload } action/effect objects */
export function msg<T extends string>(
  type: T,
): { type: T; payload: Record<string, never> };
export function msg<T extends string, P>(
  type: T,
  payload: P,
): { type: T; payload: P };
export function msg(type: string, payload?: unknown) {
  return { type, payload: payload ?? {} };
}

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

// ── schedule stubs (browser-compatible — pure effect creators, no timers) ──

type _SchedResult = {
  type: string;
  kind: string;
  id: string;
  // deno-lint-ignore no-explicit-any
  [k: string]: any;
};

const _schedEffect = (
  kind: string,
  id: string,
  // deno-lint-ignore no-explicit-any
  extra: Record<string, any> = {},
): _SchedResult => ({ type: "__schedule", kind, id, ...extra });

export const schedule: {
  after(
    id: string,
    ms: number,
    action: { type: string; payload?: unknown },
  ): _SchedResult;
  every(
    id: string,
    ms: number,
    action: { type: string; payload?: unknown },
  ): _SchedResult;
  at(
    id: string,
    time: string,
    action: { type: string; payload?: unknown },
  ): _SchedResult;
  cron(
    id: string,
    pattern: string,
    action: { type: string; payload?: unknown },
  ): _SchedResult;
  cancel(id: string): _SchedResult;
} = {
  after: (
    id: string,
    ms: number,
    action: { type: string; payload?: unknown },
  ): _SchedResult => _schedEffect("after", id, { ms, action }),
  every: (
    id: string,
    ms: number,
    action: { type: string; payload?: unknown },
  ): _SchedResult => _schedEffect("every", id, { ms, action }),
  at: (
    id: string,
    time: string,
    action: { type: string; payload?: unknown },
  ): _SchedResult => _schedEffect("at", id, { time, action }),
  cron: (
    id: string,
    pattern: string,
    action: { type: string; payload?: unknown },
  ): _SchedResult => _schedEffect("cron", id, { pattern, action }),
  cancel: (id: string): _SchedResult => _schedEffect("cancel", id),
};

// ── own stubs (browser-compatible — pure effect creators, no registry) ──
// Cell modules import `own` at module top; the browser loads them for typed
// action creators, so the import must resolve. Methods only run server-side,
// so the factory is never invoked here — no factory registry needed.

type _OwnResult = {
  type: "__own";
  kind: string;
  id: string;
  token?: number;
};

let _ownToken = 1;

export const own: {
  set(id: string, factory: () => unknown): _OwnResult;
  dispose(id: string): _OwnResult;
} = {
  set: (id: string, _factory: () => unknown): _OwnResult => ({
    type: "__own",
    kind: "set",
    id,
    token: _ownToken++,
  }),
  dispose: (id: string): _OwnResult => ({ type: "__own", kind: "dispose", id }),
};

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
export function handleControlFrame(
  f: Frame,
  bootId: { current: string | null },
): boolean {
  switch (f.t) {
    case "reload":
      location.reload();
      return true;
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
        }
      }
      return true;
    }
    case "proto-err":
      console.error(
        `[aio] server rejected protocol version: ${
          (f.d as { reason?: string } | undefined)?.reason ?? "?"
        }`,
      );
      return true;
    default:
      return false;
  }
}

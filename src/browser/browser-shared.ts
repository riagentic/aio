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

// ── schedule ─────────────────────────────────────────────────────────
// The REAL `schedule` — src/state/schedule.ts is Deno-free since alpha70 (the
// worker pool lives in blocking.ts and is no longer imported there), so the
// browser bundle exports the one implementation instead of a hand-kept twin.
// `tests/browser-shared-inline-parity.test.ts` pins that they are the same.
export { schedule } from "../state/schedule.ts";

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

/** Does this page have an HTTP origin a WebSocket could reach? On an `aio://`
 *  page (the zero-port Electron shell) there is none — the IPC bridge is the
 *  ONLY transport, and `ws://app/ws` is a socket that cannot exist. */
export function hasHttpOrigin(): boolean {
  return typeof location !== "undefined" &&
    /^https?:$/.test(location.protocol);
}

/** The one message for a page that can reach nothing: no HTTP origin to open
 *  a WebSocket to, and no IPC bridge either. */
export const NO_TRANSPORT_MSG =
  "page has no HTTP origin and no IPC bridge \u2014 the aio:// page must be " +
  "loaded by the aio Electron shell";

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

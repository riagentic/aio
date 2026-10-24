// CLI client — state client for Deno (terminal-side equivalent of browser.ts)
// Connects to an aio server via WebSocket or UDS, receives state updates, sends actions.
// Same delta protocol as browser.ts but no DOM, no React — pure Deno runtime.

import { enablePatches } from "immer";
import {
  applyWirePatches,
  type WirePatch as Patch,
} from "../protocol/patch-ops.ts";
// The offline-queue depth is one fact — the browser client reads the same
// constant. This file had its own 100 beside it.
import { WS_MAX_QUEUE } from "../protocol/protocol-types.ts";
import {
  connectLocal,
  type LocalConn,
  socketPathState,
} from "./local-listen.ts";
import {
  backoffDelay,
  FRAME_TOO_LARGE_CLOSE,
  isFrameTooLarge,
} from "../protocol/transport-shared.ts";
import {
  type AckPayload,
  dec,
  enc,
  type Frame,
  v1PeerReason,
  wireError,
} from "../protocol/envelope.ts";
import { encodeAction } from "../state/action-encode.ts";
import { LARGE_STATE_DOC } from "../state/budgets.ts";
import { bindCell } from "../state/cell-catalog.ts";
import { _releaseCellBindings } from "../state/cell-reactive.ts";
import type { CellDef, Msg } from "../state/cell-types.ts";
import {
  ackMethodKey,
  type AckRegistry,
  createAckRegistry,
  SETTLES_CALLS,
} from "../protocol/ack-registry.ts";
import { ACK_TIMEOUT_MS } from "../protocol/protocol-types.ts";
import { capDelay } from "../state/timer-ceiling.ts";
import {
  createSendPacer,
  type PacedFrame,
  type SendPacer,
} from "../protocol/send-pacer.ts";
import { VERSION } from "./aio-cli.ts";
import { readBuildStamp } from "./app-version.ts";
import { appDenoJsonLocated } from "./aio-run-helpers.ts";
import { isCompiled } from "./paths.ts";

/** The app version a COMPILED client announces: the stamp its build embedded
 *  (docs/build/versioning.md). A source run announces none — the server's
 *  hello is the fact a client needs, not the other way round. */
function stampedAppVersion(): string | undefined {
  if (!isCompiled()) return undefined;
  const located = appDenoJsonLocated();
  return located ? readBuildStamp(located.dir)?.version : undefined;
}
import {
  negotiateProtocol,
  parseProtoHello,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  protoHello,
  rememberPeerHello,
} from "../protocol/protocol-version.ts";

import { log } from "../diagnostics/logger-api.ts";
import { redactUrlToken } from "../diagnostics/redact.ts";
import { count, describeThrown, thrownText } from "../diagnostics/fmt.ts";
import { createLineReader } from "../protocol/line-reader.ts";

/** How often a CLI client says "still here". Matches the browser's heartbeat
 *  interval; the server's `frozen` threshold is 2000 ms, so this has to be
 *  comfortably inside it. */
const CLI_HEARTBEAT_MS = 1000;
/** A local-socket client failing to connect this long says so once, at
 *  warn, with what the socket path is (B20). */
export const UNREACHABLE_SAY_MS = 5_000;

/** Written heartbeats with no frame back after which a connection that has
 *  answered a ping before is dead — the page's ceiling (`SILENT_BEATS_DEAD`
 *  in browser-vitals.ts). A socket over a network that went away closes only
 *  when TCP gives up, minutes later; `watch()` sat stale on it until then. */
const CLI_SILENT_BEATS_DEAD = 20;

/** How many times one call is re-sent after the server answers "dropped,
 *  retry after N ms" before its caller gets that refusal — the browser
 *  transport's bound (`MAX_BUDGET_RETRIES` in browser-air-transport.ts). A
 *  paced client should need none; this bounds a server that keeps its window
 *  shut (the global fuse, tripped by OTHER clients) so a call cannot wait
 *  forever. */
const CLI_MAX_BUDGET_RETRIES = 8;

/** A frame waiting on a socket's pacer. `action` is set for an action frame,
 *  so a frame still waiting when its socket dies goes back to the offline
 *  queue instead of being lost; `tries` counts server refusals it was re-sent
 *  after. Heartbeats, hellos and resync requests carry no action and are
 *  dropped with the socket — the next one sends its own. */
type CliOutFrame = PacedFrame & {
  action?: { type: string; payload?: unknown; cid?: string };
  tries?: number;
};

enablePatches();

/** Apply one decoded state frame ("state" snapshot or "patches" delta) to
 *  the current state. Returns the new state. On a patch that fails to apply
 *  (desync), returns the prior state unchanged and calls `onResync` so the
 *  caller can ask the server for a fresh snapshot. Shared by the WS and UDS
 *  client paths so both transports apply deltas identically. */
function applyServerFrame<S>(
  prev: S | null,
  frame: Frame,
  onResync?: () => void,
): S | null {
  if (frame.t === "patches") {
    if (prev != null && Array.isArray(frame.d)) {
      try {
        // `append` and Immer's ops alike — the ONE applier (patch-ops.ts).
        return applyWirePatches(
          prev as unknown as Record<string, unknown>,
          frame.d as Patch[],
        ) as unknown as S;
      } catch {
        // desync — ask the server for a full snapshot
        onResync?.();
      }
    }
    return prev;
  }
  // Full state
  return frame.d as S;
}

/** Minimum gap between `resync` asks of a client that is out of sync. */
const RESYNC_MIN_MS = 2_000;

/** The `offline` option of the internal `_connectCli`/`_connectCliUDS`. */
export type CliOffline = "queue" | "fail";

/** What a call the server asked to re-send gets, said once per client. */
const HELD = (failOffline: boolean): string =>
  failOffline
    ? `held and re-sent on this connection (offline: "fail" — it fails if ` +
      `the connection drops first)`
    : "held and re-sent, not failed";

/** The rejection of a call made while disconnected under `offline: "fail"`. */
function offlineRefusal(what: string): Error {
  return new Error(
    `not connected to ${what} — the call was NOT sent and will not be sent ` +
      `later (offline: "fail")`,
  );
}

/** A call on a client that was close()d: never sent, never queued — the
 *  queue it would wait in is never drained again, so it hung for ever. */
function closedRefusal(type: string): Error {
  return new Error(
    `[aio:cli] "${type}" was NOT sent — this client is closed (close() is ` +
      `final; connect again to call)`,
  );
}

/** The wire action of a call by name — the frame a bound method sends. */
function callAction(cell: string, method: string, args: unknown[]): Msg {
  if (
    typeof cell !== "string" || !cell || typeof method !== "string" || !method
  ) {
    throw new TypeError(
      `call(cell, method, ...args): cell and method must be non-empty ` +
        `strings — got ${JSON.stringify(cell)}, ${JSON.stringify(method)}`,
    );
  }
  return { type: `${cell}:${method}`, payload: { args } } as Msg;
}

/** Reactive WS client handle — subscribe to state, send actions, close when done */
export type CliApp<S> = {
  /** Current state (null until first message from server) */
  readonly state: S | null;
  /** Send an action to the server */
  send(action: { type: string; payload?: unknown }): void;
  /** Bind cell definitions to this connection — after `cli.bind(counter)`,
   *  `await counter.increment(1)` dispatches over the socket (resolves on
   *  the server ack) and `counter.count` reads the latest server state. No
   *  raw `{ type, payload }` wire actions needed. */
  bind(...cells: import("../state/cell-types.ts").CellDef[]): void;
  /** Subscribe to state changes — returns unsubscribe function. Fires immediately if state exists. */
  subscribe(fn: (state: S) => void): () => void;
  /** Close the connection (no reconnect) */
  close(): void;
  /** Whether WS is currently open AND carries the app's state — false while
   *  a full state the server could not send this client (over the WebSocket
   *  message ceiling, `ws-frame-ceiling`) is outstanding; `state` then reads
   *  null. */
  readonly connected: boolean;
  /** Resolves when first state is received */
  readonly ready: Promise<S>;
};

/** The connection `peer()` drives: a `CliApp` plus a call BY NAME — no cell
 *  definition, no source of the other app. `call("todo", "add", "milk")`
 *  sends exactly the frame a bound `todo.add("milk")` sends (same ack, same
 *  return value, same `access` gate on the server); an unknown cell or method
 *  rejects with the server's reason. Internal: the public door is `peer()`. */
export type CliLink<S> = CliApp<S> & {
  call(cell: string, method: string, ...args: unknown[]): Promise<unknown>;
  /** `call`, asking for the method's `emitChunk`s: each reaches `onChunk`,
   *  in order, before the returned promise settles with the result. */
  stream(
    cell: string,
    method: string,
    args: unknown[],
    onChunk: (value: unknown) => void,
  ): Promise<unknown>;
  /** Fires each time "this connection carries the app's state" changes: true
   *  when a connection delivers state, false when it drops (never for the
   *  caller's own `close()`). Returns unsubscribe. */
  onStatus(fn: (connected: boolean) => void): () => void;
};

/** Where each streamed call's chunks go, by `cid` — until the call settles. */
type ChunkRoutes = Map<string, (value: unknown) => void>;

function _chunkTo(
  routes: ChunkRoutes,
  cid: string,
  onChunk: (value: unknown) => void,
  settled: Promise<unknown>,
): void {
  routes.set(cid, onChunk);
  const off = () => void routes.delete(cid);
  settled.then(off, off);
}

/** A chunk is the server answering for the call: each one restarts its ack
 *  clock, so `ackTimeoutMs` bounds the SILENCE of a streamed call, never a
 *  stream that is still delivering (a 20 s chat reply under the 15 s default
 *  was rejected mid-reply). `unwrite` + `armTimer` = stop and restart it. */
function _alive(
  pending: AckRegistry,
  cid: string,
  onChunk: (value: unknown) => void,
): (value: unknown) => void {
  return (value) => {
    if (pending.isWritten(cid)) {
      pending.unwrite(cid);
      pending.armTimer(cid);
    }
    onChunk(value);
  };
}

/** Deliver one `chunk` frame. A listener that throws is reported, and the
 *  call goes on — its result still arrives. */
function _routeChunk(routes: ChunkRoutes, d: unknown): void {
  const { cid, value } = (d ?? {}) as { cid?: unknown; value?: unknown };
  if (typeof cid !== "string") return;
  try {
    routes.get(cid)?.(value);
  } catch (e) {
    log.warn("cli", `a stream's onChunk threw: ${thrownText(e)}`);
  }
}

/** "This connection carries the app's state": true when a socket delivers its
 *  first state, false when that socket closes — told to listeners only when it
 *  changes. A listener that throws is reported and does not stop the transport
 *  or the others. The caller's own `close()` tells nobody (cleared first). */
function statusEmitter() {
  const fns = new Set<(up: boolean) => void>();
  let last = false;
  return {
    on(fn: (up: boolean) => void): () => void {
      fns.add(fn);
      return () => void fns.delete(fn);
    },
    set(now: boolean): void {
      if (now === last) return;
      last = now;
      for (const fn of [...fns]) {
        try {
          fn(now);
        } catch (e) {
          log.warn("cli", `an onStatus listener threw: ${thrownText(e)}`);
        }
      }
    },
    clear(): void {
      fns.clear();
    },
  };
}

/** One call's ceiling, decided once per client: past the timer ceiling it
 *  would reject in ~1 ms, and NaN (`Number(env)` unset) did exactly that to
 *  every call — `0` or less still means "wait for ever". */
function _ackCeiling(ms: number | undefined): number {
  return capDelay(
    "ackTimeoutMs",
    ms ?? ACK_TIMEOUT_MS,
    (m) => log.warn("cli", m),
    ACK_TIMEOUT_MS,
  );
}

/** Connect to an aio server. URL can be http:// or ws:// — protocol is auto-detected. */
/** Wire the first-connect deadline onto a `ready` promise.
 *
 *  Shared by both transports so "can I detect a connection that never
 *  happened" does not depend on which one an app picked. Returns the settle
 *  function each client calls on its first state frame — settling clears the
 *  deadline, so a slow-but-successful connect never rejects afterwards. */
function _readyDeadline<S>(
  what: string,
  ms: number | undefined,
  resolve: (s: S) => void,
  reject: (e: Error) => void,
): {
  settle: (s: S) => void;
  abandon: () => void;
  refuse: (e: Error) => void;
} {
  let done = false;
  let timer: number | undefined;
  // NaN is not "no deadline" by accident: it is said (and then is none).
  if (ms !== undefined) {
    ms = capDelay("readyTimeoutMs", ms, (m) => log.warn("cli", m), 0);
  }
  if (ms && ms > 0) {
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(
        new Error(
          `[aio:cli] no connection to ${what} after ${ms}ms — the address, ` +
            `the token or the certificate is wrong (a reachable server sends ` +
            `state immediately). Reconnection continues in the background; ` +
            `call close() to stop it.`,
        ),
      );
    }, ms) as unknown as number;
    // Never hold a process open just to report a failure.
    try {
      Deno.unrefTimer(timer);
    } catch { /* not Deno (browser bundle) — nothing to unref */ }
  }
  return {
    settle: (s: S) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(s);
    },
    // The server ANSWERED the first connection with a refusal (401/403/429):
    // no retry inside the deadline can turn that into a yes, so the caller
    // who set one is told now, with the server's status — not the generic
    // line when the deadline runs out. No deadline: `ready` waits, as before.
    refuse: (e: Error) => {
      if (done || timer === undefined) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    },
    // close() before the first state. The deadline used to stay armed past
    // close(): it fired later and told an already-closed client to "call
    // close() to stop it" (and held a timer the sanitizers report), while
    // without a deadline `await ready` after close() never returned. A client
    // closed before it connected will never connect — say so now.
    abandon: () => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      reject(
        new Error(
          `[aio:cli] client closed before the first connection to ${what}`,
        ),
      );
    },
  };
}

/** ONE cap policy for this file's two hand-written queues, the same one the
 *  shared factory uses (`state/offline-queue.ts`): at cap the OLDEST queued
 *  action is dropped — newest intent wins — and ITS caller is rejected NOW,
 *  rather than waiting out an ack timeout for a frame that was discarded
 *  locally.
 *
 *  Why this file has its own queues at all: the shared factory rejects a
 *  dropped action through the module-level `_ackSink`, which is the BROWSER's
 *  singleton. A CLI client registers acks PER CONNECTION on purpose (D2: one
 *  client's disconnect must never settle another client's calls), so it cannot
 *  use that sink. The implementation has to be separate; the policy does not.
 *
 *  It used to refuse the NEWEST action instead — keeping stale intent and
 *  throwing away the freshest, which is exactly the shape `offline-queue.ts`
 *  was written to end between the browser and the core. Three queues, two
 *  implementations, one policy. */
function _pushDroppingOldest(
  queue: Array<{ type: string; payload?: unknown }>,
  pending: { reject(cid: string, err: Error): boolean },
  transport: string,
  action: { type: string; payload?: unknown },
  /** Actions this client already ACCEPTED for sending — handed to a socket's
   *  pacer, then taken back unsent when that socket closed. The cap bounds
   *  calls made while offline and never evicts one of these: the pacer holds
   *  any number of them while online, so evicting them made a blip, not the
   *  app, decide which calls failed — and it evicted the EARLIEST. Measured:
   *  300 calls, a 0.5 s blip at 1 s, 121 rejected "offline queue full" while
   *  later calls applied. When only accepted actions are left to evict, the
   *  NEW call is the one refused, at its call. */
  accepted?: WeakSet<object>,
): void {
  while (queue.length >= WS_MAX_QUEUE) {
    const at = accepted ? queue.findIndex((a) => !accepted.has(a)) : 0;
    if (at < 0) {
      const cid = (action as { cid?: string }).cid;
      if (cid) {
        pending.reject(
          cid,
          new Error(
            `action NOT sent — the offline queue is full (${WS_MAX_QUEUE}) ` +
              `of ${queue.length} earlier calls that were accepted before ` +
              `the connection dropped; they replay first, and this one was ` +
              `refused rather than evict them`,
          ),
        );
      }
      log.warn(
        "cli",
        `${transport} queue full (${WS_MAX_QUEUE}) of calls accepted before ` +
          `the connection dropped — refused the new action ("${action.type}")`,
      );
      return;
    }
    const [dropped] = queue.splice(at, 1) as [
      { type: string; payload?: unknown },
    ];
    const cid = (dropped as { cid?: string }).cid;
    if (cid) {
      pending.reject(
        cid,
        new Error(
          `action dropped — offline queue full (${WS_MAX_QUEUE}); a newer ` +
            `action took its place, so this one was NOT sent`,
        ),
      );
    }
    log.warn(
      "cli",
      `${transport} queue full (${WS_MAX_QUEUE}) — dropped the oldest queued ` +
        `action ("${dropped.type}") to make room for "${action.type}"`,
    );
  }
  queue.push(action);
}

/** Refuse, at the call, a URL no retry can ever connect to.
 *
 *  `connectCli("localhost:8000")` parses — as protocol `localhost:` with an
 *  EMPTY host — so the client dialled `ws:///ws` and logged "still retrying"
 *  forever; `ftp://host:8000` was quietly dialled as `ws://`. Both are a typo
 *  that the retry loop turned into an apparent hang. Only the four schemes the
 *  socket URL is derived from are accepted, and the refusal shows the spelling
 *  that works. */
function assertCliUrl(url: string): void {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch { /* reported below, with the fix */ }
  const ok = parsed !== undefined && parsed.host !== "" &&
    ["http:", "https:", "ws:", "wss:"].includes(parsed.protocol);
  if (ok) return;
  const bare = /^[A-Za-z0-9.-]+:\d+(\/.*)?$/.test(url) ||
    /^[A-Za-z0-9.-]+(\/.*)?$/.test(url);
  throw new TypeError(
    `connectCli: ${JSON.stringify(url)} is not an app URL — ` +
      (parsed && parsed.host !== "" && !bare
        ? `the scheme "${parsed.protocol}" is not one a client can connect ` +
          `with (use http:, https:, ws: or wss:). `
        : `it needs a scheme and a host. `) +
      `Write it the way the app's boot banner prints it, e.g. ` +
      `connectCli("http://${
        bare ? url : parsed?.host ? parsed.host : "localhost:8000"
      }").`,
  );
}

/** Deno's `WebSocket` constructor takes `{ headers }` (a Deno extension); the
 *  DOM typing this file compiles against knows only `protocols`. */
type DenoWebSocket = new (
  url: string,
  opts: { headers: Record<string, string> },
) => WebSocket;

/** The status a refused WebSocket handshake carries in Deno's error text
 *  (`… Invalid status code: 401`), when it is a refusal no retry turns into
 *  a yes: 401, 403, 429. Pure. @internal */
export function _refusedStatus(reason: string): number | undefined {
  const m = /Invalid status code: (\d{3})\b/.exec(reason);
  const status = m ? Number(m[1]) : undefined;
  return status === 401 || status === 403 || status === 429
    ? status
    : undefined;
}

/** What a terminal client says when the server's frame is over its runtime's
 *  message ceiling — every reconnect, because the app is getting no state at
 *  all. Pure, so the hint and the chapter link are pinned by
 *  tests/large-state-hints.test.ts without a 64 MiB frame. @internal */
export function frameTooLargeMessage(
  closeReason: string,
  retryMs: number,
): string {
  return `the server sent a frame this runtime refuses: ${
    closeReason || "message too large"
  }. Deno's WebSocket takes at most 64 MiB per message and cannot be ` +
    `raised, so every reconnect ends the same way — the app's state is too ` +
    `big to push to a terminal client. Fix (in the app): keep bulk rows in ` +
    `db: tables and page them into state, or hide the big cell from this ` +
    `client (visible) — see ${LARGE_STATE_DOC}. Retrying in ${retryMs}ms.`;
}

/** Does this call end in an `undefined` argument — the one shape
 *  `wire.omitTrailingUndefined` changes on the wire? Pure. */
function endsUndefined(action: { payload?: unknown }): boolean {
  const args = (action.payload as { args?: unknown } | undefined)?.args;
  return Array.isArray(args) && args.length > 0 &&
    args[args.length - 1] === undefined;
}

/** `wire` as a `cfg` frame carries it. Pure. */
function cfgOmits(d: unknown): boolean {
  return (d as { wire?: { omitTrailingUndefined?: unknown } } | undefined)
    ?.wire?.omitTrailingUndefined === true;
}

/** Connect a CLI process to a running aio app as a real client: live state,
 *  method calls, and reconnect with the offline queue — the terminal twin of a
 *  browser client. */
export function connectCli<S>(
  url: string,
  opts?: {
    /** Auth token — a string, or a FUNCTION resolved before every (re)connect.
     *  Pass a function when tokens expire (a 5-minute signed assertion): a
     *  static string 401s forever on the first silent reconnect past its
     *  window, which no retry can fix (a field report hand-rolled a refresh
     *  loop for exactly this). A rejected token() follows the normal
     *  reconnect backoff. */
    token?: string | (() => string | Promise<string>);
    /** Ceiling for one bound-cell call, ms (0 = wait indefinitely). Defaults
     *  to the shared `ACK_TIMEOUT_MS`. A CLI client has no page shell, so the
     *  server's per-method budgets cannot be bridged to it — an app whose
     *  methods legitimately run for minutes raises this. */
    ackTimeoutMs?: number;
    /** Reject `ready` if the FIRST connection has not succeeded within this
     *  many ms. Off by default: a client that HAS connected should out-wait a
     *  flaky network, and that is the common case.
     *
     *  The first attempt is a different question. A wrong URL, a wrong token
     *  and an untrusted certificate never become right by retrying, and with
     *  `ready` unsettled a caller cannot tell them from a slow server — the
     *  console said "still retrying" while `await app.ready` simply never
     *  returned, which reads as a hang. Set this wherever a failure has to be
     *  REPORTABLE rather than waited on: a script, a test, a service-to-service
     *  link. Reconnection continues regardless; this is about the caller
     *  getting an answer, not about giving up. */
    readyTimeoutMs?: number;
  },
): CliApp<S> {
  return _connectCli<S>(url, opts);
}

/** `connectCli` with the options only `peer()` sets. @internal */
export function _connectCli<S>(
  url: string,
  opts?: Parameters<typeof connectCli>[1] & {
    /** Extra handshake headers (`peer()`'s identity proof), resolved fresh
     *  before EVERY (re)connect — a proof is bound to the boot it is sent to. */
    headers?: () => Promise<Record<string, string>>;
    /** What a call made while disconnected does. `"queue"` (default): it
     *  waits in the offline queue and is sent on reconnect — right for user
     *  intent. `"fail"`: it rejects AT ONCE and is never sent later — right
     *  for a service call whose answer is only worth having now. */
    offline?: CliOffline;
    /** Where the app is NOW — asked before every reconnect; a URL other than
     *  the current one is followed (`peer()` re-reads the lock files, since a
     *  restarted app binds a new port). Undefined: stay on the current URL. */
    retarget?: () => string | undefined;
  },
): CliLink<S> {
  assertCliUrl(url);
  const _failOffline = opts?.offline === "fail";
  let state: S | null = null;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let wasConnected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** Consecutive connections killed by an oversized frame — the reconnect
   *  backoff grows with it instead of restarting at 1 s on every open. */
  let _tooLarge = 0;
  /** The server REFUSED a full state for this client (`ws-frame-ceiling`):
   *  the copy it held is gone and no patch applies until a full state lands.
   *  See the `diag` case. */
  let _outOfSync = false;
  const _status = statusEmitter();
  const _chunks: ChunkRoutes = new Map();
  /** Last `resync` asked while out of sync, and the one queued behind it. */
  let _resyncAt = 0;
  let _resyncTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: Array<{ type: string; payload?: unknown }> = [];
  const listeners = new Set<(state: S) => void>();
  /** Which app answered on this URL, learned on the first connect.
   *
   *  A port is not an identity. A dev server takes a FREE port, so an app that
   *  dies can have its port taken by a DIFFERENT app — and this client would
   *  reconnect, flush the offline queue into a stranger's database and resolve
   *  every one of those calls as success. MEASURED with two scaffolded apps
   *  sharing one port: two decrements queued for app A landed in app B, whose
   *  counter went 0 → -2, with nothing said anywhere. The browser transport
   *  already scopes its offline queue by appId for exactly this reason (see
   *  `AioWindow.__aioConfig.appId`); this transport carried no identity at all.
   */
  let peerAppId: string | undefined;
  let _wrongPeerNoted: string | undefined;
  // One registry PER CONNECTION (not the browser's module-level singleton):
  // `connectCli` can be called more than once in a process, and one client's
  // disconnect must never settle another's pending calls (D2).
  const _ack = _ackCeiling(opts?.ackTimeoutMs);
  /** cid → action type of every call still awaiting its ack, and the
   *  `type\0message` of the last calls refused — a `reduce-error` diag for a
   *  throw THIS client's call already rejects with is not said twice (TCP
   *  printed it as `server diagnostic`, UDS never did). */
  const _callTypes = new Map<string, string>();
  const _rejectedRecently = new Set<string>();
  const _pending = createAckRegistry(
    () => _ack,
    (m) => log.warn(m),
  );
  // Cells bound through THIS client — released on close() so the same defs can
  // be bound again by a later client (a cell def binds to exactly ONE
  // dispatcher, and until now there was no way to give it back).
  const _bound: import("../state/cell-types.ts").CellDef[] = [];

  // ── one paced writer per socket ────────────────────────────────────────────
  //
  // EVERY frame this client writes goes through the open socket's pacer: bound
  // calls, `send()`, the offline flush, the hello, the heartbeat, resync. The
  // server counts all of them against one per-connection budget and says what
  // it is in its hello (`rate`), so one writer honouring it is the only shape
  // that CAN honour it.
  //
  // MEASURED before this (a real server in a subprocess, the default 100/sec):
  // `Promise.allSettled` over 150 bound `inc()` calls gave ok 99 / rejected 51
  // — 50 "frame dropped", 1 "connection lost" — and the server closed the
  // socket with 1008 and denylisted the address. The hello was read for its
  // version and nothing else. Same design as the browser transport
  // (browser-air-transport.ts), which had the same bug.

  /** The pacer for the socket that is open now; null while there is none. */
  let pacer: SendPacer<CliOutFrame> | null = null;
  // `aio.run({ wire })` — the server's decision, used HERE: this client
  // encodes the call. It arrives in the `cfg` frame. Until the answer is in
  // for this connection, a call it would change (one that ends in
  // `undefined`) waits in the queue, with everything behind it. Any other
  // call goes out exactly as it always has: same bytes, same order, no wait.
  //
  // WHEN the answer is in, from what a server sends on connect — `proto`,
  // the state, `tt-state` (dev), `boot`, and then `cfg` only if it has
  // something to say, as the LAST frame of that burst:
  //   · `cfg` is read — that is the answer; or
  //   · any other frame is read after `boot` — `cfg` would have been the
  //     very next one, so none is coming and the default stands.
  // A quiet server sends nothing after `boot`, so a call that is waiting when
  // `boot` has been read asks for a `resync`: its reply is that frame, and it
  // was asked after the server had already sent its `cfg`, if it had one.
  // A socket that closes first leaves the calls in the queue, where the
  // offline path (the next connection, or `close()`'s rejection) has them.
  //
  // A server since 1.0.20 says in its hello whether a `cfg` follows
  // (`ProtoHello.cfg`), and the hello is its first frame: `false` is the
  // answer there and then — nothing waits, nothing is asked; `true` means the
  // frame is on its way, so the wait is for it alone and no `resync` is
  // spent. The proof above is for a server that does not say.
  // `undefined` = not asked by this server: the process default stands.
  let wireOmit: true | undefined;
  let wireKnown = false;
  let wireHeld = false;
  let wireBootRead = false;
  let wireAsked = false;
  let wireComing = false;
  const _wireWaits = (a: { payload?: unknown }): boolean => {
    if (wireKnown || !(wireHeld || endsUndefined(a))) return false;
    wireHeld = true;
    _wireAsk();
    return true;
  };
  /** The one frame that makes a quiet server prove no `cfg` is coming. */
  function _wireAsk(): void {
    if (!wireHeld || !wireBootRead || wireKnown || wireAsked) return;
    if (wireComing) return;
    if (!pacer || ws?.readyState !== WebSocket.OPEN) return;
    wireAsked = true;
    try {
      pacer.push({ frame: enc("resync"), seq: _seq++ });
    } catch {
      /* aio-ok: closing — the queue keeps the calls for the next open */
    }
  }
  /** The answer is in for this connection. Send what waited for it. */
  function _wireSettled(): void {
    if (wireKnown) return;
    wireKnown = true;
    if (!wireHeld) return;
    wireHeld = false;
    _drainQueue();
  }
  /** The `rate` this client's server last advertised. Per client, not the
   *  module-level `peerHello()`: one process may hold clients to two servers
   *  with different budgets. */
  let peerRate: number | undefined;
  /** Arrival order across the offline queue and the pacer, so a re-sent call
   *  goes back where it was rather than to the back of the line. */
  let _seq = 0;
  /** Action frames written and not yet acked — kept so a frame the server
   *  drops with a retry hint can be sent again. Cleared on ack and on close. */
  const _written = new Map<string, CliOutFrame>();
  /** Actions taken back unsent from a closed socket's pacer — never evicted
   *  by the offline cap (`_pushDroppingOldest`). Weak: an entry goes with its
   *  action once it is sent and settled. */
  const _accepted = new WeakSet<object>();

  function _pacerFor(socket: WebSocket): SendPacer<CliOutFrame> {
    return createSendPacer<CliOutFrame>({
      write: (entry) => {
        // A CLOSING socket is offline for this frame. Refuse rather than write
        // into a socket that will never deliver it and arm a clock for a call
        // that never left; the frame goes back to the offline queue.
        if (socket.readyState !== WebSocket.OPEN) {
          throw new Error("the socket is no longer open");
        }
        socket.send(entry.frame);
        const cid = entry.action?.cid;
        if (!cid) return;
        // The call's ack clock starts HERE, when its frame actually leaves —
        // never while it waits on the pacer or in the offline queue.
        _pending.armTimer(cid);
        _written.set(cid, entry);
        // A call settled some other way (timed out) leaves its entry behind;
        // sweep those rather than grow with a long-lived client.
        if (_written.size > 2048) {
          for (const k of _written.keys()) {
            if (!_pending.isWritten(k)) _written.delete(k);
          }
        }
      },
      onRefused: (entries, err) => {
        const back = _requeuePaced(entries);
        if (back > 0) {
          log.warn(
            "cli",
            `the WebSocket refused a paced write (${err}) — ` +
              `${count(back, "action")} back in the offline queue, in order`,
          );
        }
      },
      rate: () => peerRate,
    });
  }

  /** Frames never written (still paced, or refused by the socket): actions go
   *  back into the offline queue AHEAD of anything queued after them, under
   *  the queue's one cap policy; other frames are dropped. None was written,
   *  so no caller is in flight and none is rejected for it here. Returns how
   *  many actions went back. */
  const _triesOf = new WeakMap<object, number>();
  function _requeuePaced(entries: CliOutFrame[]): number {
    const actions = entries.flatMap((e) => e.action ? [e.action] : []);
    if (actions.length === 0) return 0;
    // `offline: "fail"`: never sent later — each caller is told now.
    if (_failOffline) {
      for (const a of actions) _refuseOffline(a, true);
      return 0;
    }
    // Ahead of everything queued after them, and OUTSIDE the cap: each was
    // already accepted (see `_pushDroppingOldest`'s `accepted`), and pushing
    // them back through the cap evicted the oldest of them.
    for (const a of actions) _accepted.add(a);
    // The refusal count survives the queue: a reconnect must not reset the
    // re-send cap (a server that refuses, then drops the socket, would see
    // the same write forever).
    for (const e of entries) {
      if (e.action && e.tries) _triesOf.set(e.action, e.tries);
    }
    queue.unshift(...actions);
    _noteQueued();
    return actions.length;
  }

  /** The server dropped a call's frame before running it and said when a
   *  re-send will be taken (`AckPayload.retryAfterMs`). Hold the call and send
   *  it again, instead of failing a write that was never attempted. Returns
   *  true when the ack was consumed that way; false settles the caller as
   *  usual. */
  let _retryNoted = false;
  function _retryRefusedCall(d: AckPayload): boolean {
    const { cid, ok, retryAfterMs } = d;
    if (typeof cid !== "string") return false;
    const entry = _written.get(cid);
    _written.delete(cid);
    if (
      ok !== false || !entry?.action || typeof retryAfterMs !== "number" ||
      !Number.isFinite(retryAfterMs) || retryAfterMs < 0 ||
      // Still awaited: a call that already timed out was told it failed, and
      // re-sending it would land a write its caller gave up on.
      !_pending.isWritten(cid)
    ) return false;
    if ((entry.tries ?? 0) >= CLI_MAX_BUDGET_RETRIES) return false;
    // Not in flight any more — the server said so. A close from here on must
    // re-queue this call, not reject it as "connection lost".
    _pending.unwrite(cid);
    const again: CliOutFrame = { ...entry, tries: (entry.tries ?? 0) + 1 };
    if (!_retryNoted) {
      _retryNoted = true;
      log.warn(
        "cli",
        // The server's own reason, not a guess at it: a budget drop is per
        // message, per byte or the server-wide fuse, and naming the wrong
        // knob sends the reader to raise a limit that was never hit.
        `the server dropped a call and asked for a re-send in ${
          Math.round(retryAfterMs)
        }ms (${d.error ?? "over a per-second budget"}) — ${
          HELD(_failOffline)
        }` +
          `. If this repeats, raise the budget it names in ` +
          `aio.run({ wsLimits: { messagesPerSec, bytesPerSec } }) or batch ` +
          `the calls. Further re-sends are not repeated here.`,
      );
    }
    if (pacer) {
      // Nothing this socket sends can be taken before the window reopens.
      pacer.hold(Math.min(retryAfterMs, 10_000));
      try {
        pacer.push(again);
      } catch {
        _requeuePaced([again]);
      }
    } else {
      _requeuePaced([again]);
    }
    return true;
  }

  /** Write an action, or queue it while the socket is down.
   *
   *  Returns which happened, because the caller must be able to tell a real
   *  send from a silent drop: this used to `return` without sending OR queuing
   *  once the client had connected at least once, so an action issued during a
   *  reconnect vanished with no error anywhere — a quiet write loss in exactly
   *  the window a reconnecting client spends most of its time in. */
  function _trySend(
    action: { type: string; payload?: unknown },
  ): { written: boolean; queued: boolean } {
    // ENCODE BEFORE DECIDING WHERE IT GOES. Only the connected branch used to
    // encode, so a value JSON cannot carry threw at the call site when
    // connected and was queued in silence when not — the same action, two
    // answers, and the queued one poisoned the drain below for good.
    //
    // "written" means handed to the open socket's pacer: it leaves on THIS
    // socket at the advertised pace, and its call's clock starts when it does.
    const frame = encodeAction(action, wireOmit);
    const open = !!pacer && !!ws && ws.readyState === WebSocket.OPEN;
    if (open && !_wireWaits(action) && pacer) {
      try {
        pacer.push({ frame, action, seq: _seq++ });
        return { written: true, queued: false };
      } catch {
        // The socket says OPEN and refuses the write — offline in every way
        // that matters to this action. Queue it like the no-socket path.
      }
    }
    // Waiting for `cfg` on an open socket is not "offline".
    if (_failOffline && !(open && wireHeld)) {
      _refuseOffline(action);
      return { written: false, queued: false };
    }
    _pushDroppingOldest(queue, _pending, "offline", action, _accepted);
    if (!(open && wireHeld)) _noteQueued();
    return { written: false, queued: true };
  }

  /** Whether a call written now leaves on an open socket. */
  function _isUp(): boolean {
    return !!pacer && !!ws && ws.readyState === WebSocket.OPEN;
  }

  /** `offline: "fail"`: settle an unsent call now — its caller rejects, a
   *  fire-and-forget `send` throws. Never queued, so never sent later. */
  function _refuseOffline(
    action: { type: string; payload?: unknown },
    /** From a close/requeue path: a fire-and-forget action has no caller to
     *  throw to there — throwing would abort the close handler. Dropped, said. */
    inClose = false,
  ): void {
    const cid = (action as { cid?: string }).cid;
    if (cid) return void _pending.reject(cid, offlineRefusal(url));
    if (!inClose) throw offlineRefusal(url);
    log.warn(
      "cli",
      `"${action.type}" (sent without awaiting) dropped — ${
        offlineRefusal(url).message
      }`,
    );
  }

  /** Say — once per offline period — that actions are being held rather than
   *  sent. A queued call's promise stays PENDING until its frame is written
   *  (it has not failed; it has not happened), so the one thing that must
   *  never happen is for that wait to be unexplained. */
  let _queueNoted = false;
  function _noteQueued(): void {
    if (_queueNoted) return;
    _queueNoted = true;
    log.warn(
      "cli",
      `offline — actions are queued in memory (max ${WS_MAX_QUEUE}) ` +
        `and sent on reconnect; awaited calls stay pending until then, and ` +
        `close() rejects whatever is still queued`,
    );
  }

  /** Flush the queue into the open socket's pacer, in order. */
  function _drainQueue(): void {
    const sink = pacer;
    if (!sink || !ws || ws.readyState !== WebSocket.OPEN) return;
    // Drain queued actions into the pacer, in order. Each frame's ack clock
    // starts when the pacer actually writes it — not at dispatch time, or an
    // action queued for longer than the ceiling times out while still
    // sitting in the queue and is then delivered anyway.
    const q = [...queue];
    queue.length = 0;
    _queueNoted = false;
    for (let i = 0; i < q.length; i++) {
      const a = q[i]!;
      // The first call the unknown answer would change stops the flush: it
      // and everything behind it stay queued, in order, until `_wireSettled`.
      if (_wireWaits(a)) {
        queue.unshift(...q.slice(i));
        return;
      }
      const cid = (a as { cid?: string }).cid;
      // Two failures, two answers. A frame that cannot be BUILT can never be
      // sent, so it is dropped alone and its caller told; a transport that
      // refuses the WRITE is offline, so the remainder goes back in the
      // queue at its place in line. The bare loop had neither: one throw
      // abandoned every action behind it and left their callers pending.
      let frame: string;
      try {
        frame = encodeAction(a, wireOmit);
      } catch (err) {
        if (cid) {
          _pending.reject(
            cid,
            err instanceof Error ? err : new Error(String(err)),
          );
        }
        continue;
      }
      try {
        const tries = _triesOf.get(a);
        sink.push({
          frame,
          action: a,
          seq: _seq++,
          ...(tries ? { tries } : {}),
        });
      } catch (err) {
        queue.unshift(...q.slice(i));
        log.warn(
          "cli",
          `the queue flush stopped after ${i} of ${q.length} action(s) — ` +
            `the socket refused the write (${err}); the rest are back in ` +
            `the queue, in order, and go out on the next connection`,
        );
        return;
      }
    }
  }

  let _readyResolve: ((s: S) => void) | null = null;
  let _readyAbandon: (() => void) | null = null;
  let _readyRefuse: ((e: Error) => void) | null = null;
  const ready = new Promise<S>((r, j) => {
    const d = _readyDeadline<S>(url, opts?.readyTimeoutMs, r, j);
    _readyResolve = d.settle;
    _readyAbandon = d.abandon;
    _readyRefuse = d.refuse;
  });
  // An unhandled rejection is not the point of the deadline — a caller that
  // never awaits `ready` (the normal UI case) must not crash the process.
  ready.catch(() => {});

  let connecting = false;
  /** Cancels a `/__aio/health` identity request still in flight at `close()`:
   *  a closed client holds no handle open, and the answer has no reader. */
  const peerAbort = new AbortController();
  /** The appId this URL currently answers with, or undefined if it cannot be
   *  learned. `/__aio/health` is a public route and already carries `appId`,
   *  so this needs no protocol change and no new option. EVERY failure — an
   *  older server without the field, auth, an untrusted certificate, a refused
   *  connection — returns undefined, which means "no opinion" and leaves
   *  behaviour exactly as it was. */
  async function _peerIdentity(
    token: string | undefined,
  ): Promise<string | undefined> {
    try {
      const parsed = new URL(url);
      const scheme = parsed.protocol === "https:" || parsed.protocol === "wss:"
        ? "https:"
        : "http:";
      const t = token ?? parsed.searchParams.get("token") ?? undefined;
      const res = await fetch(
        `${scheme}//${parsed.host}/__aio/health`,
        {
          signal: peerAbort.signal,
          ...(t ? { headers: { authorization: `Bearer ${t}` } } : {}),
        },
      );
      if (!res.ok) {
        await res.body?.cancel();
        return undefined;
      }
      const body = await res.json() as { appId?: unknown };
      return typeof body.appId === "string" && body.appId
        ? body.appId
        : undefined;
    } catch {
      // aio-ok: no opinion — the check degrades to the old behaviour.
      return undefined;
    }
  }

  /** Learn who we are talking to, once, without delaying the first connect. */
  function _rememberPeer(token: string | undefined): void {
    if (peerAppId !== undefined) return;
    _peerIdentity(token).then((id) => {
      if (id && peerAppId === undefined) peerAppId = id;
    });
  }

  /** May we reopen? Asked only on a RECONNECT, and only once an identity is
   *  known — a first connect is never delayed by this. */
  async function _sameAppAsBefore(
    token: string | undefined,
  ): Promise<boolean> {
    const now = await _peerIdentity(token);
    if (now === undefined || now === peerAppId) return true;
    if (_wrongPeerNoted !== now) {
      _wrongPeerNoted = now;
      const shown = redactUrlToken(url); // a share link carries its key
      log.error(
        "cli",
        `${shown} is now served by a DIFFERENT app ("${now}", was ` +
          `"${peerAppId}") — the port was reused. NOT reconnecting: ` +
          `${queue.length} queued action(s) belong to "${peerAppId}" and ` +
          `would be written into "${now}". Still retrying in case the ` +
          `original app comes back; point this client at the right URL, or ` +
          `close() it to reject what is queued.`,
      );
    }
    return false;
  }

  function connect(): void {
    if (ws || closed || connecting) return;
    const moved = wasConnected ? opts?.retarget?.() : undefined;
    if (moved !== undefined && moved !== url) {
      assertCliUrl(moved);
      log.info(
        "cli",
        `${redactUrlToken(url)} → ${redactUrlToken(moved)}: the app ` +
          `restarted on a new address — following it`,
      );
      url = moved;
    }
    const t = opts?.token;
    const h = opts?.headers;
    const hdrs = async () => h ? await h() : {};
    // A reconnect to a KNOWN peer is verified first; a first connect is not
    // (there is nothing yet to compare, and nothing yet to protect).
    if (wasConnected && peerAppId !== undefined) {
      connecting = true;
      Promise.resolve()
        .then(() => typeof t === "function" ? t() : t)
        .then(async (tok) => {
          const ok = await _sameAppAsBefore(tok);
          const extra = ok ? await hdrs() : {};
          connecting = false;
          if (ws || closed) return;
          if (ok) return _openSocket(tok, extra);
          reconnectTimer = setTimeout(connect, backoffDelay(retry));
          retry++;
        })
        .catch((e) => {
          connecting = false;
          if (closed) return;
          log.error(
            "cli",
            `token() / handshake headers failed: ${e} — retrying`,
          );
          reconnectTimer = setTimeout(connect, backoffDelay(retry));
          retry++;
        });
      return;
    }
    if (typeof t !== "function" && !h) return _openSocket(t, {});
    // A function token is resolved fresh before EVERY (re)connect — this is
    // the whole point (an expiring assertion must not be frozen at connect
    // #1). A rejection is a failed attempt, not a dead client: same backoff.
    connecting = true;
    Promise.resolve().then(async () =>
      [typeof t === "function" ? await t() : t, await hdrs()] as const
    ).then(
      ([tok, extra]) => {
        connecting = false;
        if (ws || closed) return;
        _openSocket(tok, extra);
      },
      (e) => {
        connecting = false;
        if (closed) return;
        log.error(
          "cli",
          `token() / handshake headers failed: ${e} — retrying`,
        );
        reconnectTimer = setTimeout(connect, backoffDelay(retry));
        retry++;
      },
    );
  }

  function _openSocket(
    explicitToken: string | undefined,
    extra: Record<string, string>,
  ): void {
    const parsed = new URL(url);
    // wss:/https: stay secure — a TLS server never answers plain ws:
    const proto = parsed.protocol === "https:" || parsed.protocol === "wss:"
      ? "wss:"
      : "ws:";
    // token: explicit option wins, else the ?token= from the share-link URL
    const token = explicitToken ?? parsed.searchParams.get("token") ??
      undefined;
    // The credential rides in a HEADER, never the URL: a URL is what ends up
    // in proxy logs — and in this client's own "cannot reach <url>" line,
    // which printed every token it retried with. Deno's WebSocket takes
    // headers; only a runtime that cannot set one falls back to `?token=`.
    const inHeader = !!token && typeof Deno !== "undefined";
    const viaHeaders = inHeader ||
      (Object.keys(extra).length > 0 && typeof Deno !== "undefined");
    const wsUrl = `${proto}//${parsed.host}/ws${
      token && !inHeader ? `?token=${encodeURIComponent(token)}` : ""
    }`;
    const shownUrl = redactUrlToken(wsUrl);

    const socket = viaHeaders
      ? new (WebSocket as unknown as DenoWebSocket)(wsUrl, {
        headers: {
          ...extra,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      })
      : new WebSocket(wsUrl);

    // The heartbeat the browser client has always sent. Without it the server
    // graded this client by the age of a `vitals-ping` that never arrived, and
    // `server-broadcast.ts` skips a client graded frozen — so `watch()` and
    // `subscribe()` stopped receiving state two seconds after connecting, for
    // the life of the socket, with no error anywhere. The server no longer
    // grades a client that has never pinged, and this makes THIS client one
    // that does, so a real drop is still detected.
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    // The silent-socket rule (CLI_SILENT_BEATS_DEAD): judged only once this
    // connection has answered a ping; any frame resets the count.
    // Not judged while a call is in flight whose own ceiling outlives the
    // window (`ackTimeoutMs` 0 = for ever, or past 20 s): that caller said the
    // server may be busy that long — inside a long sync method it answers no
    // ping — and giving the socket up rejected a call the server then
    // committed. Its ack (any frame) or its own ceiling ends the wait.
    let ponged = false, silent = 0;
    const longCallOut = () =>
      (_ack <= 0 || _ack > CLI_SILENT_BEATS_DEAD * CLI_HEARTBEAT_MS) &&
      _pending.size() > 0;
    const stopHeartbeat = () => {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeat = undefined;
    };

    socket.onopen = () => {
      retry = 0;
      wasConnected = true;
      _rememberPeer(explicitToken);
      // A fresh budget per socket — the server's counters are per connection.
      // `peerRate` is deliberately KEPT from the last hello: a reconnect
      // flushes the offline queue before this socket's hello can arrive, and
      // the same app's last advertised budget is a far better guess than the
      // default (which a 5/sec server answers by dropping most of the flush).
      // The pacer reads it live, so the new hello re-paces what still waits.
      const paced = _pacerFor(socket);
      pacer = paced;
      // A3: announce our wire-protocol version before anything else.
      paced.push({
        frame: enc("proto", protoHello(VERSION, stampedAppVersion())),
        seq: _seq++,
      });
      stopHeartbeat();
      heartbeat = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        // Frames already waiting prove liveness when they land (the server
        // refreshes it on ANY frame); a ping queued behind a burst would only
        // spend budget the burst is waiting for.
        if (paced.length > 0) return;
        if (ponged && silent >= CLI_SILENT_BEATS_DEAD && !longCallOut()) {
          log.warn(
            "cli",
            `no frame from ${shownUrl} for ${CLI_SILENT_BEATS_DEAD} ` +
              `heartbeats — the connection is dead, reconnecting`,
          );
          // Its close may never come back over a dead network: the close
          // path runs now, and the socket is told to close on its own time —
          // and has nothing more to say: a late frame is not this client's.
          const onclose = socket.onclose;
          socket.onclose = socket.onmessage = socket.onerror = null;
          try {
            socket.close();
          } catch { /* aio-ok: already closing — the path below runs anyway */ }
          onclose?.call(
            socket,
            new CloseEvent("close", { code: 1006, reason: "silent" }),
          );
          return;
        }
        // No render meter on a CLI client, so nothing is ever "unpainted".
        try {
          paced.push({
            frame: enc("vitals-ping", { t1: Date.now(), ms: 0 }),
            seq: _seq++,
          });
          silent++;
        } catch {
          /* aio-ok: the socket closed between the check and the send */
        }
      }, CLI_HEARTBEAT_MS);
      // A heartbeat must never be the reason a CLI process refuses to exit.
      if (heartbeat !== undefined) Deno.unrefTimer?.(heartbeat);

      // A new connection is a new answer: the server may have restarted
      // with another config.
      // …and its `cfg` is the only word on `wire`: a server that came back
      // without the option sends none (and, before 1.0.20, says nothing in
      // its hello), so the last connection's answer must not outlive it.
      wireOmit = undefined;
      wireKnown = false;
      wireHeld = false;
      wireBootRead = false;
      wireAsked = false;
      wireComing = false;
      _drainQueue();
    };

    socket.onmessage = (e: MessageEvent) => {
      silent = 0;
      const raw = e.data;
      if (typeof raw !== "string") return;

      const frame = dec(raw);
      if (frame?.t === "vitals-pong") ponged = true;
      if (!frame) {
        // The one v1 shim: a v1 server's hello/refusal is still readable.
        const v1 = v1PeerReason(raw);
        if (v1) {
          log.error("cli", `protocol version mismatch: ${v1}`);
          closed = true;
          socket.close(PROTOCOL_MISMATCH_CLOSE_CODE, "protocol mismatch");
        }
        return;
      }
      // A frame after `boot` that is not `cfg`: no `cfg` is coming — unless
      // the server said one is (a frame of another client's broadcast can
      // land between the two).
      if (wireBootRead && !wireComing && frame.t !== "cfg") _wireSettled();
      switch (frame.t) {
        // Browser-only signals — irrelevant in a terminal.
        case "reload":
        case "css":
        case "tt-state":
          return;
        // "How do I encode a call" — see `wireOmit` for the rule.
        case "cfg":
          wireOmit = cfgOmits(frame.d) || undefined;
          _wireSettled();
          return;
        case "boot":
          wireBootRead = true;
          _wireAsk();
          return;
        // A server-side refusal aimed at THIS client (an oversized frame it
        // will never receive, a rejected subscription): the browser paints it
        // in the overlay, and a terminal client dropped it — so the one
        // message explaining why no state ever arrives was thrown away.
        // Errors only: informational diagnostics are the panel's business.
        case "diag": {
          const d = frame.d as
            | {
              type?: string;
              severity?: string;
              message?: string;
              hint?: string;
              detail?: unknown;
            }
            | null;
          const at = (d?.detail as { actionType?: unknown } | undefined)
            ?.actionType;
          const ownRejection = d?.type === "reduce-error" &&
            typeof at === "string" &&
            ([..._callTypes.values()].includes(at) ||
              _rejectedRecently.has(`${at}\0${d.message}`));
          if (
            d && d.severity === "error" && typeof d.message === "string" &&
            !ownRejection
          ) {
            log.error(
              "cli",
              `server diagnostic: ${d.message}${d.hint ? ` (${d.hint})` : ""}`,
            );
          }
          // The server refused a FULL STATE for this client and kept the
          // socket open. The copy held here is now a state the server no
          // longer has, and every later patch is a delta against the one it
          // refused: applying them showed `blob.len=0 n=2` against a server
          // at 70 MB n=2 — a state that never existed, reported `connected`.
          // Drop it: `state` reads null and `connected` false until a full
          // state fits; patches are not applied meanwhile, each asks for one.
          if (d?.type === "ws-frame-ceiling") {
            _outOfSync = true;
            state = null;
            log.error(
              "cli",
              `out of sync: the server could not send this client its state ` +
                `(over the WebSocket message ceiling) — the copy held here ` +
                `was dropped (state reads null, connected false) rather than ` +
                `patched on a base the server no longer has. It is asked ` +
                `for again on every change and taken once it fits.`,
            );
          }
          return;
        }
        // Per-action acks for bound-cell method calls.
        //
        // The ack carries `ok`, the method's return `value`, and on refusal
        // the server's `error` — this used to read ONLY `cid` and resolve, so
        // a method that threw resolved exactly like one that succeeded and
        // every return value was dropped. An app could not tell "done" from
        // "refused" (a field report built a whole parallel error channel —
        // ~150 lines — because a promise could not reject). The browser
        // clients have always branched on `ok`; this is that same contract.
        case "notify": {
          // A control client cannot show a desktop card; it can say the
          // sentence, which is what a headless operator wanted anyway.
          const n = (frame.d ?? {}) as { title?: string; body?: string };
          log.info(
            "cli",
            `notify: ${n.title ?? ""}${n.body ? ` — ${n.body}` : ""}`,
          );
          return;
        }
        case "icon": {
          // The app's run-time icon (appIcon()): no icon here, so the line.
          const d = (frame.d ?? {}) as Record<string, unknown>;
          const what = ["window", "tray", "tooltip"].filter((k) =>
            Object.hasOwn(d, k)
          )
            .map((k) =>
              k === "tooltip"
                ? `tooltip ${JSON.stringify(d.tooltip)}`
                : `${k} ${
                  d[k] === null
                    ? "default"
                    : Array.isArray(d[k]) && (d[k] as unknown[]).length > 1
                    ? "animated"
                    : "static"
                }`
            );
          log.info("cli", `appIcon: ${what.join(" · ")}`);
          return;
        }
        case "chunk":
          _routeChunk(_chunks, frame.d);
          return;
        case "ack": {
          const d = (frame.d ?? {}) as AckPayload;
          const { cid, ok, value } = d;
          if (typeof cid !== "string") return;
          // Dropped over a budget that reopens by itself: re-sent, not failed.
          if (_retryRefusedCall(d)) return;
          _written.delete(cid);
          if (ok === false) {
            const t = _callTypes.get(cid);
            if (t !== undefined) {
              _rejectedRecently.add(`${t}\0${d.error}`);
              if (_rejectedRecently.size > 64) {
                _rejectedRecently.delete(
                  _rejectedRecently.values().next().value!,
                );
              }
            }
            // `wireError`, not `new Error(error)`: it carries the server's
            // `code` through onto `err.code`, so `errorCode(err)` tells an
            // access denial from the app's own throw without matching text.
            _pending.reject(
              cid,
              wireError(d, "the server refused the action"),
            );
          } else {
            _pending.resolve(cid, value);
          }
          return;
        }
        // A3: wire-protocol version handshake — terminal on mismatch.
        case "proto": {
          const theirs = parseProtoHello(frame.d);
          if (theirs) {
            rememberPeerHello(theirs);
            // The budget this socket's writes are paced to.
            peerRate = theirs.rate;
            // The server's own word on `cfg` — see `wireOmit`.
            wireComing = theirs.cfg === true;
            if (theirs.cfg === false) {
              wireOmit = undefined;
              _wireSettled();
            }
          }
          // Unreadable is not "no check" — the gate would fail open; it stops
          // loudly, as a mismatch does (the browser client's rule).
          const result = theirs
            ? negotiateProtocol(protoHello(VERSION), theirs)
            : {
              ok: false as const,
              reason: `unreadable server hello: ${
                JSON.stringify(frame.d)?.slice(0, 120)
              }`,
            };
          if (!result.ok) {
            log.error("cli", `protocol version mismatch: ${result.reason}`);
            closed = true; // stop the reconnect loop — retrying can't fix it
            socket.close(PROTOCOL_MISMATCH_CLOSE_CODE, "protocol mismatch");
          }
          return;
        }
        case "proto-err":
          log.error(
            "cli",
            `server rejected protocol version: ${
              (frame.d as { reason?: string } | undefined)?.reason ?? "?"
            }`,
          );
          closed = true;
          return;
        case "state":
        case "patches": {
          _status.set(true);
          // STATE arrived: this connection really can carry the app's traffic,
          // so the oversized-frame streak (and the backoff it holds up) ends.
          // Deliberately not "any frame": an old server sends its small `proto`
          // hello before the state that kills the socket, and resetting on that
          // put the retry clock back to 1 s on every attempt.
          _tooLarge = 0;
          if (_outOfSync) {
            // No base to apply a patch to — only a full state ends it.
            if (frame.t === "patches") {
              requestResync();
              return;
            }
            _outOfSync = false;
            clearTimeout(_resyncTimer);
            _resyncTimer = undefined;
          }
          state = applyServerFrame(state, frame, () => {
            // desync — request full state from server
            if (socket.readyState === WebSocket.OPEN && pacer) {
              try {
                pacer.push({ frame: enc("resync"), seq: _seq++ });
              } catch { /* aio-ok: closing — the reconnect sends full state */ }
            }
          }) as S;
          // Resolve ready on first state
          if (state != null && _readyResolve) {
            _readyResolve(state);
            _readyResolve = null;
          }
          if (state != null) { for (const fn of listeners) fn(state); }
          return;
        }
        default:
          return; // other diagnostics — irrelevant in a terminal
      }
    };

    // The error channel is not noise: the runtime reports "Frame too large"
    // here and then closes, and this handler used to throw that away — so a
    // server pushing a state over the 64 MiB WebSocket message ceiling read as
    // an ordinary disconnect and was retried, at full speed, forever, with
    // nothing said anywhere. Kept as a REASON for the close below, which is
    // where one line is worth printing.
    let closeReason = "";
    socket.onerror = (e) => {
      closeReason = e instanceof ErrorEvent ? e.message : String(e);
    };

    socket.onclose = (ev) => {
      // A socket already replaced says nothing about the current one.
      if (ws === socket || ws === null) _status.set(false);
      stopHeartbeat();
      // Frames still waiting on this socket's pacer were never written:
      // actions go back to the offline queue, at their place in line, and
      // replay on the next open. Before the in-flight rejection below, which
      // does not touch them (none was written). After close() the pacer was
      // already emptied and its callers rejected — nothing to take back.
      if (pacer && ws === socket) {
        const left = pacer.take();
        pacer = null;
        if (!closed) _requeuePaced(left);
      }
      // `offline: "fail"`: calls held for `cfg` on this socket die with it.
      if (_failOffline) {
        for (const a of queue.splice(0)) _refuseOffline(a, true);
      }
      _written.clear();
      // A dropped connection can never ack. These calls did NOT demonstrably
      // succeed, so they must not resolve: resolving them reported success for
      // work whose fate is unknown, and an app that awaited one carried on as
      // though its write had landed. Rejecting is the honest answer — the
      // error says what is and is not known, and `state` remains the truth.
      //
      // IN-FLIGHT ONLY. `queue` survives this close and is drained by the next
      // `onopen`, so rejecting a still-queued call — with a message that
      // promises "the action is not resent automatically" — was a guarantee
      // this very client then broke: the app retried as invited and the server
      // applied one user intent twice.
      const lost = _pending.rejectInFlight(
        new Error(
          "connection lost before the server confirmed this action — it may " +
            "or may not have been applied; re-check state before retrying " +
            "(the action is not resent automatically)",
        ),
      );
      if (lost > 0) {
        log.warn(
          "cli",
          `connection lost with ${lost} unacked action(s) — rejected; verify via state`,
        );
      }
      ws = null;
      if (closed) return;
      // The server said no to the FIRST connection, at once: a caller with a
      // deadline hears it now, with the status, instead of after the whole
      // deadline as "the address, the token or the certificate is wrong".
      const refused = wasConnected ? undefined : _refusedStatus(closeReason);
      if (refused !== undefined) {
        _readyRefuse?.(
          Object.assign(
            new Error(
              `[aio:cli] ${shownUrl} refused the connection (${refused}) — ${
                refused === 429
                  ? "too many failed attempts from here; wait, then retry " +
                    "with the right credential"
                  : refused === 401
                  ? "the token is wrong, missing or expired (or an identity " +
                    "proof did not verify — the other app's log says which)"
                  : "this caller is not allowed in"
              }. Reconnection continues in the background; call close() to ` +
                `stop it.`,
            ),
            { status: refused },
          ),
        );
      }
      // A frame this runtime cannot take: 64 MiB is Deno's WebSocket message
      // ceiling and there is no option to raise it, so reconnecting gets the
      // same frame and the same death. Say so — every time, because the app is
      // getting no state at all — and never let the reconnect clock reset to
      // its 1 s floor for it: an aio server refuses such a frame and tells the
      // peer (`ws-frame-ceiling`), and anything older kept the loop spinning.
      if (isFrameTooLarge(closeReason) || ev.code === FRAME_TOO_LARGE_CLOSE) {
        _tooLarge++;
        retry = Math.max(retry, _tooLarge);
        log.error(
          "cli",
          frameTooLargeMessage(closeReason, backoffDelay(retry)),
        );
      }
      if (!wasConnected && retry === 2) {
        // A `wss://` dial that NEVER opened is, more often than not, the
        // self-signed cert an exposed aio server generates: Deno's WebSocket
        // has no API to pass a CA, so the connection dies before any protocol
        // frame and the generic "check the server is running" line sends
        // people to look at the wrong thing (R-7). DENO_CERT is read
        // at process start, so this can only be said, not fixed from here.
        const tlsHint = proto === "wss:"
          ? `\n  If the server uses aio's self-signed cert, this client cannot ` +
            `trust it after start: relaunch with DENO_CERT=<cert.pem> (get it ` +
            `with \`am profile --app=<appId>\`), or serve a real cert ` +
            `(tls: { cert, key }) / plain HTTP (tls: false) on the server.`
          : "";
        log.error(
          "cli",
          `cannot reach ${shownUrl}${
            ev.code === 1008
              ? ` (${ev.reason || "unauthorized"})`
              : refused !== undefined
              ? ` (refused: ${refused})`
              : ""
          } — check the server is running and the URL/token match its share link (still retrying)${tlsHint}`,
        );
      }
      // Exponential backoff: 1s → 2s → 4s → 8s max, ±20% jitter (shared)
      reconnectTimer = setTimeout(connect, backoffDelay(retry));
      retry++;
    };

    ws = socket;
  }

  /** Ask for a full state while out of sync — at once, then at most once per
   *  {@linkcode RESYNC_MIN_MS} (every answer that still does not fit costs
   *  the server a full serialization), with a trailing ask so the LAST change
   *  in a burst — the one that may make it fit — is never the one skipped. */
  function requestResync(): void {
    if (_resyncTimer !== undefined || closed) return;
    const wait = _resyncAt + RESYNC_MIN_MS - Date.now();
    const ask = () => {
      _resyncTimer = undefined;
      if (closed || !_outOfSync) return;
      _resyncAt = Date.now();
      if (ws?.readyState === WebSocket.OPEN && pacer) {
        try {
          pacer.push({ frame: enc("resync"), seq: _seq++ });
        } catch { /* aio-ok: closing — the reconnect sends full state */ }
      }
    };
    if (wait <= 0) ask();
    else _resyncTimer = setTimeout(ask, wait);
  }

  connect();

  // The dispatcher SETTLES the call itself: its promise is the real outcome,
  // carried back on the ack. Without this marker `bindCell`'s async branch
  // returns a LOCAL pending-call promise that nothing in this process ever
  // resolves, so every async bound method rejected at the call ceiling — 30
  // seconds after the method had already succeeded (see SETTLES_CALLS in
  // protocol/ack-registry.ts). ONE dispatcher for `bind` and `call`, so a call
  // by name is the same frame, ack and ceiling as a bound method.
  const _dispatch = (
    action: Msg,
    onChunk?: (value: unknown) => void,
  ): Promise<unknown> => {
    if (closed) return Promise.reject(closedRefusal(action.type));
    if (_failOffline && !_isUp()) return Promise.reject(offlineRefusal(url));
    const cid = crypto.randomUUID();
    // deferTimer: the clock belongs to the FRAME, not to the call. The
    // pacer arms it when the frame actually leaves (now, a moment later
    // at the advertised pace, or after the drain in `onopen`) — never
    // while the action is still waiting.
    const ackd = _pending.register(cid, {
      methodKey: ackMethodKey(action),
      deferTimer: true,
    });
    _callTypes.set(cid, action.type);
    const settled = () => void _callTypes.delete(cid);
    ackd.then(settled, settled);
    if (onChunk) _chunkTo(_chunks, cid, _alive(_pending, cid, onChunk), ackd);
    try {
      _trySend(
        { ...action, cid, ...(onChunk ? { stream: true } : {}) } as {
          type: string;
          payload?: unknown;
        },
      );
    } catch (err) {
      // The frame could not be built. Reject the call the same way the
      // full-queue branch below does — leaving `cid` registered with no
      // timer armed is a promise that never settles.
      _pending.reject(
        cid,
        err instanceof Error ? err : new Error(String(err)),
      );
      return ackd;
    }
    // Paced or queued, the ack clock must not run against a call that
    // has not been written yet, and if we close still holding it,
    // close() rejects it rather than reporting a success that never
    // happened.
    //
    // There is no third outcome to handle here any more. `_trySend`
    // either writes or queues — a full queue evicts the OLDEST entry
    // and rejects THAT caller inside `_pushDroppingOldest` (or, when
    // every entry was accepted before a blip, rejects THIS one there),
    // so the branch that used to reject this one here was unreachable
    // dead code the moment the policy changed. The only other failure, a frame that cannot be
    // built, is rejected in the `catch` above.
    return ackd;
  };
  (_dispatch as unknown as Record<symbol, boolean>)[SETTLES_CALLS] = true;

  return {
    get state() {
      return state;
    },
    get connected() {
      return ws?.readyState === WebSocket.OPEN && !_outOfSync;
    },
    ready,

    // Queue whenever the socket is down — NOT only before the first connect.
    // The old `!wasConnected` guard meant that once a client had connected,
    // an action sent during a reconnect was neither written nor queued and
    // vanished with no error: a silent write loss in the window a
    // reconnecting client spends most of its time in.
    send(action: { type: string; payload?: unknown }): void {
      // Warned, not thrown: a fire-and-forget send during shutdown must not
      // start throwing where it used to vanish.
      if (closed) return log.warn("cli", closedRefusal(action.type).message);
      _trySend(action);
    },

    bind(...cells: import("../state/cell-types.ts").CellDef[]): void {
      for (const f of cells) {
        bindCell(
          f,
          _dispatch,
          () => (state ?? {}) as Record<string, unknown>,
        );
        _bound.push(f);
      }
    },

    call(cell: string, method: string, ...args: unknown[]): Promise<unknown> {
      return _dispatch(callAction(cell, method, args));
    },

    stream(
      cell: string,
      method: string,
      args: unknown[],
      onChunk: (value: unknown) => void,
    ): Promise<unknown> {
      return _dispatch(callAction(cell, method, args), onChunk);
    },

    onStatus: (fn: (connected: boolean) => void) => _status.on(fn),

    subscribe(fn: (state: S) => void): () => void {
      listeners.add(fn);
      if (state !== null) fn(state);
      return () => {
        listeners.delete(fn);
      };
    },

    close(): void {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      clearTimeout(_resyncTimer);
      _resyncTimer = undefined;
      // Disarms the readyTimeoutMs deadline; a no-op once ready resolved.
      _readyAbandon?.();
      _readyResolve = _readyAbandon = null;
      // Frames still paced were never sent; their callers are rejected below
      // with everything else outstanding. `take()` also disarms the timer, so
      // a closed client holds no handle open.
      const unsent = pacer?.take().length ?? 0;
      pacer = null;
      _written.clear();
      if (unsent > 0) {
        log.warn(
          "cli",
          `closed with ${count(unsent, "frame")} still waiting on the send ` +
            `pacer — never sent; their callers reject`,
        );
      }
      ws?.close();
      ws = null;
      _status.clear();
      _status.set(false);
      peerAbort.abort();
      listeners.clear();
      // close() DISCARDS the queue — nothing will ever drain it — so here the
      // queued calls really are dead and rejectAll (not rejectInFlight) is the
      // truthful settlement. Say how many frames went with it.
      if (queue.length > 0) {
        log.warn(
          "cli",
          `closed with ${count(queue.length, "action")} still queued — ` +
            `they were never sent; their callers reject`,
        );
        queue.length = 0;
      }
      // Outstanding calls REJECT, never resolve: closing does not make an
      // unconfirmed action succeed, and a bound call that quietly resolved on
      // close reported work the server may never have seen.
      _pending.rejectAll(
        new Error("client closed before the server confirmed this action"),
      );
      // Give the cell definitions back. A def binds to exactly ONE dispatcher
      // (D2), and without this a second `connectCli(...).bind(cell)` — after a
      // reconnect-by-hand, or in a test file that also runs the server —
      // threw "already bound" forever, with no way to undo it.
      if (_bound.length > 0) {
        _releaseCellBindings(_bound);
        _bound.length = 0;
      }
    },
  };
}

/** Connect to an aio server via Unix Domain Socket — same API as connectCli but over UDS/NDJSON.
 *  Uses Deno.connect({ transport: 'unix' }) — no TCP port needed. */
export function connectCliUDS<S>(
  socketPath: string,
  /** Same contract as `connectCli` — including `readyTimeoutMs`, which must
   *  exist on BOTH clients or the answer to "can I detect a dead connection"
   *  depends on which transport you happened to pick. */
  opts?: { ackTimeoutMs?: number; readyTimeoutMs?: number },
): CliApp<S> {
  return _connectCliUDS<S>(socketPath, opts);
}

/** `connectCliUDS` with the options only `peer()` sets. @internal */
export function _connectCliUDS<S>(
  socketPath: string,
  opts?: Parameters<typeof connectCliUDS>[1] & {
    /** What a call made while disconnected does. `"queue"` (default): it
     *  waits in the offline queue and is sent on reconnect — right for user
     *  intent. `"fail"`: it rejects AT ONCE and is never sent later — right
     *  for a service call whose answer is only worth having now. */
    offline?: CliOffline;
    /** The peer proof (`x-aio-peer` header value) for THIS (re)connect, or
     *  undefined for none: sent as the connection's identity hello, and its
     *  verdict awaited before `ready` — a refusal fails loud, never falls
     *  back to anonymous. */
    proof?: () => Promise<string | undefined>;
  },
): CliLink<S> {
  const _failOffline = opts?.offline === "fail";
  // Same per-connection registry as the WS client — see connectCli.
  const _ack = _ackCeiling(opts?.ackTimeoutMs);
  /** cid → action type of every call still awaiting its ack, and the
   *  `type\0message` of the last calls refused — a `reduce-error` diag for a
   *  throw THIS client's call already rejects with is not said twice (TCP
   *  printed it as `server diagnostic`, UDS never did). */
  const _callTypes = new Map<string, string>();
  const _rejectedRecently = new Set<string>();
  const _udsPending = createAckRegistry(
    () => _ack,
    (m) => log.warn(m),
  );
  const _bound: CellDef[] = [];
  let state: S | null = null;
  let conn: LocalConn | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  const _status = statusEmitter();
  const _chunks: ChunkRoutes = new Map();
  let closed = false;
  let retry = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: Array<{ type: string; payload?: unknown }> = [];
  const listeners = new Set<(state: S) => void>();
  const encoder = new TextEncoder();

  let _readyResolve: ((s: S) => void) | null = null;
  let _readyAbandon: (() => void) | null = null;
  let _readyRefuse: ((e: Error) => void) | null = null;
  const ready = new Promise<S>((r, j) => {
    const d = _readyDeadline<S>(socketPath, opts?.readyTimeoutMs, r, j);
    _readyResolve = d.settle;
    _readyAbandon = d.abandon;
    _readyRefuse = d.refuse;
  });
  ready.catch(() => {}); // see connectCli — an unawaited ready must not crash
  /** This connection's identity hello, until the server judged it: its state
   *  frames are the ANONYMOUS view and are set aside — the verdict is followed
   *  by this caller's own. */
  let _helloCid: string | undefined;
  /** Refusal reasons already said at ERROR — see the hello's `ack`. */
  const _helloRefusals = new Set<string>();

  let _udsQueueNoted = false;
  /** Written actions by cid — what a door refusal (`retryAfterMs`) re-sends. */
  const _udsWritten = new Map<string, { type: string; payload?: unknown }>();
  const _udsTries = new WeakMap<object, number>();
  /** Nothing is written before this (ms epoch): the server said when it
   *  takes calls again, and a newer call must not overtake a held one. */
  let _udsHoldUntil = 0;
  let _udsHoldTimer: ReturnType<typeof setTimeout> | undefined;
  let _udsRetryNoted = false;
  /** The WS client's `_retryRefusedCall`, on this transport: the server
   *  refused the frame before running it and said when to re-send — hold the
   *  call and send it again, instead of failing a write never attempted. */
  function _udsRetryRefused(d: AckPayload): boolean {
    const { cid, ok, retryAfterMs } = d;
    if (typeof cid !== "string") return false;
    const action = _udsWritten.get(cid);
    _udsWritten.delete(cid);
    if (
      ok !== false || !action || typeof retryAfterMs !== "number" ||
      !Number.isFinite(retryAfterMs) || retryAfterMs < 0 ||
      !_udsPending.isWritten(cid)
    ) return false;
    const tries = _udsTries.get(action) ?? 0;
    if (tries >= CLI_MAX_BUDGET_RETRIES) return false;
    _udsTries.set(action, tries + 1);
    _udsPending.unwrite(cid);
    if (!_udsRetryNoted) {
      _udsRetryNoted = true;
      log.warn(
        "cli",
        `the server refused "${action.type}" before running it and asked ` +
          `for a re-send in ${Math.round(retryAfterMs)}ms (${
            d.error ?? "no reason given"
          }) — ${HELD(_failOffline)}. Further re-sends are not repeated here.`,
      );
    }
    queue.push(action);
    _udsHoldUntil = Date.now() + Math.min(retryAfterMs, 10_000);
    clearTimeout(_udsHoldTimer);
    _udsHoldTimer = setTimeout(_udsDrainQueue, _udsHoldUntil - Date.now());
    return true;
  }
  /** Write an action, or queue it while the socket is down — the ONE writer,
   *  and it reports which happened.
   *
   *  A closure, not a method on the returned object: `bind`'s dispatcher used
   *  to call `this.send(...)`, so `const { bind } = connectCliUDS(...)` made
   *  every bound method throw SYNCHRONOUSLY (uncatchable through the awaited
   *  promise) while its ack sat registered until `close()` turned it into an
   *  unhandled rejection that killed the process. `connectCli` has always used
   *  a closure; this is that same shape.
   *
   *  It also has to REPORT the over-cap discard: swallowing it left the caller
   *  to wait out the full ack ceiling and hear "the server never confirmed the
   *  call" about a frame this client threw away instantly and knowably. */
  // `aio.run({ wire })` on this transport — the rule `connectCli` states.
  // The socket's server speaks first: `proto`, `cfg` when there is one, then
  // the state; so the first state frame is the proof that no `cfg` is coming.
  // `undefined` = not asked by this server: the process default stands.
  let wireOmit: true | undefined;
  let wireKnown = false;
  let wireHeld = false;
  const _wireWaits = (a: { payload?: unknown }): boolean => {
    if (wireKnown || !(wireHeld || endsUndefined(a))) return false;
    return wireHeld = true;
  };
  function _wireSettled(): void {
    if (wireKnown) return;
    wireKnown = true;
    if (!wireHeld) return;
    wireHeld = false;
    _udsDrainQueue();
  }

  function _udsTrySend(
    action: { type: string; payload?: unknown },
  ): { written: boolean; queued: boolean } {
    // Encoded before the branch, for the reason `_trySend` gives.
    const frame = encodeAction(action, wireOmit);
    const held = Date.now() < _udsHoldUntil;
    if (writer && !held && !_wireWaits(action)) {
      const cid = (action as { cid?: string }).cid;
      if (cid) _udsWritten.set(cid, action);
      writer.write(encoder.encode(frame + "\n")).catch((e) => {
        // A refused write is not a delivered action. The caller's ack clock is
        // already running, so it heard "the server never confirmed the call"
        // 15s later about a frame that never left this process — say which
        // action, and now.
        log.warn(
          "cli",
          `the UDS write for "${action.type}" failed (${e}) — the action was ` +
            `NOT delivered`,
        );
      });
      return { written: true, queued: false };
    }
    // Waiting for `cfg` (or a re-send hold) on an open socket is not "offline".
    if (_failOffline && !(writer && (wireHeld || held))) {
      const cid = (action as { cid?: string }).cid;
      if (!cid) throw offlineRefusal(socketPath);
      _udsPending.reject(cid, offlineRefusal(socketPath));
      return { written: false, queued: false };
    }
    _pushDroppingOldest(queue, _udsPending, "UDS offline", action);
    if (!_udsQueueNoted && !(writer && (wireHeld || held))) {
      _udsQueueNoted = true;
      log.warn(
        "cli",
        `UDS offline — actions are queued in memory (max ` +
          `${WS_MAX_QUEUE}) and sent on reconnect; awaited calls stay ` +
          `pending until then, and close() rejects whatever is still queued`,
      );
    }
    return { written: false, queued: true };
  }

  /** Flush the queue into the open connection, in order. */
  function _udsDrainQueue(): void {
    const w = writer;
    if (!w || Date.now() < _udsHoldUntil) return;
    // Drain queued actions. The ack clock starts HERE — at the write —
    // not at dispatch time (see connectCli's drain).
    const q = [...queue];
    queue.length = 0;
    _udsQueueNoted = false;
    for (let i = 0; i < q.length; i++) {
      const a = q[i]!;
      // See `connectCli`'s drain: the first call the unknown answer would
      // change stops the flush, and the rest wait behind it, in order.
      if (_wireWaits(a)) {
        queue.unshift(...q.slice(i));
        return;
      }
      const cid = (a as { cid?: string }).cid;
      let frame: string;
      try {
        frame = encodeAction(a, wireOmit);
      } catch (err) {
        // Cannot be built, so it can never be sent: drop this one, tell
        // its caller, keep flushing the rest (see connectCli's drain).
        if (cid) {
          _udsPending.reject(
            cid,
            err instanceof Error ? err : new Error(String(err)),
          );
        }
        continue;
      }
      if (cid) _udsWritten.set(cid, a);
      w.write(encoder.encode(frame + "\n")).catch((e) => {
        log.warn(
          "cli",
          `the UDS write for "${a.type}" failed during the queue flush ` +
            `(${e}) — the action was NOT delivered`,
        );
      });
      if (cid) _udsPending.armTimer(cid);
    }
  }

  /** When the current run of failed dials began (0: connected, or none yet),
   *  and whether it was said: the B20 instrument. */
  let failingSince = 0;
  let failingSaid = false;
  function connect(): void {
    if (conn || closed) return;
    let proof: string | undefined;
    (opts?.proof ? opts.proof() : Promise.resolve(undefined))
      .then((p) => {
        proof = p;
        return connectLocal(socketPath);
      })
      .then((c) => {
        // close() ran while this dial was in flight. Adopting the connection
        // kept a live socket and a read loop on a closed client, open until
        // the SERVER hung up — hang up here instead.
        if (closed) {
          try {
            c.close();
          } catch { /* already closed */ }
          return;
        }
        conn = c;
        failingSince = 0;
        failingSaid = false;
        writer = c.writable.getWriter();
        // With an identity hello, the backoff resets on its OK verdict only:
        // a refused hello reconnects on the growing backoff, not every 1 s.
        if (!proof) retry = 0;

        // The identity hello is the FIRST frame (the server judges it before
        // anything behind it runs); then, A3, our wire-protocol version.
        _helloCid = proof ? crypto.randomUUID() : undefined;
        if (proof) {
          writer!.write(
            encoder.encode(
              enc("type", { kind: "peer", proof, cid: _helloCid }) + "\n",
            ),
          ).catch(() => {
            // aio-ok: a dead socket ends the read loop below, which rejects
            // the in-flight calls and reconnects with a fresh hello
          });
        }
        writer!.write(
          encoder.encode(enc("proto", protoHello(VERSION)) + "\n"),
        ).catch(() => {});

        wireOmit = undefined; // a new connection is a new answer
        wireKnown = false;
        wireHeld = false;
        _udsDrainQueue();

        // Read NDJSON
        const lineBuf = createLineReader(); // linear on a multi-MB frame
        // Per connection, like the line reader: a streaming decoder shared
        // across reconnects carried a character cut off by a dead connection
        // into the next one's first frame, which then failed to parse and
        // was dropped without a word.
        const decoder = new TextDecoder();
        const reader = c.readable.getReader();
        (async () => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              const lines = lineBuf.push(
                decoder.decode(value, { stream: true }),
              );
              for (const line of lines) {
                if (!line) continue;
                const frame = dec(line);
                if (!frame) {
                  // v1 shim: a v1 server's hello/refusal is still readable.
                  const v1 = v1PeerReason(line);
                  if (v1) {
                    log.error("cli", `protocol version mismatch: ${v1}`);
                    closed = true;
                    try {
                      c.close();
                    } catch { /* already closed */ }
                  }
                  continue;
                }
                switch (frame.t) {
                  // Per-action acks for bound-cell method calls
                  case "chunk":
                    _routeChunk(_chunks, frame.d);
                    continue;
                  case "ack": {
                    // Branch on `ok` — parity with the WS client and the
                    // browser transports. Dropping it resolved a refused
                    // call exactly like a successful one.
                    const d = (frame.d ?? {}) as AckPayload;
                    const { cid, ok, value } = d;
                    if (typeof cid !== "string") continue;
                    if (cid === _helloCid) {
                      _helloCid = undefined;
                      if (ok !== false) retry = 0;
                      else {
                        // Refused: the server closes this connection, and
                        // the reconnect sends a fresh proof — never none.
                        const why = d.error ?? "no reason given";
                        const e = new Error(
                          `[aio:cli] ${socketPath} refused this caller's ` +
                            `identity — ${why}`,
                        );
                        // Once per distinct reason; a repeat is debug.
                        if (_helloRefusals.has(why)) {
                          log.debug("cli", e.message);
                        } else {
                          _helloRefusals.add(why);
                          log.error("cli", e.message);
                        }
                        _readyRefuse?.(e);
                      }
                      continue;
                    }
                    // Refused at the door, never ran: re-sent, not failed.
                    if (_udsRetryRefused(d)) continue;
                    if (ok === false) {
                      // Carries `code` through — see the WS twin above.
                      _udsPending.reject(
                        cid,
                        wireError(d, "the server refused the action"),
                      );
                    } else {
                      _udsPending.resolve(cid, value);
                    }
                    continue;
                  }
                  // A3: version handshake — terminal on mismatch.
                  case "proto": {
                    const theirs = parseProtoHello(frame.d);
                    // Which build this connection talks to — `peerHello()`.
                    // The WS client and the TCP CLI client both recorded it;
                    // this one negotiated and threw it away, so on the socket
                    // path nothing could answer the question.
                    if (theirs) rememberPeerHello(theirs);
                    // A server that does not judge identity hellos (an older
                    // aio) sends no verdict: its calls run anonymous — said.
                    if (
                      _helloCid &&
                      (frame.d as { peerHello?: unknown } | undefined)
                          ?.peerHello !== true
                    ) {
                      _helloCid = undefined;
                      log.warn(
                        "cli",
                        `${socketPath}: this app's aio predates proven calls ` +
                          `over its local socket — this caller's calls carry ` +
                          `NO identity there (update it, or start it with a ` +
                          `port)`,
                      );
                    }
                    // Unreadable stops loudly, as the WS twin above does.
                    const result = theirs
                      ? negotiateProtocol(protoHello(VERSION), theirs)
                      : {
                        ok: false as const,
                        reason: `unreadable server hello: ${
                          JSON.stringify(frame.d)?.slice(0, 120)
                        }`,
                      };
                    if (!result.ok) {
                      log.error(
                        "cli",
                        `protocol version mismatch: ${result.reason}`,
                      );
                      closed = true; // stop the reconnect loop
                      try {
                        c.close();
                      } catch { /* already closed */ }
                    }
                    continue;
                  }
                  case "proto-err":
                    log.error(
                      "cli",
                      `server rejected protocol version: ${
                        (frame.d as { reason?: string } | undefined)?.reason ??
                          "?"
                      }`,
                    );
                    closed = true;
                    continue;
                  case "cfg":
                    wireOmit = cfgOmits(frame.d) || undefined;
                    _wireSettled();
                    continue;
                  case "state":
                  case "patches": {
                    // The anonymous view, sent before the identity verdict.
                    if (_helloCid) continue;
                    _status.set(true);
                    _wireSettled(); // no `cfg` came before it: none will
                    // onResync is NOT optional: without it a patch that fails
                    // to apply left this client frozen at its last good state
                    // — no error, no log, permanent divergence from a server
                    // that kept moving. The UDS server answers `resync` with a
                    // full snapshot exactly like the WS one.
                    state = applyServerFrame(state, frame, () => {
                      log.warn(
                        "cli",
                        "UDS patch did not apply (desync) — " +
                          "requesting a full snapshot",
                      );
                      writer?.write(encoder.encode(enc("resync") + "\n"))
                        .catch(() => {});
                    }) as S;
                    if (state != null && _readyResolve) {
                      _readyResolve(state);
                      _readyResolve = null;
                    }
                    if (state != null) {
                      for (const fn of listeners) fn(state);
                    }
                    continue;
                  }
                  default:
                    continue; // browser-only signals — irrelevant here
                }
              }
            }
          } catch { /* connection closed */ }
          // Dropped UDS connection can never ack — see the WS onclose note.
          {
            // Reject, never resolve — an unconfirmed action did not succeed
            // just because the socket died (see connectCli's onclose).
            // IN-FLIGHT ONLY: `queue` survives and is drained on reconnect.
            _udsWritten.clear();
            const lost = _udsPending.rejectInFlight(
              new Error(
                "connection lost before the server confirmed this action — " +
                  "it may or may not have been applied; re-check state " +
                  "before retrying (the action is not resent automatically)",
              ),
            );
            if (lost > 0) {
              log.warn(
                "cli",
                `UDS connection lost with ${lost} unacked action(s) — rejected; verify via state`,
              );
            }
            // `offline: "fail"`: calls held on this connection die with it.
            if (_failOffline) {
              for (const a of queue.splice(0)) {
                const cid = (a as { cid?: string }).cid;
                const why = offlineRefusal(socketPath);
                if (cid) _udsPending.reject(cid, why);
                else {
                  log.warn(
                    "cli",
                    `"${a.type}" (sent without awaiting) dropped — ${why.message}`,
                  );
                }
              }
            }
          }
          conn = null;
          writer = null;
          _status.set(false);
          if (!closed) {
            reconnectTimer = setTimeout(connect, backoffDelay(retry));
            retry++;
          }
        })();
      })
      .catch((err) => {
        if (closed) return;
        // Each failed dial, with what the path is (debug); a run of them
        // past UNREACHABLE_SAY_MS once at warn — so an outage says WHY.
        const now = Date.now();
        if (!failingSince) failingSince = now;
        const why = `${
          (err as { code?: string })?.code ?? describeThrown(err)
        }`;
        const at = socketPathState(socketPath, now);
        log.debug(
          `local socket ${socketPath}: connect failed (${why}); the path is ${at}`,
        );
        if (!failingSaid && now - failingSince >= UNREACHABLE_SAY_MS) {
          failingSaid = true;
          log.warn(
            `local socket ${socketPath} unreachable for ${
              ((now - failingSince) / 1000).toFixed(1)
            } s (${why}); the path is ${at} — still retrying`,
          );
        }
        reconnectTimer = setTimeout(
          connect,
          backoffDelay(retry++),
        );
      });
  }

  // Marked SETTLES_CALLS for the same reason as the WS client: the ack is the
  // call's real outcome, and without it every async bound method waited on a
  // local promise nobody would ever settle. One dispatcher for bind and call.
  const _dispatch = (
    action: Msg,
    onChunk?: (value: unknown) => void,
  ): Promise<unknown> => {
    if (closed) return Promise.reject(closedRefusal(action.type));
    if (_failOffline && !writer) {
      return Promise.reject(offlineRefusal(socketPath));
    }
    const cid = crypto.randomUUID();
    // deferTimer + arm-on-write: identical rule to connectCli — the
    // clock belongs to the frame, never to a queued action.
    const ackd = _udsPending.register(cid, {
      methodKey: ackMethodKey(action),
      deferTimer: true,
    });
    if (onChunk) {
      _chunkTo(_chunks, cid, _alive(_udsPending, cid, onChunk), ackd);
    }
    let sent: { written: boolean; queued: boolean };
    try {
      sent = _udsTrySend(
        { ...action, cid, ...(onChunk ? { stream: true } : {}) } as {
          type: string;
          payload?: unknown;
        },
      );
    } catch (err) {
      _udsPending.reject(
        cid,
        err instanceof Error ? err : new Error(String(err)),
      );
      return ackd;
    }
    if (sent.written) _udsPending.armTimer(cid);
    else if (!sent.queued) {
      _udsPending.reject(
        cid,
        new Error(
          "not connected and the offline queue is full — the action " +
            "was NOT sent",
        ),
      );
    }
    return ackd;
  };
  (_dispatch as unknown as Record<symbol, boolean>)[SETTLES_CALLS] = true;
  connect();

  return {
    get state() {
      return state;
    },
    get connected() {
      return conn !== null;
    },
    ready,

    send(action: { type: string; payload?: unknown }): void {
      if (closed) return log.warn("cli", closedRefusal(action.type).message);
      _udsTrySend(action);
    },

    bind(...cells: CellDef[]): void {
      for (const f of cells) {
        bindCell(f, _dispatch, () => (state ?? {}) as Record<string, unknown>);
        _bound.push(f);
      }
    },

    call(cell: string, method: string, ...args: unknown[]): Promise<unknown> {
      return _dispatch(callAction(cell, method, args));
    },

    stream(
      cell: string,
      method: string,
      args: unknown[],
      onChunk: (value: unknown) => void,
    ): Promise<unknown> {
      return _dispatch(callAction(cell, method, args), onChunk);
    },

    onStatus: (fn: (connected: boolean) => void) => _status.on(fn),

    subscribe(fn: (state: S) => void): () => void {
      listeners.add(fn);
      if (state !== null) fn(state);
      return () => {
        listeners.delete(fn);
      };
    },

    close(): void {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      clearTimeout(_udsHoldTimer);
      // See connectCli.close — the deadline must not outlive the client.
      _readyAbandon?.();
      _readyResolve = _readyAbandon = null;
      try {
        conn?.close();
      } catch { /* already closed */ }
      conn = null;
      writer = null;
      _status.clear();
      _status.set(false);
      listeners.clear();
      // close() discards the queue — those frames are dead, so rejectAll is
      // the truthful settlement here (see connectCli.close).
      if (queue.length > 0) {
        log.warn(
          "cli",
          `UDS closed with ${count(queue.length, "action")} still queued — ` +
            `they were never sent; their callers reject`,
        );
        queue.length = 0;
      }
      _udsPending.rejectAll(
        new Error("client closed before the server confirmed this action"),
      );
      if (_bound.length > 0) {
        _releaseCellBindings(_bound);
        _bound.length = 0;
      }
    },
  };
}

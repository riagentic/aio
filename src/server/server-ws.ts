// WebSocket connection handler — extracted from server.ts
// Manages WS upgrades, per-client state, message routing, rate limiting, backpressure
import type { AioUser } from "./aio.ts";
import { invokeServerFn } from "./server-fns.ts";
import {
  _clearClientDegraded,
  _recordClientDegraded,
  degraded,
} from "../diagnostics/degraded.ts";
import {
  makeServerRequest,
  runWithRequest,
  runWithUser,
  type ServerRequest,
} from "./auth-context.ts";
import {
  type ActionPayload,
  dec,
  enc,
  encRaw,
  errorFields,
  isIgnorableKind,
  type SfnPayload,
} from "../protocol/envelope.ts";
import { filterStateBySubs, parseSubs } from "../protocol/broadcast-utils.ts";
import { overUtf8, utf8Size } from "../protocol/utf8-size.ts";
import { isFrameTooLarge } from "../protocol/transport-shared.ts";
import { serializeReturn } from "../protocol/return-value.ts";
import { writeClientLog } from "./client-log.ts";
import { CLIENT_REPLY_TIMEOUT_MS, clientReplyTimeoutError } from "./uds.ts";
import { log } from "../diagnostics/logger-api.ts";
import { INFLIGHT } from "../state/dispatch.ts";
import { inServerOrigin } from "../state/call-origin.ts";
import { parseTTCommand } from "../diagnostics/time-travel.ts";
import { originVerdict, rawStateControlAllowed } from "./server-auth.ts";
import type { ClientLogEntry } from "../air/dom-inspector-types.ts";
import type { VitalsSystem } from "../vitals/mod.ts";
import { VERSION } from "./aio-cli.ts";
import {
  negotiateProtocol,
  parseProtoHello,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  protoHello,
} from "../protocol/protocol-version.ts";
import { bytes, count } from "../diagnostics/fmt.ts";
import { flushAllUrgent } from "./broadcast-coalescer.ts";
import { WS_BUFFER_HIGH_WATER, wsWriteBacklog } from "./write-backlog.ts";
import { userMemoKey } from "./aio-run-helpers.ts";

/** A whole state is about to be sent to ONE client outside the broadcast
 *  loop (connect, `subs`, `resync`). It will be serialized from the CURRENT
 *  state — which already contains the write of every patch still sitting in
 *  a coalescer's throttle window. Those patches must go out FIRST, to the
 *  base they describe, or the trailing edge sends them after the snapshot
 *  and the client applies them a second time: Immer splices an `add`, so a
 *  server-side `push` that landed in the window arrived twice — server
 *  ["one","two"], client ["one","two","two"], in range for every guard, no
 *  error anywhere, and `resync` (the client's own repair) re-creating it.
 *  `flushAllUrgent` is what client actions already do to skip the window;
 *  the throttle exists to pace background churn, not to reorder a snapshot
 *  against the deltas it contains. Pinned by
 *  tests/full-state-drains-buffered-patches.test.ts, both transports. */
function drainBeforeSnapshot(): void {
  flushAllUrgent();
}

/** Is this socket "error" just the peer going away?
 *
 *  Closing a window, killing a tab, pulling a laptop off wifi — none of them
 *  send a close frame, and every one of them arrives here as an error whose
 *  message is `Unexpected EOF` (or a reset/broken pipe). Reporting those at
 *  WARN made the last line of every clean shutdown look like a fault, which is
 *  the fastest way to teach someone that warnings are background noise.
 *
 *  Pure and exported so the classification is testable without a socket — and
 *  so widening it later is a visible, reviewed edit rather than a `catch {}`. */
export function isPeerGone(message: string): boolean {
  return /unexpected eof|connection reset|broken pipe|reset by peer|connection closed before message completed|os error 104|os error 32/i
    .test(message);
}

/** The largest message Deno's WebSocket server accepts, in bytes. Over it the
 *  RUNTIME fails the socket ("Frame too large") before aio ever sees the
 *  frame — so no aio limit above it can be enforced, answered or advertised
 *  honestly. Measured: a 63 MiB frame is taken, a 65 MiB one kills the
 *  connection. `Deno.upgradeWebSocket` has no option to raise it. */
export const WS_RUNTIME_MAX_MESSAGE = 64 * 1024 * 1024;

/** The frame limit this server can actually keep, and what to say when the
 *  configured one is not it. Pure — the boot warning and the handshake value
 *  both come from here.
 *
 *  A `wsLimits.maxMessageBytes` above the runtime's ceiling was accepted,
 *  advertised to every client in the hello, and named in each refusal's way
 *  out ("raise it with maxMessageBytes") — and every frame between the two
 *  was not refused at all: the runtime closed the socket, the caller was told
 *  "connection lost", and the server logged `Frame too large` with no limit
 *  and no way out. */
export function effectiveMaxMessage(
  configured: number,
): { limit: number; warning?: string } {
  if (configured <= WS_RUNTIME_MAX_MESSAGE) return { limit: configured };
  return {
    limit: WS_RUNTIME_MAX_MESSAGE,
    warning: `wsLimits: maxMessageBytes (${configured}) is above the ` +
      `${WS_RUNTIME_MAX_MESSAGE}-byte (64 MiB) message ceiling of Deno's ` +
      `WebSocket server — a larger frame closes the connection before aio ` +
      `can refuse it, so ${WS_RUNTIME_MAX_MESSAGE} is the limit in force ` +
      `(and the one advertised to clients). Send bulk data as a file upload ` +
      `or in chunks.`,
  };
}

/** What this PEER's runtime can receive, when that is knowable from its
 *  handshake — `undefined` means "no reason to believe it is limited".
 *
 *  A Deno peer (`connectCli`, `am`, a service-to-service link, another aio
 *  server) fails its connection on a message over
 *  {@linkcode WS_RUNTIME_MAX_MESSAGE}, exactly as this server does inbound —
 *  and it announces itself in the User-Agent (`Deno/2.9.7`), which is the only
 *  thing known about a peer before the first frame goes out. Browsers accept
 *  far larger frames and are deliberately NOT limited here: refusing a frame a
 *  peer would have taken is a regression, not a guardrail. Pure, so the rule
 *  is unit-tested rather than reasoned about. */
export function peerFrameCeiling(userAgent: string): number | undefined {
  return /^Deno\//i.test(userAgent.trim()) ? WS_RUNTIME_MAX_MESSAGE : undefined;
}

/** Is this socket error the runtime refusing an oversized message? Defined in
 *  `protocol/transport-shared.ts` — the CLI client reads the same fact about
 *  its own socket, and must not import this server to do it — and re-exported
 *  here, where it has always lived for callers. */
export { isFrameTooLarge };

/** Safety limits — prevent resource exhaustion */
const WS_MAX_MESSAGE = 1_000_000; // 1MB — reject oversized WS messages
const WS_MAX_CONNECTIONS = 100; // max concurrent WebSocket clients
const WS_RATE_LIMIT = 100; // max messages per second per client
const WS_BYTES_PER_SEC = 5_000_000; // 5MB/s per client — prevents bandwidth DoS

/** Backpressure thresholds */
const BP_STALENESS_HIGH = 300; // ms — client render staleness triggering 4x throttle
const BP_STALENESS_MODERATE = 100; // ms — 2x throttle
const BP_RECOVERY_PINGS = 3; // consecutive low-staleness pings before stepping down

/** Consecutive drop threshold before client is flagged as abusive (H3/H4 fix). */
const CONSECUTIVE_DROP_THRESHOLD = 50;

/** The LONGEST an abusive client key stays denylisted after a forced close.
 *  Plugs F-4: per-socket strike counters get reset on reconnect, so an IP
 *  can amplify throughput by cycling connections. Denylist survives reconnects.
 *
 *  A ceiling, not the sentence. Every block used to be the full minute, from
 *  the first strike — and the key is an ADDRESS, so one tab's burst (or one
 *  noisy tab behind an office NAT) locked every page from that address out
 *  for sixty seconds. The first strike is short; a key that keeps coming back
 *  doubles it, up to this. See `abuseBlockMs`. */
const ABUSE_DENYLIST_MS = 60_000;
/** The first strike's block. Long enough that a reconnect loop gains nothing
 *  (it is fifty times the one-second window it was trying to reset). */
const ABUSE_BLOCK_BASE_MS = 5_000;
/** A key with no strike for this long starts over at the first one. */
const ABUSE_STRIKE_MEMORY_MS = 10 * 60_000;

/** How long strike `n` (1-based) blocks a key: 5 s, 10 s, 20 s, 40 s, then
 *  60 s for every strike after. Pure and exported so the schedule is pinned by
 *  a test rather than by reading the constants. */
export function abuseBlockMs(strike: number): number {
  const n = Math.max(1, Math.floor(strike));
  return Math.min(ABUSE_DENYLIST_MS, ABUSE_BLOCK_BASE_MS * 2 ** (n - 1));
}

/** How long a sender should wait before a frame dropped by a one-second
 *  window is taken again: the rest of that window, plus margin for the
 *  reset timer firing late. */
function retryAfter(windowStart: number | undefined): number {
  const elapsed = windowStart === undefined ? 0 : Date.now() - windowStart;
  return Math.max(0, 1000 - elapsed) + 100;
}

/** THE framework-internal action gate — defined in protocol/ (one spelling
 *  for every door, the sync validator included), re-exported here for the
 *  server-side callers. */
export { _isFrameworkInternalActionType } from "../protocol/action-gate.ts";
import { _isFrameworkInternalActionType } from "../protocol/action-gate.ts";
import {
  _dispatchRefusal,
  _dispatchShort,
  _dispatchUnsaved,
} from "./action-ack.ts";
import { guardHookResult } from "./aio-dispatch.ts";

/** Strip client-set trusted provenance off a network action, loudly, and
 *  re-stamp it as what it IS: client input. ONE decider for all three network
 *  entry points (WS, UDS, trojan — each calls this on every action).
 *
 *  The fields, and why a network value is never legitimate:
 *  - `_user` — the SERVER-side caller identity consumed by dispatch hooks
 *    (beforeReduce/onAction/onEffect). In open/shared-token mode meta.user is
 *    undefined, so a spoofed `_user:{role:"admin"}` would become the trusted
 *    identity. The server sets the real `_user` downstream.
 *  - `_source` — provenance for app hooks (beforeReduce/onAction/onEffect):
 *    the server tags its own effect dispatches "Effect" inside the cell
 *    machinery, "System" for lifecycle. A forged "System" would ride the
 *    teardown exception of a closed queue.
 *  - `_inflight` — dispatch lets a flagged action through a DRAINING queue
 *    (a running method's write-set must land while the app closes) and
 *    refuses everything else with DISPATCH_DRAINING. A forged flag would have
 *    a `cell:method` action run during the shutdown drain — new work started
 *    while the server is closing — and its write captured by the final
 *    persist. Only the framework's own write paths set it (dispatch.ts
 *    INFLIGHT).
 *  - `_syncOp` — only the sync handler sets it, on ops already persisted to
 *    the op-log, so afterAction skips the durability fold for sync cells. A
 *    forged value makes the server treat a write that is durable NOWHERE as
 *    durable — it silently vanishes on restart.
 *  - `_syncTs` — the op-log position the sync handler stamps on the op it
 *    applied; journal:true records it as how far a cell's live state holds
 *    its op-log (`SyncReaction.at`). A forged high value made every later
 *    reaction line claim ops the state never held, and boot seeding skipped
 *    them — acked ops lost for good once compaction dropped the log.
 *  - `_syncId` — the op's id, beside `_syncTs`: journal:true names the op
 *    it commits by both (journal.ts `SYNC_APPLIED_TYPE`).
 *  - `payload._origin` — the async-batcher sets it SERVER-side to the
 *    originating method name; the cell `access` gate discriminates on it. A
 *    caller could forge `payload:{_origin:"read"}` on a `cell:delete` action
 *    to be gated as a read while the reducer ran the delete.
 *
 *  Re-stamping (not just deleting) `_source: "UI"` keeps provenance real for
 *  app hooks: clients tag their own dispatches `_source:"UI"` and deleting it
 *  outright would leave hooks unable to tell client input from server work.
 *  Anything OTHER than "UI" from the wire is warned about — a forged trusted
 *  field is an attack signal (or a badly stale client), never a shrug.
 *
 *  @decider */
export function sanitizeClientAction(
  action: Record<string, unknown>,
  via: "ws" | "uds" | "trojan",
): void {
  const forged: string[] = [];
  if (action._user !== undefined) forged.push("_user");
  if (action._source !== undefined && action._source !== "UI") {
    forged.push("_source");
  }
  if (action._syncOp !== undefined) forged.push("_syncOp");
  if (action._syncTs !== undefined) forged.push("_syncTs");
  if (action._syncId !== undefined) forged.push("_syncId");
  if (action[INFLIGHT] !== undefined) forged.push(INFLIGHT);
  delete action._user;
  delete action._syncOp;
  delete action._syncTs;
  delete action._syncId;
  delete action[INFLIGHT];
  const pl = action.payload;
  if (pl && typeof pl === "object") {
    if ((pl as Record<string, unknown>)._origin !== undefined) {
      forged.push("payload._origin");
      delete (pl as Record<string, unknown>)._origin;
    }
    // `_callId` is the key of a PROCESS-GLOBAL pending-call map, and
    // `registerCall` used to `set` it blind. Two clients that sent the same id
    // therefore collided: the first to finish resolved the OTHER one's caller
    // with its return value, and the loser hung past its ceiling because the
    // expiry check short-circuits on an id that now names a different call —
    // reproduced, one caller receiving another's result. So the server mints
    // it (`dispatchNetwork`), and the network value is discarded.
    //
    // Discarded QUIETLY, unlike the fields above: aio's OWN client sends it on
    // every async call (`bindCellReactive` tags `payload._callId` alongside
    // the envelope `cid`), so naming it here reported the framework's own
    // browser and Electron shells as attackers once per `await cell.method()`
    // — measured on amui, one WARN every 9 s, forever, on both transports.
    // A warning that fires on correct use trains people to skim warnings,
    // which is how the one that matters gets missed. The value has no effect
    // either way (it is always re-minted), so it is expected input, not a
    // forgery; the fields that WOULD change what the server does stay loud.
    if ((pl as Record<string, unknown>)._callId !== undefined) {
      delete (pl as Record<string, unknown>)._callId;
    }
  }
  if (forged.length > 0) {
    log.warn(
      via,
      `client sent trusted field(s) ${forged.join(", ")} on ` +
        `'${String(action.type)}' — stripped (a network value is never ` +
        `legitimate here)`,
    );
  }
  action._source = "UI";
}

export type ClientType =
  | "electron"
  | "browser"
  | "electron-reload"
  | "browser-reload"
  | "unknown";

export type ClientMeta = {
  id: string;
  index: number;
  clientType: ClientType;
  isElectron: boolean;
  user?: AioUser;
  /** The server this socket belongs to authenticates INDIVIDUALS (`WsDeps.
   *  perUserAuth`). Carried per socket so a sender that only holds the
   *  connection map — the broadcaster's `tt-state` flush — applies the same
   *  admin bar as `tt-cmd` without a second copy of the auth mode. */
  perUserAuth?: boolean;
  lastFullJson?: string;
  /** True when `lastFullJson` is only a SIZE memo and no longer describes what
   *  the client holds — a patch moved the client on without re-serializing.
   *  The dedup ("client already has this state, skip") may only trust
   *  `lastFullJson` while this is false; see the flush loop in
   *  server-broadcast.ts. */
  lastFullJsonStale?: boolean;
  /** A round was SKIPPED for this client (backpressure pacing, a frozen
   *  transport). Its patches are gone — the next round it is eligible for
   *  must carry full state, or the client applies later patches on top of a
   *  state that never received the earlier ones and diverges with health
   *  green. Cleared by a full send. */
  needsFull?: boolean;
  msgCount: number;
  bytesThisSec: number;
  msgResetTimer?: ReturnType<typeof setTimeout>;
  /** When the current one-second budget window opened — what a dropped
   *  frame's `retryAfterMs` is measured from. */
  msgWindowStart?: number;
  typeDetectTimer?: ReturnType<typeof setTimeout>;
  bpMultiplier: number;
  bpConsecutiveLow: number;
  bpLastSentAt: number;
  // H3/H4 fix: track consecutive drops for abuse detection (backpressure deadlock prevention)
  consecutiveDrops: number;
  /** Said once: a frame this connection sent was over `maxMessageBytes` in
   *  UTF-8 bytes and under it in code units, so it was accepted (see the
   *  inbound size check — the decision is deliberately unchanged). */
  overByteLimitSaid?: boolean;
  subscriptions: Set<string> | null;
  disconnected: boolean;
  /** Stable client key (usually remote IP) used for cross-connection abuse tracking. */
  clientKey?: string;
  /** The upgrade request's transport facts — what `serverRequest()` answers for
   *  every action / serverFn frame arriving on this socket. */
  request?: ServerRequest;
  /** Negotiated wire-protocol version (A3). Undefined until the client's
   *  "proto" hello arrives. */
  protocolVersion?: number;
  /** The client's own hello: its aio version and app version, when it said. */
  peer?: { aio?: string; app?: string };
  /** The SESSION token this socket authenticated with, when it authenticated
   *  with one. A socket outlives the credential that opened it, so the token
   *  is kept and re-checked — see `_revalidate`. Absent for anonymous sockets
   *  and for `users:`/`resolveUser` tokens (see `resolverToken`). */
  sessionToken?: string;
  /** The `users:`/`resolveUser` token this socket authenticated with — a JWT,
   *  an API key. Revocable too (the key is deleted from a table, the JWT
   *  expires), so it is re-resolved by the sweep; see `_revalidateResolved`. */
  resolverToken?: string;
};

/** Dependencies injected from server.ts closure */
export interface WsDeps {
  /** THE app version (`_appVersion`) — announced in the proto hello so a
   *  client can say which build it talks to. */
  appVersion?: string;
  /** Cost meter — sees every frame handed to a socket (`am cost`). */
  costMeter?: import("../vitals/cost-meter.ts").CostMeter;
  dispatch: (event: unknown, user?: AioUser) => Promise<unknown> | void;
  getUIState: (user?: AioUser) => unknown;
  debug: (msg: string) => void;
  prod: boolean;
  maxConnections?: number;
  wsLimits?: import("./aio-types.ts").WsLimits;
  expose?: boolean;
  allowedOrigins?: string[];
  /** When true AND expose=true, require Origin header on WS upgrade.
   *  Plugs F-6: empty/absent Origin is otherwise accepted by the handshake. */
  strictOrigin?: boolean;
  /** True when this server speaks TLS. The Origin check is otherwise
   *  SCHEME-BLIND: `http://app.example.com` and `https://app.example.com` are
   *  different origins to a browser but compared equal here, so a plaintext
   *  page (a downgrade, a stripped proxy hop, a stale bookmark) opened an
   *  authenticated socket against the https app it is NOT same-origin with. */
  secure?: boolean;
  clientCounter: { value: number };
  bootId: string;
  /** Resolved client config — sent as an early "cfg" frame so a shell
   *  templated at build time (electron UDS, android assets) still learns the
   *  compose-time decisions (`syncCells`, `callTimeouts`, `renderBudget`). */
  clientConfig?: Record<string, unknown>;
  vitalsSystem?: VitalsSystem;
  onConnect?: (user?: AioUser) => void;
  onDisconnect?: (user?: AioUser) => void;
  onTTCommand?: (cmd: string, arg?: number) => void;
  /** True when this server authenticates INDIVIDUALS (sessions / `users:` /
   *  `resolveUser` / login flows). It is the context `rawStateControlAllowed`
   *  needs: in public mode there is no identity to check and the dev panel is
   *  the point; in per-user mode a `tt-cmd` frame is raw-state control and
   *  answers to the admin bar. */
  perUserAuth?: boolean;
  getTTBroadcast?: () => unknown;
  syncHandler?: {
    handleOp: (
      op: unknown,
      meta: { id: string; user?: unknown },
      socket: WebSocket,
    ) => void;
    handleSync: (
      sync: unknown,
      meta: { id: string; user?: unknown },
      socket: WebSocket,
    ) => void;
  };
  /** Re-resolve a session token → its CURRENT user, or null when it is gone
   *  (revoked, kicked, password-rotated, expired). Supplied whenever a session
   *  store exists. See `_revalidate` for why a socket must ask again. */
  revalidateSession?: (token: string) => AioUser | null;
  /** Re-run `users:`/`resolveUser` for a token → its CURRENT user, or null
   *  when the app no longer accepts it. May be async (a DB, a JWKS). */
  revalidateToken?: (
    token: string,
  ) => AioUser | null | Promise<AioUser | null>;
}

/** Returned by createWsManager — the WS subsystem's public API */
export interface WsManager {
  handleWs: (
    req: Request,
    user?: AioUser,
    clientKey?: string,
    sessionToken?: string,
    resolverToken?: string,
  ) => Response;
  connections: Map<WebSocket, ClientMeta>;
  payloadStats: Map<
    string,
    { lastPayloadBytes: number; totalBytes: number; count: number }
  >;
  pendingClientState: Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >;
  sendToWsClient: (
    idx: number,
    msg: string,
  ) => { found: true; promise: Promise<Response> } | { found: false };
  /** Re-check every socket's session NOW (a session was revoked out of band).
   *  Same decider as the periodic sweep — this only removes the latency. */
  sweepSessions: () => void;
  shutdown: () => void;
}

const PENDING_STATE_MAX = 50;

/** Factory — creates isolated WS manager with its own connection state */
export function createWsManager(deps: WsDeps): WsManager {
  // W6.6: per-client limits are configurable; defaults stay the hardened
  // constants so existing deployments are unchanged.
  const _maxMsg = effectiveMaxMessage(
    deps.wsLimits?.maxMessageBytes ?? WS_MAX_MESSAGE,
  );
  if (_maxMsg.warning) log.warn("ws", _maxMsg.warning);
  const wsMaxMessage = _maxMsg.limit;
  const wsRateLimit = deps.wsLimits?.messagesPerSec ?? WS_RATE_LIMIT;
  const wsBytesPerSec = deps.wsLimits?.bytesPerSec ?? WS_BYTES_PER_SEC;
  // Said at startup, not discovered per frame: a frame between the two limits
  // passes the size check and can then never fit a second's byte budget, so
  // the larger `maxMessageBytes` is a promise this server refuses every time.
  if (wsMaxMessage > wsBytesPerSec) {
    log.warn(
      "ws",
      `wsLimits: maxMessageBytes (${wsMaxMessage}) is larger than bytesPerSec ` +
        `(${wsBytesPerSec}) — a frame between the two is always refused; ` +
        `raise bytesPerSec to at least maxMessageBytes`,
    );
  }

  // Global rolling-window message counter — protects against distributed
  // clients each staying under the per-socket limit while flooding the server.
  let _totalMsgsThisSec = 0;
  /** The connection ceiling has been reported once for this process. */
  let _warnedMaxConn = false;

  /** Tell the SENDER its frame was refused.
   *
   *  A limit enforced by silence is indistinguishable from a bug in the app.
   *  Three of these paths dropped the frame, logged it on the SERVER, and
   *  returned — while client sends are fire-and-forget, so a dropped frame is
   *  a message that vanishes on both ends. A field report raised `wsLimits` on
   *  both hops to stop losing photos (base64 + JSON wrapping puts a ~0.75 MB
   *  image over the 1 MB frame default) and could only find out by inference.
   *
   *  `diag` is an existing S→C kind that every v3 client already routes to one
   *  sink (overlay when the page has one, console otherwise), so this adds no
   *  protocol vocabulary and no version bump — the refusal simply arrives. */
  const refuse = (
    socket: WebSocket,
    kind: string,
    message: string,
    hint: string,
  ): void => {
    try {
      socket.send(enc("diag", {
        type: `ws-${kind}`,
        severity: "error",
        source: "server-ws",
        message,
        hint,
        ts: Date.now(),
      }));
    } catch { /* aio-ok: the socket is gone — the log line is the record */ }
  };

  /** The `cid` of a frame we are about to DROP, when it carries one.
   *
   *  `refuseAction` below states the rule this restores: "A refused frame that
   *  carries a cid is TOLD. The client registered an ack for it, so a silent
   *  return left `await cell.method()` waiting to its ceiling for a method
   *  that was never dispatched — then blaming a server that 'never confirmed
   *  the call'." That was applied to the refusals that happen AFTER parsing;
   *  the four limit drops above it happen BEFORE, and used the `diag` channel
   *  alone — which every client routes to a log, and which carries no cid, so
   *  it can settle nothing.
   *
   *  MEASURED: 250 sequential `await cell.method()` calls over one socket —
   *  248 applied, and 2 frames dropped by the per-client budget. Those two
   *  callers waited out the full ack ceiling and were then told the server
   *  "never confirmed the call: it may still be running (its writes can commit
   *  later)". It was not running and never would; the server had already
   *  decided, and said so where the call could not hear it.
   *
   *  A scan, not a parse: this runs only on a path that is already dropping
   *  the frame, and must not turn an oversized frame into work. */
  const _CID_SCAN = 64 * 1024;
  const _CID_RE = /"cid":"([A-Za-z0-9._:-]{1,64})"/;
  /** …and a scan is the FALLBACK, not the answer. A regex finds the first
   *  `"cid"` anywhere in the frame — including one the app itself put in its
   *  own payload, which is where an outbox row's correlation id naturally
   *  lives. The envelope's real cid is appended AFTER `payload` in every frame
   *  this client emits (`{...action, cid}`), so the app's won. Measured: a
   *  `chat:send` carrying `{ cid: "row-7f3a", image: … }` over the size limit
   *  was refused, the ack came back addressed to `row-7f3a`, and the awaiting
   *  call was never settled at all. Worse, if that string happens to name a
   *  live call, an UNRELATED `await cell.method()` is rejected with a failure
   *  belonging to a different frame. A parse cannot make that mistake. */
  const _CID_PARSE_MAX = 256 * 1024;
  /** The kind of frame this cid belongs to, so the refusal is answered on the
   *  channel its CALLER is listening on. A `serverFn` waits for `sfnr`; the
   *  ack registry it was answered on is a different map, so the promise stayed
   *  pending to its full 30s ceiling and then said the function "may still be
   *  running" — it never ran. */
  const _droppedCall = (
    data: unknown,
  ): { cid: string; kind: string } | null => {
    if (typeof data !== "string") return null;
    // STRUCTURAL first: `d.cid` is the envelope's own, whatever the app's
    // payload happens to be called.
    if (data.length <= _CID_PARSE_MAX) {
      try {
        const f = JSON.parse(data) as {
          t?: unknown;
          d?: { cid?: unknown } | null;
          cid?: unknown;
        };
        const d = f?.d;
        const cid = typeof d?.cid === "string"
          ? d.cid
          : typeof f?.cid === "string"
          ? f.cid
          : null;
        // Parsed cleanly and carried no envelope cid — that IS the answer;
        // falling back to the scan here is how the app's payload field got
        // picked up in the first place.
        return cid && cid.length <= 64
          ? { cid, kind: typeof f?.t === "string" ? f.t : "" }
          : null;
      } catch {
        /* aio-ok: not JSON, or truncated — the scan is the fallback */
      }
    }
    const cid = _droppedCid(data);
    return cid ? { cid, kind: "" } : null;
  };
  const _droppedCid = (data: unknown): string | null => {
    if (typeof data !== "string") return null;
    // The BUDGET is bounded, not the frame. A length cap on the input meant
    // the frame refused for being TOO LARGE — the one case that most needs
    // its caller settled — was the one case whose cid was never read, so a
    // 1 MB call hung forever while every smaller refusal answered. Found by
    // fuzzing the door: 26 of 27 malformed frames settled, and the 1 MB one
    // did not. A cid rides beside `type` inside `d`, so it is near one end or
    // the other; scan both ends and stay O(128 KB) whatever arrives.
    // The END first: the envelope's cid is appended after the action's own
    // fields, so when only a scan is possible the tail is the better guess.
    if (data.length <= _CID_SCAN * 2) return _CID_RE.exec(data)?.[1] ?? null;
    return _CID_RE.exec(data.slice(-_CID_SCAN))?.[1] ??
      _CID_RE.exec(data.slice(0, _CID_SCAN))?.[1] ?? null;
  };

  /** Refuse a frame AND settle the call it was carrying. The diag explains the
   *  server-wide situation (another client may be the cause); the ack error is
   *  what stops one caller hanging for a frame that is already gone. */
  const settleDroppedCall = (
    socket: WebSocket,
    data: unknown,
    message: string,
    /** Set when the frame was refused against a budget that reopens by
     *  itself — the ack then says when a re-send will be taken
     *  (`AckPayload.retryAfterMs`), and a client that can re-send holds the
     *  call instead of failing it. */
    retryAfterMs?: number,
  ): void => {
    const call = _droppedCall(data);
    if (!call) return;
    if (call.kind === "sfn") {
      // A serverFn caller waits on `sfnr`, never on `ack`.
      try {
        socket.send(
          enc("sfnr", { cid: call.cid, ok: false, error: message }),
        );
      } catch { /* aio-ok: the client is gone; nothing left to settle */ }
      return;
    }
    _sendAckErr(
      socket,
      call.cid,
      new Error(message),
      retryAfterMs === undefined ? undefined : { retryAfterMs },
    );
  };

  const refuseFrameWithCall = (
    socket: WebSocket,
    data: unknown,
    kind: string,
    message: string,
    hint: string,
    retryAfterMs?: number,
  ): void => {
    refuse(socket, kind, message, hint);
    settleDroppedCall(socket, data, message, retryAfterMs);
  };

  /** One "fuse tripped" line per window, not one per dropped frame. */
  let _globalFuseReported = false;
  let _globalRateTimer: ReturnType<typeof setTimeout> | undefined;
  let _globalWindowStart: number | undefined;
  /** Frames each client put into the global fuse THIS window — what "more
   *  than its even share" is measured against. Cleared with the counter, so
   *  a closed socket's entry lives at most one second. */
  const _fuseShare = new Map<ClientMeta, number>();

  const connections = new Map<WebSocket, ClientMeta>();

  /** Run `onConnect` / `onDisconnect` — observe-only, so a failure is reported
   *  and never breaks the socket's lifecycle, WHICHEVER way it fails. The
   *  try/catch alone saw only a sync throw: an `async` hook that rejected
   *  escaped as an unhandled rejection, which the crash handler logs while the
   *  app runs and which ends the process during shutdown, when every socket
   *  disconnects at once. (`composeHooks` guards the same way once plugins are
   *  installed; with only the app's own hook, this is the guard.) A failed
   *  `onConnect` used to be a DEBUG line — invisible at the default level. */
  const _runConnHook = (
    name: "onConnect" | "onDisconnect",
    hook: (user?: AioUser) => void,
    user: AioUser | undefined,
  ): void => {
    const failed = (e: unknown) =>
      log.warn(
        "ws",
        `hook ${name} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    // Server origin: a connection hook is the APP's server code, exactly like
    // `onInit` or a schedule. In production this is a pass-through (no scope
    // is installed); under `testUI`, with the server in the same isolate, an
    // `onConnect` calling a cell whose `access` refuses the network — the
    // canonical presence pattern, `relay.setOnline(user.id, true)` — was
    // refused as "an anonymous UI" (tests/access-conn-hook-origin.test.tsx).
    try {
      guardHookResult(inServerOrigin(() => hook(user)), failed);
    } catch (e) {
      failed(e);
    }
  };

  // ── Session revocation reaches live sockets ────────────────────────────────
  // `meta.user` used to be resolved ONCE, at upgrade, and never again: logging
  // out (or kicking a user, or rotating a password, or the session simply
  // expiring) killed the token for HTTP while the already-open socket kept
  // dispatching as that identity and kept receiving its `forUser` state — for
  // as long as it stayed connected. `sessions.ts` promises tokens are
  // "revocable at any time (logout, kick, breach response)"; a control that
  // only half-applies is not a control.
  //
  // CLOSING is the fix, not per-action filtering: the socket also RECEIVES
  // that identity's state, so leaving it open but ignoring its frames still
  // leaks. We learn about revocation by ASKING the store rather than by a
  // callback threaded through the boot path, because the same question also
  // answers TTL expiry and out-of-band edits — one decider covering every way
  // a session can die, instead of one per revocation call site.
  //
  // Two triggers, same decider: every inbound frame (immediate — a revoked
  // socket cannot act even once) and a sweep (idle sockets stop receiving).
  const SESSION_SWEEP_MS = 5_000;
  let _sessionSweep: ReturnType<typeof setInterval> | undefined;

  /** True when the socket may keep going. Closes + reaps it when its session
   *  is gone. Sockets without a session token are not this function's
   *  question: anonymous and shared-key sockets have no per-user credential,
   *  and `users:`/`resolveUser` tokens are re-checked by the sweep instead
   *  (`_revalidateResolved` — the hook may be async, so never per frame). */
  function _revalidate(socket: WebSocket, meta: ClientMeta): boolean {
    if (!meta.sessionToken || !deps.revalidateSession) return true;
    const fresh = deps.revalidateSession(meta.sessionToken);
    if (fresh) {
      _adoptUser(socket, meta, fresh); // a role change lands here too
      return true;
    }
    deps.debug(
      `ws: closing ${meta.id.slice(0, 8)} — session revoked or expired (user=${
        meta.user?.id ?? "anon"
      })`,
    );
    meta.sessionToken = undefined; // one close, not one per frame
    try {
      socket.close(1008, "session revoked");
    } catch { /* already closing */ }
    connections.delete(socket);
    _clearTimers(meta);
    return false;
  }

  /** Close + reap one socket whose credential the app stopped accepting. */
  function _closeRevoked(socket: WebSocket, meta: ClientMeta, why: string) {
    deps.debug(
      `ws: closing ${meta.id.slice(0, 8)} — ${why} (user=${
        meta.user?.id ?? "anon"
      })`,
    );
    meta.resolverToken = undefined; // one close, not one per sweep
    try {
      socket.close(1008, "credential revoked");
    } catch { /* already closing */ }
    connections.delete(socket);
    _clearTimers(meta);
  }

  // ── …and so does revocation of a `resolveUser` / `users:` token ────────────
  // Only session-store tokens used to be re-checked, on the stated grounds
  // that "nothing can revoke" the others. Everything can: an API key is deleted
  // from its table, a JWT expires, an entry leaves the `users` map. Measured:
  // a socket opened with `?token=key-1` kept receiving `forUser` private state
  // for 8 more seconds of broadcasts after `resolveUser` started returning
  // null for key-1 — and would have kept it for as long as it stayed open,
  // while the same key already answered 401 over HTTP.
  //
  // Sweep only, never per frame: the hook may be async and may hit a database
  // or a JWKS endpoint, so it runs off the hot path, ONCE per distinct token
  // per round (a thousand sockets on one key are one call), and a round never
  // starts while the previous one is still waiting.
  //
  // A hook that THROWS fails CLOSED for the sockets on that token: the socket
  // is no more trusted than a fresh request with the same credential, and the
  // client's reconnect gets exactly the verdict a new handshake gets. Said out
  // loud, once per round — a resolver outage is the operator's to see.
  /** How long ONE `resolveUser` re-check may hold up its round. */
  const RESOLVER_CHECK_TIMEOUT_MS = 3_000;
  /** Distinct tokens re-checked at once. */
  const RESOLVER_CHECK_CONCURRENCY = 8;
  let _resolverRound: Promise<void> | null = null;
  /** Tokens whose re-check is still out — it outlived its round's timeout.
   *  Never called again until it answers: one pending call per token, not one
   *  more per round piling up behind a hook that never returns. */
  const _resolverPending = new Set<string>();

  // The round is a bounded POOL, not a loop. It used to await each token in
  // turn, so ONE hook that never settles (a stalled JWKS fetch, a pool with no
  // free connection) held the round open forever — and `_resolverRound` kept
  // every later round from starting. Measured: a second token revoked while a
  // first one's check hung was still open 20 s later, and so was a third one
  // opened after that, while the same revocation without the hang closed in
  // ~5 s. A slow-but-healthy hook cost the same shape linearly: 60 tokens ×
  // 150 ms was a 9 s round on a 5 s sweep.
  //
  // A check that outlives RESOLVER_CHECK_TIMEOUT_MS stops holding its round,
  // and its verdict is still APPLIED whenever it lands. Until then its sockets
  // stay open on their last verdict: unlike a throw (an answer — "I cannot
  // vouch for this", fail closed), a timeout is no answer at all, and closing
  // every socket whenever the resolver is merely slow turns one slow
  // dependency into a reconnect storm aimed at that same dependency. Said out
  // loud every round it lasts.
  function _revalidateResolved(): void {
    const verify = deps.revalidateToken;
    if (!verify || _resolverRound) return;
    const byToken = new Map<string, Array<[WebSocket, ClientMeta]>>();
    for (const entry of connections) {
      const tok = entry[1].resolverToken;
      if (!tok) continue;
      const list = byToken.get(tok);
      if (list) list.push(entry);
      else byToken.set(tok, [entry]);
    }
    if (byToken.size === 0) return;
    _resolverRound = (async () => {
      let threw = 0;
      let lastErr: unknown;
      let timedOut = 0;
      let stillOut = 0;
      let roundOver = false;

      const check = async (
        tok: string,
        sockets: Array<[WebSocket, ClientMeta]>,
      ): Promise<void> => {
        _resolverPending.add(tok);
        let fresh: AioUser | null;
        let failed = false;
        try {
          fresh = await verify(tok);
        } catch (e) {
          failed = true;
          fresh = null;
          if (roundOver) {
            // Its round already reported; this verdict is new news.
            log.warn(
              "ws",
              `resolveUser threw (after timing out) while re-checking a live ` +
                `token — its sockets were closed (fail closed). Error: ${e}`,
            );
          } else {
            threw++;
            lastErr = e;
          }
        } finally {
          _resolverPending.delete(tok);
        }
        for (const [socket, meta] of sockets) {
          // Closed (or re-keyed) while the hook was out.
          if (!connections.has(socket) || meta.resolverToken !== tok) continue;
          if (fresh) _adoptUser(socket, meta, fresh); // a role change too
          else {
            _closeRevoked(
              socket,
              meta,
              failed ? "resolveUser threw" : "token no longer accepted",
            );
          }
        }
      };

      const queue = [...byToken];
      const worker = async (): Promise<void> => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const [tok, sockets] = next;
          if (_resolverPending.has(tok)) {
            stillOut++;
            continue;
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          const late = await Promise.race([
            check(tok, sockets).then(() => false),
            new Promise<boolean>((r) => {
              timer = setTimeout(() => r(true), RESOLVER_CHECK_TIMEOUT_MS);
            }),
          ]);
          clearTimeout(timer);
          if (late) timedOut++;
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(RESOLVER_CHECK_CONCURRENCY, queue.length) },
          worker,
        ),
      );
      roundOver = true;
      if (threw > 0) {
        log.warn(
          "ws",
          `resolveUser threw while re-checking ${threw} live token(s) — ` +
            `their sockets were closed (fail closed). Last error: ${lastErr}`,
        );
      }
      if (timedOut + stillOut > 0) {
        log.warn(
          "ws",
          `resolveUser did not answer within ${RESOLVER_CHECK_TIMEOUT_MS} ms ` +
            `while re-checking ${timedOut + stillOut} live token(s)` +
            (stillOut > 0 ? ` (${stillOut} still waiting from earlier)` : "") +
            ` — their sockets stay open on their last verdict until it does, ` +
            `so a token revoked meanwhile is NOT closed yet. The other ` +
            `tokens were re-checked. Look at what the hook is waiting on.`,
        );
      }
    })().finally(() => {
      _resolverRound = null;
    });
  }

  /** A re-check answered with a user: adopt it, and when it is a DIFFERENT
   *  user (a role change, a claim edit), send this socket its view again.
   *
   *  `meta.user` used to be updated and nothing else. Every later broadcast
   *  reads it, so the view was right from the next state change on — but only
   *  then: measured, a socket demoted from admin to user kept showing the
   *  admin-only slice with no frame sent at all for as long as the app sat
   *  idle, and a promoted one never saw what it had just been granted. The
   *  demotion is the one that matters: the UI keeps DISPLAYING data the app
   *  already decided this identity may not see. */
  function _adoptUser(
    socket: WebSocket,
    meta: ClientMeta,
    fresh: AioUser,
  ): void {
    const prev = meta.user;
    meta.user = fresh;
    const a = userMemoKey(prev), b = userMemoKey(fresh);
    // An unserializable record cannot be compared whole; its id and role are
    // what a view is decided on in practice. Never "assume changed" there —
    // `_revalidate` runs on every inbound frame, and a full view per frame
    // is a cost, not a safeguard.
    const same = a !== null && b !== null
      ? a === b
      : prev?.id === fresh.id && prev?.role === fresh.role;
    if (same) return;
    deps.debug(
      `ws: ${meta.id.slice(0, 8)} user changed (${prev?.id ?? "anon"}/${
        prev?.role ?? "-"
      } → ${fresh.id}/${fresh.role ?? "-"}) — re-sending its view`,
    );
    // Same ordering rule as every other out-of-loop snapshot.
    drainBeforeSnapshot();
    try {
      const msg = JSON.stringify(
        filterStateBySubs(deps.getUIState(meta.user), meta.subscriptions),
      );
      if (!meta.lastFullJsonStale && msg === meta.lastFullJson) return;
      socket.send(encRaw("state", msg));
      meta.lastFullJson = msg;
      meta.lastFullJsonStale = false;
      meta.needsFull = false;
      meta.bpLastSentAt = Date.now();
    } catch (err) {
      log.warn("ws", `state re-send after a user change failed — ${err}`);
    }
  }

  function sweepSessions(): void {
    let live = 0;
    for (const [socket, meta] of connections) {
      if (_revalidate(socket, meta) && meta.sessionToken) live++;
      else if (meta.resolverToken && deps.revalidateToken) live++;
    }
    _revalidateResolved();
    // Nothing left to watch — stop polling until the next session socket
    // arrives (`handleWs` restarts it). A timer that outlives its reason is
    // how "cheap" becomes "always on".
    if (live === 0 && _sessionSweep) {
      clearInterval(_sessionSweep);
      _sessionSweep = undefined;
    }
  }

  function _startSessionSweep(): void {
    if (_sessionSweep) return;
    if (!deps.revalidateSession && !deps.revalidateToken) return;
    _sessionSweep = setInterval(sweepSessions, SESSION_SWEEP_MS);
    // Never a reason to keep the process alive on its own.
    Deno.unrefTimer?.(_sessionSweep as unknown as number);
  }

  const payloadStats = new Map<
    string,
    { lastPayloadBytes: number; totalBytes: number; count: number }
  >();
  const pendingClientState = new Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const nextIndex = () => deps.clientCounter.value++;

  // F-4: IP/client-key denylist with TTL. Survives socket reconnects so
  // abusive clients can't reset their strike count by opening new connections.
  /** key → its block and its strike history. An entry outlives its block by
   *  `ABUSE_STRIKE_MEMORY_MS`, which is what lets a repeat offender's next
   *  block be longer than its first. */
  type AbuseEntry = {
    /** Blocked until (epoch ms). */
    until: number;
    strikes: number;
    lastStrike: number;
    /** A refused handshake has been logged for THIS block. */
    reported: boolean;
  };
  const abuseDenylist = new Map<string, AbuseEntry>();
  /** Ceiling on distinct denylisted keys — see `_addToDenylist`. */
  const ABUSE_DENYLIST_MAX_KEYS = 10_000;
  const _abuseExpired = (e: AbuseEntry, now: number) =>
    now > e.until && now - e.lastStrike > ABUSE_STRIKE_MEMORY_MS;
  /** The block on `key` still has this many ms to run, or 0. */
  function _deniedFor(key: string | undefined): number {
    if (!key) return 0;
    const entry = abuseDenylist.get(key);
    if (entry === undefined) return 0;
    const now = Date.now();
    if (_abuseExpired(entry, now)) {
      abuseDenylist.delete(key);
      return 0;
    }
    if (now > entry.until) return 0;
    // Said ONCE per block, at warn: a refused handshake used to be a debug
    // line, so an app locked out of its own server looked, from the server
    // side, like nobody was trying to connect.
    if (!entry.reported) {
      entry.reported = true;
      log.warn(
        "ws",
        `ws: refusing connections from ${key} for another ${
          Math.ceil((entry.until - now) / 1000)
        }s (rate-limit block, strike ${entry.strikes}) — answered 429`,
      );
    }
    return entry.until - now;
  }
  /** Block `key`; returns the block's length and which strike this is. */
  function _addToDenylist(
    key: string | undefined,
  ): { ms: number; strike: number } {
    if (!key) return { ms: 0, strike: 0 };
    const now = Date.now();
    // BOUNDED, because every entry is remote-fed. Entries were removed only
    // when the SAME key came back and found itself expired — an attacker
    // rotating addresses never comes back, so each one left a permanent entry
    // and the map was a memory pump driven from outside. Expire first, then
    // (still full) drop the oldest: insertion order is age order, and the
    // oldest strikes are the ones nearest expiry anyway.
    if (abuseDenylist.size >= ABUSE_DENYLIST_MAX_KEYS) {
      for (const [k, e] of abuseDenylist) {
        if (_abuseExpired(e, now)) abuseDenylist.delete(k);
      }
      const target = Math.floor(ABUSE_DENYLIST_MAX_KEYS * 0.9);
      for (const k of abuseDenylist.keys()) {
        if (abuseDenylist.size <= target) break;
        abuseDenylist.delete(k);
      }
    }
    const prev = abuseDenylist.get(key);
    const strike = prev && !_abuseExpired(prev, now) ? prev.strikes + 1 : 1;
    const ms = abuseBlockMs(strike);
    // Re-inserted, so insertion order stays age-of-last-strike order for the
    // eviction above.
    abuseDenylist.delete(key);
    abuseDenylist.set(key, {
      until: now + ms,
      strikes: strike,
      lastStrike: now,
      reported: false,
    });
    return { ms, strike };
  }

  // Derive request kind from the outgoing command envelope for the dedup key
  const reqKind = (msg: string) => {
    const t = dec(msg)?.t;
    return t === "ui-surface"
      ? "surface"
      : t === "ui-trigger"
      ? "trigger"
      : "clientState";
  };

  function handleWs(
    req: Request,
    user?: AioUser,
    clientKey?: string,
    sessionToken?: string,
    resolverToken?: string,
  ): Response {
    // F-4: reject denylisted clients at handshake so reconnect loops can't
    // reset per-socket abuse counters.
    const deniedMs = _deniedFor(clientKey);
    if (deniedMs > 0) {
      return new Response(
        `Too Many Requests — this address is blocked for another ${
          Math.ceil(deniedMs / 1000)
        }s for exceeding the per-connection message budget`,
        {
          status: 429,
          headers: { "retry-after": String(Math.ceil(deniedMs / 1000)) },
        },
      );
    }
    // CSWSH defense — always validate Origin header. Browsers attach Origin to
    // every cross-origin WebSocket upgrade; same-origin tools (curl, internal
    // health checks) typically omit it, in which case we accept the upgrade.
    //
    // Audit F-2: previous logic only ran the check when (!expose || allowedOrigins),
    // so `--expose` without an explicit allowedOrigins accepted any origin —
    // a Cross-Site WebSocket Hijacking surface for token-in-URL deployments.
    const origin = req.headers.get("origin");
    // F-6: defense-in-depth for --expose deployments. When strictOrigin is on,
    // reject upgrades that have no Origin header (or empty string). Without this,
    // origin-stripping proxies and certain sandboxed contexts reach the handler
    // with falsy `origin` and bypass the check below.
    if (deps.expose && deps.strictOrigin && !origin) {
      deps.debug("ws: rejected — strictOrigin requires Origin header");
      return new Response("Forbidden", { status: 403 });
    }
    if (origin) {
      // THE Origin decider (server-auth.ts `originVerdict`) — the one the HTTP
      // CSRF gate reads. This was a hand-kept inline copy of it: the same
      // own-origin + scheme + `allowedOrigins` rules, spelled twice, so a fix
      // to one (the full-origin allowlist match, `aio://app` for aio's own
      // Electron shell) had to be remembered for the other. 400 is an Origin
      // that does not parse (`null` included), 403 a foreign one.
      const verdict = originVerdict(origin, {
        hostHeader: req.headers.get("host"),
        secure: deps.secure === true,
        allowedOrigins: deps.allowedOrigins,
      });
      if (verdict) {
        deps.debug(
          `ws: rejected — ${verdict.reason}` +
            (verdict.status === 403
              ? "; add it to allowedOrigins if it is meant to connect"
              : ""),
        );
        return verdict.status === 400
          ? new Response("Bad Request", { status: 400 })
          : new Response("Forbidden", { status: 403 });
      }
    }

    const maxConn = deps.maxConnections ?? WS_MAX_CONNECTIONS;
    if (connections.size >= maxConn) {
      // A CEILING THAT IS HIT IS SAID OUT LOUD — once, then debug.
      //
      // This was `deps.debug` alone: the 101st user of an exposed app got a
      // bare 503 and the operator saw nothing at all. 100 is right for a
      // desktop app talking to itself and surprising for a LAN server — a
      // field report's relay registers up to 10,000 usernames and had never
      // overridden it, because nothing had ever told them the number existed.
      //
      // Once per process, naming the knob: a full server would otherwise
      // print one line per refused connection, which is how the one line that
      // explains an outage gets lost.
      if (!_warnedMaxConn) {
        _warnedMaxConn = true;
        log.warn(
          "ws",
          `connection ceiling reached: ${connections.size} of ${maxConn} — ` +
            `further clients are refused with 503 until one disconnects. ` +
            `Raise it with aio.run({ maxConnections: N }) if this app serves ` +
            `more than ${maxConn} people at once. (said once per process)`,
        );
      }
      deps.debug(`ws: rejected — max connections (${maxConn})`);
      return new Response("Too Many Connections", { status: 503 });
    }
    // Read headers BEFORE upgrading — upgradeWebSocket consumes the request,
    // and header access afterwards throws "Request closed" (Deno ≥2.9),
    // killing the serve callback on every WS connect.
    const userAgent = req.headers.get("user-agent") ?? "";
    // Same reason: snapshot the request for serverRequest() BEFORE the upgrade
    // consumes it. Every frame on this socket carries the connection's facts.
    const request = makeServerRequest(req, clientKey, "ws");
    // A plain GET /ws (a crawler, a health probe, a curl) is not a handshake.
    // `Deno.upgradeWebSocket` THROWS on it, and that throw was a 500 in every
    // auth mode — the one status that reads as "the server is broken". The
    // HTTP answer for "you must upgrade" exists: 426, naming the protocol.
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response(
        "Upgrade Required — /ws speaks WebSocket only. Send `Upgrade: " +
          "websocket` (a browser's `new WebSocket(url)` does), or use the " +
          "HTTP endpoints for everything else.",
        {
          status: 426,
          headers: { Upgrade: "websocket", Connection: "Upgrade" },
        },
      );
    }
    let socket: WebSocket, response: Response;
    try {
      ({ socket, response } = Deno.upgradeWebSocket(req));
    } catch (e) {
      // The header said websocket and the rest of the handshake did not
      // (missing key/version) — the CLIENT's request is malformed.
      return new Response(
        `Bad Request — malformed WebSocket handshake: ${
          e instanceof Error ? e.message : String(e)
        }`,
        { status: 400 },
      );
    }
    const clientId = crypto.randomUUID();
    // Meter the SOCKET, not the callers. Frames reach a client from several
    // places — the broadcaster, the handshake's first state, per-action acks,
    // diagnostics — and instrumenting each one guarantees the count drifts the
    // day a new sender is added. `am cost` promises "the bytes that crossed the
    // wire", and a correctness test holds it to a real client's own count
    // (tests/cost-wire-accuracy.test.ts), so the measurement belongs at the one
    // place every frame passes through.
    if (deps.costMeter) {
      const meter = deps.costMeter;
      const rawSend = socket.send.bind(socket);
      socket.send = (
        data: string | ArrayBufferLike | Blob | ArrayBufferView,
      ) => {
        try {
          const bytes = typeof data === "string"
            ? new TextEncoder().encode(data).byteLength
            : ((data as ArrayBufferView).byteLength ?? 0);
          // Read the envelope's kind EXACTLY — `{"v":2,"t":"<kind>",…}` — never
          // by substring: a patch payload can contain the literal `"t":"state"`
          // in its own data. And acks / diagnostics / time-travel frames are
          // `other`, not full resends: counting a wall of 40-byte acks as
          // "the whole state went out" is a plausible headline that is wrong,
          // and this feature was accepted on the condition that it never
          // produces one.
          const text = typeof data === "string" ? data : "";
          const envKind = /^\{"v":\d+,"t":"([^"]+)"/.exec(text)?.[1];
          const kind: "patch" | "full" | "other" = envKind === "patches"
            ? "patch"
            : envKind === "state"
            ? "full"
            : "other";
          meter.recordSend(bytes, clientId, kind);
        } catch { /* metering must never break a send */ }
        // The wrapper's parameter type is the DOM union (which includes
        // SharedArrayBuffer); the underlying send accepts the narrower one.
        // Nothing is transformed — the exact value goes through.
        (rawSend as (d: unknown) => void)(data);
      };
    }
    const clientIndex = nextIndex();
    const isElectron = /electron/i.test(userAgent);
    const meta: ClientMeta = {
      id: clientId,
      index: clientIndex,
      clientType: "unknown",
      isElectron,
      user,
      perUserAuth: deps.perUserAuth === true,
      msgCount: 0,
      bytesThisSec: 0,
      bpMultiplier: 1,
      bpConsecutiveLow: 0,
      bpLastSentAt: 0,
      subscriptions: null,
      disconnected: false,
      consecutiveDrops: 0,
      clientKey,
      request,
      sessionToken,
      resolverToken,
    };

    // ── Never write a frame this peer's runtime cannot take ───────────────
    //
    // Deno's WebSocket fails the connection on a message over 64 MiB — the
    // same ceiling this server documents inbound (`WS_RUNTIME_MAX_MESSAGE`).
    // Outbound there was no rule at all, so an app whose state grew past it
    // pushed a full state to a `connectCli` peer, the runtime killed the
    // socket with "Frame too large", the client reconnected and got the same
    // frame again: a loop moving 65 MB a second, with `onerror` swallowing the
    // only clue. The persist guard's 16 MiB hard limit never stopped it — it
    // refuses nothing by design and speaks about disk, not the wire.
    //
    // So the frame is refused HERE, the one place every frame passes, and the
    // peer is told why (a `diag`, the same channel every other refusal uses)
    // instead of being disconnected into a retry that cannot work. Only for a
    // peer whose ceiling is KNOWN (`peerFrameCeiling`): refusing a frame a
    // browser would have taken would be a regression, not a guardrail. The
    // check costs a length comparison for every frame under a third of the
    // ceiling — i.e. all of them (`overUtf8`).
    const peerCeiling = peerFrameCeiling(userAgent);
    if (peerCeiling !== undefined) {
      const rawSend = socket.send.bind(socket);
      let refused = 0;
      socket.send = (
        data: string | ArrayBufferLike | Blob | ArrayBufferView,
      ) => {
        if (typeof data === "string" && overUtf8(data, peerCeiling)) {
          const size = utf8Size(data);
          const kind = /^\{"v":\d+,"t":"([^"]+)"/.exec(data)?.[1] ?? "frame";
          const msg =
            `ws: a ${kind} frame of ${bytes(size)} is over the ${
              bytes(peerCeiling)
            } message ceiling of client ` +
            `${meta.index}'s runtime (a Deno peer — connectCli, am, another ` +
            `aio server) — NOT sent: writing it kills the connection, and the ` +
            `reconnect gets the same frame. This client has no state until ` +
            `the app's is smaller: move bulk rows to db: tables or files ` +
            `(docs/persistence/big-data.md).`;
          // Once per socket for the log — the round repeats every change —
          // and once for the peer, which only needs telling that it is stuck.
          if (refused++ === 0) {
            log.error("ws", msg);
            writeClientLog(meta.index, {
              level: "error",
              msg,
              ts: Date.now(),
              source: "server-ws",
            });
            try {
              (rawSend as (d: unknown) => void)(enc("diag", {
                type: "ws-frame-ceiling",
                severity: "error",
                source: "server-ws",
                message: msg,
                hint: `the whole state does not fit one WebSocket message on ` +
                  `this runtime (${bytes(peerCeiling)})`,
                ts: Date.now(),
              }));
            } catch { /* aio-ok: the socket is gone — the log is the record */ }
          }
          return;
        }
        (rawSend as (d: unknown) => void)(data);
      };
    }

    socket.onerror = (e) => {
      const detail = e instanceof ErrorEvent ? e.message : String(e);
      // A peer that vanishes without a close frame is a DISCONNECT, not a
      // fault. Closing the window is the ordinary way to end an Electron or
      // browser session, and Deno surfaces it as `Unexpected EOF` on the error
      // channel — so the last line of every single run was
      // `WARN ws error … — Unexpected EOF`, which reads as something going
      // wrong at exactly the moment nothing did (a field report's "the ugly").
      // The teardown below is identical either way; only the label changes,
      // and the text is still there at debug level.
      if (isPeerGone(detail)) {
        log.debug(
          "ws",
          `client ${clientId.slice(0, 8)} went away without a close frame ` +
            `(${detail})`,
        );
      } else if (isFrameTooLarge(detail)) {
        // The runtime refused a message over its own ceiling and closed the
        // socket — the one oversize aio cannot answer in-band (see
        // `effectiveMaxMessage`). Its caller is told only "connection lost",
        // so the server has to be the one that names the limit and the way out.
        log.error(
          "ws",
          `client ${clientId.slice(0, 8)} sent a message over the ` +
            `${WS_RUNTIME_MAX_MESSAGE}-byte (64 MiB) ceiling of Deno's ` +
            `WebSocket server, which closed the connection (${detail}). No ` +
            `wsLimits setting can raise it: send bulk data as a file upload ` +
            `or in chunks.`,
        );
      } else {
        log.warn("ws", `error ${clientId.slice(0, 8)} — ${detail}`);
      }
      connections.delete(socket);
      _clearTimers(meta);
      _cleanupVitals(meta);
      _settlePending(meta);
      _recheckBacklog();
      if (!meta.disconnected && deps.onDisconnect) {
        meta.disconnected = true;
        _runConnHook("onDisconnect", deps.onDisconnect, meta.user);
      }
    };

    socket.onopen = () => {
      // BEFORE this socket joins `connections`: the buffered patches go to
      // the peers whose base they describe; this one gets a snapshot that
      // already holds them (see drainBeforeSnapshot).
      drainBeforeSnapshot();
      connections.set(socket, meta);
      // The freeze watchdog's clock starts HERE, not at this client's first
      // vitals-ping — a peer that upgrades and then says nothing at all is
      // exactly the one the watchdog exists for. See transport-probe.ts.
      deps.vitalsSystem?.serverTransport.onClientConnected(meta.id);
      if (sessionToken || resolverToken) _startSessionSweep();
      meta.typeDetectTimer = setTimeout(() => {
        meta.typeDetectTimer = undefined;
        if (meta.clientType === "unknown") {
          meta.clientType = meta.isElectron
            ? "electron-reload"
            : "browser-reload";
        }
      }, 2000);
      deps.debug(
        `ws: connect ${clientId.slice(0, 8)} user=${
          user?.id ?? "anon"
        } (${connections.size} total)`,
      );
      if (deps.onConnect) _runConnHook("onConnect", deps.onConnect, meta.user);
      // A3: version handshake — server speaks first, before any state.
      // `rate` rides along so the client can PACE itself: the inbound budget
      // used to be a number only this side knew, and the only way to learn it
      // was to cross it and be disconnected. `maxMessageBytes` for the same
      // reason: the sync engine's reconnect flush sizes its frames to it. Spread
      // rather than passed to protoHello(), whose signature is public and
      // frozen.
      try {
        socket.send(
          enc("proto", {
            ...protoHello(VERSION, deps.appVersion),
            // At most what a client's `parseProtoHello` accepts: a client
            // built before it clamped DISCARDS a larger rate and paces at
            // the 100/sec fallback instead.
            rate: Math.min(wsRateLimit, 1_000_000),
            maxMessageBytes: wsMaxMessage,
          }),
        );
      } catch { /* socket closing during onopen (AIO-155) */ }
      try {
        const uiState = deps.getUIState(meta.user);
        const msg = JSON.stringify(uiState);
        socket.send(encRaw("state", msg));
        meta.lastFullJson = msg;
        // A client that DID get its initial state ends the episode. Without
        // this, five failures spread over the whole life of the process left
        // the app reporting degraded forever, however many clients connected
        // successfully afterwards — see the same fix on `ws:message` below.
        degraded("ws:initial-state").ok();
      } catch (e) {
        // The client is now connected and holds NO state — a blank UI, for
        // this client, forever (nothing re-sends a missed initial frame). At
        // `debug` that reached no sink under the default log level, so the
        // server believed it had served a client it had not.
        degraded("ws:initial-state").fail(e);
      }
      // The whole action log — every user's action types and error text — so
      // under per-user auth it is admin-only, like the `tt-cmd` it drives and
      // the broadcaster's flush (server-broadcast.ts `flushTT`).
      if (
        deps.getTTBroadcast &&
        !(meta.perUserAuth && !rawStateControlAllowed(meta.user))
      ) {
        try {
          socket.send(enc("tt-state", deps.getTTBroadcast()));
        } catch (e) {
          deps.debug(`ws: getTTBroadcast error on connect — ${e}`);
        }
      }
      try {
        socket.send(enc("boot", { id: deps.bootId }));
      } catch { /* socket closing during onopen (AIO-155) */ }
      if (deps.clientConfig && Object.keys(deps.clientConfig).length > 0) {
        try {
          socket.send(enc("cfg", deps.clientConfig));
        } catch { /* socket closing */ }
      }
    };

    socket.onmessage = (e) => {
      try {
        _handleMessage(socket, meta, e);
        // …and SAY SO. `degraded()`'s contract is "call ok() on every
        // success, not only the first", and this call site only ever called
        // `fail`. So any transient throw in here — not just the one the
        // `Object.hasOwn` guard above now prevents — left the app reporting
        // `degraded` for the rest of the process's life: twenty good
        // dispatches and a brand-new client did not clear it. A false alarm
        // that outlives its cause is worse than no alarm.
        degraded("ws:message").ok();
      } catch (err) {
        // "malformed message" is a GUESS about whose fault this is, and it was
        // made at `debug`: a genuine bug in server message handling looked
        // exactly like a bad client frame, and both were invisible. The tracker
        // separates them by frequency — one is a blip, a repeating one
        // escalates to /__aio/health and names the last error.
        degraded("ws:message").fail(err);
      }
    };

    socket.onclose = () => {
      connections.delete(socket);
      _clearTimers(meta);
      // A gone client's degradations are no longer live signal for health.
      _clearClientDegraded(meta.id);
      deps.debug(
        `ws: disconnect ${clientId.slice(0, 8)} user=${
          meta.user?.id ?? "anon"
        } (${connections.size} total)`,
      );
      _cleanupVitals(meta);
      _settlePending(meta);
      _recheckBacklog();
      if (!meta.disconnected && deps.onDisconnect) {
        meta.disconnected = true;
        _runConnHook("onDisconnect", deps.onDisconnect, meta.user);
      }
    };
    return response;
  }

  /** The connection is gone: answer every control request still waiting on
   *  it NOW, with the reason. Left alone, the entry ran out its
   *  `CLIENT_REPLY_TIMEOUT_MS` and then handed the caller the timeout's
   *  diagnosis — "the window is not VISIBLE / its main thread is busy / a
   *  headless client" — for a window that had simply closed. A field report
   *  lost two debugging passes to that text when it was RIGHT; sending someone
   *  down it for a client that no longer exists is worse. Same rule on UDS
   *  (`_settlePendingForGone`). Pinned by
   *  tests/pending-reply-settles-on-disconnect.test.ts. */
  function _settlePending(meta: ClientMeta): void {
    const prefix = `${meta.id}:`;
    for (const [key, pending] of pendingClientState) {
      if (!key.startsWith(prefix)) continue;
      pendingClientState.delete(key);
      clearTimeout(pending.timer);
      pending.resolve({
        error: `client ${meta.index} disconnected before answering`,
      });
    }
  }

  /** A socket just left. If no REMAINING peer is over the high-water mark,
   *  the "a WebSocket client is not draining" alarm has lost its cause.
   *
   *  The alarm is raised and lowered per broadcast ROUND
   *  (server-broadcast.ts), and a round only runs when state changes — so
   *  after the one wedged tab closed, `/__aio/health` went on reporting a
   *  peer that was not draining for as long as the app stayed idle, and for
   *  ever when that tab had been the only client (a round with zero
   *  connections never says `ok()`). The UDS half clears itself the moment a
   *  queue drains or dies; this is the WS half of the same rule. `ok()` on a
   *  tracker that never escalated only resets its counters. Pinned by
   *  tests/ws-backlog-clears-on-disconnect.test.ts. */
  function _recheckBacklog(): void {
    for (const ws of connections.keys()) {
      if (ws.bufferedAmount > WS_BUFFER_HIGH_WATER) return;
    }
    wsWriteBacklog.ok();
  }

  function _clearTimers(meta: ClientMeta): void {
    if (meta.msgResetTimer) {
      clearTimeout(meta.msgResetTimer);
      meta.msgResetTimer = undefined;
    }
    if (meta.typeDetectTimer) {
      clearTimeout(meta.typeDetectTimer);
      meta.typeDetectTimer = undefined;
    }
  }

  function _cleanupVitals(meta: ClientMeta): void {
    // UNCONDITIONAL, and first: `meta.id` is per connection, so anything left
    // keyed by it outlives the socket for the life of the process. The delete
    // used to sit inside the vitals gate below, which made "is vitals on?" the
    // decider for whether a per-connection map ever shrank — two deciders for
    // one fact, and the leaking one was the prod default.
    payloadStats.delete(meta.id);
    if (deps.vitalsSystem) {
      deps.vitalsSystem.serverTransport.removeClient(meta.id);
      deps.vitalsSystem.pressureMonitor?.onClientDisconnect(meta.id);
    }
  }

  /** Route a single WS message — called from socket.onmessage */
  function _handleMessage(
    socket: WebSocket,
    meta: ClientMeta,
    e: MessageEvent,
  ): void {
    // Before ANYTHING else: a socket whose session died acts zero more times.
    if (!_revalidate(socket, meta)) return;

    // A client that speaks is alive. Liveness used to be refreshed ONLY by a
    // `vitals-ping`, so a client mid-conversation — dispatching actions, being
    // acked — could still be graded frozen and have its state updates silently
    // dropped by `server-broadcast.ts`.
    deps.vitalsSystem?.serverTransport.onClientActivity(meta.id);

    // Rate limiting — per-second counter (original behavior)
    meta.msgCount++;
    if (!meta.msgResetTimer) {
      meta.msgWindowStart = Date.now();
      meta.msgResetTimer = setTimeout(() => {
        meta.msgCount = 0;
        meta.bytesThisSec = 0;
        meta.msgResetTimer = undefined;
      }, 1000);
    }

    // Reset global rolling-window counter once per second (lazy)
    if (!_globalRateTimer) {
      _globalWindowStart = Date.now();
      _globalRateTimer = setTimeout(() => {
        _totalMsgsThisSec = 0;
        _globalFuseReported = false;
        _fuseShare.clear();
        _globalRateTimer = undefined;
      }, 1000);
    }

    // H3/H4 fix: track consecutive drops for abuse detection (backpressure deadlock prevention)
    if (meta.msgCount > wsRateLimit) {
      meta.consecutiveDrops++;
      const dropMsg = `this frame was dropped: this connection is over its ` +
        `budget of ${wsRateLimit} messages/sec`;
      // EVERY dropped frame is answered, with when a re-send will be taken —
      // the threshold frame included. It used to close the socket without a
      // word, so that one caller learned nothing but "connection lost", which
      // reads as "may have applied". It did not; the server decided before
      // parsing it. aio's own client paces to the hello's `rate` and holds a
      // call answered this way until the window reopens.
      settleDroppedCall(
        socket,
        e.data,
        dropMsg,
        retryAfter(meta.msgWindowStart),
      );
      if (meta.consecutiveDrops >= CONSECUTIVE_DROP_THRESHOLD) {
        // F-4: block this client-key at handshake so reconnect loops can't
        // reset the strike counter — for a time proportionate to how often
        // this key has done it (`abuseBlockMs`), not a flat minute.
        const block = _addToDenylist(meta.clientKey);
        const msg =
          `ws: client ${
            meta.id.slice(0, 8)
          } flagged — ${meta.consecutiveDrops} consecutive drops over its ` +
          `${wsRateLimit} msg/sec budget; closed${
            block.ms > 0
              ? ` and ${meta.clientKey} blocked for ${block.ms / 1000}s ` +
                `(strike ${block.strike}; a repeat within ` +
                `${ABUSE_STRIKE_MEMORY_MS / 60_000} min doubles it, up to ` +
                `${ABUSE_DENYLIST_MS / 1000}s)`
              : ""
          }`;
        log.error("ws", msg);
        writeClientLog(meta.index, {
          level: "error",
          msg,
          ts: Date.now(),
          source: "server-ws",
        });
        try {
          socket.close(1008, "Rate limit exceeded");
        } catch { /* already closed */ }
        return;
      }
      // The drops BEFORE the threshold used to be silent on both ends — the
      // client sends fire-and-forget, so its message simply vanished. It now
      // learns on the first one, while it still has a socket to hear on.
      //
      // ONE EXPLANATION PER RUN, ONE SETTLEMENT PER CALL. The diag is
      // deliberately once — a tripped budget drops many frames and many
      // identical lines bury the one that explains it. The ack (above) is NOT:
      // each dropped frame is a DIFFERENT `await cell.method()`, and a caller
      // the server has already decided against must not wait out its ceiling
      // to be told the fate is unknown. Measured with both halves once-only:
      // two of four dropped callers still hung for the full 8s and were told
      // the call "may still be running (its writes can commit later)".
      if (meta.consecutiveDrops === 1) {
        refuse(
          socket,
          "rate",
          dropMsg,
          `raise it with aio.run({ wsLimits: { messagesPerSec: N } }), or ` +
            `batch — ${CONSECUTIVE_DROP_THRESHOLD} in a row closes the socket`,
        );
      }
      return;
    }

    // Global rate-limit fuse: rolling window counter on WsManager itself.
    //
    // AFTER the per-client check, and fed only by frames that passed it. It
    // used to run first and count every frame, so at a small budget one
    // flooding socket filled it before its own budget was ever consulted: at
    // `messagesPerSec: 10` (a fuse of 20 for two clients) the fuse ate the
    // flood, recorded no strike, the flooder's first in-budget frame of each
    // new second reset the ten strikes it did collect — so the 50-in-a-row
    // close never came — and every frame from the OTHER client was refused
    // "the server is over its total frame budget" for as long as the flood
    // lasted (0 of 23 applied). A frame already refused per-client costs the
    // server nothing more, and that client is on its way to being closed.
    //
    // The ceiling SCALES with the number of connected sockets. It used to be a
    // flat `wsRateLimit * 2` — 200 msg/sec for the whole server by default —
    // while each individual client is allowed 100, so four honest clients doing
    // vitals-pings, actions and acks could put the server over a limit none of
    // them was near, and every frame after that was dropped: an availability
    // cliff that arrives with the FOURTH user and looks like the network
    // failing. Per-client limiting is what stops one abusive socket (and it
    // denylists, above); this fuse is for the distributed case, so it trips
    // when the AVERAGE client exceeds its own budget, never merely because
    // there are several of them. The floor keeps the single-client case exactly
    // as strict as before.
    _totalMsgsThisSec++;
    const share = (_fuseShare.get(meta) ?? 0) + 1;
    _fuseShare.set(meta, share);
    // …and it is still a CEILING: linear growth with no upper bound would mean
    // no global limit at all (100 clients at 99 msg/s each is 9,900 under a
    // linear cap), which is the very case this fuse was written for. So it
    // scales with the room and then stops — never more than 50 clients' worth
    // of budget in aggregate, whatever the connection count.
    const globalCap = wsRateLimit *
      Math.min(50, Math.max(2, connections.size));
    // A tripped fuse refuses only the clients that took MORE than an even
    // split of it this second. Per-client windows do not line up with this
    // one, so a socket just inside its own budget can still land two windows'
    // worth here — enough, beside one other client, to fill the fuse alone
    // and starve that client again. Refusing by share means a client that
    // stays inside `globalCap / clients` (aio's own paced clients hold 80% of
    // their budget, and the split is the whole budget up to 50 clients) is
    // never refused because of a neighbour. Still a bound: once tripped, each
    // client keeps at most the larger of its share at the trip and the split,
    // which sums to at most twice the cap. None of this is a strike — N
    // honest clients filling the fuse between them are told `retryAfterMs`,
    // never closed.
    const fairShare = globalCap / Math.max(1, connections.size);
    if (_totalMsgsThisSec > globalCap) {
      if (share > fairShare) {
        // Once per window, not once per dropped FRAME: a tripped fuse drops
        // thousands, and thousands of identical lines is how the one line that
        // explains an outage gets lost.
        if (!_globalFuseReported) {
          _globalFuseReported = true;
          const msg =
            `ws: global rate limit exceeded (${_totalMsgsThisSec} msg/sec over ` +
            `${
              count(connections.size, "client")
            }, cap ${globalCap}) — dropping frames from clients over ` +
            `${Math.floor(fairShare)} this second until the next one`;
          log.error("ws", msg);
          writeClientLog(meta.index, {
            level: "error",
            msg,
            ts: Date.now(),
            source: "server-ws",
          });
        }
        // Told to the sender EVERY time, unlike the log line: the fuse is
        // server-wide, so the sender cannot tell it from its own budget and has
        // no other way to learn its frame is gone.
        refuseFrameWithCall(
          socket,
          e.data,
          "global-rate",
          `this frame was dropped: the server is over its total frame budget ` +
            `(${globalCap}/sec across ${
              count(connections.size, "client")
            }) and this connection has sent more than its even share ` +
            `(${Math.floor(fairShare)}) of it this second`,
          `this is a server-wide fuse, so other clients share the cause; ` +
            `aio.run({ wsLimits: { messagesPerSec: N } }) raises both the ` +
            `per-client budget and this ceiling`,
          retryAfter(_globalWindowStart),
        );
        return;
      }
    }

    // Reset consecutive drop counter on successful message
    meta.consecutiveDrops = 0;

    if (typeof e.data !== "string") {
      const msg = "ws: binary message dropped — only JSON strings accepted";
      log.error("ws", msg);
      writeClientLog(meta.index, {
        level: "error",
        msg,
        ts: Date.now(),
        source: "server-ws",
      });
      return;
    }
    // COMPAT: the refusal below is decided on `length` — UTF-16 code units —
    // and stays that way, because tightening it to bytes would start refusing
    // frames this server accepts today (a CJK payload is ~3× its length). But
    // the limit is DECLARED in bytes, so a frame that is over it in bytes and
    // under it in code units is accepted while breaking the promise the
    // handshake advertised: it is said, once per connection, rather than
    // quietly passed.
    if (
      e.data.length <= wsMaxMessage && !meta.overByteLimitSaid &&
      overUtf8(e.data, wsMaxMessage)
    ) {
      meta.overByteLimitSaid = true;
      const msg =
        `ws: a frame from ${meta.id.slice(0, 8)} is ${
          bytes(utf8Size(e.data))
        } — over the ${wsMaxMessage}-byte maxMessageBytes it was accepted ` +
        `under (${e.data.length} characters; non-ASCII text is up to 3 bytes ` +
        `each). The frame is ACCEPTED, as it has always been; raise ` +
        `wsLimits.maxMessageBytes to the byte size you really mean.`;
      log.warn("ws", msg);
      writeClientLog(meta.index, {
        level: "warn",
        msg,
        ts: Date.now(),
        source: "server-ws",
      });
    }
    if (e.data.length > wsMaxMessage) {
      const msg = `ws: message too large (${e.data.length} bytes), dropped`;
      log.error("ws", msg);
      writeClientLog(meta.index, {
        level: "error",
        msg,
        ts: Date.now(),
        source: "server-ws",
      });
      try {
        // The original refusal: a bare JSON object, which a non-aio peer can
        // read — and aio's OWN client cannot, because `dec()` rejects anything
        // that is not a v2 envelope and logs "undecodable frame — dropped".
        // Kept for the peers it does serve; the envelope below is the one this
        // framework's client actually surfaces.
        socket.send(
          JSON.stringify({
            error: "message_too_large",
            code: 1009,
            size: e.data.length,
          }),
        );
      } catch { /* client gone */ }
      refuseFrameWithCall(
        socket,
        e.data,
        "too-large",
        `this frame was dropped: ${e.data.length} bytes is over the ` +
          `${wsMaxMessage}-byte limit`,
        `raise it with aio.run({ wsLimits: { maxMessageBytes: N } }) — a ` +
          `photo is base64'd and JSON-wrapped on the way here, so it arrives ` +
          `about 1.35x its size on disk`,
      );
      return;
    }
    // A frame bigger than the WHOLE per-second byte budget can never be taken,
    // however long its sender waits — so it is refused for good, with no
    // `retryAfterMs`. It used to be told "retry": aio's client held its entire
    // pacer and re-sent it 8 times, and every other call on that socket waited
    // behind it (a 1.5 MB put against 1 MB/s: rejected after 8.8 s, an
    // unrelated `inc()` answered after 9.9 s, 17 server errors).
    if (e.data.length > wsBytesPerSec) {
      const msg = `ws: frame of ${
        (e.data.length / 1_000_000).toFixed(1)
      }MB from ${meta.id.slice(0, 8)} is over the whole byte budget (${
        (wsBytesPerSec / 1_000_000).toFixed(1)
      }MB/s), dropped`;
      log.error("ws", msg);
      writeClientLog(meta.index, {
        level: "error",
        msg,
        ts: Date.now(),
        source: "server-ws",
      });
      refuseFrameWithCall(
        socket,
        e.data,
        "byte-rate",
        `this frame was dropped: ${e.data.length} bytes is more than this ` +
          `connection's whole byte budget (${wsBytesPerSec} bytes/sec), so ` +
          `no re-send can pass`,
        `raise it with aio.run({ wsLimits: { bytesPerSec: N } }) to at least ` +
          `maxMessageBytes — a photo is base64'd and JSON-wrapped on the way ` +
          `here, so it arrives about 1.35x its size on disk`,
      );
      return;
    }
    // NOT charged when refused: a dropped frame cost the server nothing, and
    // counting it refused every frame behind it for the rest of the window
    // (the 100-byte `inc()` above was refused with the 1.5 MB put, each time).
    if (meta.bytesThisSec + e.data.length > wsBytesPerSec) {
      const msg = `ws: byte rate exceeded for ${meta.id.slice(0, 8)} (${
        ((meta.bytesThisSec + e.data.length) / 1_000_000).toFixed(1)
      }MB/s)`;
      log.error("ws", msg);
      writeClientLog(meta.index, {
        level: "error",
        msg,
        ts: Date.now(),
        source: "server-ws",
      });
      refuseFrameWithCall(
        socket,
        e.data,
        "byte-rate",
        `this frame was dropped: the connection is over its byte budget (${
          (wsBytesPerSec / 1_000_000).toFixed(1)
        } MB/s)`,
        `raise it with aio.run({ wsLimits: { bytesPerSec: N } }) — a photo is ` +
          `base64'd and JSON-wrapped on the way here, so it arrives about ` +
          `1.35x its size on disk`,
        retryAfter(meta.msgWindowStart),
      );
      return;
    }
    meta.bytesThisSec += e.data.length;

    // v2 envelope demux (B4b): every frame is {v:2, t, d} — one decode,
    // one switch. A legacy v1 hello (`__proto:{...}`) is answered with the
    // v1 `__proto-err:` string + 4505 so the old peer can read WHY.
    if (e.data.startsWith("__proto:")) {
      const msg = `ws: v1 client ${
        meta.id.slice(0, 8)
      } refused — this server speaks wire protocol v2+ (rebuild the client)`;
      log.error("ws", msg);
      try {
        socket.send(
          "__proto-err:this server speaks wire protocol v2+ — rebuild/update the client",
        );
        socket.close(PROTOCOL_MISMATCH_CLOSE_CODE, "protocol mismatch");
      } catch { /* already closed */ }
      return;
    }
    const frame = dec(e.data);
    if (!frame) {
      log.warn(
        "ws",
        `ws: undecodable frame from ${meta.id.slice(0, 8)} — dropped`,
      );
      return;
    }
    switch (frame.t) {
      case "client-state":
        _resolvePending(meta, "clientState", frame.d);
        return;
      case "log":
        if (!deps.prod) {
          try {
            writeClientLog(meta.index, frame.d as ClientLogEntry);
          } catch { /* malformed */ }
        }
        return;
      case "cdiag":
        // A client's degraded() escalation — recorded so /__aio/health can
        // name a browser subsystem that is failing forever. It is a CLIENT's
        // claim: `_recordClientDegraded` is the one definition (shared with
        // uds.ts) that drops malformed frames, refuses numbers no client can
        // truthfully have, and names this socket and user in the server log.
        _recordClientDegraded(meta.id, frame.d, {
          transport: "ws",
          index: meta.index,
          user: meta.user?.id,
        });
        return;
      case "ui-surface-result":
        _resolvePending(meta, "surface", frame.d);
        return;
      case "ui-trigger-result":
        _resolvePending(meta, "trigger", frame.d);
        return;
      case "type": {
        const t = (frame.d as { kind?: string } | undefined)?.kind;
        if (t === "electron" || t === "browser") meta.clientType = t;
        return;
      }
      case "proto": {
        const theirs = parseProtoHello(frame.d);
        if (!theirs) {
          deps.debug(
            `ws: malformed proto hello from ${meta.id.slice(0, 8)} — ignored`,
          );
          return;
        }
        const result = negotiateProtocol(protoHello(VERSION), theirs);
        if (!result.ok) {
          const msg = `ws: protocol mismatch with client ${
            meta.id.slice(0, 8)
          } — ${result.reason}`;
          log.error("ws", msg);
          writeClientLog(meta.index, {
            level: "error",
            msg,
            ts: Date.now(),
            source: "server-ws",
          });
          try {
            // BOTH spellings, on purpose. This peer sent a v2 hello, so it can
            // read the v2 frame — and `proto-err` was a fully declared,
            // fully ROUTED frame kind that nothing ever sent, because every
            // refusal went out as the legacy string alone. The string stays
            // for the v1 readers that only know it (`am`'s UDS client).
            socket.send(enc("proto-err", { reason: result.reason }));
            socket.send("__proto-err:" + result.reason);
            socket.close(PROTOCOL_MISMATCH_CLOSE_CODE, "protocol mismatch");
          } catch { /* already closed */ }
          return;
        }
        meta.protocolVersion = result.effective;
        // What the client SAID it is — shown by `am clients`, so an operator
        // can see which aio / app build each connection runs.
        meta.peer = { aio: theirs.ver, app: theirs.app };
        return;
      }
      case "tt-cmd":
        if (deps.onTTCommand) {
          // Raw-state control, on a socket. Same admin bar as /__aio/snapshot
          // and /__aio/trojan/* — see rawStateControlAllowed.
          if (deps.perUserAuth && !rawStateControlAllowed(meta.user)) {
            log.warn(
              "ws",
              `time-travel command '${
                (frame.d as { cmd?: string } | undefined)?.cmd ?? ""
              }' denied for ${
                meta.user
                  ? `user=${meta.user.id} role=${meta.user.role}`
                  : "anonymous client"
              } — it rewinds/freezes state for EVERY client and requires ` +
                `role "admin"`,
            );
            return;
          }
          _handleTTCommand(
            (frame.d as { cmd?: string } | undefined)?.cmd ?? "",
          );
        }
        return;
      case "vitals-ping":
        _handleVitalsPing(socket, meta, frame.d);
        return;
      case "subs":
        _handleSubs(socket, meta, (frame.d as { subs?: unknown })?.subs);
        return;
      case "resync":
        _handleResync(socket, meta);
        return;
      case "op":
        _handleSyncOp(frame.d as Record<string, unknown>, meta, socket);
        return;
      case "sync-req":
        _handleSyncMsg(frame.d as Record<string, unknown>, meta, socket);
        return;
      case "sfn": {
        const { cid, ns, name, args } = (frame.d ?? {}) as SfnPayload;
        if (
          typeof cid !== "string" || typeof ns !== "string" ||
          typeof name !== "string" || !Array.isArray(args)
        ) {
          log.warn("ws", "invalid sfn frame — dropping");
          return;
        }
        // Ambient identity + transport: the fn body (and everything it awaits)
        // can ask serverUser() who is calling and serverRequest() from where;
        // access rules check meta.user directly.
        runWithRequest(
          meta.request,
          () =>
            runWithUser(
              meta.user,
              () => invokeServerFn(ns, name, args, meta.user),
            ),
        )
          .then((result) => {
            try {
              socket.send(enc("sfnr", { cid, ...result }));
            } catch { /* client disconnected */ }
          })
          // No .catch here meant a rejecting serverFn (or a throwing access
          // predicate) surfaced as an unhandled rejection — process death.
          .catch((e) => {
            log.error("ws", `sfn ${ns}.${name} failed — ${e}`);
            try {
              socket.send(enc("sfnr", { cid, ok: false, ...errorFields(e) }));
            } catch { /* client disconnected */ }
          });
        return;
      }
      case "action":
        break; // falls through to the dispatch path below
      default:
        // Reserved-ignorable kinds ("x" extension frames) skip silently BY
        // CONTRACT — see IGNORABLE in envelope.ts.
        if (isIgnorableKind(frame.t)) return;
        // S→C-only kinds arriving C→S, or future kinds — loud, never silent.
        log.warn(
          "ws",
          `ws: unexpected "${frame.t}" frame from client ${
            meta.id.slice(0, 8)
          } — dropped`,
        );
        return;
    }

    const parsed = (frame.d ?? {}) as ActionPayload;
    // A refused frame that carries a cid is TOLD. The client registered an
    // ack for it, so a silent return left `await cell.method()` waiting to
    // its ceiling for a method that was never dispatched — then blaming a
    // server that "never confirmed the call".
    const refuseAction = (msg: string): void => {
      log.warn("ws", msg);
      const cid = (parsed as { cid?: unknown } | null)?.cid;
      if (typeof cid === "string" && cid.length > 0) {
        _sendAckErr(socket, cid, new Error(msg));
      }
    };
    if (!parsed || typeof parsed.type !== "string") {
      refuseAction("ws: invalid action — missing type field");
      return;
    }
    // Block framework-internal action types from network sources.
    // Internal actions (cell:__setX, cell:__exec, cell:__error,
    // cell:__Init, cell:__Destroy) carry trusted payload shapes
    // (e.g. mutation lists) that bypass cell method bodies. Accepting them from
    // clients is a remote-code-style vector — see audit F-1 (prototype pollution
    // via __setMethod with crafted mutation paths).
    if (_isFrameworkInternalActionType(parsed.type)) {
      refuseAction(
        `ws: rejected framework-internal action type "${parsed.type}" from client ${
          meta.id.slice(0, 8)
        }`,
      );
      return;
    }
    if (
      parsed.payload !== undefined &&
      (typeof parsed.payload !== "object" || parsed.payload === null ||
        Array.isArray(parsed.payload))
    ) {
      refuseAction(`ws: invalid action — payload must be a plain object`);
      return;
    }
    // Strip client-set trusted provenance and re-stamp `_source:"UI"` — ONE
    // decider for all three network entry points (sanitizeClientAction).
    sanitizeClientAction(parsed as Record<string, unknown>, "ws");
    deps.debug(
      `ws: recv ${JSON.stringify(parsed)} user=${meta.user?.id ?? "anon"}`,
    );
    // The cell method (and everything it awaits) sees this socket's transport
    // facts via serverRequest(); dispatch itself wraps runWithUser downstream.
    const result = runWithRequest(
      meta.request,
      () => deps.dispatch(parsed, meta.user),
    );
    // AIO-2.2 + return-value transport: emit a per-action ack carrying the
    // method's RETURN value if the client supplied a cid. We settle only AFTER
    // the dispatch promise resolves — for an async method that's on completion,
    // for a sync/void method that's the next microtask (after any synchronous
    // broadcast the dispatch triggered, so ordering is preserved).
    if (typeof parsed.cid === "string" && parsed.cid.length > 0) {
      const cid = parsed.cid;
      const actionType = typeof parsed.type === "string" ? parsed.type : "?";
      Promise.resolve(result).then(
        (value) => _sendAck(socket, cid, parsed, actionType, value),
        (err) => _sendAckErr(socket, cid, err),
      );
    }
  }

  /** Send a success ack carrying the (JSON-vetted) return value. */
  function _sendAck(
    socket: WebSocket,
    cid: string,
    action: unknown,
    actionType: string,
    value: unknown,
  ): void {
    // …unless the reduce refused it. `dispatch` resolves whether or not
    // anything ran, so this ack said `ok: true` for a method the cell no
    // longer has, a cell that was never booted, a disabled cell and a
    // `validate` refusal alike — an `await` that succeeds over a change that
    // never happened. The reason was already recorded against this very
    // action object; sending it is the whole fix (see action-ack.ts).
    const refused = _dispatchRefusal(action);
    if (refused) {
      _sendAckErr(socket, cid, refused);
      return;
    }
    // Pass the method name so a lossy-conversion warning names it (the UDS
    // path already did) — "a method" is not a diagnosis. Both the lossy and
    // the DROPPED warning are `serializeReturn`'s own; this site used to keep
    // a second copy of the dropped one, gated on `!prod`, so production was
    // silent about a return value it had thrown away.
    const { value: safe } = serializeReturn(value, actionType);
    // `short`: the call ran with arguments missing — the trojan's sentence,
    // stamped by dispatchNetwork, so the three doors agree (action-ack.ts).
    const short = _dispatchShort(action);
    // `unsaved`: it ran, and what it wrote is not on disk (action-ack.ts).
    const unsaved = _dispatchUnsaved(action);
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          enc("ack", {
            cid,
            ok: true,
            value: safe,
            ...(short !== undefined ? { short } : {}),
            ...(unsaved !== undefined ? { unsaved } : {}),
          }),
        );
      }
    } catch { /* client gone */ }
  }

  /** Send a failure ack — the awaited method rejected, or was refused,
   *  server-side. */
  function _sendAckErr(
    socket: WebSocket,
    cid: string,
    err: unknown,
    extra?: { retryAfterMs: number },
  ): void {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        // `errorFields`, not `String(err)`: it sends the message WITHOUT the
        // "Error: " prefix `String` prepends (the client wraps the text in an
        // Error again, so the prefix used to accumulate per hop) and carries
        // the failure CODE alongside it — the only way an app can tell an
        // access denial from its own method throwing without regexing a
        // sentence the semver policy refuses to freeze.
        socket.send(
          enc("ack", { cid, ok: false, ...errorFields(err), ...extra }),
        );
      }
    } catch { /* client gone */ }
  }

  function _resolvePending(
    meta: ClientMeta,
    kind: string,
    data: unknown,
  ): void {
    const key = `${meta.id}:${kind}`;
    const pending = pendingClientState.get(key);
    if (pending) {
      pendingClientState.delete(key);
      clearTimeout(pending.timer);
      try {
        pending.resolve(data);
      } catch {
        pending.resolve(null);
      }
    }
  }

  function _handleTTCommand(body: string): void {
    deps.debug(`ws: tt command ${body}`);
    const c = parseTTCommand(body);
    if (c) deps.onTTCommand?.(c.cmd, c.cmd === "goto" ? c.arg : undefined);
  }

  function _handleVitalsPing(
    socket: WebSocket,
    _meta: ClientMeta,
    data: unknown,
  ): void {
    try {
      const ping = data as { t1: number; ms?: number };
      if (!ping || typeof ping.t1 !== "number") throw new Error("malformed");
      const vmeta = connections.get(socket);
      if (vmeta && deps.vitalsSystem) {
        // Liveness is stamped by the probe from the SERVER's clock. `ping.t1`
        // is the browser's `Date.now()` and is echoed back in the pong for the
        // client to compute its own RTT — it is never used as a server-side
        // timestamp (see the one-clock invariant in transport-probe.ts).
        deps.vitalsSystem.serverTransport.onClientPing(vmeta.id);
        const staleness = typeof ping.ms === "number" ? ping.ms : 0;
        const prevMul = vmeta.bpMultiplier;
        // `vitals.backpressure: false` turns the per-client throttle off. The
        // option had NO reader at all — it type-checked, was accepted, and did
        // nothing, while the hint engine told people to toggle it.
        if (!deps.vitalsSystem.backpressureEnabled) {
          vmeta.bpMultiplier = 1;
          vmeta.bpConsecutiveLow = 0;
        } else if (staleness > BP_STALENESS_HIGH) {
          vmeta.bpMultiplier = 4;
          vmeta.bpConsecutiveLow = 0;
        } else if (staleness > BP_STALENESS_MODERATE) {
          vmeta.bpMultiplier = 2;
          vmeta.bpConsecutiveLow = 0;
        } else {
          vmeta.bpConsecutiveLow++;
          if (
            vmeta.bpConsecutiveLow >= BP_RECOVERY_PINGS &&
            vmeta.bpMultiplier > 1
          ) {
            vmeta.bpMultiplier = Math.max(1, vmeta.bpMultiplier / 2);
            vmeta.bpConsecutiveLow = 0;
          }
        }
        if (vmeta.bpMultiplier !== prevMul) {
          const cid = vmeta.id.slice(0, 8);
          if (vmeta.bpMultiplier > prevMul) {
            log.warn(
              "vitals",
              `client ${cid} — staleness ${
                Math.round(staleness)
              }ms, backpressure ${prevMul}x→${vmeta.bpMultiplier}x`,
            );
          } else {
            log.warn(
              "vitals",
              `client ${cid} — recovered, backpressure ${prevMul}x→${vmeta.bpMultiplier}x`,
            );
          }
        }
        const pong = {
          t1: ping.t1,
          t2: Date.now(),
          loop: deps.vitalsSystem.getLoopVitalsForPong(),
        };
        socket.send(enc("vitals-pong", pong));
      }
    } catch (err) {
      log.warn("vitals", `bad ping: ${err}`);
    }
  }

  function _handleSubs(
    socket: WebSocket,
    meta: ClientMeta,
    rawSubs: unknown,
  ): void {
    const subs = parseSubs(rawSubs);
    if (subs === undefined) {
      log.warn("ws", "bad subs frame");
      // TELL the client. `parseSubs` refuses the set WHOLE rather than
      // truncating it, on the reasoning that "a client that believes it is
      // subscribed to something it is not gets a UI that silently stops
      // updating" — and then the refusal went nowhere, producing exactly
      // that. The client recorded the refused set as accepted (its own write
      // succeeded), never re-sent it, and every cell outside its PREVIOUS,
      // narrower subscription stopped updating for the life of the
      // connection: loud on the server, invisible in the browser.
      //
      // `diag` is the channel this file already uses for a refused frame.
      refuse(
        socket,
        "subs",
        "this page's subscription set was refused by the server",
        "The server kept your PREVIOUS subscription, so cells outside it " +
          "would have stopped updating. Falling back to receiving " +
          "everything. Subscribe to cells or short paths " +
          '("todos", "todos.items"), or send ["*"] deliberately.',
      );
      return;
    }
    // Under the OLD subscriptions — the buffered patches describe the base
    // this client holds, filtered the way it was filtered then.
    drainBeforeSnapshot();
    meta.subscriptions = subs;
    try {
      const msg = JSON.stringify(
        filterStateBySubs(deps.getUIState(meta.user), meta.subscriptions),
      );
      // Not sent when the client already holds EXACTLY this text. The first
      // `subs` of every page arrives right after the connect-time state and,
      // for the usual wildcard or all-cells subscription, serializes to the
      // same bytes — so the biggest frame this transport sends went out twice
      // before the app rendered once, and every per-frame meter counted it
      // twice. The memo is proof only while it is FRESH (`lastFullJsonStale`,
      // see server-broadcast.ts); a `resync` is never deduplicated — the
      // client is telling us its state is wrong, and the memo is the thing in
      // question. Same rule on UDS. Pinned by
      // tests/initial-state-sent-once.test.ts.
      if (!meta.lastFullJsonStale && msg === meta.lastFullJson) {
        meta.needsFull = false; // it holds the current state — no debt
        return;
      }
      socket.send(encRaw("state", msg));
      meta.lastFullJson = msg;
      meta.lastFullJsonStale = false; // exact again: the client holds this text
      // …and the debt is PAID. `needsFull` is set by the broadcaster when a
      // round is lost for this client, and was cleared only there — so a
      // subs/resync that followed a lost round sent the whole state and then
      // the next round sent it AGAIN. The state just went out; whoever owes it
      // owes it no longer, whichever path delivered it.
      meta.needsFull = false;
      meta.bpLastSentAt = Date.now();
    } catch (err) {
      log.warn("ws", `filtered state send error — ${err}`);
    }
  }

  function _handleResync(socket: WebSocket, meta: ClientMeta): void {
    deps.debug(`ws: client ${meta.id} requested resync`);
    drainBeforeSnapshot();
    try {
      const msg = JSON.stringify(
        filterStateBySubs(deps.getUIState(meta.user), meta.subscriptions),
      );
      socket.send(encRaw("state", msg));
      meta.lastFullJson = msg;
      meta.lastFullJsonStale = false; // exact again: the client holds this text
      // …and the debt is PAID. `needsFull` is set by the broadcaster when a
      // round is lost for this client, and was cleared only there — so a
      // subs/resync that followed a lost round sent the whole state and then
      // the next round sent it AGAIN. The state just went out; whoever owes it
      // owes it no longer, whichever path delivered it.
      meta.needsFull = false;
      meta.bpLastSentAt = Date.now();
    } catch (err) {
      log.warn("ws", `resync send error — ${err}`);
    }
  }

  function _handleSyncOp(
    op: Record<string, unknown>,
    meta: ClientMeta,
    socket: WebSocket,
  ): void {
    if (!deps.syncHandler) {
      log.warn("ws", "op received but no syncHandler configured — dropping");
      return;
    }
    if (
      !op || typeof op !== "object" || typeof op.id !== "string" ||
      typeof op.cell !== "string" || typeof op.action !== "string" ||
      !Array.isArray(op.hlc) ||
      ["__proto__", "constructor", "prototype"].includes(op.cell as string) ||
      // Validate op.action against banned keys AND framework-internal action
      // types — a malicious op.action like "cell:__setMethod" would bypass
      // the _isFrameworkInternalActionType gate at line 621 because the sync
      // path returns early here before reaching it. The sync handler routes
      // op.action to dispatch, so the same gate must apply.
      ["__proto__", "constructor", "prototype"].includes(op.action as string) ||
      _isFrameworkInternalActionType(op.action as string)
    ) {
      log.warn("ws", "invalid op — malformed or forbidden fields");
      return;
    }
    deps.syncHandler.handleOp(op, { id: meta.id, user: meta.user }, socket);
  }

  function _handleSyncMsg(
    sync: Record<string, unknown>,
    meta: ClientMeta,
    socket: WebSocket,
  ): void {
    if (!deps.syncHandler) {
      log.warn(
        "ws",
        "sync-req received but no syncHandler configured — dropping",
      );
      return;
    }
    if (
      !sync || typeof sync !== "object" || typeof sync.clientId !== "string"
    ) {
      log.warn("ws", "invalid sync-req — malformed");
      return;
    }
    deps.syncHandler.handleSync(sync, { id: meta.id, user: meta.user }, socket);
  }

  function sendToWsClient(
    idx: number,
    msg: string,
  ): { found: true; promise: Promise<Response> } | { found: false } {
    const wsEntry = [...connections.entries()].find(([, m]) => m.index === idx);
    if (!wsEntry) return { found: false };
    const [ws, m] = wsEntry;
    const _json = (data: unknown) =>
      new Response(JSON.stringify(data, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    const _err = (errMsg: string, status = 400) =>
      new Response(JSON.stringify({ error: errMsg }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (ws.readyState !== 1) {
      return {
        found: true,
        promise: Promise.resolve(_err(`client ${idx} not ready`, 503)),
      };
    }
    const pendingKey = `${m.id}:${reqKind(msg)}`;
    const statePromise = new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        pendingClientState.delete(pendingKey);
        resolve({ error: clientReplyTimeoutError(idx) });
      }, CLIENT_REPLY_TIMEOUT_MS);
      if (pendingClientState.size >= PENDING_STATE_MAX) {
        const oldest = pendingClientState.keys().next().value!;
        const entry = pendingClientState.get(oldest)!;
        clearTimeout(entry.timer);
        entry.resolve({ error: "evicted — too many pending requests" });
        pendingClientState.delete(oldest);
      }
      const existing = pendingClientState.get(pendingKey);
      if (existing) {
        clearTimeout(existing.timer);
        existing.resolve({ error: "superseded by new request" });
      }
      pendingClientState.set(pendingKey, { resolve, timer });
    });
    try {
      ws.send(msg);
    } catch (e) {
      const entry = pendingClientState.get(pendingKey);
      if (entry) {
        clearTimeout(entry.timer);
        pendingClientState.delete(pendingKey);
      }
      return {
        found: true,
        promise: Promise.resolve(_err(`send failed: ${e}`, 503)),
      };
    }
    return { found: true, promise: statePromise.then((d) => _json(d)) };
  }

  function shutdown(): void {
    if (_globalRateTimer) {
      clearTimeout(_globalRateTimer);
      _globalRateTimer = undefined;
    }
    _fuseShare.clear();
    if (_sessionSweep) {
      clearInterval(_sessionSweep);
      _sessionSweep = undefined;
    }
    for (const [ws, meta] of connections) {
      _clearTimers(meta);
      try {
        ws.close(1001, "server shutting down");
      } catch { /* already closing */ }
    }
    connections.clear();
    // SETTLE, don't just drop: each entry owns an unresolved promise that a
    // caller (the trojan client-state route) is awaiting. Clearing the timer
    // and deleting the entry left that promise pending forever, so a shutdown
    // racing an in-flight request never completed — every timeout path was
    // gone with the timer.
    for (const [, pending] of pendingClientState) {
      clearTimeout(pending.timer);
      pending.resolve({ error: "server shutting down" });
    }
    pendingClientState.clear();
  }

  return {
    handleWs,
    connections,
    payloadStats,
    pendingClientState,
    sendToWsClient,
    sweepSessions,
    shutdown,
  };
}

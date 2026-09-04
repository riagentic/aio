// UDS (Unix Domain Socket) transport — NDJSON listener for Electron IPC bridge (AIO-52 Phase 3)
// Extracted from aio.ts. Speaks the same v2 envelope as WS (B4b) — one
// decoded line = one frame. Since v2, UDS serves sync + serverFns too
// (the alpha28 transport-capability skew is gone); time travel flows here too
// (tt-state out, tt-cmd in — the Electron panel needs it); vitals stay
// WS-only and are rejected loudly.

import { compactPatches } from "../state/patch-compact.ts";
import { writeClientLog } from "./client-log.ts";
import { log } from "../diagnostics/logger-api.ts";
import { warnBigFullState } from "./server-broadcast.ts";
import {
  udsWriteBacklog as _writeBacklog,
  WRITE_QUEUE_WARN,
} from "./write-backlog.ts";
import { degraded } from "../diagnostics/degraded.ts";

/** The state snapshot this transport could not serialize. Module scope, like
 *  `_writeBacklog` above: one tracker for the transport. Its WS twin is
 *  `degraded("broadcast:state")` in server-broadcast.ts — two transports, two
 *  names, one rule: a client that has silently stopped receiving state must
 *  appear at `/__aio/health`. */
const _stateSerialization = degraded("uds:broadcast-state");

/** A broadcast ROUND this transport could not deliver. Distinct from
 *  `_stateSerialization` (which is the snapshot builder): this one fires when
 *  the send itself throws — a patch payload that JSON refuses, a compaction
 *  that failed — and a lost round is unrecoverable data divergence, not just a
 *  missed frame, because the coalescer already discarded the patches. */
const _broadcastRound = degraded("uds:broadcast-round");

/** A UDS peer that has stopped draining its socket. Module scope, like the
 *  broadcast trackers: one tracker for the transport, whatever listener the
 *  connection belongs to. */

import {
  _recordClientDegraded,
  type DegradedChange,
} from "../diagnostics/degraded.ts";
import {
  _isFrameworkInternalActionType,
  sanitizeClientAction,
} from "./server-ws.ts";
import { _dispatchRefusal } from "./action-ack.ts";
import { invokeServerFn } from "./server-fns.ts";
import {
  type ActionPayload,
  type CtlPayload,
  dec,
  enc,
  encRaw,
  errorFields,
  isIgnorableKind,
  type SfnPayload,
  unsupportedOnUds,
} from "../protocol/envelope.ts";
import { serializeReturn } from "../protocol/return-value.ts";
import { VERSION } from "./aio-cli.ts";
import { parseTTCommand } from "../diagnostics/time-travel.ts";
import {
  negotiateProtocol,
  parseProtoHello,
  protoHello,
} from "../protocol/protocol-version.ts";
import type { ServerSyncHandler } from "../sync/server-handler.ts";
import { isPipePath, listenLocal, type LocalConn } from "./local-listen.ts";
import { flushAllUrgent } from "./broadcast-coalescer.ts";
import {
  filterPatchesBySubs,
  filterStateBySubs,
  parseSubs,
} from "../protocol/broadcast-utils.ts";

/** How long the server waits for a live client to answer a control request
 *  (`am surface N`, `am trigger N …`, `am client N`) — THE one decider for both
 *  transports (WS in server-ws.ts, UDS here). `am`'s transport timeout must be
 *  strictly LONGER (am-http.ts asserts it): with the two equal, the transport
 *  gave up in the same instant this fired, and the reason named here never
 *  reached the caller — every stall read as "timeout connecting". */
export const CLIENT_REPLY_TIMEOUT_MS = 5000;

/** The named reason a client did not answer, with the causes a caller can act
 *  on. `ok:false` so the CLI's one "did this happen" rule (`data.ok === false`)
 *  fails the command instead of printing the error as a success. */
export function clientReplyTimeoutError(index: number): string {
  return `client ${index} did not respond within ${CLIENT_REPLY_TIMEOUT_MS}ms — ` +
    `it is connected but not answering ui requests. Three causes, most common ` +
    `first:\n` +
    // THE WINDOW IS NOT ON SCREEN, and it was missing entirely. Chromium
    // throttles an occluded, minimised or unmapped renderer until it stops
    // answering — a field report lost two separate debugging passes to this,
    // hunting a render loop that did not exist, once suspecting their own
    // component and once a broadcast storm. Electron CPU was ~0% throughout,
    // which is the tell the old message made impossible to use: it offered two
    // explanations, both of them "something is busy".
    `  · the window is not VISIBLE — occluded, minimised, or on an unmapped ` +
    `display. Chromium throttles a hidden renderer until it stops answering. ` +
    `Near-zero CPU for the app points here, not at a busy thread.\n` +
    `  · its main thread really is busy (a long render or effect) — expect ` +
    `high CPU\n` +
    `  · it is a headless/thin client that does not run the ui-trigger ` +
    `handler\n` +
    `Check \`am clients\` for the index you meant, and \`--timeout=<ms>\` to ` +
    `wait longer.`;
}

export type UDSClient = {
  conn: LocalConn;
  index: number;
  id: string;
  subscriptions: Set<string> | null;
  lastFullJson?: string;
  /** The full-state text this client will hold once its write queue drains —
   *  the SYNCHRONOUS twin of `lastFullJson`, which is stamped only when the
   *  write lands. Every site that queues a state or a patch records the
   *  state the peer holds after it, in queue order, so "does the peer already
   *  hold exactly this text?" can be answered at the moment a `subs` frame
   *  arrives — which is before the accept-time write has necessarily landed.
   *  Needed because the first `subs` of every window used to be answered
   *  with a second, identical full state (the biggest frame this transport
   *  sends, twice, before the app rendered once). `undefined` = unknown,
   *  never dedup. */
  queuedJson?: string;
  /** This client MISSED a round, so the next send must be a whole state
   *  rather than a patch that assumes the missed one landed.
   *
   *  `lastFullJson` cannot express this: it records what was last SENT as a
   *  full state, and the patch path never consults it — so clearing it alone
   *  leaves the next round still choosing a patch. The WS twin has carried
   *  exactly this flag (`meta.needsFull`) since a thrown round was measured to
   *  strand clients permanently; this transport had neither half. */
  needsFull?: boolean;
  /** What the peer SAID it is, from its `proto` hello — the same fact
   *  `server-ws.ts` records as `meta.peer` and `am clients` reports. The UDS
   *  router negotiated the hello and threw it away, so on the desktop path
   *  (where every client lives) nothing knew which build it was talking to. */
  peer?: { aio?: string; app?: string };
};

type PatchEntry = {
  cell: string;
  ops: import("../protocol/patch-ops.ts").WirePatch[];
};

/** A peer is gone: answer the control request still waiting on it NOW, with
 *  the reason. Left alone, the entry ran out `CLIENT_REPLY_TIMEOUT_MS` and
 *  then handed the caller the timeout's diagnosis — "the window is not
 *  VISIBLE / its main thread is busy / a headless client" — for a window that
 *  had simply closed. A field report lost two debugging passes to that text
 *  when it was RIGHT; sending someone down it for a client that no longer
 *  exists is worse. Same rule on WS (`_settlePending`, server-ws.ts). Pinned
 *  by tests/pending-reply-settles-on-disconnect.test.ts. */
function _settlePendingForGone(
  pendingState: Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >,
  client: UDSClient | undefined,
): void {
  if (!client) return;
  const pending = pendingState.get(client.id);
  if (!pending) return;
  pendingState.delete(client.id);
  clearTimeout(pending.timer);
  pending.resolve({
    error: `client ${client.index} disconnected before answering`,
  });
}

export type UDSHandle = {
  broadcast: (msg: string) => void;
  /** Push state to every UDS client. Returns WHAT WENT OUT — how many clients
   *  got a whole slice and how many got a patch — because `am cost` attributes
   *  a round to the cells that produced it and cannot honestly do that from
   *  what the caller ASKED for. A request to send may produce nothing at all
   *  (every client already holds that exact state), and reporting a push there
   *  is a plausible number that is wrong. */
  broadcastState: (
    forceOrPatches?: boolean | PatchEntry[],
  ) => { full: number; patch: number };
  shutdown: () => void;
  socketPath: string;
  clients: () => UDSClient[];
  requestClientState: (index: number, msg?: string) => Promise<unknown>;
};

export function createUDSListener(
  socketPath: string,
  getUIState: () => unknown,
  onAction: (
    action: { type: string; payload?: unknown },
  ) => Promise<unknown> | void,
  debug: (msg: string) => void,
  clientCounter?: { value: number },
  syncHandler?: ServerSyncHandler | null,
  /** Resolved client config — sent as an early "cfg" frame (the electron UDS
   *  shell is templated at build time and embeds no `__aioConfig`). */
  clientConfig?: Record<string, unknown>,
  /** Time travel (dev): command sink + state getter. tt-state used to flow to
   *  WS clients only — the Electron window's panel (Ctrl+.) never received a
   *  frame, so the shortcut never even bound. */
  tt?: {
    onCommand: (cmd: string, arg?: number) => void;
    getBroadcast: () => unknown;
  },
  /** Raise the per-frame buffer ceiling (default 10 MB) — the UDS twin of
   *  `wsLimits.maxMessageBytes`. An app that raises its WS frame limit for
   *  large payloads (a base64 attachment) hits the same wall here when the
   *  Electron window talks over UDS instead, and the failure was a silent
   *  connection reset mid-send. Never lowers the default. */
  maxFrameBytes?: number,
  /** Serve one control-plane request that arrived as a `ctl` frame.
   *
   *  Supplied by `aio-server.ts` from the ServerHandle, so it IS the HTTP
   *  handler — same routes, same auth gates, same dev-only trojan mount. When
   *  absent (no HTTP server was built), a `ctl` frame is answered with a plain
   *  503 rather than dropped: a control client that gets silence cannot tell
   *  "refused" from "this build has no control plane". */
  control?: (req: Request) => Promise<Response>,
  /** The app's `fullStateThreshold` — the ratio of full-state size above
   *  which a patch frame is not worth sending. The WS path stopped comparing
   *  against 100% of full state releases ago ("so the user-set
   *  `fullStateThreshold` had no effect"); that fix landed on WS only, so a
   *  documented public knob did nothing on the transport where every desktop
   *  client lives. Default 0.5, the same default `server.ts` resolves. */
  fullStateThreshold?: number,
  /** Wire meter behind `am cost`. Metered at `sendTo` — the ONE place every
   *  UDS frame passes through — for the same reason the WS path wraps
   *  `socket.send` rather than instrumenting each caller: frames reach a
   *  client from the broadcaster, the handshake, per-action acks and
   *  diagnostics, and a per-caller count drifts the day a new sender is added.
   *
   *  Without it `am cost` reported `bytes/s 0` for every cell on the DEFAULT
   *  desktop transport — a measured zero and an unmeasured one printing the
   *  same. A field report hunted a suspected re-render storm with it, was told
   *  the server was quiet, and the server was not: a 5-second poller was
   *  reassigning a ~100 KB array on every tick. */
  costMeter?: import("../vitals/cost-meter.ts").CostMeter,
): UDSHandle {
  const fullThreshold = typeof fullStateThreshold === "number" &&
      Number.isFinite(fullStateThreshold)
    ? fullStateThreshold
    : 0.5;
  // A stale socket FILE from a crashed instance is unlinked; a pipe is a
  // kernel name that vanished with that process — nothing to remove.
  if (!isPipePath(socketPath)) {
    try {
      Deno.removeSync(socketPath);
    } catch { /* doesn't exist */ }
  }

  const listener = listenLocal(socketPath);
  const connSet = new Set<LocalConn>();
  const clientMap = new Map<LocalConn, UDSClient>();
  const counter = clientCounter ?? { value: 0 };
  let closed = false;

  const pendingState = new Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();

  (async () => {
    for await (const conn of listener) {
      // Everything below is PER-CONNECTION work, and this loop is the
      // transport's only door: a throw here does not fail one client, it ends
      // the loop — and `for await` disposes the listener on the way out, so the
      // process runs on with a socket nothing will ever accept again (and a
      // shutdown that then throws BadResource). One unserializable snapshot
      // used to be enough. Fail the CONNECTION, loudly, and keep the door open.
      try {
        connSet.add(conn);
        const client: UDSClient = {
          conn,
          index: counter.value++,
          id: crypto.randomUUID(),
          subscriptions: null,
        };
        // Same rule as the WS handshake (`drainBeforeSnapshot`, server-ws.ts):
        // the patches still buffered in a throttle window go out to the peers
        // whose base they describe BEFORE this peer joins the roster, because
        // its accept-time snapshot already holds their writes — sent after
        // it, they were applied a second time (a server-side `push` landed
        // twice on the window that opened mid-window). Both transports, one
        // registry, so neither can drift back.
        flushAllUrgent();
        clientMap.set(conn, client);
        debug(`uds: client connected #${client.index} (${connSet.size} total)`);

        // A3: version handshake — server speaks first, before any state.
        sendTo(conn, enc("proto", protoHello(VERSION)));
        if (clientConfig && Object.keys(clientConfig).length > 0) {
          sendTo(conn, enc("cfg", clientConfig));
        }
        // AIO-239: route the initial write through sendTo() for the
        // per-connection write queue — and through the SAME snapshot builder
        // every later frame uses, so the accept-time state cannot drift from
        // (or crash where) the broadcast-time state does.
        const initial = _fullJsonFor(client);
        if (initial !== undefined) {
          client.queuedJson = initial;
          sendTo(conn, encRaw("state", initial), () => {
            client.lastFullJson = initial;
          });
        }
        // Dev: hand the panel its history now — Ctrl+. binds on the first
        // tt-state frame, so without this the shortcut is inert until the next
        // recorded action's broadcast.
        if (tt) sendTo(conn, enc("tt-state", tt.getBroadcast()));

        _handleUDSConn(
          conn,
          connSet,
          clientMap,
          pendingState,
          onAction,
          debug,
          _fullJsonFor,
          sendTo,
          syncHandler ?? null,
          tt,
          maxFrameBytes,
          control,
        );
      } catch (e) {
        log.error("uds", `client handshake failed — ${e}`);
        connSet.delete(conn);
        clientMap.delete(conn);
        try {
          conn.close();
        } catch { /* already closed */ }
      }
    }
  })().catch((e) => {
    if (!closed) log.error("uds", `accept loop error — ${e}`);
  });

  // AIO-216: per-connection write queue to prevent byte interleaving
  const _writeQueues = new WeakMap<LocalConn, Promise<void>>();
  /** Frames queued and not yet written, per connection — see `sendTo`. */
  const _writeDepth = new WeakMap<LocalConn, number>();

  function sendTo(conn: LocalConn, msg: string, onSent?: () => void): void {
    const encoded = new TextEncoder().encode(msg + "\n");
    if (costMeter) {
      try {
        // The envelope's kind read EXACTLY — `{"v":2,"t":"<kind>",…}` — never
        // by substring: a patch payload can contain the literal `"t":"state"`
        // in its own data. Acks, diagnostics and tt frames are `other`, not
        // full resends; counting a wall of 40-byte acks as "the whole state
        // went out" is a plausible headline that is wrong. Same classifier as
        // server-ws.ts, on purpose.
        const envKind = /^\{"v":\d+,"t":"([^"]+)"/.exec(msg)?.[1];
        costMeter.recordSend(
          encoded.byteLength,
          clientMap.get(conn)?.id ?? "uds",
          envKind === "patches"
            ? "patch"
            : envKind === "state"
            ? "full"
            : "other",
        );
      } catch { /* aio-ok: metering must never break a send */ }
    }
    const prev = _writeQueues.get(conn) ?? Promise.resolve();
    // Depth is OBSERVED, not capped. The WS transport skips a peer whose
    // socket buffer is not draining (one policy, `write-backlog.ts`); this
    // one cannot — a peer that stops reading grows
    // an unbounded promise chain, each link holding an encoded frame, with
    // nothing anywhere saying so. Dropping frames instead would be worse: the
    // peer here is the app's OWN window, and a silently skipped state frame is
    // a frozen UI. So the memory keeps growing and the app now says that it is
    // — one structured event at `/__aio/health`, and one on recovery.
    const depth = (_writeDepth.get(conn) ?? 0) + 1;
    _writeDepth.set(conn, depth);
    if (depth > WRITE_QUEUE_WARN) {
      _writeBacklog.fail(
        new Error(
          `a UDS client has ${depth} frames queued and is not draining them — ` +
            `it has stopped reading its socket. Every queued frame is held in ` +
            `memory until it does.`,
        ),
      );
    }
    const next = prev.then(async () => {
      const writer = conn.writable.getWriter();
      try {
        await writer.write(encoded);
        onSent?.();
      } finally {
        writer.releaseLock();
      }
    }).catch(() => {
      _writeQueues.delete(conn);
      _writeDepth.delete(conn);
      connSet.delete(conn);
      _settlePendingForGone(pendingState, clientMap.get(conn));
      clientMap.delete(conn);
      try {
        conn.close();
      } catch { /* already closed */ }
    }).finally(() => {
      const left = (_writeDepth.get(conn) ?? 1) - 1;
      _writeDepth.set(conn, left);
      if (left === 0) _writeBacklog.ok();
    });
    _writeQueues.set(conn, next);
  }

  /** THE snapshot builder for this listener: read state, apply the client's
   *  subscription filter, serialize. Every state frame on this transport —
   *  accept-time, broadcast, `subs` reply, `resync` reply — comes from here,
   *  because a snapshot that is built two ways is a snapshot that eventually
   *  differs two ways.
   *
   *  `undefined` means the snapshot could not be produced (a throwing getter, a
   *  BigInt, a cycle). Serializing is INSIDE the guard: the stringify is where
   *  that actually throws, and it used to sit outside — so the guard caught the
   *  rarer failure and let the common one through. */
  /** The snapshot verdict of ONE broadcast round — settled after the client
   *  loop, never inside it. `degraded()` counts CONSECUTIVE failures and
   *  `ok()` ends the episode, so a per-client verdict went fail, ok, fail,
   *  ok… whenever one window's slice failed (a BigInt in the one cell it
   *  subscribes to) and another's did not: that window received no state
   *  again, ever, with `/__aio/health` green for as long as any other window
   *  was open. Same shape as the WS broadcaster's `SnapshotVerdict`. Pinned by
   *  tests/broadcast-degraded-per-round.test.ts. */
  type SnapshotVerdict = { attempted: boolean; failed: boolean; err: unknown };

  /** Build the snapshot and record the outcome on `verdict` — the caller
   *  decides when that verdict is settled (once per round in the broadcast
   *  loop; immediately for a single-client door, see `_fullJsonFor`). */
  function _snapshot(
    client: Pick<UDSClient, "subscriptions">,
    verdict: SnapshotVerdict,
  ): string | undefined {
    verdict.attempted = true;
    try {
      // One filter, both transports (broadcast-utils.ts) — a hand-inlined
      // copy here is how the two drifted in the first place.
      const uiState: unknown = filterStateBySubs(
        getUIState(),
        client.subscriptions,
      );
      const json = JSON.stringify(uiState);
      // The same guardrail the WS path has had. It used to live INSIDE the WS
      // broadcaster, so a desktop app — every client on this socket, no TCP
      // port open at all — got no warning at any size: a field report put
      // 83,000 rows in a cell, reached a 17 GB heap, and wrote "it is a bug aio
      // makes easy and gives no feedback about". The feedback existed and was
      // blind on their transport.
      const snapshot = uiState;
      warnBigFullState(json, () => snapshot);
      return json;
    } catch (e) {
      // NOT a log line only. The caller's response to `undefined` is
      // `continue`, i.e. THIS client silently stops receiving state —
      // permanently — while `/__aio/health` keeps answering "healthy". That is
      // the exact unnoticeable failure `degraded()` exists for, and the WS
      // twin (`_getFilteredFullJson` in server-broadcast.ts) already says so
      // in its own comment and escalates. This path is the DESKTOP default,
      // where every client lives, and it only logged.
      log.error("uds", `state snapshot failed — ${e}`);
      verdict.failed = true;
      verdict.err = e;
      return undefined;
    }
  }

  /** A serialization that WORKED ends the episode. `degraded()` escalates on
   *  N CONSECUTIVE failures and reports recovery from `ok()` — without this,
   *  five failures spread across a whole process lifetime escalate as if they
   *  were consecutive, and once escalated the app reports itself degraded
   *  forever even after the offending value is gone. */
  function _settleSnapshotVerdict(v: SnapshotVerdict): void {
    if (v.failed) _stateSerialization.fail(v.err);
    else if (v.attempted) _stateSerialization.ok();
  }

  /** The single-client doors (accept, `subs`, `resync`): one snapshot IS the
   *  round, so its verdict is settled on the spot. */
  function _fullJsonFor(
    client: Pick<UDSClient, "subscriptions">,
  ): string | undefined {
    const verdict: SnapshotVerdict = {
      attempted: false,
      failed: false,
      err: undefined,
    };
    const json = _snapshot(client, verdict);
    _settleSnapshotVerdict(verdict);
    return json;
  }

  return {
    socketPath,
    // AIO-239: route broadcast through sendTo() to use per-connection write queue
    broadcast: (msg: string) => {
      for (const conn of connSet) sendTo(conn, msg);
    },
    broadcastState: (forceOrPatches?: boolean | PatchEntry[]) => {
      // Counted, not assumed — see the type. Every `sendTo` below bumps one.
      let full = 0, patch = 0;
      const force = forceOrPatches === true;
      // Patches are pre-filtered by aio.ts filterPatchesByStrategy — use directly
      const patches = Array.isArray(forceOrPatches)
        ? forceOrPatches
        : undefined;

      // A THROWN ROUND IS A LOST ROUND, and this loop had no catch.
      //
      // The coalescer empties its buffer BEFORE calling here
      // (`broadcast-coalescer.ts` — `drain()` takes the items, then flushes),
      // so a throw anywhere below means those patches exist nowhere else: the
      // clients keep applying LATER patches on top of state that is missing
      // this round's writes, forever. Nothing downstream notices, because
      // Immer's out-of-range array `add` splices rather than throwing, so the
      // client's own resync safety net never fires and the list is merely
      // wrong.
      //
      // Reachable with nothing exotic: `JSON.stringify(allOps)` below throws
      // on a patch carrying a BigInt, which is exactly the measured case the
      // WS twin documents (`s.items.push(v); s.big = 1n`). The WS flush has
      // wrapped its whole loop and marked clients `needsFull` since that
      // measurement; this path — the transport every DESKTOP client is on —
      // never got it.
      //
      // Per client, not per round: one client's bad frame must not cost the
      // others their update (the same rule persistence applies per cell). A
      // client whose send failed is marked for a FULL state next round, which
      // is what actually repairs a divergence.
      const failed: UDSClient[] = [];
      // ONE snapshot verdict for the round — see `SnapshotVerdict`.
      const verdict: SnapshotVerdict = {
        attempted: false,
        failed: false,
        err: undefined,
      };
      for (const [conn, client] of clientMap) {
        try {
          if (force) {
            client.lastFullJson = undefined;
          }

          // Patch-based path: filter patches by client subscriptions and send $patches
          // NEVER a patch for a client that missed a round: its base state no
          // longer matches what a patch assumes.
          if (patches && patches.length > 0 && !force && !client.needsFull) {
            const clientPatches = filterPatchesBySubs(
              patches,
              client.subscriptions,
            );

            const allOps = compactPatches(
              clientPatches.flatMap((p) =>
                p.ops.map((op) => ({
                  ...op,
                  path: [p.cell, ...op.path],
                }))
              ),
            );

            if (allOps.length > 0) {
              const patchJson = JSON.stringify(allOps);
              // Size guard: if patches exceed full state, send full state instead
              const fullJson = _snapshot(client, verdict);
              if (
                fullJson && patchJson.length > fullJson.length * fullThreshold
              ) {
                debug(
                  `uds: patch payload (${patchJson.length}B) > ${
                    Math.round(fullThreshold * 100)
                  }% of full state (${fullJson.length}B) — sending full state`,
                );
                if (fullJson !== client.lastFullJson) {
                  const fj = fullJson;
                  full++;
                  client.queuedJson = fj;
                  sendTo(conn, encRaw("state", fullJson), () => {
                    client.lastFullJson = fj;
                    client.needsFull = false; // paid once it is written
                  });
                }
              } else {
                const fj = fullJson;
                patch++;
                client.queuedJson = fj; // undefined when the snapshot failed
                sendTo(
                  conn,
                  encRaw("patches", patchJson),
                  fj
                    ? () => {
                      client.lastFullJson = fj;
                    }
                    : undefined,
                );
              }
              continue;
            }
          }

          // Fallback: force-full, trailing flush, or no patches — send full state
          const json = _snapshot(client, verdict);
          if (!json) {
            // A snapshot that could not be built is a LOST round for this
            // client, like a thrown one below — and a force round's change (a
            // "full"-strategy cell) exists in no patch. Record the debt, or a
            // transient failure left the window applying later patches on top
            // of a state that never saw this round. Same rule as the WS
            // fallback; pinned by
            // tests/broadcast-failed-snapshot-owes-full.test.ts.
            if (force || (patches && patches.length > 0)) {
              client.needsFull = true;
            }
            continue;
          }
          if (json === client.lastFullJson) continue; // no change
          const j = json;
          full++;
          client.queuedJson = j;
          sendTo(conn, encRaw("state", json), () => {
            client.lastFullJson = j;
            client.needsFull = false; // the debt is paid once it is written
          });
        } catch (e) {
          // This client's round is lost. Say so, and arrange for the NEXT one
          // to carry a whole state rather than a patch that assumes the lost
          // one landed.
          log.error(
            "uds",
            `broadcast failed for client ${client.index} — ${e}. Its patches ` +
              `for this round are gone (the coalescer already drained them), ` +
              `so it is marked for a full state on the next round. A patch ` +
              `carrying a value JSON cannot represent (a BigInt, a cycle) is ` +
              `the usual cause; fix it at its source.`,
          );
          _broadcastRound.fail(e);
          failed.push(client);
        }
      }
      // Marked AFTER the loop: clearing `lastFullJson` mid-iteration would
      // change what a later client in the same round is compared against.
      // BOTH halves. `needsFull` makes the next round choose a whole state
      // instead of a patch; clearing `lastFullJson` stops the fallback's
      // "same as last time" check from then skipping that state, which it
      // would whenever the visible value happens to match what was last sent.
      for (const c of failed) {
        c.needsFull = true;
        c.lastFullJson = undefined;
        c.queuedJson = undefined;
      }
      if (failed.length === 0) _broadcastRound.ok();
      _settleSnapshotVerdict(verdict);
      return { full, patch };
    },
    clients: () => [...clientMap.values()],
    requestClientState: (
      index: number,
      msg = enc("get-state"),
    ): Promise<unknown> => {
      const client = [...clientMap.values()].find((c) => c.index === index);
      if (!client) {
        return Promise.resolve({ error: `client ${index} not connected` });
      }
      return new Promise<unknown>((resolve) => {
        // AIO-223: cleanup existing pending request before overwriting
        const existing = pendingState.get(client.id);
        if (existing) {
          clearTimeout(existing.timer);
          existing.resolve({ error: "superseded by new request" });
        }
        const timer = setTimeout(() => {
          pendingState.delete(client.id);
          resolve({ error: clientReplyTimeoutError(index) });
        }, CLIENT_REPLY_TIMEOUT_MS);
        pendingState.set(client.id, { resolve, timer });
        sendTo(client.conn, msg);
      });
    },
    shutdown: () => {
      closed = true;
      listener.close();
      for (const conn of connSet) {
        try {
          conn.close();
        } catch { /* already closed */ }
      }
      for (const entry of pendingState.values()) clearTimeout(entry.timer);
      pendingState.clear();
      connSet.clear();
      clientMap.clear();
      if (!isPipePath(socketPath)) {
        try {
          Deno.removeSync(socketPath);
        } catch { /* already removed */ }
      }
    },
  };
}

/** The per-frame buffer ceiling for a UDS connection.
 *
 *  10MB floor — it prevents an OOM from a peer that never sends a newline. An
 *  app may RAISE it via `wsLimits.maxMessageBytes` (the WS frame limit; this is
 *  its twin, so one transport cannot refuse a payload the other accepts — a
 *  ~9MB base64 attachment travelled over WS and reset the Electron/UDS
 *  connection mid-send), and may never LOWER it below the floor. Pure, so the
 *  rule is unit-tested rather than reasoned about. */
export function udsFrameCeiling(maxFrameBytes?: number): number {
  return Math.max(10 * 1024 * 1024, maxFrameBytes ?? 0);
}

function _handleUDSConn(
  conn: LocalConn,
  connections: Set<LocalConn>,
  clientMap: Map<LocalConn, UDSClient>,
  pendingState: Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >,
  onAction: (
    action: { type: string; payload?: unknown },
  ) => Promise<unknown> | void,
  debug: (msg: string) => void,
  /** THE snapshot builder (see `_fullJsonFor`) — passed in, never re-derived
   *  here: this handler used to carry its own copy of the subscription filter,
   *  which is the same fact decided twice. */
  fullJsonFor: (client: Pick<UDSClient, "subscriptions">) => string | undefined,
  sendTo: (conn: LocalConn, msg: string, onSent?: () => void) => void,
  syncHandler: ServerSyncHandler | null,
  tt?: {
    onCommand: (cmd: string, arg?: number) => void;
    getBroadcast: () => unknown;
  },
  maxFrameBytes?: number,
  /** The control-plane server (see `createUDSListener`) — the HTTP handler
   *  itself, so a `ctl` frame meets the same routes and gates as a request
   *  over TCP. */
  control?: (req: Request) => Promise<Response>,
): void {
  const decoder = new TextDecoder();
  const MAX_BUF = udsFrameCeiling(maxFrameBytes);
  let buf = "";

  // Minimal structural WebSocket stand-in for the sync handler — it only
  // ever calls .send(). One stable object per conn so broadcast exclusion
  // (identity-based) stays consistent across calls.
  const _sinks = new WeakMap<LocalConn, WebSocket>();
  function _wireSink(conn: LocalConn): WebSocket {
    let sink = _sinks.get(conn);
    if (!sink) {
      sink = {
        send: (m: string) => sendTo(conn, m),
        readyState: 1,
      } as unknown as WebSocket;
      _sinks.set(conn, sink);
    }
    return sink;
  }

  /** `dedup`: skip the send when the peer already holds EXACTLY this text
   *  (`queuedJson`). True for a `subs` reply — the first one of every window
   *  arrives right after the accept-time state and, for the usual wildcard
   *  or all-cells subscription, serializes to the same bytes, so the biggest
   *  frame this transport sends went out twice before the app rendered once
   *  (measured on real Electron; the cost meter and the transport probe
   *  counted it twice too). False for `resync`: the peer is TELLING us its
   *  state is wrong, and our memo of what it holds is the thing in question.
   *  Same rule as the WS `subs` reply. Pinned by
   *  tests/initial-state-sent-once.test.ts. */
  function _sendFilteredState(
    conn: LocalConn,
    client: UDSClient,
    dedup: boolean,
  ): void {
    const msg = fullJsonFor(client);
    if (msg === undefined) return; // already reported by the snapshot builder
    if (dedup && msg === client.queuedJson) {
      client.needsFull = false; // it holds the current state — no debt
      return;
    }
    client.queuedJson = msg;
    sendTo(conn, encRaw("state", msg), () => {
      client.lastFullJson = msg;
    });
  }
  (async () => {
    const reader = conn.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.length > MAX_BUF && !buf.includes("\n")) {
          log.error(
            "uds",
            `client buffer exceeded ${MAX_BUF}B without newline — closing`,
          );
          break;
        }
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
          if (!line) continue;

          // v1 hello → refuse in the v1-readable string form (the one shim).
          if (line.startsWith("__proto:")) {
            log.error(
              "uds",
              "v1 client refused — this server speaks wire protocol v2+ (rebuild the client)",
            );
            sendTo(
              conn,
              "__proto-err:this server speaks wire protocol v2+ — rebuild/update the client",
            );
            sendTo(conn, "", () => {
              try {
                conn.close();
              } catch { /* already closed */ }
            });
            continue;
          }

          const frame = dec(line);
          if (!frame) {
            log.warn("uds", "undecodable frame — dropped");
            continue;
          }
          switch (frame.t) {
            case "ping":
              continue;
            case "type": {
              // A peer declaring it is not a UI. The control client (`am`,
              // amui) asks a question and leaves; it is not a window, so it
              // must not appear in the client roster, must not consume the
              // index `am surface N` addresses, and must not be mailed state
              // broadcasts it will never render. `clientMap` keys BOTH the
              // roster and the broadcast loop, so leaving it is the whole fix.
              const kind = (frame.d as { kind?: string } | undefined)?.kind;
              if (kind === "control") clientMap.delete(conn);
              continue;
            }
            case "tt-cmd": {
              if (tt && typeof frame.d === "string") {
                const cmd = parseTTCommand(frame.d);
                if (cmd) {
                  tt.onCommand(cmd.cmd, "arg" in cmd ? cmd.arg : undefined);
                }
              }
              continue;
            }
            case "proto": {
              const theirs = parseProtoHello(frame.d);
              if (!theirs) {
                debug("uds: malformed proto hello — ignored");
                continue;
              }
              const result = negotiateProtocol(protoHello(VERSION), theirs);
              if (result.ok) {
                const c = clientMap.get(conn);
                if (c) c.peer = { aio: theirs.ver, app: theirs.app };
              } else {
                log.error("uds", `protocol mismatch — ${result.reason}`);
                // The v2 frame for a v2 peer (`cli-client.ts` routes it),
                // and the legacy string for the readers that only know that
                // one (`am-uds.ts`). `proto-err` was declared and routed on
                // both and sent by neither.
                sendTo(conn, enc("proto-err", { reason: result.reason }));
                sendTo(conn, "__proto-err:" + result.reason);
                // Close after the error message flushes through the write queue.
                sendTo(conn, "", () => {
                  try {
                    conn.close();
                  } catch { /* already closed */ }
                });
              }
              continue;
            }
            case "client-state":
            case "ui-surface-result":
            case "ui-trigger-result": {
              const client = clientMap.get(conn);
              if (client) {
                const pending = pendingState.get(client.id);
                if (pending) {
                  pendingState.delete(client.id);
                  clearTimeout(pending.timer);
                  pending.resolve(frame.d ?? null);
                }
              }
              continue;
            }
            case "log": {
              const client = clientMap.get(conn);
              if (client && frame.d) {
                try {
                  // deno-lint-ignore no-explicit-any
                  writeClientLog(client.index, frame.d as any);
                } catch { /* malformed — drop */ }
              }
              continue;
            }
            case "cdiag": {
              // A client's degraded() escalation — mirrors server-ws.ts.
              // Electron speaks UDS, so a health escalation from its renderer
              // MUST land here too, or /__aio/health reports "healthy" while
              // the window's subsystem is failing forever (the exact silent
              // fork the cdiag frame exists to close). Values are capped
              // inside _recordClientDegraded; malformed frames are dropped.
              const client = clientMap.get(conn);
              const d = frame.d as DegradedChange | undefined;
              if (
                client && d && typeof d.name === "string" &&
                d.name.length > 0 &&
                (d.kind === "down" || d.kind === "up")
              ) {
                _recordClientDegraded(client.id, {
                  name: d.name,
                  kind: d.kind,
                  failures: typeof d.failures === "number" ? d.failures : 0,
                  since: typeof d.since === "number" ? d.since : Date.now(),
                  lastError: typeof d.lastError === "string" ? d.lastError : "",
                });
              }
              continue;
            }
            case "subs": {
              const client = clientMap.get(conn);
              if (!client) continue;
              const paths = (frame.d as { subs?: unknown } | undefined)?.subs;
              // `parseSubs`, not an inline `new Set(...)`: the count and
              // length caps exist because the parsed Set is held PER
              // CONNECTION and walked on EVERY broadcast. This router had no
              // bound at all, behind a frame ceiling ten times the WS one.
              const parsed = parseSubs(paths, "uds");
              if (parsed !== undefined) {
                // Buffered patches first, under the OLD subscriptions — they
                // describe the base this peer holds (see the accept path).
                flushAllUrgent();
                client.subscriptions = parsed;
                _sendFilteredState(conn, client, true);
              }
              continue;
            }
            case "resync": {
              // Client detected patch desync — send full state. Buffered
              // patches first, or the repair re-creates the desync (see the
              // accept path).
              const client = clientMap.get(conn);
              if (client) {
                flushAllUrgent();
                _sendFilteredState(conn, client, false);
              }
              continue;
            }
            // ── v2 parity: sync + serverFns over UDS ────────────────────
            case "op": {
              const client = clientMap.get(conn);
              if (!syncHandler) {
                log.warn(
                  "uds",
                  "op received but sync is not configured — dropping",
                );
                continue;
              }
              const op = frame.d as Record<string, unknown> | undefined;
              if (
                !op || typeof op.id !== "string" ||
                typeof op.cell !== "string" || typeof op.action !== "string" ||
                !Array.isArray(op.hlc) ||
                ["__proto__", "constructor", "prototype"].includes(
                  op.cell as string,
                ) ||
                ["__proto__", "constructor", "prototype"].includes(
                  op.action as string,
                ) ||
                // Same gate as the WS path (audit F-1): op.action routes to
                // dispatch, so internal action types must be refused here too.
                _isFrameworkInternalActionType(op.action as string)
              ) {
                log.warn("uds", "invalid op — malformed or forbidden fields");
                continue;
              }
              syncHandler.handleOp(
                op,
                { id: client?.id ?? "uds" },
                _wireSink(conn),
              );
              continue;
            }
            case "sync-req": {
              const client = clientMap.get(conn);
              if (!syncHandler) {
                log.warn(
                  "uds",
                  "sync-req received but sync is not configured — dropping",
                );
                continue;
              }
              const sync = frame.d as Record<string, unknown> | undefined;
              if (!sync || typeof sync.clientId !== "string") {
                log.warn("uds", "invalid sync-req — malformed");
                continue;
              }
              syncHandler.handleSync(
                sync,
                { id: client?.id ?? "uds" },
                _wireSink(conn),
              );
              continue;
            }
            case "sfn": {
              const { cid, ns, name, args } = (frame.d ?? {}) as SfnPayload;
              if (
                typeof cid !== "string" || typeof ns !== "string" ||
                typeof name !== "string" || !Array.isArray(args)
              ) {
                log.warn("uds", "invalid sfn frame — dropping");
                continue;
              }
              // Fire-and-forget: BOTH the call and the reply encode must be
              // guarded. An unserializable return value (or a throwing access
              // predicate) escaped as an unhandled rejection, and aio's crash
              // handler is a last-words logger, not a survival net — one bad
              // serverFn took the whole server down.
              invokeServerFn(ns, name, args)
                .then((result) => {
                  try {
                    sendTo(conn, enc("sfnr", { cid, ...result }));
                  } catch (e) {
                    sendTo(
                      conn,
                      enc("sfnr", {
                        cid,
                        ok: false,
                        error: `serverFn result is not serializable: ${e}`,
                      }),
                    );
                  }
                })
                .catch((e) => {
                  log.error("uds", `sfn ${ns}.${name} failed — ${e}`);
                  try {
                    sendTo(
                      conn,
                      enc("sfnr", { cid, ok: false, ...errorFields(e) }),
                    );
                  } catch { /* peer gone */ }
                });
              continue;
            }
            case "ctl": {
              // The control plane (`am`, amui) over the socket. The frame is
              // HTTP-shaped on purpose: it is turned back into a `Request` and
              // handed to the server's own handler, so nothing about the
              // trojan's routing or its gates is re-decided here. This file
              // does transport, not policy.
              const c = (frame.d ?? {}) as CtlPayload;
              if (
                typeof c?.id !== "string" || typeof c.path !== "string" ||
                (c.method !== "GET" && c.method !== "POST")
              ) {
                log.warn("uds", "invalid ctl frame — dropping");
                continue;
              }
              const reply = (
                status: number,
                body: string,
                headers?: Record<string, string>,
              ) => {
                try {
                  sendTo(
                    conn,
                    enc("ctlr", { id: c.id, status, body, headers }),
                  );
                } catch { /* peer gone mid-call */ }
              };
              if (!control) {
                reply(
                  503,
                  JSON.stringify({
                    error:
                      "this app has no control plane (no HTTP handler built)",
                  }),
                );
                continue;
              }
              // The origin is a placeholder: only the PATH is routed on, and
              // every gate downstream reads the peer address, never the host.
              const req = new Request(`http://uds.invalid${c.path}`, {
                method: c.method,
                headers: c.headers ?? {},
                ...(c.method === "POST" ? { body: c.body ?? "" } : {}),
              });
              control(req)
                .then(async (res: Response) => {
                  const headers: Record<string, string> = {};
                  res.headers.forEach((v: string, k: string) => {
                    headers[k] = v;
                  });
                  reply(res.status, await res.text(), headers);
                })
                .catch((e: unknown) => {
                  // A throw from the handler is an ANSWER, not a dropped
                  // frame — the caller is waiting on this id.
                  log.error("uds", `ctl ${c.method} ${c.path} failed — ${e}`);
                  reply(500, JSON.stringify({ error: String(e) }));
                });
              continue;
            }
            case "action": {
              const action = (frame.d ?? {}) as ActionPayload;
              if (!action || typeof action.type !== "string") {
                log.warn("uds", "invalid action — missing type field");
                continue;
              }
              // Block framework-internal action types from UDS sources —
              // parity with the WS server. Internal actions carry trusted
              // payload shapes that bypass cell method bodies (audit F-1).
              if (_isFrameworkInternalActionType(action.type)) {
                log.warn(
                  "uds",
                  `rejected framework-internal action type "${action.type}"`,
                );
                continue;
              }
              // Strip client-set trusted provenance and re-stamp
              // `_source:"UI"` — ONE decider for all three network entry
              // points (sanitizeClientAction, server-ws.ts).
              sanitizeClientAction(action as Record<string, unknown>, "uds");
              const result = onAction(action);
              // AIO-402 + return-value transport: per-action ack — parity with
              // the WS server. Settles the Promise of an awaited method call
              // over UDS+IPC, carrying the method's RETURN value. We wait for
              // the dispatch promise (async → completion; sync/void → next
              // microtask, after any broadcast the dispatch triggered).
              if (typeof action.cid === "string" && action.cid.length > 0) {
                const cid = action.cid;
                const actionType = typeof action.type === "string"
                  ? action.type
                  : "?";
                Promise.resolve(result).then(
                  (value) => {
                    // Parity with the WS ack: `dispatch` resolves whether or
                    // not anything ran, so a refused action (unknown method,
                    // unbooted cell, disabled cell, `validate` refusal) was
                    // acked `ok: true`. See server/action-ack.ts.
                    const refused = _dispatchRefusal(action);
                    if (refused) {
                      try {
                        sendTo(
                          conn,
                          enc("ack", {
                            cid,
                            ok: false,
                            ...errorFields(refused),
                          }),
                        );
                      } catch { /* client gone */ }
                      return;
                    }
                    // `serializeReturn` warns for both a dropped and a lossy
                    // return, once, for every transport.
                    const { value: safe } = serializeReturn(value, actionType);
                    try {
                      sendTo(conn, enc("ack", { cid, ok: true, value: safe }));
                    } catch { /* client gone */ }
                  },
                  (err) => {
                    try {
                      sendTo(
                        conn,
                        // Message + CODE, never `String(err)` — see the WS
                        // twin in server-ws.ts `_sendAckErr`.
                        enc("ack", { cid, ok: false, ...errorFields(err) }),
                      );
                    } catch { /* client gone */ }
                  },
                );
              }
              continue;
            }
            default:
              // Reserved-ignorable kinds ("x" extension frames) skip silently
              // BY CONTRACT — see IGNORABLE in envelope.ts.
              if (isIgnorableKind(frame.t)) continue;
              // Vitals are WS-only diagnostics; anything else S→C-only.
              // Loud, never silent (dev/prod equivalency).
              log.warn(
                "uds",
                unsupportedOnUds(frame.t)
                  ? `"${frame.t}" frames are WS-only diagnostics — not served over UDS/IPC`
                  : `unexpected "${frame.t}" frame from client — dropped`,
              );
              continue;
          }
        }
      }
    } catch { /* connection closed */ }
    try {
      reader.releaseLock();
    } catch { /* stream may be errored (AIO-149) */ }
    connections.delete(conn);
    _settlePendingForGone(pendingState, clientMap.get(conn));
    clientMap.delete(conn);
    try {
      conn.close();
    } catch { /* already closed */ }
    debug(`uds: client disconnected (${connections.size} total)`);
  })();
}

// envelope.ts — THE wire envelope (perfect-aio D7/B4b, v2).
//
// Every message on every transport (WS browser/cli, UDS NDJSON, Electron
// IPC relay) is ONE JSON envelope: `{ v: 2, t: "<kind>", d?: payload }`.
// New frames MUST be added to the Kind union + FRAME_KINDS here first —
// tests/wire-envelope.test.ts pins the catalog against the live code in
// both directions, so an undocumented kind fails CI.
//
// v2 replaced the v1 zoo (string prefixes + discriminator keys + bare-JSON
// state) and split the keys the survey found overloaded:
//   __tt:            → "tt-state" (S→C) / "tt-cmd" (C→S)
//   __ack:<cid>:<ok> → "ack"      — distinct from the CRDT "sync-ack"
//   {__sync}         → "sync-req" (C→S) / "sync-res" (S→C)
//   bare JSON        → "state" / "patches" — no more "anything without a
//                      discriminator is state" hazard.
// The ONE deliberate v1 shim: a version-mismatch reply is still sent as the
// legacy `__proto-err:<reason>` string (a v1 peer must be able to READ why
// it was refused before the 4505 close).
//
// Unknown kinds have exactly TWO tiers — nothing in between:
//   • not in FRAME_KINDS and not in IGNORABLE → `dec()` returns null and the
//     caller treats it as a protocol violation (loud, never silent);
//   • in IGNORABLE → `dec()` decodes it and every router SKIPS it silently.
//     This is the additive-extension reservation: kind "x" is reserved so a
//     future peer can attach experimental/extension frames that an older
//     binary ignores by contract instead of logging a violation per frame.
// SERVES below records which kinds each transport router actually handles;
// tests/wire-serves.test.ts parses the routers' `case "…":` labels and pins
// them against it, so a new kind cannot ship silently unrouted.

/** Every wire-frame kind, with direction (C→S / S→C / both). */
export type Kind =
  | "proto" // both — version hello {v,min}
  | "proto-err" // S→C — mismatch reason, then close 4505
  | "type" // C→S — client kind {kind:"electron"|"browser"}
  | "boot" // S→C — boot id (reload token) {id}
  | "reload" // S→C — dev: full reload
  | "css" // S→C — dev: css-only reload
  | "ping" // C→S — UDS/IPC keepalive
  | "subs" // C→S — subscription list {subs}
  | "resync" // C→S — request full snapshot
  | "get-state" // S→C — request client-side state
  | "client-state" // C→S — reply to get-state {state}
  | "log" // C→S — dev: forwarded console entry
  | "diag" // S→C — diagnostic event
  | "cdiag" // C→S — client degraded() escalation/recovery (health visibility)
  | "cfg" // S→C — resolved client config (syncCells/callTimeouts/renderBudget)
  | "graph-error" // S→C — dev: graph-validator errors (overlay)
  | "graph-clear" // S→C — dev: graph errors fixed
  | "tt-state" // S→C — time-travel panel state
  | "tt-cmd" // C→S — time-travel command {cmd}
  | "ui-surface" // S→C — semantic-surface request
  | "ui-surface-result" // C→S — surface reply
  | "ui-trigger" // S→C — trigger request
  | "ui-trigger-result" // C→S — trigger reply
  | "vitals-ping" // C→S — RTT probe {t1,ms}
  | "vitals-pong" // S→C — RTT reply {t1,t2,loop}
  | "ack" // S→C — per-action ack {cid,ok}
  | "action" // C→S — dispatch {type,payload?,cid?,_source?}
  | "state" // S→C — full-state snapshot
  | "patches" // S→C — Immer patch delta
  | "op" // both — CRDT op (C→S local / S→C broadcast)
  | "sync-req" // C→S — sync request
  | "sync-res" // S→C — sync response
  | "sync-ack" // S→C — per-op CRDT ack
  | "op-rejected" // S→C — server refused an optimistic op (D11)
  | "sync-err" // S→C — sync failure, client backs off + re-requests
  | "sfn" // C→S — server-function invocation
  | "sfnr" // S→C — server-function result
  | "ctl" // C→S — control-plane request {id,path,method,headers?,body?}
  | "ctlr"; // S→C — control-plane reply {id,status,headers?,body}

/** Runtime list of every kind — the test pins this against the union. */
export const FRAME_KINDS: readonly Kind[] = [
  "proto",
  "proto-err",
  "type",
  "boot",
  "reload",
  "css",
  "ping",
  "subs",
  "resync",
  "get-state",
  "client-state",
  "log",
  "diag",
  "cdiag",
  "cfg",
  "graph-error",
  "graph-clear",
  "tt-state",
  "tt-cmd",
  "ui-surface",
  "ui-surface-result",
  "ui-trigger",
  "ui-trigger-result",
  "vitals-ping",
  "vitals-pong",
  "ack",
  "action",
  "state",
  "patches",
  "op",
  "sync-req",
  "sync-res",
  "sync-ack",
  "op-rejected",
  "sync-err",
  "sfn",
  "sfnr",
  "ctl",
  "ctlr",
] as const;

const KIND_SET: ReadonlySet<string> = new Set(FRAME_KINDS);

/** Kinds a receiver must SKIP SILENTLY instead of treating as a protocol
 *  violation. This is the additive wire reservation: `"x"` (extension) is
 *  reserved so a newer peer can send frames an older binary drops by
 *  contract — no log line per frame, no 4505. Everything NOT listed here and
 *  not in FRAME_KINDS stays a loud violation (`dec()` → null). */
export const IGNORABLE: ReadonlySet<Kind | string> = new Set(["x"]);

/** True when `t` is a reserved-ignorable kind — routers check this in their
 *  default arm and skip without logging. ONE decider for the tier. */
export function isIgnorableKind(t: string): boolean {
  return IGNORABLE.has(t);
}

/** Which frame kinds each transport ROUTER handles (its `case "…":` labels).
 *  Pinned against the live routers by tests/wire-serves.test.ts, so adding a
 *  kind to FRAME_KINDS without routing it (or routing one without recording
 *  it) is a red gate, not a silent drop at runtime.
 *
 *  A CATALOGUE, read only by that gate — deliberately, and not a wire the
 *  routers forgot to plug in. Each `case` does different work with a different
 *  payload, so nothing here could BE the dispatch: a router driven by this set
 *  would need a handler table per transport, which is the same list written
 *  again with functions attached, and it would trade an exhaustive `switch`
 *  (which the type-checker and a reader can both see through) for indirection.
 *  What matters is that the two cannot drift apart silently, and the gate
 *  parses the real routers in BOTH directions to guarantee exactly that.
 *
 *  Deliberate omissions, per transport:
 *  • ws (server-ws.ts, C→S): everything a client sends EXCEPT "ping" — WS has
 *    protocol-level ping/pong frames; the app-level "ping" keepalive exists
 *    only for UDS/IPC, which has no transport heartbeat of its own.
 *  • uds (uds.ts, C→S): everything EXCEPT
 *    "vitals-ping" (vitals are WS-only diagnostics — see unsupportedOnUds,
 *    which rejects them LOUDLY rather than dropping them).
 *  • browser (browser-air-transport + browser-shared handleControlFrame +
 *    browser-air-commands routeCommand, S→C): every server-sent kind. No
 *    omissions — a server frame the client cannot route is a bug.
 *  S→C-only kinds are absent from ws/uds and C→S-only kinds from browser by
 *  direction, not by choice. */
export const SERVES: Record<
  "ws" | "uds" | "browser" | "am",
  ReadonlySet<Kind>
> = {
  ws: new Set<Kind>([
    "proto",
    "type",
    "subs",
    "resync",
    "client-state",
    "log",
    "cdiag",
    "tt-cmd",
    "ui-surface-result",
    "ui-trigger-result",
    "vitals-ping",
    "action",
    "op",
    "sync-req",
    "sfn",
  ]),
  uds: new Set<Kind>([
    "proto",
    "ping",
    "subs",
    "resync",
    "client-state",
    "log",
    "cdiag",
    "tt-cmd",
    "ui-surface-result",
    "ui-trigger-result",
    "action",
    "op",
    "sync-req",
    "sfn",
    "ctl",
    // "type" earns its place on this transport now that the socket carries a
    // peer that is NOT a UI: `am`'s control client. Without it every control
    // call was counted as a connected window — it took a client index, showed
    // up in `am clients`, and was mailed a full state snapshot on every
    // `am state`.
    "type",
  ]),
  browser: new Set<Kind>([
    "proto",
    "proto-err",
    "boot",
    "reload",
    "css",
    "get-state",
    "diag",
    "cfg",
    "graph-error",
    "graph-clear",
    "tt-state",
    "ui-surface",
    "ui-trigger",
    "vitals-pong",
    "ack",
    "state",
    "patches",
    "op",
    "sync-res",
    "sync-ack",
    "op-rejected",
    "sync-err",
    "sfnr",
  ]),
  // The CONTROL client (`am`, amui) — a fourth router, and the only peer that
  // is not a UI. It connects to the same socket as the Electron shell and
  // speaks exactly one exchange: `ctl` out, `ctlr` back. Recorded here for the
  // same reason as the other three — a reply kind no router handles is a frame
  // dead on the wire, and this is the transport that carries it.
  am: new Set<Kind>(["ctlr"]),
};

/** One decoded wire frame. `d` is kind-specific (see payload types below).
 *  `v: 2` is the ENVELOPE shape (one JSON object per frame) and is not the
 *  negotiated contract version — that is `PROTOCOL_VERSION` in
 *  protocol-version.ts (v3 since the `append` patch op), announced in the
 *  "proto" hello. The shape has not changed since v2; the vocabulary has. */
export type Frame = { v: 2; t: Kind; d?: unknown };

/** Encode a frame for the wire (WS message body / one NDJSON line). */
export function enc(t: Kind, d?: unknown): string {
  return d === undefined
    ? JSON.stringify({ v: 2, t })
    : JSON.stringify({ v: 2, t, d });
}

/** Encode around an ALREADY-STRINGIFIED payload — the broadcast hot path
 *  serializes big state once and must not pay for it twice. */
export function encRaw(t: Kind, dJson: string): string {
  return `{"v":2,"t":"${t}","d":${dJson}}`;
}

/** Decode one wire message. Null for anything that is not a well-formed v2
 *  envelope — callers treat null as a protocol violation, never as state
 *  (the v1 bare-JSON fallthrough is gone by design).
 *
 *  Reserved-ignorable kinds (see {@linkcode IGNORABLE}) DO decode: they are
 *  well-formed by contract, and the routers' default arms skip them silently
 *  via {@linkcode isIgnorableKind} instead of logging a violation. */
export function dec(raw: string): Frame | null {
  if (raw.length === 0 || raw[0] !== "{") return null;
  try {
    const p = JSON.parse(raw) as { v?: unknown; t?: unknown; d?: unknown };
    if (
      p && p.v === 2 && typeof p.t === "string" &&
      (KIND_SET.has(p.t) || IGNORABLE.has(p.t))
    ) {
      return p as Frame;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Kind-specific payload shapes ─────────────────────────────────────────
export type ActionPayload = {
  type: string;
  payload?: unknown;
  cid?: string;
  _source?: string;
};
export type AckPayload = {
  cid: string;
  ok: boolean;
  /** The method's transported RETURN value — resolves `await cell.method()` on
   *  the caller (serializable results only; non-serializable → omitted + a dev
   *  warning). Absent for void methods / older servers → resolves undefined. */
  value?: unknown;
  /** Error message when ok:false — rejects the awaiting caller. */
  error?: string;
};
// The CRDT frames — "op", "sync-req", "sync-res", "sync-ack", "op-rejected",
// "sync-err" — deliberately have NO payload type here. Their shapes live in
// `src/sync/types.ts` (`OpMessage`, `SyncRequest`, `SyncResponse`,
// `AckMessage`, `OpRejectedMessage`), next to the code that builds and reads
// them, and that is the only place they may live.
//
// A second copy sat here, unused by anything (`enc` takes `unknown`), and it
// had already drifted from the wire in three ways that each read as a fact:
// `lastServerTs` typed `number` when it is a PER-CELL `Record<string, number>`;
// `sync-ack` with no `serverTs`, the cursor position the whole
// snapshot-watermark mechanism turns on; `sync-req` with neither `reqId` nor
// `session`, the two fields that keep overlapping catch-ups and cloned client
// ids apart. Nothing broke, because nothing read them — a maintainer would
// have. Same reason `SyncResponse.rebase` was deleted rather than left
// looking like protocol. Pinned by tests/wire-envelope.test.ts.
//
// `PatchesPayload = Patch[]` (immer) went with them: also unread, and `Patch[]`
// says it better than a name for it does.
export type SfnPayload = {
  cid: string;
  ns: string;
  name: string;
  args: unknown[];
};
export type SfnrPayload = {
  cid: string;
  ok: boolean;
  value?: unknown;
  error?: string;
};
/** A control-plane request, tunnelled over the socket.
 *
 *  Deliberately HTTP-shaped: the server answers it by building a `Request`
 *  and handing it to the SAME handler the TCP listener uses, so the control
 *  plane has one implementation and one set of auth gates whatever wire it
 *  arrived on. A second, socket-specific control API would be a second place
 *  for the trojan's rules to drift out of agreement with itself. */
export type CtlPayload = {
  /** Correlates the reply — several control calls may be in flight. */
  id: string;
  /** Absolute path, query string included (`/__aio/trojan/state?x=1`). */
  path: string;
  method: "GET" | "POST";
  /** Carried verbatim onto the synthetic Request — this is how the local
   *  control credential and the CSRF header reach the same gates they do
   *  over HTTP. */
  headers?: Record<string, string>;
  body?: string;
};
export type CtlrPayload = {
  id: string;
  status: number;
  headers?: Record<string, string>;
  body: string;
};

/** Kinds a UDS/NDJSON endpoint does NOT serve (vitals are WS-only
 *  diagnostics) — rejected LOUDLY, never dropped (dev/prod equivalency: no
 *  silent forks). Sync + serverFns ARE served on UDS since v2; time travel
 *  since alpha42-dev (the Electron panel needs it). */
export function unsupportedOnUds(t: Kind): boolean {
  // Time travel flows over UDS since alpha42-dev (the Electron panel needs
  // tt-state in / tt-cmd out); vitals remain WS-only.
  return t === "vitals-ping" || t === "vitals-pong";
}

/** @deprecated v1 string prefixes — kept ONLY for the version-mismatch shim
 *  (`__proto-err:`) and historical tests. New code speaks `enc`/`dec`. */
export const WIRE = {
  proto: "__proto:",
  protoErr: "__proto-err:",
} as const;

/** The receive side of the v1 shim: when an undecodable line is a v1 peer's
 *  hello or refusal, returns the human-readable mismatch reason so the caller
 *  can go terminal LOUDLY. Null for anything else (plain garbage). */
export function v1PeerReason(line: string): string | null {
  if (line.startsWith(WIRE.protoErr)) return line.slice(WIRE.protoErr.length);
  if (line.startsWith(WIRE.proto)) {
    return "peer speaks wire protocol v1 — rebuild/update it";
  }
  return null;
}

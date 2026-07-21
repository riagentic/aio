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

import type { Patch } from "immer";

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
  | "sfnr"; // S→C — server-function result

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
] as const;

const KIND_SET: ReadonlySet<string> = new Set(FRAME_KINDS);

/** One decoded wire frame. `d` is kind-specific (see payload types below). */
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
 *  (the v1 bare-JSON fallthrough is gone by design). */
export function dec(raw: string): Frame | null {
  if (raw.length === 0 || raw[0] !== "{") return null;
  try {
    const p = JSON.parse(raw) as { v?: unknown; t?: unknown; d?: unknown };
    if (p && p.v === 2 && typeof p.t === "string" && KIND_SET.has(p.t)) {
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
export type AckPayload = { cid: string; ok: boolean };
export type PatchesPayload = Patch[];
export type OpPayload = {
  id: string;
  hlc: [number, number, string];
  cell: string;
  action: string;
  payload?: unknown;
  serverTs?: number;
};
export type SyncReqPayload = {
  clientId: string;
  cells: unknown;
  pendingOps?: unknown;
};
export type SyncResPayload = {
  mode: "snapshot" | "incremental";
  ops: unknown[];
  snapshot?: unknown;
  lowWater?: unknown;
  lastServerTs?: number;
};
export type SyncAckPayload = {
  cell: string;
  opId: string;
  serverHlc: [number, number, string];
};
export type OpRejectedPayload = { opId: string; cell: string; reason: string };
export type SyncErrPayload = { reason: string };
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

/** Kinds a UDS/NDJSON endpoint does NOT serve (vitals + time-travel are
 *  WS-only diagnostics) — rejected LOUDLY, never dropped (dev/prod
 *  equivalency: no silent forks). Sync + serverFns ARE served on UDS since
 *  v2 (the alpha28 transport-capability skew is gone). */
export function unsupportedOnUds(t: Kind): boolean {
  return t === "vitals-ping" || t === "vitals-pong" || t === "tt-cmd" ||
    t === "tt-state";
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

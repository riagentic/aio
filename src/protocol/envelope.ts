// envelope.ts — THE wire-frame catalog (perfect-aio D7/B4b).
//
// Every message that crosses a transport (WS browser/cli, UDS, Electron IPC)
// is listed here, typed, with its direction and carrier. New frames MUST be
// added here first — tests/wire-envelope.test.ts pins this catalog against
// the live encoders/decoders, so an undocumented frame fails CI.
//
// Wire encoding (v1, unchanged): control frames are string-prefixed
// (`__x:` + payload), data frames are JSON keyed by a discriminator
// (`__op`, `__sync`, `__sfn`, …), state frames are bare JSON. The catalog
// types the existing bytes — byte-level unification into a single JSON
// envelope is deferred to the next PROTOCOL_VERSION bump (see
// docs/upgrade/restructure.md § B4b).

import type { Patch } from "immer";

// ── String-prefix control frames ─────────────────────────────────────────
/** Every string-prefix a demux chain may see, in one place. */
export const WIRE = {
  proto: "__proto:", // both dirs — version hello {v,min}
  protoErr: "__proto-err:", // S→C — version mismatch, then close 4505
  type: "__type:", // C→S — client kind: electron|browser
  boot: "__boot:", // S→C — boot id (reload token)
  reload: "__reload", // S→C — dev: full reload
  css: "__css", // S→C — dev: css-only reload
  ping: "__ping", // C→S — UDS/IPC keepalive
  subs: "__subs:", // C→S — subscription list (JSON string[])
  resync: "__resync", // C→S — request full snapshot
  getState: "__getState", // S→C — request client-side state
  clientState: "__clientState:", // C→S — reply to getState (JSON)
  log: "__log:", // C→S — dev: forwarded console entry
  diag: "__diag:", // S→C — diagnostic event (JSON)
  tt: "__tt:", // S→C: panel state (JSON) / C→S: command string
  uiSurface: "__ui:surface", // S→C — semantic-surface request
  uiSurfaceResult: "__ui:surface-result:", // C→S — surface reply (JSON)
  uiTrigger: "__ui:trigger:", // S→C — trigger request (JSON)
  uiTriggerResult: "__ui:trigger-result:", // C→S — trigger reply (JSON)
  vitalsPing: "__vitals:ping:", // C→S — RTT probe {t1,ms}
  vitalsPong: "__vitals:pong:", // S→C — RTT reply {t1,t2,loop}
  ack: "__ack:", // S→C — per-action ack `__ack:<cid>:<0|1>`
} as const;

// ── JSON data frames (discriminator-keyed) ───────────────────────────────
/** C→S action dispatch (also what UDS/NDJSON lines carry). */
export type ActionFrame = {
  type: string;
  payload?: unknown;
  cid?: string;
  _source?: string;
};
/** S→C full-state snapshot: any JSON object without a discriminator key. */
export type StateFrame = Record<string, unknown>;
/** S→C state delta. */
export type PatchesFrame = { $patches: Patch[] };
/** CRDT op — C→S (local) and S→C (broadcast). */
export type OpFrame = {
  __op: {
    id: string;
    hlc: [number, number, string];
    cell: string;
    action: string;
    payload?: unknown;
    serverTs?: number;
  };
};
/** C→S sync request. */
export type SyncRequestFrame = {
  __sync: { clientId: string; cells: unknown; pendingOps?: unknown };
};
/** S→C sync response (same key as the request — shape differs by direction). */
export type SyncResponseFrame = {
  __sync: {
    mode: "snapshot" | "incremental";
    ops: unknown[];
    snapshot?: unknown;
    lowWater?: unknown;
    lastServerTs?: number;
  };
};
/** S→C per-op sync ack (JSON form — distinct from the string `__ack:` frame). */
export type SyncAckFrame = {
  __ack: { cell: string; opId: string; serverHlc: [number, number, string] };
};
/** S→C op rejection (D11 — server refused an optimistic op). */
export type OpRejectedFrame = {
  __op_rejected: { opId: string; cell: string; reason: string };
};
/** S→C sync failure — client must back off and re-request. */
export type SyncErrorFrame = { __sync_error: { reason: string } };
/** C→S server-function invocation. */
export type SfnFrame = {
  __sfn: { cid: string; ns: string; name: string; args: unknown[] };
};
/** S→C server-function result. */
export type SfnResultFrame = {
  __sfnr: { cid: string; ok: boolean; value?: unknown; error?: string };
};

export type JsonFrame =
  | ActionFrame
  | PatchesFrame
  | OpFrame
  | SyncRequestFrame
  | SyncResponseFrame
  | SyncAckFrame
  | OpRejectedFrame
  | SyncErrorFrame
  | SfnFrame
  | SfnResultFrame
  | StateFrame;

/** Frames a UDS/NDJSON server endpoint does NOT implement (CRDT sync,
 *  serverFn, vitals, time-travel) — receivers must reject these LOUDLY
 *  instead of dropping them (dev/prod-equivalency: no silent forks). */
export function unsupportedOnUds(
  parsed: Record<string, unknown>,
): string | null {
  if (parsed.__op || parsed.__sync) return "CRDT sync";
  if (parsed.__sfn) return "serverFns";
  return null;
}

// protocol-version.ts — WS wire-protocol version handshake (roadmap A3).
//
// Both sides announce `{ v, min }` on connect (`__proto:` control message,
// server speaks first). The effective version is `min(ours.v, theirs.v)`;
// the connection is compatible iff each side's `min` is satisfied by it.
// A mismatch closes the socket with code 4505 — loudly, never silently.
//
// Browser-safe: pure constants + a pure function, zero imports.

/** Highest wire-protocol version this build speaks. */
export const PROTOCOL_VERSION = 1;

/** Lowest wire-protocol version this build still accepts. */
export const PROTOCOL_MIN_SUPPORTED = 1;

/** WebSocket close code used for protocol-version mismatches. */
export const PROTOCOL_MISMATCH_CLOSE_CODE = 4505;

/** Version announcement exchanged as `__proto:<json>` on connect. */
export type ProtoHello = { v: number; min: number };

/** This build's announcement. */
export function protoHello(): ProtoHello {
  return { v: PROTOCOL_VERSION, min: PROTOCOL_MIN_SUPPORTED };
}

/** Parse a `__proto:<json>` payload; null when malformed. */
export function parseProtoHello(json: string): ProtoHello | null {
  try {
    const p = JSON.parse(json) as Partial<ProtoHello> | null;
    if (
      p && typeof p.v === "number" && Number.isInteger(p.v) && p.v >= 1 &&
      typeof p.min === "number" && Number.isInteger(p.min) && p.min >= 1 &&
      p.min <= p.v
    ) {
      return { v: p.v, min: p.min };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Negotiate the effective protocol version between two hellos.
 * Compatible iff `min(a.v, b.v)` satisfies both sides' minimums.
 */
export function negotiateProtocol(
  ours: ProtoHello,
  theirs: ProtoHello,
): { ok: true; effective: number } | { ok: false; reason: string } {
  const effective = Math.min(ours.v, theirs.v);
  if (effective < ours.min) {
    return {
      ok: false,
      reason:
        `peer speaks protocol v${theirs.v} but this side requires ≥ v${ours.min} — upgrade the older peer`,
    };
  }
  if (effective < theirs.min) {
    return {
      ok: false,
      reason:
        `this side speaks protocol v${ours.v} but the peer requires ≥ v${theirs.min} — upgrade this side`,
    };
  }
  return { ok: true, effective };
}

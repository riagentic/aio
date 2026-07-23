// protocol-version.ts — wire-protocol version handshake (roadmap A3).
//
// Both sides announce `{ v, min }` on connect (a "proto" envelope, server
// speaks first). The effective version is `min(ours.v, theirs.v)`; the
// connection is compatible iff each side's `min` is satisfied by it.
// A mismatch closes the socket with code 4505 — loudly, never silently.
// v2 (B4b): ONE JSON envelope for every frame; v1 peers are refused (the
// mismatch reason is still sent in v1's `__proto-err:` string form so the
// old peer can read it).
//
// Browser-safe: pure constants + a pure function, zero imports.

/** Highest wire-protocol version this build speaks. */
export const PROTOCOL_VERSION = 2;

/** Lowest wire-protocol version this build still accepts. */
export const PROTOCOL_MIN_SUPPORTED = 2;

/** WebSocket close code used for protocol-version mismatches. */
export const PROTOCOL_MISMATCH_CLOSE_CODE = 4505;

/** Version announcement exchanged in the "proto" envelope on connect.
 *  `ver` is the peer's aio build version — DIAGNOSTIC ONLY (never negotiated),
 *  carried so a mismatch can name which artifact is stale instead of leaving
 *  the user to guess which of server/client/AppImage to rebuild. Optional: a
 *  peer built before it existed simply omits it. */
export type ProtoHello = { v: number; min: number; ver?: string };

/** This build's announcement. Pass the build's aio version when known (the
 *  server reads it from its CLI module; the browser bundle gets it stamped in
 *  at build time) — it only ever appears in diagnostics. */
export function protoHello(ver?: string): ProtoHello {
  return {
    v: PROTOCOL_VERSION,
    min: PROTOCOL_MIN_SUPPORTED,
    ...(ver ? { ver } : {}),
  };
}

/** Validate a hello payload — a decoded envelope `d`, or a JSON string for
 *  the legacy `__proto:` body. Null when malformed. */
export function parseProtoHello(input: unknown): ProtoHello | null {
  try {
    const p = (typeof input === "string" ? JSON.parse(input) : input) as
      | Partial<ProtoHello>
      | null;
    if (
      p && typeof p.v === "number" && Number.isInteger(p.v) && p.v >= 1 &&
      typeof p.min === "number" && Number.isInteger(p.min) && p.min >= 1 &&
      p.min <= p.v
    ) {
      // `ver` is untrusted peer input used only in log lines — keep it a short
      // string so a hostile peer can't flood the log through it.
      const ver = typeof p.ver === "string" && p.ver.length <= 64
        ? p.ver
        : undefined;
      return { v: p.v, min: p.min, ...(ver ? { ver } : {}) };
    }
    return null;
  } catch {
    return null;
  }
}

/** Global the browser bundle is stamped with at build time. */
export const VERSION_STAMP = "__aioVersion";

/** The aio version this browser bundle was built from — stamped into the
 *  generated entry by the build (see build-bundle). Undefined when running
 *  outside a bundle (server, tests), where callers pass their VERSION directly. */
export function stampedVersion(): string | undefined {
  const v = (globalThis as Record<string, unknown>)[VERSION_STAMP];
  return typeof v === "string" ? v : undefined;
}

/** "aio 1.0.0-alpha33" / "an unknown aio version" — for mismatch diagnostics. */
function build(h: ProtoHello): string {
  return h.ver ? `aio ${h.ver}` : "an unknown aio version";
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
        `peer speaks protocol v${theirs.v} but this side requires ≥ v${ours.min} — ` +
        `the PEER is the older build (peer: ${build(theirs)}, here: ${
          build(ours)
        }); rebuild it against this aio version`,
    };
  }
  if (effective < theirs.min) {
    return {
      ok: false,
      reason:
        `this side speaks protocol v${ours.v} but the peer requires ≥ v${theirs.min} — ` +
        `THIS side is the older build (here: ${build(ours)}, peer: ${
          build(theirs)
        }); rebuild it against the newer aio version`,
    };
  }
  return { ok: true, effective };
}

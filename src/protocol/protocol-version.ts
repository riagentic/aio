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
// v3 (alpha70): a `patches` frame may carry `{ op: "append", path, value }`
// — a string that grew ships as its suffix (protocol/patch-ops.ts). A v2 peer
// hands the op to Immer, which throws, and would resync on EVERY streamed
// frame; so v3 is the floor and a v2 peer is refused at the handshake with
// the reason naming the op (PROTOCOL_CHANGES). Last contract change before
// beta.
//
// v2 was ADDITIVE as of alpha70, no bump: an `ack` may now carry the error
// code `DISPATCH_DRAINING` (the loop is closing — running methods are still
// finishing their writes; the action was new input and was refused) next to
// the existing `DISPATCH_CLOSED` (sealed — nothing lands). A v2 peer that does
// not know the new code treats it as any other refusal, which is correct. The
// inbound half of the same change is not on the wire at all: the `_inflight`
// action flag that rides the drain window is server-constructed only and is
// stripped from every network entry point (server-ws.ts sanitizeClientAction).
//
// Browser-safe: pure constants + a pure function, zero imports.

/** Highest wire-protocol version this build speaks. */
export const PROTOCOL_VERSION = 3;

/** Lowest wire-protocol version this build still accepts. */
export const PROTOCOL_MIN_SUPPORTED = 3;

/** What each version added, keyed by the version that introduced it — so a
 *  refusal can say WHY the older build cannot be talked to, not just that it
 *  is older. Every bump adds a row; a version-mismatch reason names every
 *  row above the effective version. */
export const PROTOCOL_CHANGES: Readonly<Record<number, string>> = {
  2: "one JSON envelope per frame",
  3: 'the "append" patch op (a grown string ships as its suffix)',
};

/** "v3 added the "append" patch op …" — the rows of PROTOCOL_CHANGES above
 *  `effective`, or "" when none are known. */
function changesSince(effective: number): string {
  const rows = Object.entries(PROTOCOL_CHANGES)
    .filter(([v]) => Number(v) > effective)
    .map(([v, what]) => `v${v} added ${what}`);
  return rows.length ? `; ${rows.join("; ")}` : "";
}

/** WebSocket close code used for protocol-version mismatches. */
export const PROTOCOL_MISMATCH_CLOSE_CODE = 4505;

/** Version announcement exchanged in the "proto" envelope on connect.
 *  `ver` is the peer's aio build version — DIAGNOSTIC ONLY (never negotiated),
 *  carried so a mismatch can name which artifact is stale instead of leaving
 *  the user to guess which of server/client/AppImage to rebuild. Optional: a
 *  peer built before it existed simply omits it. */
export type ProtoHello = {
  v: number;
  min: number;
  ver?: string;
  /** The peer's APP version (`major.minor.build`, docs/build/versioning.md)
   *  — diagnostic, never negotiated. A server sends its own so a client can
   *  say which build it talks to; a compiled client sends the stamp it
   *  carries. Additive within protocol v3: a peer without it omits it. */
  app?: string;
};

/** This build's announcement. Pass the build's aio version when known (the
 *  server reads it from its CLI module; the browser bundle gets it stamped in
 *  at build time) — it only ever appears in diagnostics. */
export function protoHello(ver?: string, app?: string): ProtoHello {
  return {
    v: PROTOCOL_VERSION,
    min: PROTOCOL_MIN_SUPPORTED,
    ...(ver ? { ver } : {}),
    ...(app ? { app } : {}),
  };
}

/** Global the peer's hello is remembered in, so a client can say which build
 *  it talks to (`peerHello().app`) — set by every transport's proto handler. */
const PEER_HELLO = "__aioPeerHello";

export function rememberPeerHello(h: ProtoHello): void {
  (globalThis as Record<string, unknown>)[PEER_HELLO] = h;
}

/** The hello the other side sent on this connection, or null before one. */
export function peerHello(): ProtoHello | null {
  const h = (globalThis as Record<string, unknown>)[PEER_HELLO];
  return h && typeof h === "object" ? h as ProtoHello : null;
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
      const app = typeof p.app === "string" && p.app.length <= 64
        ? p.app
        : undefined;
      return {
        v: p.v,
        min: p.min,
        ...(ver ? { ver } : {}),
        ...(app ? { app } : {}),
      };
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
        }); rebuild it against this aio version${changesSince(effective)}`,
    };
  }
  if (effective < theirs.min) {
    return {
      ok: false,
      reason:
        `this side speaks protocol v${ours.v} but the peer requires ≥ v${theirs.min} — ` +
        `THIS side is the older build (here: ${build(ours)}, peer: ${
          build(theirs)
        }); rebuild it against the newer aio version${changesSince(effective)}`,
    };
  }
  return { ok: true, effective };
}

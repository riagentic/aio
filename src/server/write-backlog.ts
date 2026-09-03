// write-backlog.ts — "this peer has stopped reading its socket", decided in
// ONE place for both server transports.
//
// The server pushes state at every connected peer on its own schedule, and a
// peer that never reads costs the SERVER the memory: the frames pile up in the
// runtime's outgoing buffer, alive, until the socket closes. The UDS transport
// grew a guard for this in alpha74 — under a comment that said "the WS
// transport throttles and freezes a slow client", which it did not:
//
//  • `server-broadcast.ts` skipped only clients the transport probe already
//    knew were FROZEN, and the probe learned a client existed on its first
//    `vitals-ping` — so a peer that upgrades and never sends a frame was never
//    registered, never evaluated, and never frozen. It got every broadcast.
//  • Nothing on the WS path ever looked at `bufferedAmount`, so even a
//    registered client that stopped draining kept being written to.
//
// Measured (audit a2/W2): +23 MB of RSS per 1000 × 30 KB commits with one
// silent peer attached, linear in the number of commits, with
// `/__aio/health` green throughout.
//
// Two transports, two natural units — the UDS queue is counted in FRAMES
// (each an already-encoded Uint8Array held by a promise chain), the WS buffer
// is counted in BYTES by the runtime — so this module holds the pair rather
// than pretending one number fits both. They live together so the policy is
// read and changed as one thing, and both report through `degraded()`, which
// is what puts them on `/__aio/health`.

import { degraded } from "../diagnostics/degraded.ts";

/** Queued-but-unwritten frames on ONE UDS connection before the app says so.
 *  Generous: a burst of state during a slow render is normal, a peer that has
 *  stopped reading is not, and only the second should be reported. */
export const WRITE_QUEUE_WARN = 64;

/** Bytes the runtime is holding for ONE WebSocket peer before the broadcaster
 *  stops feeding it. Sized off the same intent as `WRITE_QUEUE_WARN`: tens of
 *  ordinary state frames may legitimately be in flight to a browser on a slow
 *  link, megabytes of them may not. */
export const WS_BUFFER_HIGH_WATER = 4 * 1024 * 1024;

/** The UDS half — a peer whose write queue is not draining. */
export const udsWriteBacklog = degraded("uds:write-backlog");

/** The WS half — a peer whose socket buffer is not draining. Skipping its
 *  rounds is not silent: a skipped round is a LOST round, so the client is
 *  marked `needsFull` and the next round it is eligible for carries whole
 *  state rather than a patch that assumes the skipped ones landed. */
export const wsWriteBacklog = degraded("ws:write-backlog");

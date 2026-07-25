// Return-value transport guard.
//
// A cell method's return value crosses the wire in the per-action `ack` frame
// (see AckPayload.value). Only JSON-serializable values survive the trip — a
// function, class instance, BigInt, or circular structure cannot. Rather than
// throw mid-send (which would drop the ack and hang the awaiting caller), we
// coerce a non-serializable return to `undefined` and warn loudly in dev, so
// the caller resolves with `undefined` instead of never resolving.

/** Result of vetting a return value for transport. */
export interface SerializedReturn {
  /** JSON-clean value safe to place in the ack frame (or undefined). */
  value: unknown;
  /** True when the original value could not be transported as-is. */
  dropped: boolean;
}

/** Vet a method's return value for the ack frame. Returns a JSON-clean value,
 *  or `{value: undefined, dropped: true}` when it cannot cross the wire. */
export function serializeReturn(value: unknown): SerializedReturn {
  if (value === undefined) return { value: undefined, dropped: false };
  try {
    // Round-trip so the receiver gets exactly what JSON can carry, and so we
    // reject BigInt / circular refs (which throw) up front.
    const json = JSON.stringify(value);
    if (json === undefined) {
      // A bare function/symbol stringifies to `undefined` without throwing.
      return { value: undefined, dropped: true };
    }
    return { value: JSON.parse(json), dropped: false };
  } catch {
    return { value: undefined, dropped: true };
  }
}

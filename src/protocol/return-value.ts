// Return-value transport guard.
//
// A cell method's return value crosses the wire in the per-action `ack` frame
// (see AckPayload.value). Only JSON-serializable values survive the trip — a
// function, class instance, BigInt, or circular structure cannot. Rather than
// throw mid-send (which would drop the ack and hang the awaiting caller), we
// coerce a non-serializable return to `undefined` and warn loudly in dev, so
// the caller resolves with `undefined` instead of never resolving.
//
// The harder half is LOSSY conversion. `JSON.stringify` only throws for BigInt
// and cycles; everything else it "handles" by quietly changing it:
//
//   Date        → ISO string          Map / Set / RegExp / Error → {}
//   NaN / ±Inf  → null                -0 → 0
//   undefined member → key vanishes   function / symbol member → key vanishes
//   Uint8Array  → {"0":1,"1":2,…}     class instance → plain object
//   an object with toJSON → whatever toJSON felt like returning
//
// The old guard set `dropped` only when the WHOLE value failed to stringify,
// so every one of those arrived corrupted and SILENT: a 45-class × {sync,
// async} × {in-process, WS, UDS} sweep found 37 exact, 0 warned, 53
// lossy-silent. The persistence layer already has a loud per-value/per-path
// guard for exactly this class; the ack path did not. It does now: the
// round-trip is compared against the original, per path, and every conversion
// is named.
//
// It WARNS rather than rejects, deliberately. By the time an ack is built the
// method has already run and its writes are committed — rejecting the caller
// here would be the same lie as rejecting a queued action and then sending it:
// a promise outcome that contradicts what the server actually did. The
// developer gets the exact path and conversion; the value still travels.

import { log } from "../diagnostics/logger-api.ts";

// The JSON round-trip comparison itself lives in wire-value.ts — ONE walk,
// shared with the argument guard (the other direction of the same wire).
export type { LossyConversion } from "./wire-value.ts";
import {
  findLossy,
  formatLossy,
  type LossyBudget,
  type LossyConversion,
} from "./wire-value.ts";

/** Result of vetting a return value for transport. */
export interface SerializedReturn {
  /** JSON-clean value safe to place in the ack frame (or undefined). */
  value: unknown;
  /** True when the original value could not be transported as-is. */
  dropped: boolean;
  /** Values that survived, but not intact. Empty when the trip was exact —
   *  unless `truncated`, in which case empty means "nothing found in the part
   *  that was checked". */
  lossy: LossyConversion[];
  /** The comparison walk gave up before the end of the value (see
   *  `wire-value.ts`'s MAX_NODES).
   *
   *  Without it `lossy: []` reads as "this value crossed the wire EXACTLY",
   *  which a walk that stopped early cannot know — the measured case is a
   *  30 000-key object with a trailing `Date`, reported as a clean bill of
   *  health. `serializeArgs` — the OTHER direction of the same wire, sharing
   *  the same walk for exactly this reason — has always returned it; this half
   *  dropped the budget on the floor and reported the exactness it could not
   *  establish. */
  truncated: boolean;
}

/** Vet a method's return value for the ack frame. Returns a JSON-clean value,
 *  or `{value: undefined, dropped: true}` when it cannot cross the wire, plus
 *  the list of values that crossed in a different shape than they left.
 *
 *  `what` names the method for the warning ("cell:method"); pass it from the
 *  ack site so a corrupted return says WHICH call produced it. */
export function serializeReturn(
  value: unknown,
  what?: string,
): SerializedReturn {
  if (value === undefined) {
    return { value: undefined, dropped: false, lossy: [], truncated: false };
  }
  let round: unknown;
  try {
    // Round-trip so the receiver gets exactly what JSON can carry, and so we
    // reject BigInt / circular refs (which throw) up front.
    const json = JSON.stringify(value);
    if (json === undefined) {
      // A bare function/symbol stringifies to `undefined` without throwing.
      return dropValue(what);
    }
    round = JSON.parse(json);
  } catch {
    return dropValue(what);
  }

  const lossy: LossyConversion[] = [];
  const budget: LossyBudget = { n: 0 };
  findLossy(value, round, "value", lossy, budget);
  if (lossy.length > 0) warnLossy(lossy, what);
  return {
    value: round,
    dropped: false,
    lossy,
    truncated: budget.truncated === true,
  };
}

/** The value could not cross the wire at all — a function, a BigInt, a
 *  circular reference. The caller resolves with `undefined`, and the ack is
 *  `{ok:true}` with no value, which on the wire is indistinguishable from a
 *  method that returns nothing. So the server is the only place this can be
 *  said, and it says it ONCE, here, for every transport.
 *
 *  It used to be said at each ack site instead: the UDS path warned always,
 *  the WS path warned only when `!prod` — so in production, over the transport
 *  every browser uses, a method whose return value was thrown away logged
 *  nothing at any level. Its sibling `warnLossy` had already settled the
 *  question one line below: a corrupted return value is a defect either way.
 *  Observe-only, so this is not a dev/prod behaviour fork. */
function dropValue(what?: string): SerializedReturn {
  const where = what ? `"${what}"` : "a method";
  log.warn(
    "ack",
    `${where} returned a value JSON cannot carry AT ALL (a function, a ` +
      `BigInt, or a circular reference) — the caller resolves with ` +
      `undefined. Return JSON-safe data (plain objects/arrays/primitives) to ` +
      `transport a value, or read it from synced state instead.`,
  );
  return { value: undefined, dropped: true, lossy: [], truncated: false };
}

/** Say exactly what changed. Loud in dev AND prod: a corrupted return value is
 *  a defect either way, and the whole point is that it stops being invisible.
 *  Observe-only, so it is not a dev/prod behaviour fork. */
function warnLossy(lossy: LossyConversion[], what?: string): void {
  const where = what ? `"${what}"` : "a method";
  log.warn(
    "ack",
    `${where} returned a value JSON cannot carry intact — the caller ` +
      `receives a DIFFERENT value than the method returned:\n${
        formatLossy(lossy)
      }\nReturn JSON-safe data across the wire (ISO strings for dates, arrays ` +
      `for Map/Set, plain objects for class instances), or read the value ` +
      `from synced state instead.`,
  );
}

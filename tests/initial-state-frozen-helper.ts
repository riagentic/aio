// The shape boot works with: a deep MUTABLE copy of the frozen declaration.
// Kept beside the test rather than inlined so the assertion reads as the
// contract ("boot's state accepts a write") and not as a clone call.
import { cloneState } from "../src/state/immutable.ts";

const DECLARED = Object.freeze({
  frozen1: Object.freeze({ a: 0 }),
  nested: Object.freeze({ deep: "original" }),
  gone: Object.freeze({ old: true }),
});

/** What `aio-boot.ts` builds: `cloneState(initialState)`. */
export function bootState(): Record<string, unknown> {
  return cloneState(DECLARED) as Record<string, unknown>;
}

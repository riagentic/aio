// A cheap estimate of the memory a value keeps alive — the one measure behind
// every byte budget on a retained history (the dispatch timeline's ring, dev
// time travel's history).
//
// COST. A full walk visits every node: ~15–20 ms for a 200k-row array, as slow
// as `JSON.stringify` of the same value, and it ran on the dispatch path of
// every action that replaced a big value. So a large container is SAMPLED:
// `RETAINED_SAMPLE` members at a uniform stride stand in for all of them, and
// the walk of a 200k-row array costs what a 256-row one does (~0.03 ms).
//
// ACCURACY — the stated bound, pinned by tests/retained-bytes.test.ts:
//   • a container with at most 2 × RETAINED_SAMPLE members is walked
//     EXACTLY — the estimate is the model's value, not an approximation;
//   • a larger container is estimated as (its length) × (mean modeled size of
//     the sampled members), plus its own flat cost. When every member's
//     modeled size lies within [lo, hi], the estimate lies within
//     [length × lo, length × hi] — i.e. within a factor hi/lo of the model —
//     and for members of one shape (rows of one record type, the common
//     case) within a few percent;
//   • what sampling CAN miss is a single outlier member far larger than the
//     rest: 256 draws from 100 000 members find it 0.26% of the time, and no
//     count cap bounds the BYTES that costs. So the DELTA estimator, whose
//     containers are mostly shared with the previous entry (Immer), never
//     samples the container — it samples only what is new, which is usually
//     one member (see `approxDeltaBytes`). `approxRetainedBytes` runs on the
//     always-on dispatch path over a timeline entry's payload and diff, where
//     a big value is a DIRECT member and is walked; there the outlier miss
//     stands, bounded only by the ring's count cap.
//
// THE MODEL (unchanged): strings count their length + 16 (V8 stores ASCII one
// byte per character), binary buffers their byteLength, primitives 8, every
// object 32 plus its keys' lengths. Shared subtrees are counted once per call.

/** What one member slot of a COPIED container costs, in the delta model — a
 *  V8 pointer. See {@linkcode approxDeltaBytes}. */
export const SLOT_BYTES = 8;

/** Members walked per large container — see the accuracy bound above. */
export const RETAINED_SAMPLE = 256;

/** How many members a DELTA (see {@linkcode approxDeltaBytes}) walks exactly
 *  before it decides the container is mostly new and samples it instead — the
 *  same threshold below which a whole container is walked exactly. */
const FRESH_CAP = 2 * RETAINED_SAMPLE;

/** Estimated bytes `v` keeps alive, stopping as soon as the running total
 *  passes `budget` (the answer is then "at least that much", which is all an
 *  eviction needs). Never throws: a node the walk cannot read — an enumerable
 *  getter that throws, a revoked Proxy — counts its flat cost. */
export function approxRetainedBytes(v: unknown, budget = Infinity): number {
  let n = 0;
  // Parallel stacks: a node and the number of members it stands in for.
  const stack: unknown[] = [v];
  const weights: number[] = [1];
  const seen = new Set<object>();
  const push = (x: unknown, w: number): void => {
    stack.push(x);
    weights.push(w);
  };
  while (stack.length > 0 && n <= budget) {
    const x = stack.pop();
    const w = weights.pop()!;
    if (typeof x === "string") {
      n += w * (x.length + 16);
      continue;
    }
    if (x === null || typeof x !== "object") {
      n += w * 8;
      continue;
    }
    if (seen.has(x)) continue;
    seen.add(x);
    n += w * 32;
    try {
      if (ArrayBuffer.isView(x)) {
        n += w * x.byteLength;
      } else if (x instanceof ArrayBuffer) {
        n += w * x.byteLength;
      } else if (Array.isArray(x)) {
        const len = x.length;
        if (len <= 2 * RETAINED_SAMPLE) {
          for (let i = 0; i < len; i++) push(x[i], w);
        } else {
          const step = len / RETAINED_SAMPLE;
          const cw = w * step;
          for (let j = 0; j < RETAINED_SAMPLE; j++) {
            push(x[Math.floor(j * step)], cw);
          }
        }
      } else if (x instanceof Map || x instanceof Set) {
        const size = x.size;
        const every = size <= 2 * RETAINED_SAMPLE
          ? 1
          : Math.ceil(size / RETAINED_SAMPLE);
        const cw = w * (size / Math.ceil(size / every));
        let i = 0;
        for (const e of x.entries()) {
          if (i++ % every !== 0) continue;
          if (x instanceof Map) {
            push(e[0], cw);
            push(e[1], cw);
          } else push(e[0], cw);
        }
      } else {
        const keys = Object.keys(x);
        const len = keys.length;
        if (len <= 2 * RETAINED_SAMPLE) {
          for (let i = 0; i < len; i++) {
            const k = keys[i]!;
            n += w * k.length;
            push((x as Record<string, unknown>)[k], w);
          }
        } else {
          // A dictionary keyed by id — as big as an array of rows, and
          // sampled the same way, keys included.
          const step = len / RETAINED_SAMPLE;
          const cw = w * step;
          for (let j = 0; j < RETAINED_SAMPLE; j++) {
            const k = keys[Math.floor(j * step)]!;
            n += cw * k.length;
            push((x as Record<string, unknown>)[k], cw);
          }
        }
      }
    } catch {
      // aio-ok: a node the walk cannot read counts its flat cost. This is an
      // ESTIMATE feeding an eviction; a throw here, inside a ring's `record`,
      // skipped the count cap and grew the ring on every such dispatch
      // (tests/timeline-byte-budget.test.ts).
    }
  }
  return n;
}

/** Estimated bytes `next` keeps alive that `prev` does not — the retention a
 *  history pays for ONE more entry when the entries are immutable trees with
 *  structural sharing (Immer's, so dev time travel's and the timeline's).
 *
 *  A subtree the two share by reference costs nothing: it is one tree, already
 *  counted. What a replaced value costs is its own size, and what a COPIED
 *  container costs is its slots — an array rebuilt to append one row keeps a
 *  fresh backing store of `length` pointers even though every element is
 *  shared, which is 1.6 MB per entry on a 200k-row array and the difference
 *  between "history is free" and a server past 2 GB. So a container that is
 *  not shared with `prev` is charged {@linkcode SLOT_BYTES} per member on top
 *  of its members' own deltas.
 *
 *  SAMPLING IS OVER WHAT IS NEW, not over the container. Membership is a
 *  reference compare (a lookup for a Map/Set) — ~50× cheaper than the walk it
 *  decides — so every member is checked and only the ones `prev` does not
 *  already hold are walked, exactly, while there are at most
 *  2 × {@linkcode RETAINED_SAMPLE} of them. Sampling the CONTAINER instead
 *  found the one row an action rewrote 256 times in 100 000: a 4 MB row read
 *  as nothing, and 40 actions really retaining 16 MB each read as 38.7 MB
 *  against a 128 MB budget with nothing evicted. Only a container that is
 *  mostly new falls back to a uniform stride over all of it, and there the
 *  sampled members are representative by construction.
 *
 *  Membership is compared at the SAME index (and its two neighbours, which
 *  covers a shift/unshift/splice of one). A container whose members all moved
 *  reads as entirely new, so the estimate is an over-estimate there — history
 *  is evicted earlier than it strictly must be, never later. */
export function approxDeltaBytes(
  prev: unknown,
  next: unknown,
  budget = Infinity,
): number {
  let n = 0;
  const a: unknown[] = [prev];
  const b: unknown[] = [next];
  const weights: number[] = [1];
  const seen = new Set<object>();
  const push = (x: unknown, y: unknown, w: number): void => {
    a.push(x);
    b.push(y);
    weights.push(w);
  };
  /** Is `y` in `prev` near index `i` (same slot, or one either way)? */
  const shared = (arr: unknown[], i: number, y: unknown): boolean =>
    arr[i] === y || (i > 0 && arr[i - 1] === y) ||
    (i + 1 < arr.length && arr[i + 1] === y);
  while (b.length > 0 && n <= budget) {
    const x = a.pop();
    const y = b.pop();
    const w = weights.pop()!;
    if (x === y) continue; // shared with the previous entry — already held
    if (typeof y === "string") {
      n += w * (y.length + 16);
      continue;
    }
    if (y === null || typeof y !== "object") {
      n += w * 8;
      continue;
    }
    if (seen.has(y)) continue;
    seen.add(y);
    n += w * 32;
    try {
      if (ArrayBuffer.isView(y)) {
        n += w * y.byteLength;
      } else if (y instanceof ArrayBuffer) {
        n += w * y.byteLength;
      } else if (Array.isArray(y)) {
        const old = Array.isArray(x) ? x : undefined;
        const len = y.length;
        n += w * SLOT_BYTES * len; // the copied backing store
        // Every member is CHECKED (a reference compare), only what is new is
        // walked. `null` means the array is mostly new and a uniform stride
        // over all of it is representative — the fallback below.
        const fresh: number[] = [];
        let mostlyNew = false;
        for (let i = 0; i < len; i++) {
          if (old !== undefined && shared(old, i, y[i])) continue;
          if (fresh.length === FRESH_CAP) {
            mostlyNew = true;
            break;
          }
          fresh.push(i);
        }
        if (!mostlyNew) {
          for (const i of fresh) push(undefined, y[i], w);
        } else {
          const step = len / RETAINED_SAMPLE;
          const cw = w * step;
          for (let j = 0; j < RETAINED_SAMPLE; j++) {
            const i = Math.floor(j * step);
            if (old && shared(old, i, y[i])) continue;
            push(undefined, y[i], cw);
          }
        }
      } else if (y instanceof Map || y instanceof Set) {
        // No index to align on: a member the previous collection also holds is
        // free (reference-equal), everything else is new.
        const old = x instanceof Map || x instanceof Set ? x : undefined;
        const oldMap = old instanceof Map ? old : undefined;
        const oldSet = old instanceof Set ? old : undefined;
        const isMap = y instanceof Map;
        const size = y.size;
        n += w * SLOT_BYTES * size;
        /** A key the previous map also holds is one string, already counted;
         *  a NEW key is new memory, like any other value. */
        const take = (e: [unknown, unknown], cw: number): void => {
          if (isMap) {
            const hadKey = oldMap?.has(e[0]) ?? false;
            push(hadKey ? e[0] : undefined, e[0], cw);
            push(hadKey ? oldMap!.get(e[0]) : undefined, e[1], cw);
          } else if (!oldSet?.has(e[0])) push(undefined, e[0], cw);
        };
        // Same rule as the array above: membership is a LOOKUP, so the entries
        // the previous collection does not already hold are found exactly and
        // only they are walked, while there are few enough of them.
        const fresh: [unknown, unknown][] = [];
        let mostlyNew = false;
        for (const e of y.entries()) {
          if (
            isMap ? (oldMap?.has(e[0]) && oldMap.get(e[0]) === e[1]) : oldSet
              ?.has(e[0])
          ) continue;
          if (fresh.length === FRESH_CAP) {
            mostlyNew = true;
            break;
          }
          fresh.push(e as [unknown, unknown]);
        }
        if (!mostlyNew) {
          for (const e of fresh) take(e, w);
        } else {
          const every = Math.ceil(size / RETAINED_SAMPLE);
          const cw = w * (size / Math.ceil(size / every));
          let i = 0;
          for (const e of y.entries()) {
            if (i++ % every !== 0) continue;
            take(e as [unknown, unknown], cw);
          }
        }
      } else {
        const old = x !== null && typeof x === "object"
          ? x as Record<string, unknown>
          : undefined;
        const keys = Object.keys(y);
        const len = keys.length;
        const rec = y as Record<string, unknown>;
        n += w * SLOT_BYTES * len;
        // Same rule as the array above: the keys whose value `prev` does not
        // already hold are found exactly — `Object.keys` has already walked
        // the whole object, so this costs one property read per key — and
        // only they are walked. A dictionary of rows keyed by id is the
        // array-of-rows case in another shape, and used to lose a rewritten
        // row to the stride the same way.
        const fresh: string[] = [];
        let mostlyNew = false;
        for (const k of keys) {
          if (old !== undefined && old[k] === rec[k]) continue;
          if (fresh.length === FRESH_CAP) {
            mostlyNew = true;
            break;
          }
          fresh.push(k);
        }
        if (!mostlyNew) {
          for (const k of fresh) {
            n += w * k.length;
            push(old?.[k], rec[k], w);
          }
        } else {
          const step = len / RETAINED_SAMPLE;
          const cw = w * step;
          for (let j = 0; j < RETAINED_SAMPLE; j++) {
            const k = keys[Math.floor(j * step)]!;
            const yv = rec[k];
            if (old && old[k] === yv) continue;
            n += cw * k.length;
            push(old?.[k], yv, cw);
          }
        }
      }
    } catch {
      // aio-ok: as in approxRetainedBytes — an unreadable node costs its flat
      // cost rather than taking an eviction down with it.
    }
  }
  return n;
}

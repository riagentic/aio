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

import { log } from "../diagnostics/logger.ts";

/** One value that changed shape on the way through JSON. */
export interface LossyConversion {
  /** Path from the returned root, e.g. `value.items[0].due`. */
  path: string;
  /** What it was: `Date`, `Map`, `NaN`, `undefined`, `function`, `Foo`… */
  from: string;
  /** What the caller actually receives: `string`, `object`, `null`, `absent`… */
  to: string;
}

/** Result of vetting a return value for transport. */
export interface SerializedReturn {
  /** JSON-clean value safe to place in the ack frame (or undefined). */
  value: unknown;
  /** True when the original value could not be transported as-is. */
  dropped: boolean;
  /** Values that survived, but not intact. Empty when the trip was exact. */
  lossy: LossyConversion[];
}

/** Cap on reported paths and on the comparison walk, so a huge return value
 *  cannot turn a diagnostic into a performance problem. */
const MAX_REPORTED = 8;
const MAX_NODES = 20_000;

function typeName(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number") {
    if (Number.isNaN(v as number)) return "NaN";
    if (!Number.isFinite(v as number)) {
      return (v as number) > 0 ? "Infinity" : "-Infinity";
    }
    if (Object.is(v, -0)) return "-0";
    return "number";
  }
  if (t !== "object") return t;
  const ctor = (v as { constructor?: { name?: string } }).constructor;
  return ctor?.name || "object";
}

function isPlainObject(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Walk the original beside its JSON round-trip and name every difference. */
function findLossy(
  orig: unknown,
  round: unknown,
  path: string,
  out: LossyConversion[],
  budget: { n: number },
): void {
  if (out.length >= MAX_REPORTED || budget.n++ > MAX_NODES) return;

  const t = typeof orig;
  if (orig === null || t === "boolean" || t === "string") {
    if (orig !== round) {
      out.push({ path, from: typeName(orig), to: typeName(round) });
    }
    return;
  }
  if (t === "number") {
    // Object.is separates -0 from 0 as well as catching NaN → null.
    if (!Object.is(orig, round)) {
      out.push({
        path,
        from: typeName(orig),
        // "number" says nothing when the change IS the value.
        to: Object.is(round, 0) ? "0 (sign lost)" : typeName(round),
      });
    }
    return;
  }
  if (
    t === "bigint" || t === "function" || t === "symbol" || t === "undefined"
  ) {
    // Reachable only for a nested member; a bare one is handled by the caller.
    if (round !== orig) out.push({ path, from: t, to: typeName(round) });
    return;
  }

  // Objects. A custom toJSON means the receiver never sees this object at all.
  const hasToJson = typeof (orig as { toJSON?: unknown }).toJSON === "function";
  if (hasToJson) {
    out.push({ path, from: typeName(orig), to: typeName(round) });
    return;
  }
  if (Array.isArray(orig)) {
    if (!Array.isArray(round)) {
      out.push({ path, from: "Array", to: typeName(round) });
      return;
    }
    for (let i = 0; i < orig.length; i++) {
      findLossy(orig[i], (round as unknown[])[i], `${path}[${i}]`, out, budget);
      if (out.length >= MAX_REPORTED) return;
    }
    return;
  }
  if (!isPlainObject(orig)) {
    // Map / Set / RegExp / Error / TypedArray / class instance: the prototype
    // and everything it carried is gone. `{}` for Map & friends, a plain
    // object of fields for a class instance, {"0":1,…} for a Uint8Array.
    out.push({ path, from: typeName(orig), to: typeName(round) });
    return;
  }
  if (!isPlainObject(round)) {
    out.push({ path, from: "object", to: typeName(round) });
    return;
  }
  const r = round as Record<string, unknown>;
  for (const [k, v] of Object.entries(orig as Record<string, unknown>)) {
    const p = `${path}.${k}`;
    if (!(k in r)) {
      // undefined / function / symbol members are erased by JSON, key and all.
      out.push({ path: p, from: typeName(v), to: "absent" });
    } else {
      findLossy(v, r[k], p, out, budget);
    }
    if (out.length >= MAX_REPORTED) return;
  }
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
    return { value: undefined, dropped: false, lossy: [] };
  }
  let round: unknown;
  try {
    // Round-trip so the receiver gets exactly what JSON can carry, and so we
    // reject BigInt / circular refs (which throw) up front.
    const json = JSON.stringify(value);
    if (json === undefined) {
      // A bare function/symbol stringifies to `undefined` without throwing.
      return { value: undefined, dropped: true, lossy: [] };
    }
    round = JSON.parse(json);
  } catch {
    return { value: undefined, dropped: true, lossy: [] };
  }

  const lossy: LossyConversion[] = [];
  findLossy(value, round, "value", lossy, { n: 0 });
  if (lossy.length > 0) warnLossy(lossy, what);
  return { value: round, dropped: false, lossy };
}

/** Say exactly what changed. Loud in dev AND prod: a corrupted return value is
 *  a defect either way, and the whole point is that it stops being invisible.
 *  Observe-only, so it is not a dev/prod behaviour fork. */
function warnLossy(lossy: LossyConversion[], what?: string): void {
  const where = what ? `"${what}"` : "a method";
  const list = lossy
    .map((l) => `  ${l.path}: ${l.from} → ${l.to}`)
    .join("\n");
  log.warn(
    "ack",
    `${where} returned a value JSON cannot carry intact — the caller ` +
      `receives a DIFFERENT value than the method returned:\n${list}\n` +
      `${
        lossy.length >= MAX_REPORTED ? "  …(more)\n" : ""
      }Return JSON-safe data across the wire (ISO strings for dates, arrays ` +
      `for Map/Set, plain objects for class instances), or read the value ` +
      `from synced state instead.`,
  );
}

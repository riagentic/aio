import { log } from "../diagnostics/logger-api.ts";

// wire-value.ts — what JSON does to a value on the way across the wire.
//
// THE decider for one fact: "did this value survive the trip, and if not, what
// exactly changed?" A call's RESULT (return-value.ts, the `ack`/`sfnr` frames)
// and a call's ARGUMENTS (the `sfn` frame, vetted in the browser client) are
// the two directions of that same fact, so they share this walk rather than
// each hand-reasoning about JSON.
//
// `JSON.stringify` only THROWS for BigInt and cycles; everything else it
// "handles" by quietly changing it:
//
//   Date        → ISO string          Map / Set / RegExp / Error → {}
//   NaN / ±Inf  → null                -0 → 0
//   undefined member → key vanishes   function / symbol member → key vanishes
//   Uint8Array  → {"0":1,"1":2,…}     class instance → plain object
//   an object with toJSON → whatever toJSON felt like returning
//
// This module is BROWSER-SAFE by construction: no logger (the structured
// logger pulls in @std/path for rotation, which no browser import map
// provides — same rule diagnostics/degraded.ts follows), no Deno APIs.

/** One value that changed shape on the way through JSON. */
export interface LossyConversion {
  /** Path from the walked root, e.g. `value.items[0].due`, `args[1]`. */
  path: string;
  /** What it was: `Date`, `Map`, `NaN`, `undefined`, `function`, `Foo`… */
  from: string;
  /** What the receiver actually gets: `string`, `object`, `null`, `absent`… */
  to: string;
}

/** Cap on reported paths and on the comparison walk, so a huge value cannot
 *  turn a diagnostic into a performance problem. */
export const MAX_REPORTED = 8;
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
export function findLossy(
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

/** `path: from → to` lines, plus a `…(more)` marker when the cap was hit. */
export function formatLossy(lossy: LossyConversion[]): string {
  return lossy.map((l) => `  ${l.path}: ${l.from} → ${l.to}`).join("\n") +
    (lossy.length >= MAX_REPORTED ? "\n  …(more)" : "");
}

/** Result of vetting a call's ARGUMENTS for transport. */
export interface SerializedArgs {
  /** JSON-clean arguments safe to put on the wire (identical when exact). */
  args: unknown[];
  /** True when JSON cannot carry them at all (BigInt / circular). The caller
   *  must refuse the call rather than send something else. */
  dropped: boolean;
  /** Arguments that survived, but not intact. Empty when the trip was exact. */
  lossy: LossyConversion[];
}

/** Vet a call's arguments before they go on the wire.
 *
 *  The OTHER direction of the result guard, and it did not exist: a serverFn's
 *  arguments cross the same JSON wire, so `f(new Date())` arrived as a string,
 *  a `Map` as `{}`, `NaN`/`undefined` as `null` — silently, while the identical
 *  value RETURNED warned loudly. Same round-trip, same walk, so the two
 *  directions cannot drift.
 *
 *  Warns (console, not the structured logger — this runs in the browser) and
 *  hands back the JSON-clean arguments; `dropped` says the call must not be
 *  sent at all. `what` names the call so the warning is actionable. */
export function serializeArgs(
  args: unknown[],
  what?: string,
): SerializedArgs {
  let round: unknown;
  try {
    round = JSON.parse(JSON.stringify(args));
  } catch {
    return { args, dropped: true, lossy: [] };
  }
  const lossy: LossyConversion[] = [];
  findLossy(args, round, "args", lossy, { n: 0 });
  if (lossy.length > 0) {
    log.warn(
      `[aio] ${what ?? "a call"} was called with arguments JSON cannot carry ` +
        `intact — the server receives DIFFERENT values than the caller ` +
        `passed:\n${formatLossy(lossy)}\nPass JSON-safe data across the wire ` +
        `(ISO strings for dates, arrays for Map/Set, plain objects for class ` +
        `instances).`,
    );
  }
  return { args: round as unknown[], dropped: false, lossy };
}

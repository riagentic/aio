// view-delta.ts — a `visible.forUser` cell's change as PATCHES, per client.
//
// A per-user view has no Immer patch: the server's patch describes the cell,
// and the client holds a projection of it. It used to be sent as a full state
// for the whole ROUND — every cell the client reads, whenever any `forUser`
// cell changed (feedback: 69 KB × clients per broadcast for a one-field edit).
//
// Now the transport keeps, per client, the view slice it last sent for each
// `forUser` cell (`createViewTracker`), and a round that changed such a cell sends
// the structural diff of that client's new slice against it — standard
// `replace`/`add`/`remove` ops inside the ordinary `patches` frame, so every
// client of any version applies them (no protocol change). An unchanged view
// diffs to nothing and sends nothing.
//
// Correct by construction, on two invariants:
//   1. A baseline is what the client HOLDS. It is only ever advanced in the
//      same step as the frame that carries the diff, and it is VOID the moment
//      any other whole-state frame may have reached the client: the tracker
//      stamps each baseline with the transport's "what the client holds" memo
//      (`token`) and answers `undefined` when the memo moved since. An
//      unknown baseline sends the cell's whole slice (`replace`), which is
//      correct whatever the client holds.
//   2. A baseline never changes under us. Committed state is frozen (Immer
//      autoFreeze is never disabled), so a frozen node is kept by reference
//      and equal references are equal content; everything else (the objects a
//      `forUser` builds) is COPIED into the baseline and frozen there.
//
// Values are compared as JSON sees them — the full frame is `JSON.stringify`,
// so a member that is `undefined`/a function/a symbol is absent, an array
// element of that kind is `null`, and a Date (any object with `toJSON` or a
// non-plain prototype) is the value it serializes to.
import type { WirePatch } from "../protocol/patch-ops.ts";
import { utf8Size } from "../protocol/utf8-size.ts";

/** The client holds no such cell (it was omitted from its view). */
const ABSENT: unique symbol = Symbol("absent");

type Path = (string | number)[];

/** A member JSON drops from an object (and writes as `null` in an array). */
const gone = (v: unknown): boolean =>
  v === undefined || typeof v === "function" || typeof v === "symbol";

/** A plain object or array — something the diff walks into. */
function isContainer(v: unknown): v is object {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v);
  return (proto === Object.prototype || proto === null) &&
    typeof (v as { toJSON?: unknown }).toJSON !== "function";
}

/** A non-container object as the wire carries it (Date → string, Map → {}). */
function asWire(v: unknown): unknown {
  if (v === null || typeof v !== "object" || isContainer(v)) return v;
  const s = JSON.stringify(v);
  return s === undefined ? undefined : JSON.parse(s);
}

/** An immutable copy of `v` for a baseline: frozen nodes by reference (they
 *  cannot change), everything else copied and frozen. */
function snap(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (!isContainer(v)) return snap(asWire(v));
  if (Object.isFrozen(v)) return v;
  if (Array.isArray(v)) return Object.freeze(v.map(snap));
  // `fromEntries` defines own properties — a `__proto__` key stays a key.
  return Object.freeze(
    Object.fromEntries(
      Object.keys(v).map((k) => [k, snap((v as Record<string, unknown>)[k])]),
    ),
  );
}

/** Ops turning `a` (a baseline node) into `b` (the new view) at `path`. */
function diff(a: unknown, b: unknown, path: Path, out: WirePatch[]): void {
  // Same reference: `a` is a baseline node, i.e. frozen, so `b` is too and
  // nothing under it changed.
  if (Object.is(a, b)) return;
  const bw = asWire(b);
  if (
    !isContainer(a) || !isContainer(bw) ||
    Array.isArray(a) !== Array.isArray(bw) ||
    // A `__proto__` key cannot be addressed by a path (every applier refuses
    // it), so its container is replaced whole.
    Object.hasOwn(a, "__proto__") || Object.hasOwn(bw, "__proto__")
  ) {
    if (!Object.is(a, bw)) out.push({ op: "replace", path, value: bw });
    return;
  }
  if (Array.isArray(a)) {
    diffArray(a, bw as unknown[], path, out);
    return;
  }
  const ao = a as Record<string, unknown>;
  const bo = bw as Record<string, unknown>;
  for (const k of Object.keys(ao)) {
    if (!gone(ao[k]) && (!Object.hasOwn(bo, k) || gone(bo[k]))) {
      out.push({ op: "remove", path: [...path, k] });
    }
  }
  for (const k of Object.keys(bo)) {
    const v = bo[k];
    if (gone(v)) continue;
    if (!Object.hasOwn(ao, k) || gone(ao[k])) {
      out.push({ op: "add", path: [...path, k], value: v });
    } else diff(ao[k], v, [...path, k], out);
  }
}

/** An array element as JSON writes it. */
const el = (v: unknown): unknown => (gone(v) ? null : v);

/** Common prefix and suffix (by reference) stay; the middle is diffed index
 *  by index, then the length difference is removed or added in place — so a
 *  filtered list that gained or lost one row costs one op plus the rows that
 *  really changed. */
function diffArray(a: unknown[], b: unknown[], path: Path, out: WirePatch[]) {
  const n = Math.min(a.length, b.length);
  let p = 0;
  while (p < n && Object.is(a[p], b[p])) p++;
  let s = 0;
  while (s < n - p && Object.is(a[a.length - 1 - s], b[b.length - 1 - s])) s++;
  const ma = a.length - p - s, mb = b.length - p - s, m = Math.min(ma, mb);
  for (let i = 0; i < m; i++) {
    diff(el(a[p + i]), el(b[p + i]), [...path, p + i], out);
  }
  for (let i = m; i < ma; i++) {
    out.push({ op: "remove", path: [...path, p + m] });
  }
  for (let i = m; i < mb; i++) {
    out.push({ op: "add", path: [...path, p + i], value: el(b[p + i]) });
  }
}

/** What one client holds of each `forUser` cell. A missing entry = unknown. */
type Known = Map<string, unknown>;

/** The ops that bring a client holding `known` to `view` for `cells` (the
 *  `forUser` cells changed this round that the client reads), and what it
 *  holds after them. Pure. Exported for the property test. */
export function viewOps(
  known: Known | undefined,
  view: Record<string, unknown>,
  cells: readonly string[],
): { ops: WirePatch[]; next: Known } {
  const ops: WirePatch[] = [];
  const next: Known = new Map(known);
  for (const c of cells) {
    const has = Object.hasOwn(view, c) && !gone(view[c]);
    const cur = has ? view[c] : undefined;
    if (!next.has(c)) {
      // Unknown: the whole slice. `remove` of a key the client lacks is a
      // no-op, so both are right whatever it holds.
      ops.push(
        has
          ? { op: "replace", path: [c], value: cur }
          : { op: "remove", path: [c] },
      );
    } else {
      const was = next.get(c);
      if (was === ABSENT) {
        if (has) ops.push({ op: "add", path: [c], value: cur });
      } else if (!has) ops.push({ op: "remove", path: [c] });
      else diff(was, cur, [c], ops);
    }
    next.set(c, has ? snap(cur) : ABSENT);
  }
  return { ops, next };
}

/** What a client holds of `cells` right after a whole-state frame built
 *  from `view`. A cell missing from it stays unknown (never assumed absent:
 *  how a client treats a cell a full frame omits is not this module's to
 *  decide). */
export function viewsOf(
  view: Record<string, unknown>,
  cells: Iterable<string>,
): Known {
  const known: Known = new Map();
  for (const c of cells) {
    if (Object.hasOwn(view, c) && !gone(view[c])) known.set(c, snap(view[c]));
  }
  return known;
}

/** Per-client baselines, each stamped with the transport's memo of what the
 *  client holds (`token`: WS `[lastFullJson, lastFullJsonStale]`, UDS
 *  `[queuedJson]`). Every whole-state send in either transport rewrites that
 *  memo, so a baseline read under a different token is void — whichever code
 *  path sent the frame, including ones that never heard of this tracker. */
export function createViewTracker() {
  const byClient = new WeakMap<
    object,
    { known: Known; token: readonly unknown[] }
  >();
  const same = (a: readonly unknown[], b: readonly unknown[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  return {
    get(client: object, token: readonly unknown[]): Known | undefined {
      const e = byClient.get(client);
      return e && same(e.token, token) ? e.known : undefined;
    },
    set(client: object, known: Known, token: readonly unknown[]): void {
      byClient.set(client, { known, token: [...token] });
    },
    /** Keep the baseline across a frame that did not touch any `forUser`
     *  cell, under the token that frame left — or drop it if already void. */
    carry(
      client: object,
      before: readonly unknown[],
      after: readonly unknown[],
    ): void {
      const e = byClient.get(client);
      if (!e) return;
      if (same(e.token, before)) e.token = [...after];
      else byClient.delete(client);
    },
  };
}

/** `am cost` for one round's `forUser` diffs. A round attributes what ONE
 *  client is sent (a raw patch is the same frame for all), but each client's
 *  diff is its own — so a cell/key is attributed the MEAN over the clients
 *  that were sent a diff this round, never one client picked as the sample.
 *  Sized as `attributeRound` sizes an op (its value's JSON); a whole-slice op
 *  (path `[cell]`) is key `"*"`, the meter's whole-slice resend. */
export function createViewTally() {
  const sums = new Map<string, Map<string, number>>();
  let clients = 0;
  return {
    /** One client's view ops, as sent. */
    add(ops: readonly WirePatch[]): void {
      if (ops.length === 0) return;
      clients++;
      for (const op of ops) {
        const cell = String(op.path[0]);
        const key = op.path.length > 1 ? String(op.path[1]) : "*";
        let bytes = 0;
        try {
          bytes = utf8Size(
            JSON.stringify((op as { value?: unknown }).value ?? null) ?? "",
          );
        } catch {
          // aio-ok: an unserializable value costs 0 bytes, as in attributeRound
        }
        const byKey = sums.get(cell) ?? new Map<string, number>();
        byKey.set(key, (byKey.get(key) ?? 0) + bytes);
        sums.set(cell, byKey);
      }
    },
    /** cell → key → mean bytes per client sent a diff; undefined if none. */
    mean(): Map<string, Map<string, number>> | undefined {
      if (clients === 0) return undefined;
      const out = new Map<string, Map<string, number>>();
      for (const [cell, byKey] of sums) {
        out.set(
          cell,
          new Map([...byKey].map(([k, b]) => [k, Math.round(b / clients)])),
        );
      }
      return out;
    },
  };
}

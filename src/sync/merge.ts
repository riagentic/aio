// src/sync/merge.ts — CRDT merge strategies
import type { HLC, MergeStrategy } from "./types.ts";
import { compareHLC } from "./hlc.ts";
import { mergeText3 } from "./merge-text.ts";

/**
 * Outcome of merging a single field: resolved value and whether a conflict occurred.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export interface MergeResult {
  value: unknown;
  conflict: boolean;
}

/**
 * Merge a field using the specified CRDT strategy, returning the resolved value.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export function mergeField(
  strategy: MergeStrategy,
  local: unknown,
  localHlc: HLC,
  remote: unknown,
  remoteHlc: HLC,
  base?: unknown,
  idField = "id",
): MergeResult {
  switch (strategy) {
    case "lww":
      return mergeLWW(local, localHlc, remote, remoteHlc);
    case "counter":
      return mergeCounter(local, remote, base);
    case "text":
      return mergeTextField(local, localHlc, remote, remoteHlc, base);
    case "lww-per-key":
      return mergeLWWPerKey(
        local as Record<string, unknown>,
        localHlc,
        remote as Record<string, unknown>,
        remoteHlc,
      );
    case "set-add":
      return mergeSetAdd(
        local as unknown[],
        localHlc,
        remote as unknown[],
        remoteHlc,
        idField,
      );
    case "set-remove":
      return mergeSetRemove(
        local as unknown[],
        localHlc,
        remote as unknown[],
        remoteHlc,
        base as unknown[],
        idField,
      );
  }
}

/** The one message shape for "this strategy cannot merge these values".
 *
 *  The set strategies already refuse a missing `id` with a sentence naming the
 *  fix; the null/type cases leaked internal locals instead — an app author's
 *  log read `safeRemote is not iterable`, which names nothing they wrote. Same
 *  standard for both. */
function refuse(
  strategy: MergeStrategy,
  wants: string,
  side: string,
  got: unknown,
): never {
  const shown = got === undefined
    ? "undefined"
    : got === null
    ? "null"
    : Array.isArray(got)
    ? "an array"
    : typeof got;
  throw new Error(
    `merge: the "${strategy}" strategy needs ${wants} on both sides, and the ` +
      `${side} value is ${shown}. Give the field a starting value of the right ` +
      `shape (a synced field that can be null needs merge: "lww"), or drop the ` +
      `strategy for this field.`,
  );
}

/** Both sides of a numeric strategy, or a refusal that names the side. */
function numeric(
  strategy: MergeStrategy,
  local: unknown,
  remote: unknown,
  base: unknown,
): [number, number, number] {
  const ok = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);
  if (!ok(local)) refuse(strategy, "a finite number", "local", local);
  if (!ok(remote)) refuse(strategy, "a finite number", "remote", remote);
  // No prior value (the field did not exist, or was null, before either side
  // wrote) is a fact, not a type error: the counter's base is 0 then — which
  // is what `base = 0` always meant. Only a base that IS a value of the wrong
  // shape is refused.
  if (base === undefined || base === null) return [local, remote, 0];
  if (!ok(base)) refuse(strategy, "a finite number", "base", base);
  return [local, remote, base];
}

/** A record on both sides, or a refusal that names the side. */
function records(
  strategy: MergeStrategy,
  local: unknown,
  remote: unknown,
): [Record<string, unknown>, Record<string, unknown>] {
  const ok = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!ok(local)) refuse(strategy, "an object", "local", local);
  if (!ok(remote)) refuse(strategy, "an object", "remote", remote);
  return [local, remote];
}

/** An array on both sides, or a refusal that names the side. `null`/`undefined`
 *  are treated as "empty" — a cleared list is an ordinary state, unlike a
 *  string or a number, which means the field's shape changed under the app. */
function arrays(
  strategy: MergeStrategy,
  ...vals: [string, unknown][]
): unknown[][] {
  return vals.map(([side, v]) => {
    if (v === null || v === undefined) return [];
    if (!Array.isArray(v)) refuse(strategy, "an array", side, v);
    return v;
  });
}

function mergeLWW(
  local: unknown,
  localHlc: HLC,
  remote: unknown,
  remoteHlc: HLC,
): MergeResult {
  if (
    local === remote ||
    stableJSONStringify(local) === stableJSONStringify(remote)
  ) {
    return { value: local, conflict: false };
  }
  const winner = compareHLC(localHlc, remoteHlc) >= 0 ? local : remote;
  return { value: winner, conflict: true };
}

/** `text` — a three-way merge against the agreed base.
 *
 *  Refuses non-strings the way every sibling strategy refuses its own wrong
 *  shape: a `text` merge on a number would stringify it and write the string
 *  back into cell state, which is exactly the silent coercion this framework
 *  does not do. The base may legitimately be absent (a field that did not
 *  exist when the peers diverged) — an empty base is the honest reading, and
 *  the diff3 then treats both sides as pure insertions.
 *
 *  `null`/`undefined` on either side means the field was cleared or never set,
 *  which is not a text edit at all — that is LWW's question, and it answers it
 *  correctly, so it is delegated rather than guessed at. */
function mergeTextField(
  local: unknown,
  localHlc: HLC,
  remote: unknown,
  remoteHlc: HLC,
  base: unknown,
): MergeResult {
  if (local == null || remote == null) {
    return mergeLWW(local, localHlc, remote, remoteHlc);
  }
  if (typeof local !== "string") refuse("text", "a string", "local", local);
  if (typeof remote !== "string") refuse("text", "a string", "remote", remote);
  if (base != null && typeof base !== "string") {
    refuse("text", "a string", "base", base);
  }
  return mergeText3(
    (base as string | undefined) ?? "",
    local,
    localHlc,
    remote,
    remoteHlc,
  );
}

function mergeCounter(
  localRaw: unknown,
  remoteRaw: unknown,
  baseRaw?: unknown,
): MergeResult {
  // Validated, because `base + (local - base) + (remote - base)` on anything
  // else is silent: a non-number gives NaN, and an object gives a STRING
  // (`"[object Object]NaNNaN"`) — written straight into cell state through
  // onStateUpdate, in a framework whose rule is that nothing is ever silently
  // coerced. Every sibling strategy refuses; this one now does too.
  const [local, remote, base] = numeric(
    "counter",
    localRaw,
    remoteRaw,
    baseRaw,
  );
  const localDelta = local - base;
  const remoteDelta = remote - base;
  return { value: base + localDelta + remoteDelta, conflict: false };
}

/** LWW-per-key: keys unique to one side are kept, shared keys use record-level HLC.
 *  NOTE: uses a single HLC per record, not per-key timestamps. */
function mergeLWWPerKey(
  local: Record<string, unknown>,
  localHlc: HLC,
  remote: Record<string, unknown>,
  remoteHlc: HLC,
): MergeResult {
  const [l, r] = records("lww-per-key", local, remote);
  local = l;
  remote = r;
  // SORTED, so both peers emit the same key order. Local-then-remote made the
  // merged record's key order depend on which side you were standing on —
  // semantically the same object, a different one on the wire and in any
  // byte-level convergence check.
  const allKeys = [
    ...new Set([...Object.keys(local), ...Object.keys(remote)]),
  ].sort();
  const merged: Record<string, unknown> = {};
  let conflict = false;

  for (const key of allKeys) {
    const inLocal = key in local;
    const inRemote = key in remote;
    if (inLocal && !inRemote) {
      merged[key] = local[key];
    } else if (!inLocal && inRemote) {
      merged[key] = remote[key];
    } else {
      const result = mergeLWW(local[key], localHlc, remote[key], remoteHlc);
      merged[key] = result.value;
      if (result.conflict) conflict = true;
    }
  }
  return { value: merged, conflict };
}

/** Stable JSON serialization that sorts object keys for deterministic output,
 *  ensuring equivalent objects produce identical strings regardless of key order.
 *
 *  The replacer sorts keys and nothing else: `JSON.stringify` already walks
 *  into arrays and applies it to every element. An explicit array branch used
 *  to recurse by hand and return an array of already-stringified STRINGS, so
 *  `[{a:1}]` serialized to `["{\"a\":1}"]` — not the JSON of the input, and not
 *  round-trippable. Comparisons still matched (both sides were mangled the same
 *  way), which is why it never showed; any use for hashing, storage or a log
 *  would have produced garbage. */
function stableJSONStringify(val: unknown): string {
  return JSON.stringify(val, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[key] = (value as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return value;
  });
}

/** Extract a stable id from a set item. Primitives use String() (callers must
 *  ensure uniqueness). Objects without the idField throw — silent collisions
 *  on "" would cause data loss in CRDT sets. */
function _getId(idField: string): (item: unknown) => string {
  return (item: unknown) => {
    if (item === null || item === undefined || typeof item !== "object") {
      return String(item);
    }
    const id = (item as Record<string, unknown>)[idField];
    if (id === undefined || id === null) {
      throw new Error(
        `merge: set item missing required id field "${idField}" (item: ${
          JSON.stringify(item).slice(0, 80)
        }). Add the field to every item, or set merge: { strategy: "set", idField: "<your-key>" }.`,
      );
    }
    return String(id);
  };
}

function mergeSetAdd(
  local: unknown[],
  localHlc: HLC,
  remote: unknown[],
  remoteHlc: HLC,
  idField: string,
): MergeResult {
  const [safeLocal = [], safeRemote = []] = arrays(
    "set-add",
    ["local", local],
    ["remote", remote],
  );
  const getId = _getId(idField);
  const merged = new Map<string, unknown>();
  let conflict = false;
  // LOSER first, then the winner's new ids — the one order BOTH peers compute.
  //
  // The loop used to run local-then-remote, which is a different order on each
  // side of the same merge: peer A ended with [x, y] and peer B with [y, x]
  // from the identical inputs. `docs/persistence/crdt.md` lists this strategy
  // as "Conflict-free: Yes" and only `text` carried a both-peers-agree
  // property test. `compareHLC` is TOTAL (it tie-breaks on the node id), so
  // "who is older" is a fact both peers agree on and can order by.
  const [first, second] = compareHLC(localHlc, remoteHlc) <= 0
    ? [safeLocal, safeRemote]
    : [safeRemote, safeLocal];
  for (const item of first) merged.set(getId(item), item);
  for (const item of second) {
    const id = getId(item);
    if (!merged.has(id)) {
      merged.set(id, item);
    } else {
      // Both sides added the same id — LWW on content divergence, and by
      // construction `second` IS the newer side, so it wins.
      const existing = merged.get(id);
      if (stableJSONStringify(existing) !== stableJSONStringify(item)) {
        conflict = true;
        merged.set(id, item);
      }
    }
  }
  return { value: [...merged.values()], conflict };
}

/** Did this side change the item, or merely carry it along unchanged? A remove
 *  that races an EDIT is a real disagreement; a remove that races "nothing
 *  happened" is not, and reporting the second would make the first invisible. */
function edited(base: unknown, side: unknown): boolean {
  return stableJSONStringify(base) !== stableJSONStringify(side);
}

function mergeSetRemove(
  local: unknown[],
  localHlc: HLC,
  remote: unknown[],
  remoteHlc: HLC,
  base: unknown[],
  idField: string,
): MergeResult {
  const [safeLocal = [], safeRemote = [], safeBase = []] = arrays(
    "set-remove",
    ["local", local],
    ["remote", remote],
    ["base", base],
  );
  const getId = _getId(idField);
  const baseIds = new Set(safeBase.map(getId));
  const localIds = new Set(safeLocal.map(getId));
  const remoteIds = new Set(safeRemote.map(getId));
  const localMap = new Map(safeLocal.map((i) => [getId(i), i]));
  const remoteMap = new Map(safeRemote.map((i) => [getId(i), i]));
  const baseMap = new Map(safeBase.map((i) => [getId(i), i]));

  const result: unknown[] = [];
  // Same canonical order as set-add, and for the same reason: iterating
  // local-then-remote is a different order on each peer, so the identical
  // inputs produced [x, z, y] on one side and [y, z, x] on the other.
  const allIds = compareHLC(localHlc, remoteHlc) <= 0
    ? new Set([...localIds, ...remoteIds])
    : new Set([...remoteIds, ...localIds]);
  let conflict = false;
  const remoteWins = compareHLC(remoteHlc, localHlc) > 0;

  for (const id of allIds) {
    const inBase = baseIds.has(id);
    const inLocal = localIds.has(id);
    const inRemote = remoteIds.has(id);

    // Remove-wins, SYMMETRICALLY: an item that was in base and is gone from
    // either side is gone. That is a deliberate set-merge rule, not an
    // oversight, and a 3-way ARRAY diff could not do better — "remote re-added
    // it" and "remote left it alone" produce the identical array, so telling
    // them apart needs per-item tombstones this structure does not carry.
    //
    // What it CAN tell apart is remove-vs-EDIT: if the side that kept the item
    // also changed it, the two sides made incompatible decisions about the same
    // item, and resolving that to "removed" without a word is the silent half.
    // The value still resolves the same way — the merge stays predictable —
    // but the conflict is now reported, so `onConflict` sees it.
    if (inBase && !inLocal) {
      if (inRemote && edited(baseMap.get(id), remoteMap.get(id))) {
        conflict = true;
      }
      continue; // locally removed
    }
    if (inBase && !inRemote) {
      if (inLocal && edited(baseMap.get(id), localMap.get(id))) {
        conflict = true;
      }
      continue; // remotely removed
    }

    // Both sides have same id — LWW on content divergence
    if (inLocal && inRemote) {
      const lv = localMap.get(id);
      const rv = remoteMap.get(id);
      if (stableJSONStringify(lv) !== stableJSONStringify(rv)) {
        conflict = true;
        result.push(remoteWins ? rv : lv);
        continue;
      }
    }

    result.push(localMap.get(id) ?? remoteMap.get(id));
  }
  return { value: result, conflict };
}

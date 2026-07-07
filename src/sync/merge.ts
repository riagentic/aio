// src/sync/merge.ts — CRDT merge strategies
import type { HLC, MergeStrategy } from "./types.ts";
import { compareHLC } from "./hlc.ts";

/**
 * Outcome of merging a single field: resolved value and whether a conflict occurred.
 * @experimental Excluded from the 1.0 stability guarantee.
 */
export interface MergeResult {
  value: unknown;
  conflict: boolean;
}

/**
 * Merge a field using the specified CRDT strategy, returning the resolved value.
 * @experimental Excluded from the 1.0 stability guarantee.
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
      return mergeCounter(local as number, remote as number, base as number);
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

function mergeCounter(
  local: number,
  remote: number,
  base = 0,
): MergeResult {
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
  const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);
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
 *  ensuring equivalent objects produce identical strings regardless of key order. */
function stableJSONStringify(val: unknown): string {
  return JSON.stringify(val, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[key] = (value as Record<string, unknown>)[key];
      }
      return sorted;
    }
    if (Array.isArray(value)) {
      return value.map((v) => stableJSONStringify(v));
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
        `merge: set item missing required id field "${idField}"`,
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
  const safeLocal = local ?? [];
  const safeRemote = remote ?? [];
  const getId = _getId(idField);
  const merged = new Map<string, unknown>();
  let conflict = false;
  for (const item of safeLocal) merged.set(getId(item), item);
  for (const item of safeRemote) {
    const id = getId(item);
    if (!merged.has(id)) {
      merged.set(id, item);
    } else {
      // Both sides added same id — LWW on content divergence
      const existing = merged.get(id);
      if (stableJSONStringify(existing) !== stableJSONStringify(item)) {
        conflict = true;
        // Remote wins if its HLC is newer
        if (compareHLC(remoteHlc, localHlc) > 0) merged.set(id, item);
      }
    }
  }
  return { value: [...merged.values()], conflict };
}

function mergeSetRemove(
  local: unknown[],
  localHlc: HLC,
  remote: unknown[],
  remoteHlc: HLC,
  base: unknown[],
  idField: string,
): MergeResult {
  const safeLocal = local ?? [];
  const safeRemote = remote ?? [];
  const safeBase = base ?? [];
  const getId = _getId(idField);
  const baseIds = new Set(safeBase.map(getId));
  const localIds = new Set(safeLocal.map(getId));
  const remoteIds = new Set(safeRemote.map(getId));
  const localMap = new Map(safeLocal.map((i) => [getId(i), i]));
  const remoteMap = new Map(safeRemote.map((i) => [getId(i), i]));

  const result: unknown[] = [];
  const allIds = new Set([...localIds, ...remoteIds]);
  let conflict = false;
  const remoteWins = compareHLC(remoteHlc, localHlc) > 0;

  for (const id of allIds) {
    const inBase = baseIds.has(id);
    const inLocal = localIds.has(id);
    const inRemote = remoteIds.has(id);

    if (inBase && !inLocal) continue; // locally removed
    if (inBase && !inRemote) continue; // remotely removed

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

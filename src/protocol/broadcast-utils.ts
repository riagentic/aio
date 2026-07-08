// Shared broadcast utilities — subscription filtering for WS (server.ts) and UDS (uds.ts)

/** Minimal client interface for subscription-aware filtering */
export type SubClient = { subscriptions: Set<string> | null };

/** Patch entry — cell name + Immer ops */
export type PatchEntry = { cell: string; ops: import("immer").Patch[] };

/** Filter a full state object by client subscriptions. Returns state as-is if subs is null. */
export function filterStateBySubs(
  state: unknown,
  subs: Set<string> | null,
): unknown {
  if (!subs) return state;
  const filtered: Record<string, unknown> = {};
  const src = state as Record<string, unknown>;
  for (const sub of subs) {
    const feat = sub.includes(".") ? sub.slice(0, sub.indexOf(".")) : sub;
    if (feat in src && !(feat in filtered)) filtered[feat] = src[feat];
  }
  return filtered;
}

/** Filter patch entries — keep only those matching at least one subscription path */
export function filterPatchesBySubs(
  patches: PatchEntry[],
  subs: Set<string> | null,
): PatchEntry[] {
  if (!subs) return patches;
  return patches.filter((p) => {
    for (const sub of subs) {
      if (sub === p.cell || sub.startsWith(p.cell + ".")) return true;
    }
    return false;
  });
}

/**
 * Parse a __subs: message payload into a subscriptions Set (or null for wildcard).
 * Returns undefined if the payload is invalid.
 */
export function parseSubs(raw: string): Set<string> | null | undefined {
  try {
    const paths = JSON.parse(raw);
    if (!Array.isArray(paths)) return undefined;
    if (paths.includes("*")) return null;
    return new Set(paths.filter((p: unknown) => typeof p === "string"));
  } catch {
    return undefined;
  }
}

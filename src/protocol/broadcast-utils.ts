// Shared broadcast utilities — subscription filtering for WS (server.ts) and UDS (uds.ts)

import { log } from "../diagnostics/logger-api.ts";

/** How many subscription paths one connection may declare, and how long each
 *  may be.
 *
 *  The `subs` frame is client-supplied and anonymous-reachable on a public app
 *  — and the parsed Set is held PER CONNECTION and looped over on EVERY
 *  broadcast (`filterPatchesBySubs`), so one frame of short strings (~165 000
 *  of them inside the 1 MB `WS_MAX_MESSAGE` ceiling) bought a permanent
 *  per-client Set plus a 165 000-iteration inner loop on the hottest path in
 *  the server. The `op` handler sitting directly below this one in
 *  `server-ws.ts` validates rigorously; this path had no bound at all.
 *
 *  1024 is deliberately far above honest use rather than close to it: the
 *  browser COLLAPSES paths by prefix before sending (`state-subs.ts`), so a
 *  real client sends a handful — and a refused frame leaves the connection on
 *  whatever it had (a fresh one: the wildcard), so the cost of being wrong
 *  high is bounded work, while the cost of being wrong low is an app that
 *  quietly stops updating. */
export const MAX_SUBS = 1024;
export const MAX_SUB_LEN = 256;

/** Minimal client interface for subscription-aware filtering */
export type SubClient = { subscriptions: Set<string> | null };

/** Patch entry — cell name + Immer ops */
export type PatchEntry = {
  cell: string;
  ops: import("./patch-ops.ts").WirePatch[];
};

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
 * Parse a "subs" frame payload (string[] — already decoded from the
 * envelope; a JSON string is still accepted for internal callers) into a
 * subscriptions Set (or null for wildcard). Undefined = invalid.
 */
export function parseSubs(raw: unknown): Set<string> | null | undefined {
  try {
    const paths = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(paths)) return undefined;
    // Refused whole, and out loud — never quietly truncated to the first 256:
    // a client that believes it is subscribed to something it is not gets a
    // UI that silently stops updating, which is worse than a rejected frame.
    if (paths.length > MAX_SUBS) {
      log.warn(
        "ws",
        `subs frame refused: ${paths.length} paths, the cap is ${MAX_SUBS}. ` +
          `The set is kept per connection and walked on every broadcast, so ` +
          `an unbounded list is a per-client memory and CPU cost. Fix: ` +
          `subscribe to cells or short paths ("todos", "todos.items"), or ` +
          `send ["*"] for everything.`,
      );
      return undefined;
    }
    if (paths.includes("*")) return null;
    const out = new Set<string>();
    for (const p of paths) {
      if (typeof p !== "string") continue;
      if (p.length > MAX_SUB_LEN) {
        log.warn(
          "ws",
          `subs frame refused: a path of ${p.length} characters, the cap is ` +
            `${MAX_SUB_LEN}. Fix: subscriptions are cell names and dotted ` +
            `state paths, not payloads.`,
        );
        return undefined;
      }
      out.add(p);
    }
    return out;
  } catch {
    return undefined;
  }
}

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
 *  BOTH transports ask here. The UDS router used to parse the frame inline —
 *  `new Set(paths.filter(isString))`, no cap on the count and none on the
 *  length — behind a frame ceiling ten times the WS one, so the whole bound
 *  existed on one of the two paths that need it.
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
export function parseSubs(
  raw: unknown,
  where: "ws" | "uds" = "ws",
): Set<string> | null | undefined {
  try {
    const paths = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(paths)) return undefined;
    // Refused whole, and out loud — never quietly truncated to the first 256:
    // a client that believes it is subscribed to something it is not gets a
    // UI that silently stops updating, which is worse than a rejected frame.
    if (paths.length > MAX_SUBS) {
      log.warn(
        where,
        `subs frame refused: ${paths.length} paths, the cap is ${MAX_SUBS}. ` +
          `The set is kept per connection and walked on every broadcast, so ` +
          `an unbounded list is a per-client memory and CPU cost. Fix: ` +
          `subscribe to cells or short paths ("todos", "todos.items"), or ` +
          `send ["*"] for everything.`,
      );
      return undefined;
    }
    if (paths.includes("*")) return null;
    // "Subscribe to NOTHING" is never what anyone means, and it is the
    // quietest possible way to break an app: an empty set makes
    // `filterPatchesBySubs` return nothing for every cell, so the client
    // receives no delta for the life of the connection while `connected` stays
    // true and no error appears anywhere. `docs/ui/reactivity-tracking.md`
    // names this exact shape at the component level — "There is no symptom. A
    // component that subscribes to nothing renders correctly, once" — and the
    // wire had the same hole one layer down, reachable from `{"subs":[]}`.
    //
    // Refused WHOLE, like the two caps below it and for the reason stated
    // there: a client that believes it is subscribed to something it is not
    // gets a UI that silently stops updating, which is worse than a rejected
    // frame. `undefined` means "no change", so the connection keeps whatever
    // it had (initially: everything) instead of going dark.
    if (paths.length === 0) {
      log.warn(
        where,
        `subs frame refused: an EMPTY subscription list means "send me ` +
          `nothing", which stops every delta for this client with no other ` +
          `symptom. Send ["*"] for everything, or the cells you need.`,
      );
      return undefined;
    }
    const out = new Set<string>();
    for (const p of paths) {
      // A non-string entry used to be skipped in silence, so `["todos", 7]`
      // subscribed to one cell and `[7]` subscribed to nothing at all — the
      // dead-client case above, arrived at without an empty array. Refused
      // whole, like every other malformed shape here.
      if (typeof p !== "string") {
        log.warn(
          where,
          `subs frame refused: a path that is not a string (${typeof p}). ` +
            `Subscriptions are cell names and dotted state paths.`,
        );
        return undefined;
      }
      if (p.length > MAX_SUB_LEN) {
        log.warn(
          where,
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

// storage-prefix.ts — the offline queue's localStorage namespace, and the
// scan for queues nothing will ever send. Engine-free and tiny: the eager
// browser bundle reaches it (browser-protocol.ts) without loading the engine.

/** The unscoped namespace every build before app-scoping wrote under, and the
 *  fallback for a client that was never told which app it is. */
export const SYNC_STORAGE_PREFIX = "__aio_sync";

/** The localStorage namespace for ONE app's offline queue.
 *
 *  `localStorage` is per ORIGIN, and an app id is not part of an origin: two
 *  aio apps served from the same host:port (a pinned port, a shared host, or
 *  simply one app replacing another on the dev port) shared the queue of every
 *  cell whose NAME they had in common — app B's first `requestSync` flushed
 *  app A's unsent ops into B's server, as B's user, silently. The app id is
 *  the only thing that separates them, so it is part of the key. */
export function syncStoragePrefix(appId?: string | null): string {
  if (!appId) return SYNC_STORAGE_PREFIX;
  // The key format is `<prefix>:<cell>`; an id carrying the separator (or
  // anything else exotic) must not be able to reshape a key into another
  // app's. Slugified server-side already — this is the belt.
  return `${SYNC_STORAGE_PREFIX}.${appId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** The cells whose offline queue under `prefix` holds unsent ops while the
 *  cell is not in `syncing` — a cell that stopped syncing (its `sync` option
 *  dropped, the cell removed) leaves its queue behind, and no engine will ever
 *  send it. Read-only; an unreadable document is not counted. */
export function orphanSyncQueues(
  prefix: string,
  syncing: ReadonlySet<string>,
): { cell: string; unsent: number }[] {
  const out: { cell: string; unsent: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(`${prefix}:`)) continue;
      const cell = k.slice(prefix.length + 1);
      // `clientId` is the sync identity; `.corrupt` keys are forensic copies.
      if (cell === "clientId" || cell.includes(".corrupt")) continue;
      if (syncing.has(cell)) continue;
      let ops: unknown;
      try {
        ops = (JSON.parse(localStorage.getItem(k) ?? "null") as
          | { ops?: unknown }
          | null)?.ops;
      } catch {
        continue; // aio-ok: unreadable — the engine's own repair reports it
      }
      const unsent = Array.isArray(ops)
        ? ops.filter((o) => !(o as { confirmed?: unknown })?.confirmed).length
        : 0;
      if (unsent > 0) out.push({ cell, unsent });
    }
  } catch {
    // aio-ok: storage unavailable (private mode) — there is no queue.
  }
  return out;
}

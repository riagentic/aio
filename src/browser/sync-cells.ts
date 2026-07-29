// Which cells sync — ONE answer, for every client-side caller.
//
// There are two: the transport gate that decides whether to load the CRDT
// engine at all (`browser-protocol.ts`, eager, must stay engine-free) and the
// engine boot itself (`browser-sync.ts`, lazy). They used to answer the
// question separately — both by testing `__aio.syncConfig` — which was fine
// while a cell's own `sync: true` was the only source of truth.
//
// `localFirst` added a second source: the SERVER decides at compose time and
// tells the browser in the page shell. The gate kept answering from the cell
// definitions alone, so an adopted cell never reached the engine — a switch
// that logged "3 cells run locally" on the server while every method quietly
// kept round-tripping. One function now, so a third source of truth cannot
// split them again.

import type { CellDef } from "../state/cell-types.ts";
import type { AioWindow } from "../protocol/protocol-types.ts";

/** Cell ids the server adopted into local-first (`aio.run({localFirst:true})`).
 *  Empty unless the page shell says otherwise. */
function serverAdopted(): Set<string> {
  const cfg = (globalThis as unknown as AioWindow).__aioConfig;
  return new Set(cfg?.syncCells ?? []);
}

/** The cells that route through the CRDT engine, in registration order.
 *
 *  Adoption is applied here (idempotently) so a cell can never end up with a
 *  `syncConfig` and no replay reducer — `enableSync` sets both or neither.
 *  `onSkip` reports a cell the server adopted that cannot run locally. */
export function resolveSyncCells(
  defs: Iterable<CellDef>,
  onSkip?: (id: string) => void,
): Map<string, CellDef> {
  const adopted = serverAdopted();
  const out = new Map<string, CellDef>();
  for (const def of defs) {
    // Every key is reached through `def` directly, never an alias: the
    // cell-binding parity gate greps for exactly that shape to prove the
    // browser stub produces every key client code reads.
    // A client-scoped cell never leaves the tab — there is nothing to converge.
    if (def.__aio.scope === "client") continue;
    if (def.__aio.syncConfig) {
      out.set(def.__aio.id, def);
      continue;
    }
    if (!adopted.has(def.__aio.id) || def.__aio.syncOptOut) continue;
    if (!def.__aio.enableSync) {
      onSkip?.(def.__aio.id);
      continue;
    }
    def.__aio.enableSync(true);
    out.set(def.__aio.id, def);
  }
  return out;
}

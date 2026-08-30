// cell-defaults.ts — app-level defaults applied to a composed cell set.
//
// `cellDefaults` fills in what a cell left undecided (visibility, persist);
// `localFirst` adopts sync for every cell that can take it. Both change what a
// cell HIDES and whether it SYNCS, so the boot refusals that judge those
// (refuseUnsafeComposition) are only decidable after they have run. They live
// here, in the isomorphic core, because every runtime that composes cells has
// to apply them the same way: the server boot (aio-composition.ts), the
// standalone runtime (Android, and the in-process test harnesses). A harness
// that skipped them was strictly MORE permissive than production — an app whose
// contradiction only arose from its app-level defaults booted green under
// `testUI` and was refused the moment it really started.
import type { ComposedCells } from "./cell.ts";
import type { CellFieldFilter, CellVisibility } from "./cell-types.ts";
import {
  extractForUser,
  extractPublicFields,
  normalizeUiFilter,
  resolveVisibility,
} from "./cell-helpers.ts";
import { normalizeSyncConfig } from "../sync/types.ts";
import { persistFilterOnSyncCellMessage } from "./cell-create.ts";
import { log } from "../diagnostics/logger-api.ts";
import { count } from "../diagnostics/fmt.ts";

/** App-wide defaults for what a cell left undecided. `visible` (alpha52)
 *  takes full CellVisibility — forUser/publicFields are settable as app-wide
 *  defaults. (`ui`, its pre-alpha52 spelling, went out in alpha70 — see
 *  src/state/removals.ts.) */
export type CellDefaults = {
  visible?: CellVisibility;
  persist?: CellFieldFilter;
};

/** Apply cellDefaults to cells missing explicit persist/visible config.
 *  `visible` (alpha52) carries the FULL CellVisibility vocabulary, so each of
 *  its three parts — structural filter, forUser, publicFields — fills in
 *  independently wherever the cell itself left that part undecided. Per-part
 *  (not all-or-nothing) is the pre-alpha52 behavior preserved: a cell with
 *  only `forUser` always picked up a structural default. */
export function applyCellDefaults(
  composed: ComposedCells,
  cellDefaults?: CellDefaults,
): void {
  if (!cellDefaults) return;
  // Same decider as the per-cell config: both spellings set throws; the
  // removed `ui` spelling is refused (dev) / logged and honoured (prod) by
  // the registry, under its own `cellDefaults.ui` row.
  const vis = resolveVisibility("cellDefaults", cellDefaults);
  const struct = normalizeUiFilter(vis);
  const forUser = extractForUser(vis);
  const publicFields = extractPublicFields(vis);
  for (const f of composed.cells) {
    if (!f.__aio.persist && cellDefaults.persist) {
      f.__aio.persist = cellDefaults.persist;
    }
    if (!f.__aio.ui && struct) f.__aio.ui = struct;
    if (!f.__aio.uiForUser && forUser) f.__aio.uiForUser = forUser;
    if (!f.__aio.uiPublicFields?.length && publicFields?.length) {
      f.__aio.uiPublicFields = publicFields;
    }
  }
}

/** How a cell's RESOLVED `ui` hides state from clients — `null` when it hides
 *  nothing. The string is the reason, phrased for an error message.
 *
 *  Read `f.__aio.ui` AFTER applyCellDefaults: a `cellDefaults.ui` hides exactly
 *  as much as a per-cell one, so it must count the same. */
function uiHidesState(f: ComposedCells["cells"][number]): string | null {
  if (f.__aio.uiForUser) return "visible.forUser — a per-user view";
  const ui = f.__aio.ui;
  if (ui === "none") return 'visible: "none"';
  if (ui && typeof ui === "object") {
    if ("include" in ui) {
      return `visible.include(${
        ui.include.join(", ")
      }) — every other field is hidden`;
    }
    if ("exclude" in ui) return `visible.exclude(${ui.exclude.join(", ")})`;
  }
  return null;
}

/** A cell cannot be BOTH per-client-filtered and CRDT-replicated. Refuse.
 *
 *  CRDT sync replicates a cell to every peer: op frames carry the payload
 *  verbatim to all other sockets (server-handler.ts), and a catch-up snapshot
 *  ships the cell's state. Convergence REQUIRES that — replicas that saw
 *  different ops do not converge, and the ops themselves are opaque
 *  `{cell, action, payload}` records with no user dimension to filter on. A
 *  `ui` filter is a statement about what a client may SEE; there is no coherent
 *  way to honour it on a channel whose contract is "everyone gets everything".
 *
 *  So we do not "filter the sync path" — that would be a clever fix that
 *  silently breaks convergence instead of silently leaking. We make the
 *  combination impossible, at compose time, naming the cell.
 *
 *  Throws in prod as well as dev. This is not a heuristic like the
 *  secret-field-name warning above: the leak is certain and total (every
 *  connected client receives the filtered-out data), so degrading to a log
 *  would be a silent privacy failure — exactly what the framework refuses.
 *  Implicit adoption (`localFirst: true`) never reaches here: applyLocalFirst
 *  declines to adopt a filtered cell and says so. */
export function refuseFilteredSyncCells(composed: ComposedCells): void {
  for (const f of composed.cells) {
    if (!f.__aio.syncConfig) continue;
    // The persist twin: `cell()` already refuses the cell's OWN persist filter
    // on a sync cell; a `cellDefaults.persist` filter lands after that check
    // and would reach the same place (the op-log cannot honour it). Same rule,
    // same wording, one more source named.
    if (f.__aio.persist && f.__aio.persist !== "all") {
      throw new Error(
        persistFilterOnSyncCellMessage(
          f.__aio.id,
          f.__aio.persist,
          "cellDefaults.persist",
        ),
      );
    }
    const why = uiHidesState(f);
    if (!why) continue;
    throw new Error(
      `[aio] SECURITY — refusing to start. Cell "${f.__aio.id}" is sync: true ` +
        `AND hides state from clients (${why}).\n` +
        `  CRDT sync replicates the cell to EVERY client — ops are broadcast ` +
        `verbatim to all peers and catch-up snapshots carry the cell's state — ` +
        `so a visible filter on it cannot hold: the hidden data would reach every ` +
        `connected client anyway.\n` +
        `  Pick one:\n` +
        `    • drop sync from "${f.__aio.id}" (server-authoritative, filter enforced), or\n` +
        `    • drop the visible filter (fully replicated, and public to every client), or\n` +
        `    • move the private fields into their own non-sync cell.`,
    );
  }
}

/** `localFirst: true` — every SERVER cell syncs unless it said otherwise, which
 *  is what moves method execution to the caller (perfect-aio D3,
 *  docs/specs/2026-07-22-local-first.md). Per-cell resolution:
 *
 *    cell.sync = anything   → the cell decided; never touched here
 *    cell.sync = false      → explicit opt-out; keeps round-tripping
 *    (absent)               → adopted into local-first
 *
 *  Client-scoped cells never reach this function (they are filtered out of the
 *  server entries above) and have nothing to sync anyway.
 *
 *  Adoption is LOGGED per cell, not assumed: a flag that silently changes where
 *  every method in the app runs is exactly the kind of quiet, load-bearing
 *  decision this framework refuses to make invisibly. */
export function applyLocalFirst(
  composed: ComposedCells,
  enabled: boolean,
): void {
  if (!enabled) return;
  const adopted: string[] = [];
  const kept: string[] = [];
  const unable: string[] = [];
  const filtered: string[] = [];
  for (const f of composed.cells) {
    if (f.__aio.syncConfig) continue; // the cell already asked for sync
    if (f.__aio.syncOptOut) {
      kept.push(f.__aio.id);
      continue;
    }
    // A cell whose `ui` hides anything from clients must NOT be adopted:
    // replicating it would ship the hidden data to every peer (see
    // refuseFilteredSyncCells). One app-level flag must never quietly convert
    // a filtered cell into a fully-replicated one — that is the whole bug
    // class. Explicit `sync: true` on such a cell throws; implicit adoption
    // declines and SAYS SO, so the author sees which cells stayed
    // server-authoritative and why.
    const why = uiHidesState(f);
    if (why) {
      filtered.push(`${f.__aio.id} (${why})`);
      continue;
    }
    // Same for a persist filter: the op-log cannot honour one (see
    // refuseFilteredSyncCells), so adoption declines and says so rather than
    // converting a filtered cell into one whose filter is silently void.
    if (f.__aio.persist && f.__aio.persist !== "all") {
      filtered.push(`${f.__aio.id} (a persist filter)`);
      continue;
    }
    // Only methods-style cells replay as CRDT ops (the browser stub builds
    // its rebase reducer from the sync methods — `asyncMethods` marks that
    // factory). Adopting an actions-style cell would EXCLUDE it from KV
    // persistence while the client warns and keeps round-tripping: all cost,
    // no local-first, and its post-flip writes would not survive a restart.
    if (!f.__aio.asyncMethods) {
      unable.push(f.__aio.id);
      continue;
    }
    f.__aio.syncConfig = normalizeSyncConfig(true);
    adopted.push(f.__aio.id);
  }
  log.info(
    `localFirst: ${count(adopted.length, "cell")} run locally and sync — ` +
      `${adopted.join(", ") || "none"}` +
      (kept.length ? `; server-only by opt-out: ${kept.join(", ")}` : "") +
      (unable.length
        ? `; server-only (actions-style cells cannot replay locally): ${
          unable.join(", ")
        }`
        : "") +
      (filtered.length
        ? `; server-only (a visible/persist filter cannot survive CRDT replication): ${
          filtered.join(", ")
        }`
        : ""),
  );
}

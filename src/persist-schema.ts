// persist-schema.ts — persistence schema versioning (roadmap A4).
//
// Every KV snapshot is stamped with the framework's persistence-schema
// version (`<appId>:__schema`, written by the persistence manager after each
// successful state write — never before, so a stamp can't outrun its state).
// On boot, stored state from an older schema is migrated through the steps
// below; state from a NEWER schema (downgrade) fails loudly instead of being
// misread. Alpha-era snapshots predate the stamp and read as version 0.
//
// Distinct from per-cell `version`/`onMigrate` (user data shape): this covers
// the framework's own storage layout (key structure, envelope format).

import { createAioError } from "./error.ts";

/** Current persistence-schema version. Bump when the storage layout changes
 *  and add a migration step below. */
export const PERSIST_SCHEMA_VERSION = 1;

/** One framework-level migration step: state stored at version N → N+1. */
export type SchemaMigration = (
  state: Record<string, unknown>,
) => Record<string, unknown>;

/** Migration steps keyed by the version they migrate FROM. Every version in
 *  [0, PERSIST_SCHEMA_VERSION) must have a step — the gate test enforces it. */
export const SCHEMA_MIGRATIONS: Record<number, SchemaMigration> = {
  // 0 → 1: alpha-era snapshots predate the stamp; the layout is unchanged,
  // so this is an identity step — the point is that they get stamped.
  0: (state) => state,
};

/**
 * Migrate a loaded snapshot from `from` to the current schema version.
 * Returns the migrated state and the steps applied. Throws `AioError`
 * (`PERSIST_SCHEMA`) on a downgrade or a missing migration step.
 */
export function migrateSchema(
  state: Record<string, unknown>,
  from: number,
  to: number = PERSIST_SCHEMA_VERSION,
): { state: Record<string, unknown>; applied: number[] } {
  if (from > to) {
    throw createAioError(
      "PERSIST_SCHEMA",
      new Error(
        `stored state uses persistence schema v${from}, but this build only knows v${to} — ` +
          `it was written by a NEWER aio. Upgrade the framework, or restore state from a backup.`,
      ),
      {},
    );
  }
  const applied: number[] = [];
  let current = state;
  for (let v = from; v < to; v++) {
    const step = SCHEMA_MIGRATIONS[v];
    if (!step) {
      throw createAioError(
        "PERSIST_SCHEMA",
        new Error(
          `no migration step from persistence schema v${v} → v${v + 1} — ` +
            `stored state cannot be upgraded. Export your data or clear the KV store.`,
        ),
        {},
      );
    }
    current = step(current);
    applied.push(v);
  }
  return { state: current, applied };
}

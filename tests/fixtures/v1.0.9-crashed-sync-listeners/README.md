# v1.0.9-crashed-sync-listeners

A data directory **v1.0.9-beta wrote and then crashed on** (SIGKILL): the
upgrade guard for `tests/journal-upgrade-compat.test.ts`. v1.0.9 journalled no
`listensTo` reaction lines, and it crashed before the store ever saved, so no
record holds a reaction to a sync op. `../v1.0.9-crashed-streaming` covers the
case where a save does.

What every upgrade boot over v1.0.9 data does (the contract these fixtures pin):
each cell's own ops fold into its own cell, as v1.0.9 did; **no** `listensTo`
reaction is re-derived, so nothing is counted twice; and every listener that may
lack reactions is named in one warning, ending "nothing was re-applied, so
nothing is counted twice; 1.0.9 may have saved these reactions or lost them —
check "<cell>"". The second boot is stamped, recovers the same state and names
nothing again.

- `app.js` — the app, as it ran. `MOD` names the aio `mod.ts` to import.
- `data/` — `state.db`, `journal`, `journal.base`, `meta.json` as v1.0.9 left
  them at the kill.
- `expected.json` — the live state at the kill.
- `v1.0.9-recovered.json` — what v1.0.9 recovers from `data/`, on its first boot
  and its second. It loses every reaction on the sync listener `mirror`.
- `upgrade-recovered.json` — what this build recovers, twice: every cell's own
  writes, `feed` whole (its posts' journal lines replay as calls), and `tally`,
  `shaped` and `mirror` without their reactions to `notes` (0 of 10, 0 of 10, 5
  of 15) — each named, nothing above the live state.

## How it was made (2026-09-23)

1. Check out the `v1.0.9-beta` tag somewhere (`<head>`).
2. Run `app.js` with `PHASE=before-fold`, `DIR=<dir>`, `AIO_APPS_DIR=<dir>`, a
   free `PORT`, and `MOD=file://<head>/mod.ts`, under
   `deno run -A --config <head>/deno.json`. It kills itself after its last acked
   write.
3. Copy `app.js`, `expected.json`, and
   `data/{journal,journal.base,meta.json,state.db,state.db-wal}` here. Fold the
   WAL into the database file so only committed pages are kept:
   `PRAGMA wal_checkpoint(TRUNCATE); VACUUM;` (node:sqlite), which removes
   `state.db-wal`.
4. Boot a copy twice with `<head>` and `PHASE=read`; each boot writes
   `recovered.json`. Both must match; that output is `v1.0.9-recovered.json`.

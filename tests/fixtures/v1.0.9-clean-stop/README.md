# v1.0.9-clean-stop

A data directory **v1.0.9-beta wrote and then stopped cleanly** (SIGTERM): the
store saved, the journal compacted to nothing, and the op-log still holds every
sync op. There is no crashed tail, so nothing in the journal says an older build
ran here. It is the guard for `tests/journal-upgrade-compat.test.ts`:

- The older build is recognised by the **missing stamp** on the op-log (a
  `sync_meta` row named `__aio_reactions_fmt`, written by every newer boot once
  it is settled), not by the journal.
- The sync listener `mirror` holds its reactions to `notes` in no record (v1.0.9
  re-derived them at each boot and never folded them), so it comes back with its
  own ops only, 5 of 15 — named. `feed` comes back 3 of 8, named.
- `tally` and `shaped` come back 10 of 10: the clean stop saved them. None of
  their reactions is applied again; they are named all the same, because nothing
  in the data proves which reactions a save holds.

What every upgrade boot over v1.0.9 data does (the contract these fixtures pin):
each cell's own ops fold into its own cell, as v1.0.9 did; **no** `listensTo`
reaction is re-derived, so nothing is counted twice; and every listener that may
lack reactions is named in one warning, ending "nothing was re-applied, so
nothing is counted twice; 1.0.9 may have saved these reactions or lost them —
check "<cell>"". The second boot is stamped, recovers the same state and names
nothing again.

`app.js` is the hunt probe's app, `PHASE=before-fold` with `CLEAN=1`.
`expected.json` is the live state at the stop. `v1.0.9-recovered.json` is what
v1.0.9 itself recovers: `tally` 20 of 10 (each op folded through the saved slice
again) and `mirror` 5 of 15. `upgrade-recovered.json` is what this build
recovers, twice.

## How it was made (2026-09-23)

The steps are those of `../v1.0.9-crashed-sync-listeners/README.md`, with
`PHASE=before-fold` and `CLEAN=1` (the app stops itself with SIGTERM after its
last acked write). A clean stop leaves no WAL to fold.

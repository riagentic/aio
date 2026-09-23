# v1.0.9-crashed-streaming

A data directory **v1.0.9-beta wrote and then crashed on** (SIGKILL) in the
middle of a stream of writes. The store had saved (`__journal_wm` 10) and the
op-log still held every sync op, so each op's `listensTo` reaction on a
store-persisted listener is in the saved slice for the ops before the save, and
nowhere for the ones after it. The guard for
`tests/journal-upgrade-compat.test.ts`. (`../v1.0.9-crashed-sync-listeners`
crashed before the store ever saved, which hides this case.)

- `app.js` is the same app as that fixture's, `PHASE=streaming`.
- `data/` holds `state.db`, `journal`, `journal.base` and `meta.json` as v1.0.9
  left them at the kill.
- `expected.json` is the live state at the kill.
- `v1.0.9-recovered.json` is what v1.0.9 itself recovers, on its first boot and
  on its second. It is wrong, and kept as the record of what it did: a tally of
  24 comes back 45, because every op is folded through the whole root again,
  including the ones already in the saved slice. The sync listener `mirror`
  loses every reaction to `notes`, and `feed` loses its reactions to the `inbox`
  posts that were saved.

A newer build must never count a reaction twice, and nothing in the data proves
which reactions a record holds. So it re-derives none: `tally` and `shaped` come
back 21 of 24 (the save), `mirror` 12 of 36 (its own ops), `feed` 11 of 24 —
each listener named.

What every upgrade boot over v1.0.9 data does (the contract these fixtures pin):
each cell's own ops fold into its own cell, as v1.0.9 did; **no** `listensTo`
reaction is re-derived, so nothing is counted twice; and every listener that may
lack reactions is named in one warning, ending "nothing was re-applied, so
nothing is counted twice; 1.0.9 may have saved these reactions or lost them —
check "<cell>"". The second boot is stamped, recovers the same state and names
nothing again.

## How it was made (2026-09-23)

The steps are those of `../v1.0.9-crashed-sync-listeners/README.md`, with
`PHASE=streaming`.

`upgrade-recovered.json` is what this build recovers, twice. The test pins it,
and pins that it is sound against `expected.json`.

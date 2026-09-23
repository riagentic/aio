# v1.0.9-crashed-sync-only-save

A data directory **v1.0.9-beta wrote and then crashed on** (SIGKILL), after its
store had saved while the journal held no line yet. Every write before that save
was a sync op, so 1.0.9 saved the state (`tally` 7) **without** the app-wide
`__journal_wm` key. A reader that took "no watermark" to mean "never saved"
re-applied every op's reaction on top of the saved slice: 7 came back 14, and
did so again on every boot. The guard for
`tests/journal-upgrade-compat.test.ts`.

- `app.js` is the same app as `../v1.0.9-crashed-sync-listeners`. The data was
  written by the hunt probe's `burst` phase (`BURST=5`, a post 300 ms after the
  burst, then the kill).
- `data/` holds `state.db`, `journal`, `journal.base` and `meta.json` as v1.0.9
  left them. The WAL was folded in (see that fixture's README).
- `expected.json` is the live state at the kill.
- `v1.0.9-recovered.json` is what v1.0.9 itself recovers, twice: `tally` 14.
- `upgrade-recovered.json` is what this build recovers, twice: `tally` 7 (the
  save; no reaction applied again), `mirror` 1 of 8 (its own op) — each listener
  named.

What every upgrade boot over v1.0.9 data does (the contract these fixtures pin):
each cell's own ops fold into its own cell, as v1.0.9 did; **no** `listensTo`
reaction is re-derived, so nothing is counted twice; and every listener that may
lack reactions is named in one warning, ending "nothing was re-applied, so
nothing is counted twice; 1.0.9 may have saved these reactions or lost them —
check "<cell>"". The second boot is stamped, recovers the same state and names
nothing again.

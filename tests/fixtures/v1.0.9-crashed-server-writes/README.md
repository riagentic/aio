# v1.0.9-crashed-server-writes

A data directory **v1.0.9-beta wrote and then crashed on** (SIGKILL) while
server-side calls to its sync cells (`notes:add`, `mirror:onAdd`, called through
the trojan) were interleaved with client ops and store-persisted posts. v1.0.9
journalled those calls as plain call lines, kept by each sync cell's own
watermark. It is the guard for `tests/journal-upgrade-compat.test.ts`:

- A second boot after the upgrade must not reduce those old calls again. The
  upgrade boot already recorded what they did, as stamped state lines before its
  marker.
- No reaction is re-derived: `tally` and `shaped` come back 16 of 18 (the
  store's save), `mirror` 18 of 30 (its own ops and the server calls' state
  lines), `feed` 7 of 12. Every one of them is named.

What every upgrade boot over v1.0.9 data does (the contract these fixtures pin):
each cell's own ops fold into its own cell, as v1.0.9 did; **no** `listensTo`
reaction is re-derived, so nothing is counted twice; and every listener that may
lack reactions is named in one warning, ending "nothing was re-applied, so
nothing is counted twice; 1.0.9 may have saved these reactions or lost them —
check "<cell>"". The second boot is stamped, recovers the same state and names
nothing again.

`app.js` is the hunt probe's app (phase `mixed`), and `data/` is as v1.0.9 left
it, with the WAL folded in. `expected.json` is the live state at the kill,
`v1.0.9-recovered.json` is what v1.0.9 itself recovers (`tally` 28 of 18), and
`upgrade-recovered.json` is what this build recovers, twice (`tally` 16 of 18,
named).

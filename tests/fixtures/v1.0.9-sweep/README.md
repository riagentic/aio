# v1.0.9-sweep

The app `tests/journal-upgrade-sweep.test.ts` runs on **real v1.0.9-beta**
(exported from the `v1.0.9-beta` tag) and kills at a random point, before this
build boots the directory it left. It is the hunt probe's app, with every
workload the upgrade was reviewed against:

- `PHASE`: `rejdrift` (every `DUPEVERY`-th op of a burst is refused, so its
  issued `server_ts` has no row), `stalebase` (`BLOCKBASE=1` makes the
  compaction base's write fail, so the base is stale), `mixed`, `streaming`,
  `after-fold`, `fold-lags-persist`, `synconly`, `drift` (a burst of sync ops
  whose `server_ts` runs ahead of the clock, with store-persisted posts
  streaming beside it) and `before-fold`.
- Knobs: `PDM` (persist debounce), `KILLAT` (ms before the kill), `GAP`, `PGAP`,
  `BURST`, `K`, `OGAP`.
- `PHASE=read` writes the recovered state to `recovered.json` and exits.

No data is kept here. Each run makes its own, and the fixtures beside this one
pin five such directories.

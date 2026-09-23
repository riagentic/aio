# crash-sweep

The app `tests/journal-crash-sweep.test.ts` runs on **this build** and kills at
a random moment (`KILLMS`), before booting the directory it left twice. Its
first recovery boot is sometimes killed too. It is the re-verify round's sweep
app. Its topology is sync and store-persisted listeners of sync cells, listeners
of listeners, and store-persisted posts with a sync listener.

- `SEED` drives the workload: client ops, bursts through `sync-req` (with
  `DUPS=1`, duplicate adds the reducer refuses), and server calls through the
  trojan.
- Knobs: `PDM` (persist debounce), `GAP`, `BURST`, `MULTI=1` (multi-key store),
  and `JUMPAT`/`JUMPMS` (the wall clock steps back mid-run).
- `PHASE=read` writes the recovered state to `recovered.json` and exits.

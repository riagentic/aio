# v1.0.11-crashed-none-listener

A data directory **v1.0.11-beta wrote and then crashed on** (SIGKILL inside the
persist debounce): the guard for
`tests/persist-none-scrub-journal-old-listener.test.ts`. v1.0.11 journalled a
`persist: "none"` cell's calls with their ARGUMENTS and wrote no data line for
the `listensTo` reactions they caused — the raw call line is the only record of
`audit`'s reaction to `vault:setTok`, and that reaction reads the argument
(`lens`). So a copy of this journal (an `am backup`, a `data.replaced-*`) cannot
have that line scrubbed without losing an acked write; the call nobody listens
to (`vault:setOther`) can.

- `app.js` — the app, as it ran. `MOD` names the aio `mod.ts` to import.
- `data/` — `state.db`, `journal`, `journal.base`, `meta.json` as v1.0.11 left
  them at the kill (one save after the first call, then four journalled calls).
- `expected.json` — the live state at the kill.
- `v1.0.11-recovered.json` — what v1.0.11 recovers from `data/`, on its first
  boot and its second (equal to `expected.json`).

## How it was made (2026-09-24)

1. `git archive v1.0.11-beta` somewhere (`<head>`).
2. Run `app.js` with `PHASE=crash`, `DIR=<dir>`, `AIO_APPS_DIR=<dir>`, a free
   `PORT`, and `MOD=file://<head>/mod.ts`, under
   `deno run -A --config <head>/deno.json`. It kills itself after its last acked
   write.
3. Copy `app.js`, `expected.json`, and
   `data/{journal,journal.base,meta.json,state.db}` here, after folding the WAL
   into the database file
   (`PRAGMA wal_checkpoint(TRUNCATE); VACUUM;
   PRAGMA journal_mode=DELETE;`,
   node:sqlite).
4. Boot a copy twice with `<head>` and `PHASE=read`; each boot writes
   `recovered.json`. Both matched; that output is `v1.0.11-recovered.json`.

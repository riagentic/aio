#!/usr/bin/env -S deno run -A
// check-mutations.ts — the mutation gate.
//
// A green suite means the tests passed. It does NOT mean the tests would have
// noticed the bug. Eight audits in one week found the difference, and the
// worst finding of all was this one: DELETING THE ROLLBACK BODY IN THE UPDATE
// PATH TURNED NO TEST RED. Thousands of green tests, and the line that decides
// whether a failed update leaves an app running or bricked was unguarded.
//
// The only way to know a test guards a line is to break the line and watch the
// test go red. That is what this does. For a CURATED ledger of the framework's
// load-bearing invariants — the ones where a silent regression costs data,
// money or security — it:
//
//   1. copies the tree to scratch (once per worker, not once per entry),
//   2. runs the named test UNMUTATED and requires it GREEN — a test that is
//      already red, or whose name matches nothing, proves nothing when it
//      fails under mutation, so that is a gate failure with its own message,
//   3. writes the mutation, runs the same test, and requires it RED,
//   4. restores the file.
//
// A mutation that SURVIVES is the finding: the invariant is unguarded, and the
// gate says so by name — the invariant, the file:line, and the test that was
// supposed to cover it.
//
// This is deliberately NOT whole-file mutation testing. Mutating every line of
// `src/` would take hours, drown a reviewer in equivalent mutants, and get
// switched off. A curated ledger of ~25 invariants runs in a couple of minutes
// and every entry is a sentence someone chose to write.
//
//   deno task check:mutations                 the whole ledger
//   deno task check:mutations --only=sha256   entries whose `what` matches
//   deno task check:mutations --jobs=8        parallel workers (default 4)
//   deno task check:mutations --list          print the ledger, run nothing
//
// ADDING AN ENTRY IS THE POINT AND MUST STAY CHEAP: four fields, no
// registration anywhere else. If you fix a bug that no test caught, the
// regression test you write next belongs here.
//
//   { what: "…what it costs when this silently regresses",
//     file: "src/…",           // the enforcing file
//     find: "…",               // the enforcing line, VERBATIM, unique in it
//     replace: "…",            // the same line with the invariant disabled
//     test: "tests/….test.ts", // the test that must go red
//     filter: "…" }            // its exact Deno.test name
//
// `tests/mutation-ledger.test.ts` keeps every entry HONEST in milliseconds as
// part of the normal suite: each `find` must still occur exactly once in its
// file, and each `filter` must still name a real test. So an entry can never
// quietly rot into a no-op between runs of this slower gate.

export type Mutation = {
  /** The invariant, phrased as what it costs when it silently regresses. */
  what: string;
  /** Repo-relative path of the file holding the enforcing line. */
  file: string;
  /** The enforcing line, verbatim. Must occur EXACTLY ONCE in `file`. */
  find: string;
  /** The same line with the invariant disabled. Must still type-check. */
  replace: string;
  /** Repo-relative path of the test that must go red. */
  test: string;
  /** The exact `Deno.test` name inside `test`. */
  filter: string;
};

// ─── the ledger ────────────────────────────────────────────────────────────

export const LEDGER: readonly Mutation[] = [
  {
    what:
      "retireData stops moving the profile and the new build boots on the OLD data it was blocked for \u2014 the operator asked for a fresh start and got a migration nobody vetted, on the code path where being wrong costs a user their data",
    file: "src/server/updates-retire.ts",
    find: "    await Deno.rename(dataDir, archive);",
    replace: "    await Deno.mkdir(archive);",
    test: "tests/updates-retire.test.ts",
    filter:
      "retireData: a blocked release installs, and the profile is retired at handover \u2014 moved whole, never deleted",
  },
  {
    what:
      "aio.restart() stops refusing in libraryMode and a cell method under test ends the TEST RUNNER \u2014 a refusal with the manual step becomes a silent process exit in whoever hosts the app",
    file: "src/server/aio-lifecycle.ts",
    find: "  if (f.libraryMode) { // the host owns the process — never exit it",
    replace: "  if (f.libraryMode && !f.running) { // mutated",
    test: "tests/lifecycle-restart.test.ts",
    filter:
      "restart matrix: every launcher has a row, and no row is a silent no-op",
  },
  {
    what:
      'a declared share stops being held inside the repository \u2014 deno.json "share": ["/"] (or a symlink that leaves the checkout) turns the dev server into a file server for the whole machine',
    file: "src/server/app-dirs.ts",
    find: "    if (real !== repo && !real.startsWith(repoPfx)) {",
    replace: "    if (real !== repo && real.startsWith(repoPfx)) {",
    test: "tests/share.test.ts",
    filter:
      "share: resolves to /<basename> inside the repo; refuses missing, escaping and colliding entries",
  },
  {
    what:
      "an update installs code signed by ANY key, including the attacker's own \u2014 a forged manifest is internally consistent by construction, so verifying against the key it carries proves nothing, and the app replaces its own binary with whatever the source served",
    file: "src/build/ship.ts",
    find:
      "    trusted.length > 0 && !trusted.some((k) => sameKey(manifest.publicKey!, k))",
    // `&& false` would give the condition the literal type `false`, which
    // costs the branch its narrowing of `manifest.publicKey` and makes the
    // mutant fail to COMPILE — a mutation the test never gets to judge.
    // Inverting the comparison keeps the types identical and the branch dead.
    replace:
      "    trusted.length < 0 && !trusted.some((k) => sameKey(manifest.publicKey!, k))",
    test: "tests/ship.test.ts",
    filter: "ship manifest: a self-signed manifest fails against a pinned key",
  },
  {
    what:
      "the downloaded bytes stop being checked against the signed digest \u2014 a correctly signed manifest served beside a tampered artifact installs the artifact, and the signature that was supposed to authenticate it authenticated a number nobody compared",
    file: "src/server/updates-check.ts",
    // THE enforcing line is the streaming check during the download, not
    // `verifyDownload`'s re-read below it — that one is belt and braces, and
    // mutating it leaves the suite green because the download already refused.
    find: "    if (sha !== opts.expectSha256) {",
    replace: "    if (sha !== sha) {",
    test: "tests/updates-e2e.test.ts",
    filter:
      "updates e2e: a SAME-SIZE tampered artifact is refused by its digest",
  },
  {
    what:
      "a leaked pairing PIN stays replayable for its whole window \u2014 anyone who saw the boot banner can pull the profile and the app key, repeatedly",
    file: "src/server/pairing.ts",
    find:
      "    _state = null; // one-shot: consume on success so it can't be replayed",
    replace: "    // one-shot consumption removed",
    test: "tests/pairing.test.ts",
    filter:
      "pairing: correct PIN is ONE-SHOT \u2014 consumed on success, no replay",
  },
  {
    what:
      "the 6-digit pairing PIN becomes brute-forceable at line speed \u2014 an attacker on the LAN grinds it and walks off with the app key",
    file: "src/server/pairing.ts",
    find:
      "  if ((_state.attempts.get(key) ?? 0) >= MAX_ATTEMPTS) return false;",
    replace:
      "  if ((_state.attempts.get(key) ?? 0) >= Number.MAX_SAFE_INTEGER) return false;",
    test: "tests/pairing.test.ts",
    filter:
      "pairing: wrong tries lock the OFFENDING client key, not the PIN globally",
  },
  {
    what:
      "expired bearer sessions keep authenticating forever \u2014 a lapsed token still resolves to a live user on HTTP, WS and every access: rule",
    file: "src/server/sessions.ts",
    find: "      if (row.expires_at <= Date.now()) {",
    replace: "      if (row.expires_at <= 0) {",
    test: "tests/sessions.test.ts",
    filter: "sessions: TTL expiry removes the session on read",
  },
  {
    what:
      "a TOTP code observed once (proxy log, screen share) is replayable for the rest of its window \u2014 the second factor stops being single-use",
    file: "src/server/auth-totp.ts",
    find:
      "    if (prev && step <= prev.step) return false; // replay of a used code",
    replace:
      "    if (prev && step < -1) return false; // replay of a used code",
    test: "tests/auth-security-regression.test.ts",
    filter: "regression: a TOTP code cannot be used twice",
  },
  {
    what:
      "the TOTP compare short-circuits on the first differing digit \u2014 a per-digit timing oracle over the whole 6-digit space",
    file: "src/server/auth-totp.ts",
    find:
      "    if (!_timingSafeEqual(await totpCode(secretB32, step), submitted)) continue;",
    replace:
      "    if ((await totpCode(secretB32, step)) !== submitted) continue;",
    test: "tests/auth-boundary.test.ts",
    filter:
      "totp: the code compare is timing-safe in the source, not just in the docstring",
  },
  {
    what:
      "a forUser cell rides the raw-patch path, so every delta is computed from UNFILTERED state \u2014 one tenant's rows reach another tenant's socket",
    file: "src/server/aio-composition.ts",
    find: '      cellPatchStrategies.set(f.__aio.id, "full");',
    replace: '      cellPatchStrategies.set(f.__aio.id, "raw");',
    test: "tests/foruser-leak.test.ts",
    filter: "forUser: another user's row never reaches the wire",
  },
  {
    what:
      "a forUser filter that throws falls back to the PRE-filter value \u2014 one TypeError broadcasts every user's data to whoever tripped it",
    file: "src/server/aio-composition.ts",
    find: "          delete result[cellName];\n          log.error(",
    replace: "          log.error(",
    test: "tests/foruser-leak.test.ts",
    filter:
      "forUser: a filter that throws sends NOTHING for that cell (fail closed)",
  },
  {
    what:
      "the trojan control-plane credential (raw state, arbitrary SQL, shutdown) is written into a directory other local users can read",
    // The rule moved to dir-permissions.ts when the lock directory started
    // asking the same question. Mutating the MASK disables detection for both
    // doors at once, which is the point: they are one rule now.
    file: "src/server/dir-permissions.ts",
    find: '  return typeof mode === "number" ? mode & 0o077 : null;',
    replace: '  return typeof mode === "number" ? mode & 0o000 : null;',
    test: "tests/local-control.test.ts",
    filter: "control key: refuses a data dir other users can read",
  },
  {
    what:
      "a control SOCKET is bound in a directory another local user owns \u2014 chmod on someone else's directory fails with EPERM, and whoever can reach the socket can dispatch methods into the app",
    file: "src/server/single-instance-lock.ts",
    find: "  return privateDirRefusal(dir, st.mode, st.uid);",
    replace: "  return null;",
    test: "tests/lock-dir-private.test.ts",
    filter: "a directory we cannot narrow is refused, not used",
  },
  {
    what:
      "the trojan credential compare accepts a prefix match \u2014 the master local credential falls to a near-miss guess",
    file: "src/server/server-auth.ts",
    find: "    if (_timingSafeEqual(presented, key)) ok = true;",
    replace: "    if (presented.slice(0, 8) === key.slice(0, 8)) ok = true;",
    test: "tests/local-control.test.ts",
    filter: "trojan gate: a wrong credential is refused and named as stale",
  },
  {
    what:
      "--expose stops defaulting to off: every app that says nothing binds to the LAN, public by default in the strongest sense",
    file: "src/server/aio.ts",
    find: "  if (cli.expose ?? config.expose ?? false) return true;",
    replace: "  if (cli.expose ?? config.expose ?? true) return true;",
    test: "tests/expose-config.test.ts",
    filter:
      "expose: ONE decider \u2014 CLI wins, config carries, default false",
  },
  {
    what:
      "a BLOCKING server-only import becomes silenceable by a comment \u2014 the one diagnostic that says the browser will not boot can be muted",
    file: "src/server/graph-validator.ts",
    find: "    BLOCKING_CATEGORIES.has(e.category) ||",
    replace: "    false ||",
    test: "tests/graph-server-only-ack.test.ts",
    filter: "server-only: a BLOCKING import cannot be acknowledged away",
  },
  {
    what:
      "a huge patch ships instead of the cheaper full state \u2014 at the WS frame budget the frame is dropped and the client is stuck on stale state",
    file: "src/server/server-broadcast.ts",
    find: "  const fullStateThreshold = deps.fullStateThreshold ?? 0.5;",
    replace: "  const fullStateThreshold = deps.fullStateThreshold ?? 1;",
    test: "tests/big-data-guardrails.test.ts",
    filter:
      "broadcast perf: small patch rounds skip full-state serialization; big patches still flip to full",
  },
  {
    what:
      "a state that serializes back to an older remembered value is read as already-delivered \u2014 the client is stranded on an intermediate value forever, nothing logged",
    file: "src/server/server-broadcast.ts",
    find: '          meta.lastFullJsonStale = sentKind === "patch";',
    replace: "          meta.lastFullJsonStale = false;",
    test: "tests/broadcast-stale-memo.test.ts",
    filter:
      "broadcast: a state EQUAL to the last full send is still sent after a patch round",
  },
  {
    what:
      "proxy-derived values are recorded by reference instead of materialized, so `s.x = { ...s.x }` stores live proxies in the mutation log",
    file: "src/state/cell-impl.ts",
    find: "        value: materializeValue(value),",
    replace: "        value: value,",
    test: "tests/proxy-write-loud.test.ts",
    filter:
      "async: spreading the live proxy back into state WORKS, same as sync",
  },
  {
    what:
      "a rolled-back build stamps stored data DOWNWARD, so the next roll-forward re-runs onMigrate over already-migrated data \u2014 a money migration applied twice",
    file: "src/server/persistence.ts",
    find: "        const highest = Math.max(v, merged[cell] ?? 0);",
    replace: "        const highest = v;",
    test: "tests/persist-version-stamp-atomic.test.ts",
    filter:
      "persist: the stamp stays MONOTONIC per cell (a rollback never stamps down)",
  },
  {
    what:
      "the db: table writes and the state snapshot stop sharing a transaction \u2014 a kill between the two commits returns N rows and a counter of N+1",
    file: "src/server/persistence.ts",
    find:
      "        await asyncDb.transaction([...(sql?.stmts ?? []), ...kv.stmts]);",
    replace:
      "        await asyncDb.transaction(sql?.stmts ?? []);\n        await asyncDb.transaction(kv.stmts);",
    test: "tests/persist-store-atomicity.test.ts",
    filter:
      "persist (single): the db: table and the state snapshot land in ONE transaction",
  },
  {
    what:
      "one row SQLite refuses takes the whole state snapshot with it \u2014 the app never persists ANYTHING again, every cell's state gone at the next restart",
    file: "src/server/persistence.ts",
    find:
      "      if (!sql?.stmts.length) return; // the snapshot itself is what failed",
    replace:
      "      if (sql?.stmts.length) return; // the snapshot itself is what failed",
    test: "tests/persist-bad-row-isolation.test.ts",
    filter: "persist: a row SQLite refuses does not stop the state snapshot",
  },
  {
    what:
      "a corrupt SQLite file is opened and served \u2014 the app returns half the data and writes on top of the damage, with no quarantine copy kept",
    file: "src/server/db-integrity.ts",
    find: "    result = await opts.db.checkIntegrity();",
    replace: "    result = { ok: true, problems: [] };",
    test: "tests/db-integrity.test.ts",
    filter:
      "integrity: a damaged file is QUARANTINED and restored from a snapshot",
  },
  {
    what:
      "a mass delete exceeds SQLITE_MAX_VARIABLE_NUMBER, the shared transaction rolls back forever and a confirmed deletion is silently undone by the next restart",
    file: "src/db/state-sync.ts",
    find: "        for (const batch of chunkParams(d.toDelete)) {",
    replace: "        for (const batch of [d.toDelete]) {",
    test: "tests/db-mass-delete.test.ts",
    filter:
      "db: a mass delete is chunked \u2014 no statement exceeds the param cap",
  },
  {
    what:
      "frames from a peer speaking an older wire version are accepted and misinterpreted instead of refused",
    file: "src/protocol/envelope.ts",
    find: '      p && p.v === 2 && typeof p.t === "string" &&',
    replace: '      p && typeof p.t === "string" &&',
    test: "tests/wire-envelope.test.ts",
    filter: "envelope: dec rejects everything that is not a v2 frame",
  },
  {
    what:
      "a tampered 100 MB Electron zip is unpacked and executed as the user's desktop app \u2014 native code execution on every launch",
    file: "src/electron/electron-runtime-fetch.ts",
    find: "      const actual = await sha256Hex(bytes);",
    replace: "      const actual = expected;",
    test: "tests/electron-runtime-fetch.test.ts",
    filter:
      "ensureElectronRuntime: a tampered zip is REFUSED, and nothing is cached",
  },
  {
    what:
      "fetched build sources stop being pinned by digest \u2014 a compromised CDN swaps framework source between two builds and the code lands in every shipped binary",
    file: "src/build/build-integrity.ts",
    find: "  const hash = await _sha256(contents);",
    replace: "  const hash = map[url] ?? await _sha256(contents);",
    test: "tests/build-integrity.test.ts",
    filter: "verifyIntegrity: record-first, match-passes, mismatch-throws",
  },
  {
    what:
      "a STATIC *.server.ts import from client code stops being a bundle leak \u2014 keys and internal queries ship to the browser, readable in devtools",
    file: "src/build/esbuild-plugin.ts",
    find:
      "          record(args.importer, args.path);\n          return undefined; // still resolves, so the error can name ONE thing",
    replace:
      "          recordDynamic(args.importer, args.path);\n          return undefined; // still resolves, so the error can name ONE thing",
    test: "tests/build-browser-leak-gate.test.ts",
    filter: "bundle gate: a STATIC *.server.ts import is recorded too",
  },
  {
    what:
      "a dist/ bundle of the wrong SHAPE is embedded verbatim by a target that did not build it \u2014 the shipped binary serves a permanently blank page, exit 0",
    file: "src/build/build-bundle.ts",
    find:
      '  if (!stamps) return { action: "embed" }; // no UI \u2192 the 503 page, unchanged',
    replace:
      '  if (!stamps || stamps.target !== want) return { action: "embed" }; // no UI \u2192 the 503 page, unchanged',
    test: "tests/build-bundle-cache.test.ts",
    filter:
      "embed guard: only a bundle matching THIS target's shape and version is embedded",
  },
  {
    what:
      "`am pin` certifies a forward move that drops a config key the app still uses \u2014 the tool says yes and the app dies at boot",
    file: "src/am/am-cmd-pin.ts",
    find: "      if (stillAccepts(ref, hit.removal.lastGood)) continue;",
    replace: "      if (stillAccepts(hit.removal.lastGood, ref)) continue;",
    test: "tests/am-pin-preflight.test.ts",
    filter: "preflight: a forward move that would break the app is reported",
  },
  {
    what:
      "an app boots on a Deno older than MIN_DENO and dies cryptically mid-run instead of refusing at boot with an actionable message",
    file: "src/server/deno-version.ts",
    find: "  if (!meetsMinDeno(have)) {",
    replace: "  if (false && !meetsMinDeno(have)) {",
    test: "tests/deno-version.test.ts",
    filter:
      "deno-version: assertDenoVersion throws an actionable error below floor",
  },
  {
    what:
      "an unhandled rejection from a fire-and-forget dispatch kills a long-running server that owns persisted state instead of being logged and survived",
    file: "src/diagnostics/crash-handler.ts",
    find:
      "    if (guardRejections && (isBootComplete?.() ?? true)) e.preventDefault();",
    replace:
      "    if (false && guardRejections && (isBootComplete?.() ?? true)) e.preventDefault();",
    test: "tests/guard-dispatches.test.ts",
    filter:
      "guardDispatches: a rejection is logged AND prevented from crashing",
  },
  {
    what:
      "the worker's drain budget reaches the main isolate's ack deadline, so shutdown terminates the thread part-way through the final writes the drain exists to deliver",
    file: "src/server/cell-worker-protocol.ts",
    find: "export const WORKER_CLOSE_DRAIN_MS = 800;",
    replace: "export const WORKER_CLOSE_DRAIN_MS = 1_000;",
    test: "tests/shutdown-worker-cell-durability.test.ts",
    filter: "worker close: the drain deadline must stay UNDER the ack deadline",
  },
  {
    what:
      "a per-method flag the browser branches on stops being mirrored in the hand-kept browser cell stub \u2014 a `long:` method gives up at the 30s ceiling in the browser and nowhere else",
    file: "src/browser/protocol-cell.ts",
    find: "        longMethods: (config as { long?: string[] }).long,",
    replace: "        longMethods: undefined,",
    test: "tests/browser-cell-stub-parity.test.ts",
    filter:
      "browser cell stub mirrors every __aio key the browser bundle reads",
  },
  {
    what:
      "an async onStop (a flush, a child to wait for) is abandoned the moment it starts and the process exits milliseconds later",
    file: "src/server/shutdown.ts",
    find: '      await phase(log, "hook onStop", tLeft, () => refs.onStop!());',
    replace:
      '      void phase(log, "hook onStop", tLeft, () => refs.onStop!());',
    test: "tests/onstop-awaited.test.ts",
    filter: "onStop: an async hook finishes before app.close() resolves",
  },
  {
    what:
      "persisted keys bleed between cells \u2014 one cell's restore picks up another's rows, and a neighbouring prefix silently overwrites them",
    file: "src/server/skv-sqlite.ts",
    find: "        [`${prefix}${SEP}`, `${prefix}${SEP}${HIGH}`],",
    replace: "        [prefix, `${prefix}${HIGH}`],",
    test: "tests/skv-sqlite.test.ts",
    filter: "sqliteKv: prefixes never bleed into each other",
  },
  {
    what:
      "journal compaction eats the newest un-snapshotted action, so the one write a crash was supposed to replay is the one that cannot be",
    file: "src/server/journal.ts",
    find:
      "        const keep = parseJournal(Deno.readTextFileSync(path)).filter((e) =>\n          e.seq > s\n        );",
    replace:
      "        const keep = parseJournal(Deno.readTextFileSync(path)).filter((e) =>\n          e.seq > s + 1\n        );",
    test: "tests/journal-compaction-perms.test.ts",
    filter: "journal: compaction still keeps the unpersisted tail",
  },
  {
    what:
      "a row with a null primary key is silently dropped instead of refused \u2014 the write is acknowledged and the data is simply not there",
    file: "src/db/state-sync.ts",
    find: "  if (key === undefined || key === null) {",
    replace: "  if (key === undefined) {",
    test: "tests/db-sync-integrity.test.ts",
    filter: "db sync: a null primary key is refused, not silently dropped",
  },
  {
    what:
      "a write through an async method's `s` from a callback that outlived the method COMMITS \u2014 persisted, broadcast, ok:true, no log line",
    file: "src/state/cell-impl.ts",
    find: "    if (closed) {",
    replace: "    if (closed && mutation.path.length < 0) {",
    test: "tests/async-view-sealed-after-settle.test.ts",
    filter: "a write after the method settled throws by name and lands nowhere",
  },
  {
    what:
      "a client whose broadcast round was skipped under backpressure receives the NEXT patch on top of a state that never got the skipped one \u2014 diverges with health green",
    file: "src/server/server-broadcast.ts",
    find:
      "        if (!force && !meta.needsFull && patchesToSend.length > 0) {",
    replace: "        if (!force && patchesToSend.length > 0) {",
    test: "tests/broadcast-skipped-round-sends-full.test.ts",
    filter:
      "broadcast: a round skipped under backpressure makes the next one a full state",
  },
  {
    what:
      "a bare action type (`incremnt`) in a cells app is dispatched into the void and answered {ok:true}",
    file: "src/server/server-trojan.ts",
    find: "      } else if (sepIdx <= 0 && Object.keys(methods).length > 0) {",
    replace:
      "      } else if (sepIdx <= 0 && Object.keys(methods).length < 0) {",
    test: "tests/trojan-dispatch-validate.test.ts",
    filter:
      "trojan dispatch: a bare type in a cells app is refused, with the nearest method named",
  },
  {
    what:
      "an async method that throws after its first await is logged while `am dispatch` has already answered {ok:true}",
    file: "src/server/server-trojan.ts",
    find:
      '        if (asyncOnes.includes(method) && typeof pl._callId !== "string") {',
    replace:
      '        if (asyncOnes.includes(method) && typeof pl._callId === "number") {',
    test: "tests/trojan-async-rejection-reaches-caller.test.ts",
    filter:
      "trojan dispatch: a post-await throw is the route's answer, not a log line",
  },
  {
    what:
      "a scheduled tick or a client action dispatched while the app is closing is APPLIED — new work started during shutdown, captured by the final persist",
    file: "src/state/dispatch.ts",
    find:
      '      const admitted = isTeardown || (phase === "draining" && isInflight);',
    replace: '      const admitted = isTeardown || phase === "draining";',
    test: "tests/dispatch.test.ts",
    filter: "dispatch: open → draining → sealed — each refusal names its phase",
  },
  {
    what:
      "an in-flight write after the seal moves state the final persist has already read — disk and memory diverge silently",
    file: "src/state/dispatch.ts",
    find: '    phase = "sealed";',
    replace: '    phase = "draining";',
    test: "tests/dispatch.test.ts",
    filter: "dispatch: open → draining → sealed — each refusal names its phase",
  },
  {
    what:
      "a client forges `_inflight` and rides the shutdown drain window — a cell:method runs while the server closes and its write is persisted",
    file: "src/server/server-ws.ts",
    find: "  delete action[INFLIGHT];",
    replace: '  delete action["_inflight_never"];',
    test: "tests/aio-402-uds-ack.test.ts",
    filter: "uds: forged trusted provenance is stripped and _source re-stamped",
  },
  {
    what:
      "one app's cancel trigger aborts ANOTHER app's same-named cell method mid-write (two apps in one process)",
    file: "src/state/method-cancel.ts",
    find: "      const fires = sameApp(t.app, app) && sameApp(e.app, t.app) &&",
    replace: "      const fires = true || sameApp(t.app, app) &&",
    test: "tests/method-cancel-app-scope.test.ts",
    filter:
      "method-cancel: two apps, one cell name — cancelling in one never cancels the other",
  },
  {
    what:
      "a call half-way to its ceiling says nothing — slow is indistinguishable from dead until the ceiling fires",
    file: "src/state/cell-impl.ts",
    find: "    armHeartbeat();",
    replace: "    void armHeartbeat;",
    test: "tests/call-ceiling-heartbeat.test.ts",
    filter:
      "call ceiling: a call past half its ceiling logs 'still running (slow)' once, at info",
  },
  {
    what:
      "persistence is handed no row information — every one-row write clones and diffs the whole db: table again",
    file: "src/server/aio-dispatch.ts",
    find: "      if (!tt?.paused) schedulePersist(groupCellPatches(patches));",
    replace: "      if (!tt?.paused) schedulePersist();",
    test: "tests/dispatch-cell-patches.test.ts",
    filter:
      "dispatch: onDone hands persistence the batch's per-cell patches, grouped by cell",
  },
  {
    what:
      "a row deleted from a bound table is never DELETEd from SQLite \u2014 the incremental diff finds deletions by count, and without that check a confirmed removal comes back on the next boot",
    file: "src/db/state-sync.ts",
    find: "  if (idx.size !== rows.length - toInsert.length) {",
    replace: "  if (idx.size !== idx.size) {",
    test: "tests/db-dirty-tracking.test.ts",
    filter:
      "dirty tracking: a hint that cannot be trusted falls back to the full pass (shrink, move)",
  },
  {
    what:
      "a refused schema step no longer refuses the boot \u2014 the app serves traffic against tables it does not have, and every query on them fails at a random later moment",
    file: "src/db/ddl.ts",
    find: "      await step.run(db);",
    replace: "      await step.run(db).catch(() => {});",
    test: "tests/db-schema-runner.test.ts",
    filter:
      "schema runner: the first failing step refuses by name, with its fix, and nothing after it runs",
  },
  {
    what:
      "a schema version that could not be READ reads as 0 \u2014 the ladder stamps the epoch over a file whose real version was never seen",
    file: "src/db/ddl.ts",
    find: "    if (/no such table/i.test(msg)) return 0;",
    replace: "    if (msg) return 0;",
    test: "tests/db-schema-runner.test.ts",
    filter:
      "schema version read: 'no such table' is the one honest 0 \u2014 any other failure throws by name",
  },
  {
    what:
      "dev boots on unmigrated shape drift and warns forever \u2014 the stale shape is loaded on every boot and nothing forces the onMigrate before it ships",
    file: "src/server/aio-boot.ts",
    find: "      if (isDevBoot() && structural.length > 0) {",
    replace: "      if (isDevBoot() && structural.length < 0) {",
    test: "tests/shape-drift-strict.test.ts",
    filter:
      "shape-drift strict: DEV refuses to boot on unmigrated drift; PROD boots and warns",
  },
  {
    what:
      "a journal that exists but cannot be read counts as no journal \u2014 the actions it holds are never replayed and the boot says nothing",
    file: "src/server/journal.ts",
    find: "      if (e instanceof Deno.errors.NotFound) return null;",
    replace: "      if (e instanceof Error) return null;",
    test: "tests/journal-honest-read.test.ts",
    filter:
      "journal: a missing journal is 'nothing yet' \u2014 an unreadable one throws by name",
  },
  {
    what:
      "a discovery sweep carrying a nonce accepts answers that do not echo it \u2014 the test measures the neighbourhood, not its own responder",
    file: "src/server/discovery.ts",
    find:
      "      if (opts.nonce !== undefined && ad.nonce !== opts.nonce) return;",
    replace:
      "      if (opts.nonce !== undefined && ad.nonce === opts.nonce) return;",
    test: "tests/discovery.test.ts",
    filter:
      "discovery: a nonce sweep drops answers that do not echo it; a plain sweep keeps them",
  },
  {
    what:
      "a grown string goes back to shipping WHOLE on every broadcast window \u2014 a streamed reply costs its own length squared and pushes the app over the pressure threshold, exactly the field report the append op closed",
    file: "src/state/patch-compact.ts",
    find: "  return narrowStringPatches(prev, narrowArrayPatches(prev, ops));",
    replace: "  return narrowArrayPatches(prev, ops);",
    test: "tests/append-patches-wire.test.ts",
    filter:
      "append: streaming 50 chunks into a 10 KB string costs the chunks, not the string",
  },
  {
    what:
      "an append in a coalesced frame is resolved against the frame's BASE instead of the state the earlier ops left \u2014 after a row removal it extends the deleted row's text: a plausible string, silently wrong, on every client",
    file: "src/protocol/patch-ops.ts",
    find: "    if (applied < i) {",
    replace: "    if (applied < i && i < 0) {",
    test: "tests/patch-ops.test.ts",
    filter:
      "applyWirePatches: an append resolves against the state AS THE OPS APPLY",
  },
  {
    what:
      "an append survives a later whole-value replace at its path \u2014 the frame applies the append AFTER the reset the client should have ended on, and every client shows a reset reply with the old suffix glued back on",
    file: "src/state/patch-compact.ts",
    find: '    if (p.op === "replace" || p.op === "append") {',
    replace: '    if (p.op === "replace") {',
    test: "tests/patch-compact.test.ts",
    filter:
      "compactPatches: an append followed by a replace at its path is dropped",
  },
  {
    what:
      "the browser applies deltas through Immer directly again and an append frame throws \u2014 every streamed token forces a full resync, the exact quadratic cost the op exists to remove, invisible because the state still ends up right",
    file: "src/state/state-message.ts",
    find: "      const next = applyWirePatches(prev, patches);",
    replace:
      '      const next = applyWirePatches(prev, patches.filter((p) => p.op !== "append"));',
    test: "tests/patch-ops.test.ts",
    filter:
      "browser applier: handleMessage applies an append frame to the client state",
  },
];

// ─── the runner ────────────────────────────────────────────────────────────

/** Everything a scratch copy needs to run a test. `amui/node_modules` (364 MB)
 *  and `.git` are the reason this is a whitelist and not an exclude list. */
const COPY = [
  "src",
  "tests",
  "aiol",
  "amui/src",
  "amui/deno.json",
  "docs",
  "scripts",
  "examples",
  "mod.ts",
  "deno.json",
  "deno.lock",
  "README.md",
  "CHANGELOG.md",
  "todo.md",
  "CLAUDE.md",
  "perfect-aio.md",
  ".katana",
  "android-template",
  "init.sh",
  "install.sh",
  "install.ps1",
  "run.sh",
  "run.ps1",
];

const ROOT = new URL("../", import.meta.url).pathname;

async function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; out: string }> {
  const p = new Deno.Command(cmd, {
    args,
    cwd: opts.cwd,
    env: opts.env,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const r = await p.output();
  return {
    code: r.code,
    out: new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr),
  };
}

async function makeScratch(i: number): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: `aio-mutate-${i}-` });
  for (const rel of COPY) {
    try {
      await Deno.stat(`${ROOT}${rel}`);
    } catch {
      continue; // an optional path; the tree is allowed to move on.
    }
    const dest = `${dir}/${rel}`;
    const parent = dest.slice(0, dest.lastIndexOf("/"));
    await Deno.mkdir(parent, { recursive: true });
    const cp = await sh("cp", ["-a", `${ROOT}${rel}`, dest]);
    if (cp.code !== 0) throw new Error(`cp ${rel} failed:\n${cp.out}`);
  }
  // `node_modules` (320 MB of esbuild/electron/happy-dom) is SYMLINKED, not
  // copied: tests only ever read it, and copying it per worker would cost more
  // than the whole gate. Same for the amui one.
  for (const nm of ["node_modules", "amui/node_modules"]) {
    try {
      await Deno.stat(`${ROOT}${nm}`);
      await Deno.symlink(`${ROOT}${nm}`, `${dir}/${nm}`);
    } catch {
      // aio-ok: an absent node_modules is a valid tree; the tests that need it
      // will say so themselves, loudly, in the baseline run.
    }
  }
  await Deno.mkdir(`${dir}/.aio-test-home`, { recursive: true });
  return dir;
}

/** One `deno test` run, in a scratch tree. */
async function runTest(
  scratch: string,
  m: Mutation,
): Promise<{ passed: number; failed: number; out: string; code: number }> {
  const r = await sh(Deno.execPath(), [
    "test",
    "-A",
    "--no-check=remote",
    "--quiet",
    m.test,
    "--filter",
    m.filter,
  ], {
    cwd: scratch,
    env: {
      ...Deno.env.toObject(),
      AIO_APPS_DIR: `${scratch}/.aio-test-home`,
      NO_COLOR: "1",
    },
  });
  const passed = Number(/(\d+) passed/.exec(r.out)?.[1] ?? 0);
  const failed = Number(/(\d+) failed/.exec(r.out)?.[1] ?? 0);
  return { passed, failed, out: r.out, code: r.code };
}

/** A red that is a COMPILER complaint is not evidence: the mutation was not
 *  valid code, so the test never got to disagree with it. That is a broken
 *  ledger entry, and it must be loud rather than counted as a kill. */
const TYPE_ERROR = /\bTS\d{3,5} \[ERROR\]|error: The module's source code/;

export type Result = {
  m: Mutation;
  verdict: "killed" | "survived" | "invalid";
  line: number;
  detail: string;
};

async function check(scratch: string, m: Mutation): Promise<Result> {
  const path = `${scratch}/${m.file}`;
  const original = await Deno.readTextFile(path);
  const line = original.slice(0, original.indexOf(m.find)).split("\n").length;
  const bad = (detail: string): Result => ({
    m,
    verdict: "invalid",
    line,
    detail,
  });

  const occurrences = original.split(m.find).length - 1;
  if (occurrences !== 1) {
    return bad(
      `\`find\` occurs ${occurrences} times in ${m.file} (must be exactly 1) — ` +
        `the enforcing line moved or was reworded. Re-copy it verbatim.`,
    );
  }
  if (m.replace === m.find) return bad("`replace` is identical to `find`.");

  // 1. Baseline. A test that is already red — or whose name matches nothing —
  //    would "go red" under any mutation whatsoever and prove nothing.
  const before = await runTest(scratch, m);
  if (before.failed > 0 || before.code !== 0) {
    return bad(
      `${m.test} is ALREADY RED unmutated (or failed to load), so its failure ` +
        `under mutation would prove nothing:\n${tail(before.out)}`,
    );
  }
  if (before.passed === 0) {
    return bad(
      `the named test did not run: \`--filter ${
        JSON.stringify(m.filter)
      }\` matched nothing in ${m.test}. Fix the name.`,
    );
  }

  // 2. Mutate.
  try {
    await Deno.writeTextFile(path, original.replace(m.find, m.replace));
    const after = await runTest(scratch, m);
    if (TYPE_ERROR.test(after.out)) {
      return bad(
        `the mutation does not compile, so the test never judged it — pick a ` +
          `mutation that is valid code:\n${tail(after.out)}`,
      );
    }
    if (after.failed > 0 || after.code !== 0) {
      return { m, verdict: "killed", line, detail: "" };
    }
    return {
      m,
      verdict: "survived",
      line,
      detail:
        `the invariant was DISABLED and ${before.passed} test(s) still passed.`,
    };
  } finally {
    await Deno.writeTextFile(path, original);
  }
}

const tail = (s: string): string =>
  s.trim().split("\n").slice(-12).map((l) => `      ${l}`).join("\n");

// ─── main ──────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = Deno.args;
  const only = args.find((a) => a.startsWith("--only="))?.slice(7);
  const jobs = Number(args.find((a) => a.startsWith("--jobs="))?.slice(7) ?? 4);
  const entries = LEDGER.filter((m) =>
    !only ||
    (m.what + m.file + m.test).toLowerCase().includes(only.toLowerCase())
  );

  if (args.includes("--list")) {
    for (const m of LEDGER) {
      console.log(`${m.what}\n    ${m.file}\n    → ${m.test} :: ${m.filter}\n`);
    }
    Deno.exit(0);
  }
  if (entries.length === 0) {
    console.error(`no ledger entries match --only=${only}`);
    Deno.exit(1);
  }

  const t0 = performance.now();
  console.log(
    `check:mutations — ${entries.length} invariants, ${jobs} workers. ` +
      `Each one is broken on purpose; its test must notice.\n`,
  );

  const scratches = await Promise.all(
    Array.from(
      { length: Math.min(jobs, entries.length) },
      (_, i) => makeScratch(i),
    ),
  );
  const queue = [...entries];
  const results: Result[] = [];
  await Promise.all(scratches.map(async (dir) => {
    for (;;) {
      const m = queue.shift();
      if (!m) return;
      const r = await check(dir, m).catch((e) => ({
        m,
        verdict: "invalid" as const,
        line: 0,
        detail: String(e),
      }));
      const mark = r.verdict === "killed"
        ? "\x1b[32m✓ killed  \x1b[0m"
        : r.verdict === "survived"
        ? "\x1b[31m✗ SURVIVED\x1b[0m"
        : "\x1b[33m! invalid \x1b[0m";
      console.log(`  ${mark} ${m.what}`);
      results.push(r);
    }
  }));
  for (const d of scratches) await Deno.remove(d, { recursive: true });

  const survived = results.filter((r) => r.verdict === "survived");
  const invalid = results.filter((r) => r.verdict === "invalid");
  const secs = ((performance.now() - t0) / 1000).toFixed(1);

  if (survived.length) {
    console.error(
      `\n\x1b[31m${survived.length} invariant(s) SURVIVED being broken\x1b[0m — ` +
        `nothing in the suite guards them:\n`,
    );
    for (const r of survived) {
      console.error(`  ${r.m.what}`);
      console.error(`    enforced at  ${r.m.file}:${r.line}`);
      console.error(`      ${r.m.find.trim().slice(0, 100)}`);
      console.error(`    disabled to  ${r.m.replace.trim().slice(0, 100)}`);
      console.error(
        `    supposedly covered by  ${r.m.test} :: "${r.m.filter}"`,
      );
      console.error(`    ${r.detail}\n`);
    }
    console.error(
      `  Make the test assert the CONSEQUENCE of the invariant, not its ` +
        `presence — then this gate goes green for a reason.`,
    );
  }
  if (invalid.length) {
    console.error(
      `\n\x1b[33m${invalid.length} broken ledger entr(y|ies)\x1b[0m:\n`,
    );
    for (const r of invalid) {
      console.error(`  ${r.m.what}\n    ${r.m.file} → ${r.m.test}`);
      console.error(`    ${r.detail}\n`);
    }
  }
  console.log(
    `\n${
      results.filter((r) => r.verdict === "killed").length
    }/${entries.length} ` +
      `invariants are genuinely guarded  (${secs}s)`,
  );
  Deno.exit(survived.length + invalid.length > 0 ? 1 : 0);
}

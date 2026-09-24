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
// switched off. A curated ledger (347 invariants at 1.0.11, ~36 min on four
// workers) is every entry a sentence someone chose to write.
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
  /** Env the test needs to RUN at all — an opt-in lane (the packaged
   *  AppImage) is `ignore`d without it, and an ignored test proves nothing
   *  (the baseline then reports "did not run", never a false kill). */
  env?: Record<string, string>;
};

// ─── the ledger ────────────────────────────────────────────────────────────

export const LEDGER: readonly Mutation[] = [
  {
    what:
      "the Electron main process is generated source, and one JS escape written once instead of twice leaves main.cjs with a string literal broken across two lines \u2014 no app using the shell can open a window, and nothing between the generator and a human launching the product would have said so (cc \u00a75.4)",
    file: "src/electron/electron-uds.ts",
    find: "} }) + '\\\\n');",
    replace: "} }) + '\\n');",
    test: "tests/generated-scripts-parse.test.ts",
    filter: "generated scripts: every standalone script parses",
  },
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
      "    _states.delete(scope); // one-shot: consume on success so it can't be replayed",
    replace: "    // one-shot consumption removed",
    test: "tests/pairing.test.ts",
    filter:
      "pairing: correct PIN is ONE-SHOT \u2014 consumed on success, no replay",
  },
  {
    what:
      "the 6-digit pairing PIN becomes brute-forceable at line speed \u2014 an attacker on the LAN grinds it and walks off with the app key",
    file: "src/server/pairing.ts",
    find: "  if ((s.attempts.get(key) ?? 0) >= MAX_ATTEMPTS) return false;",
    replace:
      "  if ((s.attempts.get(key) ?? 0) >= Number.MAX_SAFE_INTEGER) return false;",
    test: "tests/pairing.test.ts",
    filter:
      "pairing: wrong tries lock the OFFENDING client key, not the PIN globally",
  },
  {
    what:
      "a pairing PIN has no TOTAL guess budget \u2014 a guesser rotating source addresses grinds all 10^6 codes inside the TTL and walks off with the app key",
    file: "src/server/pairing.ts",
    find: "  if (++s.wrong >= MAX_WRONG_TOTAL) {",
    replace: "  if (++s.wrong >= Number.MAX_SAFE_INTEGER) {",
    test: "tests/pairing-per-app.test.ts",
    filter: "pairing: wrong guesses from many addresses BURN the code",
  },
  {
    what:
      "the pairing PIN is one slot for the whole process \u2014 app B's code pairs app A and hands out A's key, and A's printed code is dead",
    file: "src/server/pairing.ts",
    find:
      "  _states.set(scope, { pin, createdAt: now, attempts: new Map(), wrong: 0 });",
    replace:
      "  _states.clear(); _states.set(scope, { pin, createdAt: now, attempts: new Map(), wrong: 0 });",
    test: "tests/pairing-per-app.test.ts",
    filter:
      "pairing: two apps in one process each pair with their OWN code only",
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
      "a TOTP code used just before a restart signs in again just after it \u2014 the replay record lives only in the process that died",
    file: "src/server/auth-users.ts",
    find: "        updTotpStep.run(step, normId(rawId), step).changes > 0,",
    replace: "        updTotpStep.run(step, normId(rawId), step).changes >= 0,",
    test: "tests/totp-replay-across-restart.test.ts",
    filter: "totp: a code accepted before a restart is refused after it",
  },
  {
    what:
      "an OIDC email the provider never verified maps to a role \u2014 typing boss@corp.com at the IdP makes you the app's admin",
    file: "src/server/auth-oidc.ts",
    find: "  const emailVerified = claims.email_verified === true;",
    replace: "  const emailVerified = claims.email_verified !== null;",
    test: "tests/oidc-claims-hardening.test.ts",
    filter:
      "oidc: an UNVERIFIED email grants no role, is not stored, and is not marked verified",
  },
  {
    what:
      "a page on any other origin POSTs to an app route with the visitor's cookie \u2014 CSRF against every route of every app",
    file: "src/server/server-auth.ts",
    find: "  if (!verdict) return null;",
    replace: "  if (!verdict || Date.now() > 0) return null;",
    test: "tests/cross-origin-http-gate.test.ts",
    filter:
      "cross-origin: an auth:true app refuses a foreign POST that carries the victim's session cookie",
  },
  {
    what:
      "the CSRF gate refuses a cookieless cross-site form POST to an EXPOSED app's public route \u2014 payment return URLs and SAML/OIDC form_post receivers stop working",
    file: "src/server/server-auth.ts",
    find: "  if (!ambientCookie && !byPosition) return null;",
    replace:
      "  if (!ambientCookie && !byPosition && Date.now() < 0) return null;",
    test: "tests/cross-origin-http-gate.test.ts",
    filter:
      "cross-origin: an EXPOSED app's route takes a cookieless cross-site POST; a cookie or a local peer is refused",
  },
  {
    what:
      "the CSRF gate lets a foreign page POST with the visitor's cookie to an exposed app \u2014 a sibling localhost port acts as the signed-in user",
    file: "src/server/server-auth.ts",
    find:
      '  const ambientCookie = (req.headers.get("cookie") ?? "").trim() !== "";',
    replace: "  const ambientCookie = false;",
    test: "tests/cross-origin-http-gate.test.ts",
    filter:
      "cross-origin: an exposed auth:true app refuses a sibling-port POST riding the session cookie",
  },
  {
    what:
      "an allowedOrigins entry naming one origin admits every port and scheme on its host \u2014 any other service on that machine opens an authenticated socket",
    file: "src/server/server-auth.ts",
    find:
      "          if (u.protocol === o.protocol && u.host === o.host) return true;",
    replace: "          if (u.hostname === o.hostname) return true;",
    test: "tests/cross-origin-http-gate.test.ts",
    filter:
      "allowedOrigins: a full-origin entry admits exactly that origin; a bare hostname any port",
  },
  {
    what:
      "with per-user auth, one user's error text (a dev diag frame) reaches every other user's socket",
    file: "src/server/server.ts",
    find: "          if (!rawStateControlAllowed(meta.user)) continue;",
    replace: "          if (false) continue;",
    test: "tests/diag-per-user-admin-only.test.ts",
    filter:
      "diag: a user's reduce error reaches admin sockets, never another user's",
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
      "the machine root stops being NAME-CONSTRAINED \u2014 a CA the user was asked to install in their trust store can then vouch for ANY site on the internet, which is what made Superfish and eDellRoot catastrophic rather than merely untidy",
    // The constraints are what make `am trust` a reasonable thing to ask of a
    // person. Present-but-unenforced would pass every parse-and-compare test;
    // only verifying a leaf for a PUBLIC name can tell the difference.
    file: "src/server/x509.ts",
    find: "      nameConstraints(opts.permittedDns, opts.permittedIpMasks),",
    replace: "      // mutated: the root is unconstrained",
    test: "tests/x509.test.ts",
    filter:
      "the name constraints BITE: a public name under this root is refused",
  },
  {
    what:
      "the SAN reader stops reading the certificate and answers from nowhere \u2014 a cached cert is judged against addresses it never carried, so it is either re-issued every boot (breaking every pinned client) or kept while stale (a handshake failure on an app nobody edited)",
    file: "src/server/tls.ts",
    find: "  return Deno.readTextFile(certPath).then(certSubjectAltNames);",
    replace: "  return Deno.readTextFile(certPath).then(() => null);",
    test: "tests/tls-no-external-binary.test.ts",
    filter: "a full auto-TLS boot succeeds with an empty PATH",
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
    // The default lives in the ONE decider since 1.0.6 (config-sources.ts).
    file: "src/server/config-sources.ts",
    find: '  pickOr(false, ["flag", cli.expose], ["config", config.expose]);',
    replace: '  pickOr(true, ["flag", cli.expose], ["config", config.expose]);',
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
    // `recordValue`'s own walk, not either call site: the set trap and the
    // array-op args both record through it, so one entry covers both doors.
    find: "  const value = walk(v, []);",
    replace: "  const value = v;",
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
    filter:
      "persist: a row SQLite refuses holds its own cell, and every other cell still persists",
  },
  {
    what:
      "a corrupt SQLite file is opened and served \u2014 the app returns half the data and writes on top of the damage, with no quarantine copy kept",
    file: "src/server/db-integrity.ts",
    find: "      checked = await opts.db.checkIntegrity();",
    replace: "      checked = { ok: true, problems: [] };",
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
    find: "  const actual = await sha256Hex(bytes);",
    replace: "  const actual = expected;",
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
    find: "    if (guardRejections && (isBootComplete?.() ?? true)) {",
    replace:
      "    if (false && guardRejections && (isBootComplete?.() ?? true)) {",
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
    find: "        [`${prefix}${SEP}`, `${prefix}${AFTER_SEP}`],", // aio-ok: the literal SOURCE line this mutation patches in and out
    replace: "        [prefix, `${prefix}${AFTER_SEP}`],", // aio-ok: the literal SOURCE line this mutation patches in and out
    test: "tests/skv-sqlite.test.ts",
    filter: "sqliteKv: prefixes never bleed into each other",
  },
  {
    what:
      "journal compaction eats the newest un-snapshotted action, so the one write a crash was supposed to replay is the one that cannot be",
    file: "src/server/journal.ts",
    find: "          e.seq > s || (cellWm.size > 0 && e.seq > governing(e));",
    replace:
      "          e.seq > s + 1 || (cellWm.size > 0 && e.seq > governing(e));",
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
    // The invariant MOVED in alpha76: the correlation id is minted in
    // `dispatchNetwork`, for all three doors at once, instead of privately by
    // the trojan route — which is why the WS and UDS doors were reporting
    // `{ok:true, value:undefined}` for an async method that threw while the
    // operator's door answered honestly.
    file: "src/server/aio-server.ts",
    find: "      cellId && Object.hasOwn(asyncMethods, cellId) &&",
    replace: "      false && Object.hasOwn(asyncMethods, cellId) &&",
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
    find:
      "  const narrowed = narrowStringPatches(prev, narrowArrayPatches(prev, ops));",
    replace: "  const narrowed = narrowArrayPatches(prev, ops);",
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
  {
    what:
      "a peer that stopped reading is skipped by broadcastRaw instead of closed — it misses a sync op, moves its cursor past it and silently diverges forever",
    file: "src/server/server-broadcast.ts",
    find: "        _closeNotDraining(ws, meta);",
    replace: "        void _closeNotDraining;",
    test: "tests/ws-raw-broadcast-backlog.test.ts",
    filter:
      "ws backlog: broadcastRaw stops feeding a peer that never reads, and closes it so it resyncs",
  },
  {
    what:
      "a frozen client that recovers on an IDLE app is never resynced — its skipped rounds are lost and it shows stale state until some unrelated write happens",
    file: "src/server/server-broadcast.ts",
    find: "    resyncRecovered,",
    replace: "    (_id: string) => {},",
    test: "tests/frozen-client-recovery-resync.test.ts",
    filter:
      "vitals: a frozen client that recovers on an IDLE app is resynced immediately",
  },
  {
    what:
      "the sync engine prunes and retries a refused op itself — every op lost at the pending cap is reported twice, and a 'N changes were lost' banner doubles",
    file: "src/sync/sync-engine.ts",
    find: "        const accepted = await deps.buffer.add(op);",
    replace:
      "        let accepted = await deps.buffer.add(op); if (!accepted) { await deps.buffer.pruneConfirmed(cell); accepted = await deps.buffer.add(op); }",
    test: "tests/sync/cap-drop-reported-once.test.ts",
    filter: "sync cap: a refused op fires onDrop exactly once",
  },
  {
    what:
      "with per-user auth, the time-travel flush sends every user's action log (types, timings, error text) to every other user's socket",
    file: "src/server/server-broadcast.ts",
    find:
      "        if (meta.perUserAuth && !rawStateControlAllowed(meta.user)) continue;",
    replace:
      "        if (meta.perUserAuth && !rawStateControlAllowed(meta.user) && Date.now() < 0) continue;",
    test: "tests/tt-state-per-user-admin-only.test.ts",
    filter:
      "tt-state: a user's action log reaches admin sockets, never another user's — on flush and on connect",
  },
  {
    what:
      "with per-user auth, a socket's connect greeting hands a non-admin the whole time-travel history of every user",
    file: "src/server/server-ws.ts",
    find: "        !(meta.perUserAuth && !rawStateControlAllowed(meta.user))",
    replace:
      "        !(meta.perUserAuth && !rawStateControlAllowed(meta.user) && Date.now() < 0)",
    test: "tests/tt-state-per-user-admin-only.test.ts",
    filter:
      "tt-state: a user's action log reaches admin sockets, never another user's — on flush and on connect",
  },
  {
    what:
      "the WebSocket Origin gate drifts from originVerdict, the decider the HTTP gate reads — aio's own Electron dev window (aio://app) is refused its socket while HTTP admits it",
    file: "src/server/server-ws.ts",
    find: "      const verdict = originVerdict(origin, {",
    replace:
      '      const verdict = origin.startsWith("aio:") ? { status: 403 as const, reason: "" } : originVerdict(origin, {',
    test: "tests/ws-origin-one-decider.test.ts",
    filter:
      "ws origin: the upgrade gate answers exactly what originVerdict answers — aio://app included",
  },
  {
    what:
      "the sync handler keeps writing sync-res / acks / whole-cell pushes to a peer that stopped reading — unbounded server heap per stuck sync client",
    file: "src/sync/server-handler.ts",
    find: "    if (!gone && held > SYNC_SOCKET_HIGH_WATER) {",
    replace: "    if (!gone && held < 0) {",
    test: "tests/sync-send-high-water.test.ts",
    filter:
      "sync sendTo: a peer over the high-water mark is closed 1013, not written to; a draining one is answered",
  },
  {
    what:
      "a notify() storm keeps queueing toasts for a peer that stopped reading, and counts them as shown",
    file: "src/server/server-broadcast.ts",
    find: "          (dropped ??= []).push(meta);",
    replace: "          (dropped ??= []).push(meta); ws.send(raw); n++;",
    test: "tests/ws-notify-backlog.test.ts",
    filter:
      "broadcastUi: a toast skips a peer over the high-water mark, keeps it open, says so once, and counts only deliveries",
  },
  {
    what:
      "a client's cdiag frame stores a failure count no client can have (negative, fractional, infinite) and /__aio/health reports it as fact",
    file: "src/diagnostics/degraded.ts",
    find:
      '  const failures = typeof f === "number" && Number.isFinite(f) && f > 0',
    replace: '  const failures = typeof f === "number"',
    test: "tests/cdiag-client-origin.test.ts",
    filter:
      "cdiag: impossible numbers are not reported as fact, and the report is attributed to its client in the server log",
  },
  {
    what:
      "a client's cdiag report turns /__aio/health degraded with nothing in the server log saying which client (or user) claimed it",
    file: "src/diagnostics/degraded.ts",
    find: "  if (said.has(name) || said.size >= CLIENT_CAP_PER_CLIENT) return;",
    replace: "  if (said.has(name) || said.size >= 0) return;",
    test: "tests/cdiag-client-origin.test.ts",
    filter:
      "cdiag: impossible numbers are not reported as fact, and the report is attributed to its client in the server log",
  },
  {
    what:
      "a closed Electron window's cdiag report stays on /__aio/health as degraded until the process restarts — the UDS router never cleared a gone peer's record",
    file: "src/server/uds.ts",
    find: "  if (client) _clearClientDegraded(client.id);",
    replace: "  if (client && Date.now() < 0) _clearClientDegraded(client.id);",
    test: "tests/uds-cdiag-client-origin.test.ts",
    filter:
      "uds cdiag: impossible numbers are not reported as fact, the report is attributed once per name, and a gone peer's report is cleared",
  },
  {
    what:
      "a notify() raised inside a signed-in user's call reaches every other user's screen and nothing ever says so",
    file: "src/server/aio-dispatch.ts",
    find: "    warn(notifyCrossUserNotice());",
    replace: "    void notifyCrossUserNotice;",
    test: "tests/notify-per-user-notice.test.ts",
    filter:
      "notify: raised in a signed-in user's call → delivered app-wide as documented, and named once",
  },
  {
    what:
      "the same notify() moved into a `worker: true` cell reaches every other user's screen and nothing says so — only the dispatch loop's router knew the notice",
    file: "src/server/aio.ts",
    find: "              _workerUserCalls > 0,",
    replace: "              _workerUserCalls < 0,",
    test: "tests/worker-notify-per-user-notice.test.ts",
    filter:
      "notify from a REAL worker cell: raised in a signed-in user's call → delivered app-wide, and named once",
  },

  // ─── v1.0.10: what that release claimed, each one broken on purpose ─────
  // A release that adds mechanism adds ledger rows, or its claims are only
  // as good as the day they were written. These are 1.0.10's.

  // sync crash and upgrade
  {
    what:
      "a sync op a kill caught between its persist and its commit has its listensTo reaction re-applied to a store listener whose store ALREADY saved it — the recovered tally counts that op twice (11 for 10), silently",
    file: "src/server/op-placement.ts",
    find: '    return listener.storeWm < op.intentSeq ? "apply" : "held";',
    replace: '    return listener.storeWm < Infinity ? "apply" : "held";',
    test: "tests/journal-sync-op-in-flight.test.ts",
    filter:
      "sync op in flight at a kill, the store saved after its persist: its reaction there is held and named, never applied on a guess",
  },
  {
    what:
      "the store's reactions stamp stops counting as 'this build's data' — once the journal compacts empty, every boot after the first 1.0.10 boot over 1.0.9 data warns 'last run by an older aio build' again, forever",
    file: "src/server/aio.ts",
    find: "    const ours = await reactionsFormat(asyncDb) !== undefined ||",
    replace: "    const ours = await reactionsFormat(asyncDb) === -1 ||",
    test: "tests/journal-upgrade-compat.test.ts",
    filter:
      "journal upgrade: the store's stamp outlives the journal — once its stamped lines are compacted away, the next boot is not an upgrade again",
  },
  {
    what:
      "an op the boot NAMED as uncovered is never committed — every later boot names the same listensTo listeners again ('cannot tell whether …'), so the one-time upgrade warning becomes permanent noise",
    file: "src/server/aio.ts",
    find:
      "          if (_marking) _unmarked.push({ cell: c, id: r.id, ts: r.server_ts });",
    replace:
      "          if (!_marking) _unmarked.push({ cell: c, id: r.id, ts: r.server_ts });",
    test: "tests/journal-upgrade-compat.test.ts",
    filter:
      "journal upgrade (clean-stop): v1.0.9 data — nothing re-derived, nothing counted twice, every listener that may lack reactions named — twice",
  },
  {
    what:
      "a journal a crash left, found by a journal-OFF run, is copied aside but left in place — the next journal-on boot replays it over everything the off run saved, with the warning still saying it was moved",
    file: "src/server/aio-boot.ts",
    find: "  j.quarantine(to);",
    replace: "  Deno.copyFileSync(j.path, to);",
    test: "tests/journal-toggle-stale.test.ts",
    filter:
      "journal on → killed → journal OFF, clean → journal on: the off run's data is kept — sync and store cells",
  },

  // am means its exit code
  {
    what:
      "a failing am verb whose error is thrown to the dispatcher exits 0, so `am x && deploy` walks on into the wreck — every thrown-error verb at once",
    file: "src/am.ts",
    find:
      "outError(e instanceof Error ? e.message : String(e), detectMode(flags));\n    Deno.exit(1);",
    replace:
      "outError(e instanceof Error ? e.message : String(e), detectMode(flags));\n    Deno.exit(0);",
    test: "tests/am-exit-code-sweep.test.ts",
    filter:
      "am exit-code sweep: every verb fails with its exit code, no success doc, and names what failed",
  },
  {
    what:
      "every am failure prints a success document instead of an error doc, so a script parsing --json reads a failed command as done",
    file: "src/am/am-output.ts",
    find:
      "sayData(JSON.stringify(fix ? { error: msg, fix } : { error: msg }));",
    replace: "sayData(JSON.stringify(fix ? { ok: true, fix } : { ok: true }));",
    test: "tests/am-exit-code-sweep.test.ts",
    filter:
      "am exit-code sweep: every verb fails with its exit code, no success doc, and names what failed",
  },
  {
    what:
      "`am remove` of an app that is not installed exits 0, so `am remove x && reinstall` believes the removal happened (the 1.0.9 class)",
    file: "src/am/am-cmd-remove.ts",
    find:
      "      mode,\n    );\n    Deno.exit(1);\n  }\n\n  // Data is unrecoverable",
    replace:
      "      mode,\n    );\n    Deno.exit(0);\n  }\n\n  // Data is unrecoverable",
    test: "tests/am-exit-code-sweep.test.ts",
    filter:
      "am exit-code sweep: every verb fails with its exit code, no success doc, and names what failed",
  },

  // one persist decider, and persist:"none" really gone
  {
    what:
      'the server host writes the whole composed state around the persist filter, so a persist:"none" session token or passphrase is fsync\'d to disk and restored on the next boot (the 1.0.7 shape)',
    file: "src/server/aio-composition.ts",
    find: "  const autoGetDBState = buildDBStateGetter(composed);",
    replace: "  const autoGetDBState = (s: unknown): unknown => s;",
    test: "tests/persist-decider.test.ts",
    filter:
      "persist-decider: src/ is clean — every host routes through cell-persist-filter.ts",
  },
  {
    what:
      "an older build's persist:\"none\" slice is deleted but not vacuumed, so the secret's older revisions stay readable as bytes in freed SQLite pages",
    file: "src/server/aio-boot.ts",
    find:
      '  await db.execute("VACUUM");\n  await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");',
    replace:
      '  await Promise.resolve();\n  await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");',
    test: "tests/hosts.test.ts",
    filter: 'hosts: server — persist:"none" never kept, last write drained',
  },
  {
    what:
      'boot never scrubs a persist:"none" slice an older build left behind, so the secret stays on disk until some later write happens to reuse its pages',
    file: "src/server/aio-boot.ts",
    find: "        if (stale.length > 0) {\n          await scrubStaleSlices(",
    replace:
      "        if (stale.length < 0) {\n          await scrubStaleSlices(",
    test: "tests/hosts.test.ts",
    filter: 'hosts: server — persist:"none" never kept, last write drained',
  },

  // profiles and the instance lock
  {
    what:
      "the home claim stops refusing a DIFFERENT lock on the same folder — a profile by path and one by name, or two lock keys deriving one home, both open one state.db",
    file: "src/server/single-instance-lock.ts",
    find: "    if (mine !== undefined && holder?.lock === mine) return none;",
    replace: "    if (mine !== undefined) return none;",
    test: "tests/profile-home-identity.test.ts",
    filter: "claimHome: only the EXACT lock just judged may share the home",
  },
  {
    what:
      "boot stops taking the in-home OS claim — an appDir app started under two AIO_APPS_DIR scopes (two lock dirs) runs twice on one database",
    file: "src/server/aio-run-helpers.ts",
    find:
      "  const claim = claimHome(appLock.home, { appId, port, key: appLock.key });",
    replace:
      "  const claim = { ok: true, close: () => {} } as ReturnType<typeof claimHome>;",
    test: "tests/profile-runtime-flag.test.ts",
    filter:
      "bug: an appDir app from two AIO_APPS_DIR scopes never opens one database twice",
  },
  {
    what:
      "a named profile stops getting its own folder — `--profile=dev` boots on the app's REAL data, the one thing a profile exists to keep apart",
    file: "src/server/app-dirs.ts",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    find: "  return `${resolve(appDir ?? appHome(appId))}-${profile}`;",
    replace: "  return `${resolve(appDir ?? appHome(appId))}`;",
    test: "tests/profile-runtime-flag.test.ts",
    filter:
      "runtime: --profile=dev / AIO_PROFILE=dev boot in <base>-dev, stamped, keyed <appId>@dev",
  },
  {
    what:
      "the lock dir is named after the raw AIO_APPS_DIR string — two spellings of one apps root are two lock dirs, so a second instance boots on the same data and am says 'not running' about a live app",
    file: "src/server/single-instance-lock.ts",
    find:
      '  // an app whose data it could see.\n  const appsRoot = appsDirEnv() ?? "";',
    replace:
      '  // an app whose data it could see.\n  const appsRoot = Deno.env.get("AIO_APPS_DIR") ?? "";',
    test: "tests/apps-dir-spellings-one-lock-dir.test.ts",
    filter:
      "AIO_APPS_DIR spellings: one lock dir and one CA root, whichever cwd-relative form",
  },
  {
    what:
      "meta.json ownership is ignored — profile `dev` of `myapp` and the real app `myapp-dev` derive one folder under different lock keys and share its database",
    file: "src/server/app-dirs.ts",
    find: "  if (meta.appId === appId && had === profile) return null;",
    replace: '  if (typeof had !== "symbol") return null;',
    test: "tests/profile-home-identity.test.ts",
    filter: "meta.json ownership: two names deriving one folder never share it",
  },
  {
    what:
      "a derived home that is another program's directory (~/.ssh, /var/lib/dpkg) is accepted — the app writes state.db, keys and logs among its files",
    file: "src/server/app-dirs.ts",
    find: "  if (entries.some((n) => AIO_HOME_ENTRIES.has(n))) return null;",
    replace: "  if (entries.length > 0) return null;",
    test: "tests/app-home-foreign-dir-refused.test.ts",
    filter:
      "foreignAppHomeError: absent, empty and aio-owned homes pass; another program's directory does not",
  },
  {
    what:
      "am start --profile stops forwarding the profile as ARGV — the child boots on the app's real home, and an older runtime can no longer refuse the unknown flag",
    file: "src/am/am-cmd-process.ts",
    find: "    if (pa) passthrough.push(pa);",
    replace: "    if (pa) void pa;",
    test: "tests/am-profile-roundtrip.test.ts",
    filter: "am --profile: start, list, bare stop spares it, pr@dev stops it",
  },
  {
    what:
      "lock publication stops being exclusive — two racing instances both believe they hold the lock and open one state.db",
    file: "src/server/single-instance-lock.ts",
    find:
      "    Deno.linkSync(tmp, path);\n    return true;\n  } catch (e) {\n    if (e instanceof Deno.errors.AlreadyExists) return false;",
    replace:
      "    Deno.linkSync(tmp, path);\n    return true;\n  } catch (e) {\n    if (e instanceof Deno.errors.AlreadyExists) return true;",
    test: "tests/single-instance-lock-exclusive.test.ts",
    filter: "single-instance lock: 6 racers on a barrier, never two holders",
  },

  // SSR route, CLI token, Electron death, unsaved acks
  {
    what:
      "renderToStream reads the route at first pull again — a handler that awaits before streaming serves the NEXT visitor's page (and their reset token)",
    file: "src/air/ssr-stream.ts",
    find: "    if (_inSsrCall()) {",
    replace: "    if (_inSsrCall() || !Number.isNaN(0)) {",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR stream: a route set by another request after this call's turn never reaches it",
  },
  {
    what:
      "the CLI client puts its token in the WS URL — it lands in proxy logs and in its own retry line",
    file: "src/server/cli-client.ts",
    find: '    const inHeader = !!token && typeof Deno !== "undefined";',
    replace: '    const inHeader = !!token && typeof Deno === "undefined";',
    test: "tests/aio-403-cli-client-remote.test.ts",
    filter: "aio-403: connectCli preserves ?token= from the share-link URL",
  },
  {
    what:
      "a crashed Electron window exits 0 — a launcher or supervisor sees a user close, not a crash",
    file: "src/server/aio-lifecycle.ts",
    find: "if (plan.stop) stopProcess(plan.exitCode);",
    replace: "if (plan.stop) stopProcess(0);",
    test: "tests/electron-crash-exit.test.ts",
    filter: "electron window dies of SIGTRAP → app exit 1, state saved",
  },
  {
    what:
      "a crashed Electron window is logged at INFO with no cause — the crash is invisible in the log",
    file: "src/server/aio-lifecycle.ts",
    find: "            if (plan.crashed) {",
    replace: "            if (!plan.crashed && plan.crashed) {",
    test: "tests/electron-crash-exit.test.ts",
    filter: "electron window dies of SIGTRAP → app exit 1, state saved",
  },
  {
    what:
      "a sync call whose stand-in save failed is acked clean at every door — the write is lost silently",
    file: "src/server/aio.ts",
    find:
      "if (why !== undefined) _noteUnsaved(action as object, undefined, why);",
    replace:
      'if (why === "never") _noteUnsaved(action as object, undefined, why);',
    test: "tests/journal-owed-saves-all-callers.test.ts",
    filter:
      "owed saves: a stand-in save that failed is `unsaved` at every door, alike",
  },
  {
    what:
      "an unsaved write REJECTS the call instead of resolving — a call that ran reads as one that did not",
    file: "src/server/aio.ts",
    find:
      "if (why !== undefined) _noteUnsaved(action as object, undefined, why);",
    replace: "if (why !== undefined) throw new Error(why);",
    test: "tests/journal-owed-saves-all-callers.test.ts",
    filter:
      "owed saves: a stand-in save that failed is `unsaved` at every door, alike",
  },
  {
    what:
      "an async call whose save failed is acked clean — the write is lost silently",
    file: "src/server/aio.ts",
    find: "if (why !== undefined) _noteUnsaved(undefined, callId, why);",
    replace: 'if (why === "never") _noteUnsaved(undefined, callId, why);',
    test: "tests/journal-owed-saves-all-callers.test.ts",
    filter:
      "owed saves: a stand-in save that failed is `unsaved` at every door, alike",
  },
  {
    what:
      "the WS ack drops `unsaved` — a browser tab believes a lost write was saved",
    file: "src/server/server-ws.ts",
    find: "const unsaved = _dispatchUnsaved(action);",
    replace: "const unsaved = undefined as string | undefined;",
    test: "tests/journal-owed-saves-all-callers.test.ts",
    filter:
      "owed saves: a stand-in save that failed is `unsaved` at every door, alike",
  },
  {
    what:
      "the UDS ack (Electron) drops `unsaved` — a desktop window believes a lost write was saved",
    file: "src/server/uds.ts",
    find: "const unsaved = _dispatchUnsaved(action);",
    replace: "const unsaved = undefined as string | undefined;",
    test: "tests/aio-402-uds-ack.test.ts",
    filter:
      "aio-402: a UDS ack carries `unsaved` when what the call wrote could not be saved — same as the WS ack",
  },
  {
    what: "a browser tab resolves an unsaved call without a word",
    file: "src/browser/browser-air-commands.ts",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    find: 'typeof d.unsaved === "string" ? `NOT SAVED — ${d.unsaved}` : null,',
    replace:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      'typeof d.unsaved === "number" ? `NOT SAVED — ${d.unsaved}` : null,',
    test: "tests/aio-399-ack-routing.test.ts",
    filter:
      "routeCommand: an ok ack carrying `unsaved` / `short` resolves AND warns, once per call",
  },
  {
    what:
      "am dispatch answers no `unsaved` for a call whose own stand-in save failed — the store's last verdict is clean, so the lost write reads as saved",
    file: "src/server/server-trojan.ts",
    find: "      const owedUnsaved = _dispatchUnsaved(action);",
    replace: "      const owedUnsaved = undefined as string | undefined;",
    test: "tests/journal-owed-saves-all-callers.test.ts",
    filter:
      "owed saves: the trojan reply's `unsaved` is THIS call's failed save, not only the store's last verdict",
  },
  {
    what:
      "a stream reads the route at its first pull — a handler that awaits a session before streaming serves the next visitor's page",
    file: "src/air/ssr-stream.ts",
    find: "    if (_inSsrCall()) {",
    replace: "    if (_inSsrCall() || !Number.isNaN(0)) {",
    test: "tests/air-ssr-stream-route-snapshot.test.ts",
    filter:
      "SSR route snapshot: two interleaved streams each render their own request's route",
  },

  // the release gate keeps what 1.0.10 added to it
  {
    what:
      "check:release silently drops the hosts matrix — every host's persist and drain claims ship unchecked",
    file: "scripts/release-check.ts",
    find: '["test:hosts", ["deno", "task", "test:hosts"]],',
    replace: "",
    test: "tests/ci-mirrors-release-check.test.ts",
    filter:
      "ci: check:release keeps its required lanes, and only the lab may skip",
  },
  {
    what:
      "check:release silently drops the SSR overlap soak — a stream serving another visitor's page ships unchecked",
    file: "scripts/release-check.ts",
    find: '["test:ssr-soak", ["deno", "task", "test:ssr-soak"]],',
    replace: "",
    test: "tests/ci-mirrors-release-check.test.ts",
    filter:
      "ci: check:release keeps its required lanes, and only the lab may skip",
  },
  {
    what:
      "check:release silently drops the sync lane — crash replay and double counting ship unchecked",
    file: "scripts/release-check.ts",
    find: '["test:sync", ["deno", "task", "test:sync"]],',
    replace: "",
    test: "tests/ci-mirrors-release-check.test.ts",
    filter:
      "ci: check:release keeps its required lanes, and only the lab may skip",
  },
  {
    what:
      "check:release silently drops dead-wiring, and the persist decider that rides inside it — a host writing around the persist filter ships",
    file: "scripts/release-check.ts",
    find: '["check:dead-wiring", ["deno", "task", "check:dead-wiring"]],',
    replace: "",
    test: "tests/ci-mirrors-release-check.test.ts",
    filter:
      "ci: check:release keeps its required lanes, and only the lab may skip",
  },
  {
    what:
      "check:release silently drops this ledger — every invariant above is unguarded again",
    file: "scripts/release-check.ts",
    find: '["check:mutations", ["deno", "task", "check:mutations"]],',
    replace: "",
    test: "tests/ci-mirrors-release-check.test.ts",
    filter:
      "ci: check:release keeps its required lanes, and only the lab may skip",
  },
  {
    what:
      "the persist decider stops running inside check:dead-wiring — a raw getDBState passes every gate",
    file: "scripts/check-dead-wiring.ts",
    find: "  const persist = persistCheck(",
    replace:
      "  const persist = ((_: unknown) => [] as ReturnType<typeof persistCheck>)(",
    test: "tests/ci-mirrors-release-check.test.ts",
    filter:
      "ci: check:release keeps its required lanes, and only the lab may skip",
  },
  // no app key in a log line
  {
    what:
      "the CLI health probe sends no credential — on an app with accounts health refuses it, and the port-reuse guard quietly answers 'no opinion' for every keyed server",
    file: "src/server/cli-client.ts",
    find:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      "        t ? { headers: { authorization: `Bearer ${t}` } } : undefined,",
    replace: "        undefined,",
    test: "tests/no-token-in-logs.test.ts",
    filter:
      "cli health probe: the key (opts.token) rides as Bearer, never in the URL",
  },
  {
    what:
      "the CLI health probe puts the app key in its URL — it lands in every proxy and access log between the client and the app",
    file: "src/server/cli-client.ts",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    find: "        `${scheme}//${parsed.host}/__aio/health`,",
    replace:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      '        `${scheme}//${parsed.host}/__aio/health${t ? `?token=${t}` : ""}`,',
    test: "tests/no-token-in-logs.test.ts",
    filter:
      "cli health probe: the key (opts.token) rides as Bearer, never in the URL",
  },
  {
    what:
      "the CLI's 'a DIFFERENT app' refusal prints the share link it was given, app key included, into the terminal and any captured log",
    file: "src/server/cli-client.ts",
    find:
      "      const shown = redactUrlToken(url); // a share link carries its key",
    replace: "      const shown = url; // a share link carries its key",
    test: "tests/no-token-in-logs.test.ts",
    filter:
      "cli client: the 'DIFFERENT app' refusal does not print the share link's key",
  },
  {
    what:
      "'Electron not installed' prints the local URL with the app key — the error line users paste into bug reports hands out the key",
    file: "src/server/aio-lifecycle.ts",
    find:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      "    `server is up meanwhile at ${redactUrlToken(electronUrl)} — open it ` +",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    replace: "    `server is up meanwhile at ${electronUrl} — open it ` +",
    test: "tests/no-token-in-logs.test.ts",
    filter:
      "no-token-in-logs: 'Electron not installed' shows the URL without its key",
  },
  {
    what:
      "the forced aio:// warning in the generated Electron main prints the app key into the app log",
    file: "src/electron/electron-uds.ts",
    find: "proxied to ' + HTTP_URL_SHOWN);",
    replace: "proxied to ' + HTTP_URL);",
    test: "tests/no-token-in-logs.test.ts",
    filter: "no-token-in-logs: the generated UDS main script logs no token",
  },
  {
    what:
      "a failed page load in the Electron window logs its URL with the app key",
    file: "src/electron/electron-uds.ts",
    find: "navigation to ' + _shownUrl(failedUrl) + ' failed",
    replace: "navigation to ' + failedUrl + ' failed",
    test: "tests/no-token-in-logs.test.ts",
    filter: "no-token-in-logs: the generated UDS main script logs no token",
  },
  {
    what: "every window the Electron shell opens logs its URL with the app key",
    file: "src/electron/electron-uds.ts",
    find: "openWindow → ' + _shownUrl(u.href) +",
    replace: "openWindow → ' + u.href +",
    test: "tests/no-token-in-logs.test.ts",
    filter: "no-token-in-logs: the generated UDS main script logs no token",
  },
  {
    what:
      "the thin client's launch line prints the --server-url key into the log",
    file: "src/electron/electron-spawn.ts",
    find:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      '  log.info(`launching aio client${url ? ` → ${redactUrlToken(url)}` : ""}`);',
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    replace: '  log.info(`launching aio client${url ? ` → ${url}` : ""}`);',
    test: "tests/no-token-in-logs.test.ts",
    filter:
      "no-token-in-logs: the thin client's launch line hides a --server-url key",
  },
  {
    what: "'connecting to' prints the --server-url key into the log",
    file: "src/server/aio-run-helpers.ts",
    find:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      "  if (serverUrl) log.info(`connecting to ${redactUrlToken(serverUrl)}`);",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    replace: "  if (serverUrl) log.info(`connecting to ${serverUrl}`);",
    test: "tests/no-token-in-logs.test.ts",
    filter:
      "no-token-in-logs: --server-url's 'connecting to' line hides the key",
  },
  {
    what:
      "the one URL-token redactor redacts nothing — every log site that trusts it prints the app key",
    file: "src/diagnostics/redact.ts",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    find: "  return text.replace(URL_TOKEN, `$1${TOKEN_MASK}`);",
    replace: "  return text;",
    test: "tests/no-token-in-logs.test.ts",
    filter:
      "no-token-in-logs: redactUrlToken hides the value and keeps the rest",
  },
  // 1.0.11: the sync-line warning, the scrub said once, profiles spared
  {
    what:
      "a listensTo pair across the sync line boots silently under aio.run — the listener's reactions replicate (or lag) differently from its source's and nobody said so",
    file: "src/server/aio-cells-bridge.ts",
    find:
      "    for (const line of syncListensMismatches(composed.cells)) log.warn(line);",
    replace:
      "    for (const line of syncListensMismatches([])) log.warn(line);",
    test: "tests/sync-listens-mismatch-warns.test.ts",
    filter: "aio.run (testServer) warns once per mismatched pair at boot",
  },
  {
    what:
      "the test harnesses stop saying the sync-mismatch line aio.run says — a test env quieter than production",
    file: "src/testing/boot-refusals.ts",
    find:
      "  for (const line of syncListensMismatches(composed.cells)) log.warn(line);",
    replace: "  for (const line of syncListensMismatches([])) log.warn(line);",
    test: "tests/sync-listens-mismatch-warns.test.ts",
    filter:
      "bootCells says the same line as aio.run — and nothing when all agree",
  },
  {
    what:
      "a mismatched pair is said once per ACTION, not once per pair — one real warning drowns in repeats",
    file: "src/server/aio-cells-bridge.ts",
    find:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      "      if (lSync === !!source.__aio.syncConfig || said.has(`${l}\\0${s}`)) {",
    replace: "      if (lSync === !!source.__aio.syncConfig) {",
    test: "tests/sync-listens-mismatch-warns.test.ts",
    filter:
      "syncListensMismatches: one line per mismatched pair, none for agreeing pairs",
  },
  {
    what:
      "an op the boot NAMED is never committed (before-fold upgrade) — every later boot names the same listeners again, forever",
    file: "src/server/aio.ts",
    find:
      "          if (_marking) _unmarked.push({ cell: c, id: r.id, ts: r.server_ts });",
    replace:
      "          if (!_marking) _unmarked.push({ cell: c, id: r.id, ts: r.server_ts });",
    test: "tests/journal-upgrade-compat.test.ts",
    filter:
      "journal upgrade (before-fold): v1.0.9 data — nothing re-derived, nothing counted twice, every listener that may lack reactions named — twice",
  },
  {
    what:
      'the persist:"none" scrub (secure_delete + VACUUM of the whole db) runs on EVERY boot — a large app pays a full rewrite of its database at each start',
    file: "src/server/aio-boot.ts",
    find: "        if (stale.length > 0) {",
    replace: "        if (stale.length >= 0) {",
    test: "tests/persist-none-scrub-once.test.ts",
    filter:
      'persist:"none": an older build\'s slice is scrubbed on the first boot, said once — the second boot says and scrubs nothing',
  },
  {
    what:
      'the persist:"none" scrub happens without a word — the operator never learns a secret was on disk',
    file: "src/server/aio-boot.ts",
    find: "            .then(() =>\n              log.info(",
    replace: "            .then(() =>\n              log.debug(",
    test: "tests/persist-none-scrub-once.test.ts",
    filter:
      'persist:"none": an older build\'s slice is scrubbed on the first boot, said once — the second boot says and scrubs nothing',
  },
  {
    what:
      "am remove --data deletes a profile's data home too — `--profile=dev`'s data gone with the app's, which the command promises to keep",
    file: "src/am/am-cmd-remove.ts",
    find: "      await Deno.remove(dataDir, { recursive: true });",
    replace:
      "      await Deno.remove(dataDir, { recursive: true }); for (const p of profileHomesOf(name)) await Deno.remove(p, { recursive: true });",
    test: "tests/am-remove-spares-profiles.test.ts",
    filter:
      "am remove --data --force: the app's data goes, its profile homes stay — and are named",
  },
  // SSR: the shared-promise race is said on read, and never silent for good
  {
    what:
      "a request that sets its route, awaits a promise another request shares, then renders, serves the OTHER request's page without a word (the row-2 read check is gone)",
    file: "src/air/vdom-ssr.ts",
    find: "  render.routeForeign = _ssrRouteForeign(ctx) ? new Error() : null;",
    replace: "  render.routeForeign = null;",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR route contract (1.0.11, documented): two overlapping streams + a shared promise — which page each renders, and what is said",
  },
  {
    what:
      "the route check fires on pages that never read the route — every 404 shell and email render warns, and the real warning drowns",
    file: "src/air/vdom-ssr.ts",
    find: "  render.routeForeign = _ssrRouteForeign(ctx) ? new Error() : null;",
    replace:
      "  render.routeForeign = _ssrRouteForeign(ctx) ? new Error() : null if (render.routeForeign) { const p = _ssrRenderEnter(render); _ssrRouteRead(); _ssrRenderEnter(p); }",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR route contract over HTTP: correct handlers and pages that never read the route are never warned",
  },
  {
    what:
      "a route change the end-of-turn re-read already reported is said twice, late and on read — one mistake, two alarms",
    file: "src/air/vdom-ssr.ts",
    find:
      "            r && (changed || _ssrRouteWrittenSince(r.routeCtx, r.routeSince))",
    replace:
      "            r && (false || _ssrRouteWrittenSince(r.routeCtx, r.routeSince))",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR route contract: a route written after an await is said on read; create-then-set in the call's own step is not the read check's",
  },
  {
    what:
      "the 1.0.9 create-then-set pattern (same value) is warned falsely — a documented-safe app is told it is broken",
    file: "src/air/vdom-ssr.ts",
    find:
      "            r && (changed || _ssrRouteWrittenSince(r.routeCtx, r.routeSince))",
    replace: "            r && (changed || false)",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR route contract: a route written after an await is said on read; create-then-set in the call's own step is not the read check's",
  },
  {
    what:
      "a route written after an await is excused as the call's own step — the race the warning exists for is silent",
    file: "src/air/ssr-render.ts",
    find:
      "  return ctx !== undefined && last !== undefined && last.id > since &&",
    replace:
      "  return ctx !== undefined && last !== undefined && last.id > -1 &&",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR route contract: a route written after an await is said on read; create-then-set in the call's own step is not the read check's",
  },
  {
    what:
      "route warnings go silent for good after the first hit — a busy handler mis-renders every later request unannounced",
    file: "src/air/ssr-render.ts",
    find:
      "  if ((e.n & (e.n - 1)) !== 0) return null; // not a power of two: count only",
    replace: "  if (e.n > 1) return null;",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR stream: the late-route warning is counted per call site — said at the 1st, 2nd, 4th … hit, never silent for good",
  },
  {
    what:
      "the CLI client's 'cannot reach' retry line prints the socket URL raw — wherever the key cannot ride a header (a non-Deno runtime), every retry logs `?token=<key>`",
    file: "src/server/cli-client.ts",
    find: "    const shownUrl = redactUrlToken(wsUrl);",
    replace: "    const shownUrl = wsUrl;",
    test: "tests/no-token-in-logs.test.ts",
    filter: "no-token-in-logs: no log/console call in src/ prints a token",
  },
  // SSR: route-on-render — the race-free form
  {
    what:
      "a route set inside another library's AsyncLocalStorage.run() (a tracer span) and rendered in the same step is warned — correct code told it is racing",
    file: "src/air/ssr-render.ts",
    find: "  return !(last.tick === _tick && _writtenFrom(last, ctx));",
    replace: "  return true;",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR route contract: a route set inside another library's run() and rendered in the same step is not warned",
  },
  {
    what:
      "route stamps retain every write of a long synchronous loop — a static-site build over 100k pages keeps every stamp for the life of the process",
    file: "src/air/ssr-render.ts",
    find: "  const t: RouteWriter = {",
    replace: "  const t: RouteWriter & { prev?: unknown } = { prev,",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR route stamps: retention is bounded over a long synchronous loop",
  },
  {
    what:
      "an explicit route is ignored and the render routes by the global again — the one race-free form serves another request's page",
    file: "src/air/vdom-ssr.ts",
    find:
      "  return (scope?.get(SSR_ROUTE_KEY) as SsrRoute | undefined) ?? null;",
    replace: "  return null;",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: the row-2 shape (two streams + a shared promise, awaits everywhere) — each its own page, nothing said, the global untouched",
  },
  {
    what:
      "a component reading routePath.value inside an explicit-route render reads the global — the page mixes its own route with another request's",
    file: "src/air/router-core.ts",
    find: "      return r !== null ? pick(r) : global;",
    replace: "      return global;",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: renderToString routes by it too, query included, and the route signals read it inside the render",
  },
  {
    what:
      "an explicit-route render writes the global route — every global-form request in flight now reads this request's route",
    file: "src/air/router.ts",
    find: "  if (explicit !== null) return explicit;",
    replace:
      "  if (explicit !== null) { routePath.set(explicit.path); return explicit; }",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: the row-2 shape (two streams + a shared promise, awaits everywhere) — each its own page, nothing said, the global untouched",
  },
  // SSR: every read of an explicit-route render routes by it
  {
    what:
      "`{routePath}` as a child or an attribute in renderToString reads the global route — an explicit-route page links to another request's path",
    file: "src/air/vdom-ssr.ts",
    find: "    return _ssrIn(scope, () => _rts(vnode, { n: 0 }, scope));",
    replace: "    return _rts(vnode, { n: 0 }, scope);",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: a route signal as a child, an attribute or a fallback renders the render's route",
  },
  {
    what:
      "a route signal as a child in a stream reads the global route — an explicit-route stream prints another request's path",
    file: "src/air/ssr-stream.ts",
    find: "    yield _ssrIn(",
    replace: "    yield ((_s: unknown, f: () => string) => f())(",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: a route signal as a child, an attribute or a fallback renders the render's route",
  },
  {
    what:
      "a route signal as an attribute in a stream reads the global route — an explicit-route stream's href points at another request's page",
    file: "src/air/ssr-stream.ts",
    find: "  const { ownValue, open, areaText } = _ssrIn(scope, () => {",
    replace:
      "  const { ownValue, open, areaText } = ((_s: unknown, f: () => { ownValue: unknown; open: string; areaText: string | null }) => f())(scope, () => {",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: a route signal as a child, an attribute or a fallback renders the render's route",
  },
  {
    what:
      "a read under a render's route recomputes the computed's GLOBAL slot — a computed that branches on the route drops its global dependencies, and every app effect over it silently stops updating",
    file: "src/state/signal.ts",
    find: "      return _scopedValue(e) as T;",
    replace: "      this._recompute(); return this._cached as T;",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: a render reading a computed that branches on the route leaves its global subscribers intact",
  },
  {
    what:
      "effects flushed mid-render see the render's route instead of the global — an app effect acts on another request's path and drops its subscription",
    file: "src/state/signal.ts",
    find: "  if (_readScope === null) outsideServerOrigin(_flushSubscribers);",
    replace:
      "  if (_readScope === _readScope) outsideServerOrigin(_flushSubscribers);",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: module-scope computeds, trackedMemo and effects over the route are right in every render and globally",
  },
  {
    what: "a trackedMemo entry serves one render's route to another",
    file: "src/state/signal.ts",
    find: "      let byKey = scoped.get(scope);",
    replace:
      "      const g = cache.get(k); if (g) return g.value; let byKey = scoped.get(scope);",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: module-scope computeds, trackedMemo and effects over the route are right in every render and globally",
  },
  {
    what:
      "a computed evaluated inside a render drops its link to the route — it never updates again when the route changes",
    file: "src/air/router-core.ts",
    find:
      "      const global = value.get!.call(this); // tracks, in every scope",
    replace: "      const global = peek.call(this); // tracks, in every scope",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: module-scope computeds, trackedMemo and effects over the route are right in every render and globally",
  },
  {
    what:
      "options passed in renderToStream's key slot are silently ignored — the call routes by the racy global it was written to avoid",
    file: "src/air/ssr-stream.ts",
    find:
      '      opts === undefined && key !== null && typeof key === "object" &&',
    replace:
      '      opts === null && key !== null && typeof key === "object" &&',
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: renderToStream with the options in the key slot is refused",
  },
  {
    what:
      "a relative, empty or absolute route is accepted and rendered as a path — `//evil` becomes a page's route",
    file: "src/air/vdom-ssr.ts",
    find: '    typeof route !== "string" || !route.startsWith("/") ||',
    replace: '    typeof route !== "string" ||',
    test: "tests/air-ssr-soak.test.ts",
    filter: "SSR explicit route: malformed options are refused, never guessed",
  },
  {
    what:
      "a long run of route writes in the render's own step is warned — correct code told it is racing",
    file: "src/air/ssr-render.ts",
    find:
      "  return t.base === ctx.id || (ctx.tick === t.tick && ctx.base === t.base);",
    replace: "  return t.base === ctx.id;",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR route contract: a long run of writes in the render's own step is never warned",
  },
  {
    what:
      "a computed is re-evaluated on every read inside a render — under concurrent streams a heavy module computed (a sort over cell state) runs once per read",
    file: "src/state/signal.ts",
    find: "    if (hit !== undefined && _scopedFresh(hit, scope)) return hit;",
    replace:
      "    if (hit !== undefined && _scopedFresh(hit, scope) && hit.stamp < 0) return hit;",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: a computed is evaluated once per render per computed, interleaved streams included",
  },
  {
    what:
      "an effect created in a render over a computed nothing read globally never hears a later write — a silent dropped update",
    file: "src/state/signal.ts",
    find: "        _trackScoped(tracker, e, scope);",
    replace: "        void _trackScoped;",
    test: "tests/signal-scope-differential.test.ts",
    filter:
      "signal scope: a subscriber frame opened under a read scope is linked to the global graph",
  },
  // signal scope: the global graph is identical with or without route renders
  {
    what:
      "a trackedMemo read inside a render links a real subscriber to an unsettled computed — that subscriber never fires again",
    file: "src/state/signal.ts",
    find: "      if (tracker) _trackScoped(tracker, e, scope);",
    replace:
      "      if (tracker && e.stamp < 0) _trackScoped(tracker, e, scope);",
    test: "tests/signal-scope-differential.test.ts",
    filter:
      "signal scope: a subscriber frame opened under a read scope is linked to the global graph",
  },
  {
    what:
      "untrack inside a render is treated as a real subscriber — every scoped read in it walks its whole subtree into a frame that is thrown away",
    file: "src/state/signal.ts",
    find: "  if (_readScope !== null) _scopedFrames.add(throwaway);",
    replace: "  if (_readScope === null) _scopedFrames.add(throwaway);",
    test: "tests/signal-scope-differential.test.ts",
    filter: "signal scope: untrack inside a render walks nothing",
  },
  {
    what:
      "a scoped read recomputes the computed's GLOBAL slot — caught by the seeded differential, not only by the hand-written shape",
    file: "src/state/signal.ts",
    find: "      return _scopedValue(e) as T;",
    replace: "      this._recompute(); return this._cached as T;",
    test: "tests/signal-scope-differential.test.ts",
    filter:
      "signal scope differential: scoped reads never change what the global side observes",
  },
  {
    what:
      "an effect created in a render subscribes to the render's branch, not the global's — a later write on the global branch never reaches it",
    file: "src/state/signal.ts",
    find: "    if (_readScope === null) sub.execute();",
    replace: "    if (_readScope === _readScope) sub.execute();",
    test: "tests/signal-scope-differential.test.ts",
    filter:
      "signal scope differential: scoped reads never change what the global side observes",
  },
  {
    what:
      "a watch created in a render starts from the render's route value — its first change and `immediate` call report another request's route",
    file: "src/state/watch.ts",
    find: "  const inRender = _readScopeNow() !== null;",
    replace: "  const inRender = _readScopeNow() === undefined;",
    test: "tests/signal-scope-differential.test.ts",
    filter:
      "signal scope differential: scoped reads never change what the global side observes",
  },
  // signals: a memo that threw recovers; nested renders stay subscribed
  {
    what:
      "a subscriber frame under a render's route is linked only one computed deep — a render nested in an effect, over a computed branching on the route, never re-runs (caught by the differential)",
    file: "src/state/signal.ts",
    find: "      if (child !== undefined) todo.push(child);",
    replace:
      "      if (child !== undefined && child.stamp < 0) todo.push(child);",
    test: "tests/signal-scope-differential.test.ts",
    filter:
      "signal scope differential: scoped reads never change what the global side observes",
  },
  {
    what:
      "a subscriber frame under a render's route is linked only one computed deep — a render nested in an effect never re-runs when its branch's source changes",
    file: "src/state/signal.ts",
    find: "      if (child !== undefined) todo.push(child);",
    replace:
      "      if (child !== undefined && child.stamp < 0) todo.push(child);",
    test: "tests/signal-scope-differential.test.ts",
    filter:
      "signal scope: a render nested in an effect re-runs when what its route's branch read changes",
  },
  {
    what:
      "a trackedMemo whose compute throws drops its reads — an effect over it never runs again, even after the data recovers (a 1.0.10 bug)",
    file: "src/state/signal.ts",
    find: "        if (tracker) { for (const d of deps) tracker.add(d); }",
    replace: "        if (tracker) { for (const d of deps) void d; }",
    test: "tests/tracked-memo.test.tsx",
    filter:
      "trackedMemo: an effect whose memo threw (signal) runs again when it recovers",
  },
  {
    what:
      "a trackedMemo whose compute throws drops its reads — a component whose render hit the throw never re-renders (a 1.0.10 bug)",
    file: "src/state/signal.ts",
    find: "        if (tracker) { for (const d of deps) tracker.add(d); }",
    replace: "        if (tracker) { for (const d of deps) void d; }",
    test: "tests/tracked-memo.test.tsx",
    filter:
      "trackedMemo: a component whose memo threw re-renders when it recovers",
  },
  {
    what:
      "a trackedMemo whose compute throws drops its reads — the differential's global effect logs diverge after a memo recovers",
    file: "src/state/signal.ts",
    find: "        if (tracker) { for (const d of deps) tracker.add(d); }",
    replace: "        if (tracker) { for (const d of deps) void d; }",
    test: "tests/signal-scope-differential.test.ts",
    filter:
      "signal scope differential: scoped reads never change what the global side observes",
  },
  {
    what:
      "a trackedMemo hit over a computed that still throws throws before replaying its reads — the reader is stranded and never runs again",
    file: "src/state/signal.ts",
    find:
      "        try {\n          d.peek();\n        } catch {\n          return false;\n        }",
    replace: "        d.peek();",
    test: "tests/tracked-memo.test.tsx",
    filter:
      "trackedMemo: an effect whose memo threw (computed) runs again when it recovers",
  },
  {
    what:
      "a trackedMemo hit over a throwing computed strands its reader — the differential's global effect logs diverge",
    file: "src/state/signal.ts",
    find:
      "        try {\n          d.peek();\n        } catch {\n          return false;\n        }",
    replace: "        d.peek();",
    test: "tests/signal-scope-differential.test.ts",
    filter:
      "signal scope differential: scoped reads never change what the global side observes",
  },
  {
    what:
      "a scoped evaluation that throws keeps no reads — a page rendered inside an effect never re-renders after its memo recovers",
    file: "src/state/signal.ts",
    find: "    error = { thrown };",
    replace: "    throw thrown;",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: an effect rendering a page whose memo threw re-renders when it recovers",
  },
  {
    what:
      "a scoped evaluation that throws keeps no reads — nested renders stay on the error after recovery (differential)",
    file: "src/state/signal.ts",
    find: "    error = { thrown };",
    replace: "    throw thrown;",
    test: "tests/signal-scope-differential.test.ts",
    filter:
      "signal scope differential: scoped reads never change what the global side observes",
  },
  {
    what:
      "a scoped computed that threw is served from its cache — within a render it never recovers, unlike the global one",
    file: "src/state/signal.ts",
    find: "  if (e.error) return false;",
    replace: "  if (e.error && e.stamp < 0) return false;",
    test: "tests/signal-scope-differential.test.ts",
    filter:
      "signal scope: a computed that threw is re-evaluated on its next scoped read",
  },
  {
    what:
      "an effect or watch created in a route render that reads the route is never named — the page silently shows the global route's value",
    file: "src/state/signal.ts",
    find: "      _scopedEffectHook?.((targets) => _reaches(deps, targets));",
    replace: "      void _reaches;",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: an effect or watch created in the render that reads the route is named",
  },
  {
    what:
      "the route warning sees only direct reads — an effect or watch over a computed of the route writes the global route's value into the page silently",
    file: "src/state/signal.ts",
    find:
      "      for (const x of inner as Set<SignalImpl<unknown>>) todo.push(x);",
    replace: "      for (const x of inner as Set<SignalImpl<unknown>>) void x;",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: an effect or watch created in the render that reads the route through a computed is named",
  },
  {
    what:
      "the route warning is handed an empty read set — no effect or watch created in a route render is ever named",
    file: "src/state/signal.ts",
    find: "          if (firstDeps === null) firstDeps = deps;",
    replace: "          if (firstDeps === undefined) firstDeps = deps;",
    test: "tests/air-ssr-soak.test.ts",
    filter:
      "SSR explicit route: an effect or watch created in the render that reads the route is named",
  },
  {
    what:
      "a subscriber frame re-walks a shared scoped subtree once per reader — a render nested in an effect over a large graph costs readers × subtree",
    file: "src/state/signal.ts",
    find: "    if (seen.has(next)) continue;",
    replace: "    if (seen.has(next) && next.stamp < 0) continue;",
    test: "tests/signal-scope-differential.test.ts",
    filter: "signal scope: a subscriber frame walks each scoped entry once",
  },
  {
    what:
      "the walked set is kept per call, not per frame — a render nested in an effect over a large graph costs readers × subtree",
    file: "src/state/signal.ts",
    find: "    _walked.set(tracker, seen);",
    replace: "    void _walked;",
    test: "tests/signal-scope-differential.test.ts",
    filter: "signal scope: a subscriber frame walks each scoped entry once",
  },
  // the v1 bar audit: every item held by a row
  {
    what:
      "check:release silently drops check:api — a removed or changed export ships as if the surface were frozen",
    file: "scripts/release-check.ts",
    find: '  ["check:api", ["deno", "task", "check:api"]],',
    replace: "",
    test: "tests/ci-mirrors-release-check.test.ts",
    filter:
      "ci: check:release keeps its required lanes, and only the lab may skip",
  },
  {
    what:
      "check:release silently drops the bundle-size gate — a page that grew ships under an old size claim",
    file: "scripts/release-check.ts",
    find: '  ["check:bundle-size", ["deno", "task", "check:bundle-size"]],',
    replace: "",
    test: "tests/ci-mirrors-release-check.test.ts",
    filter:
      "ci: check:release keeps its required lanes, and only the lab may skip",
  },
  {
    what:
      "the suite stops running check:report-dirs — a private report directory can be committed and published again",
    file: "deno.json",
    find: "scripts/check-report-dirs.ts && ",
    replace: "",
    test: "tests/ci-mirrors-release-check.test.ts",
    filter:
      "ci: the suite runs the ratchets first, and the ratchets keep check:report-dirs",
  },
  {
    what:
      "a skipped lab prints ✓ — a release looks fully gated when the fresh-machine install never ran",
    file: "scripts/release-check.ts",
    find: '  const mark = r.skipped ? "⚠" : r.ok ? "✓" : "✗";',
    replace: '  const mark = r.ok ? "✓" : "✗";',
    test: "tests/release-check-skip-visible.test.ts",
    filter:
      "release check: a skipped lab is ⚠ in the report and named in the releasable line",
  },
  {
    what: "the releasable line hides that the lab was skipped",
    file: "scripts/release-check.ts",
    find: '    ? " (lab SKIPPED — no docker/podman)"',
    replace: '    ? ""',
    test: "tests/release-check-skip-visible.test.ts",
    filter:
      "release check: a skipped lab is ⚠ in the report and named in the releasable line",
  },
  {
    what:
      "a press swallowed by an input's key filter goes unnamed — a test passes while its handler ran zero times",
    file: "src/air/ui-trigger.ts",
    find:
      "  if (_globalKeyProbe.ran !== probe.ran) return; // something ran — correct code",
    replace:
      "  if (_globalKeyProbe.ran === _globalKeyProbe.ran) return; // something ran — correct code",
    test: "tests/ui-press-input-swallow-warning.test.tsx",
    filter: "press into a field that the shortcut ignores is NAMED",
  },
  {
    what:
      "the swallowed-press ratchet is off — this repo's own tests can pass with a handler that never ran",
    file: "scripts/test-shards.ts",
    find:
      "    else if (l.includes(SWALLOWED_PRESS) && !SWALLOW_OK.test(source(file))) {",
    replace:
      "    else if (Number.isNaN(0) && l.includes(SWALLOWED_PRESS) && !SWALLOW_OK.test(source(file))) {",
    test: "tests/test-shards-env.test.ts",
    filter:
      "swallowedPresses: a swallowed press fails its file unless the file says why",
  },
  {
    what:
      "the runner ignores the swallowed-press ratchet's answer — the shard passes anyway",
    file: "scripts/test-shards.ts",
    find: "      left: left.length > 0 || swallowed.length > 0,",
    replace: "      left: left.length > 0,",
    test: "tests/test-shards-env.test.ts",
    filter:
      "swallowed press ratchet: real deno output is attributed, and the runner fails the shard on it",
  },
  {
    what:
      "a test shard shares the real runtime dir — its sockets and locks collide with the developer's running apps",
    file: "scripts/test-shards.ts",
    find: "    ...(opts.realWindow ? {} : { XDG_RUNTIME_DIR: runtimeDir! }),",
    replace: "    ...({}),",
    test: "tests/test-shards-env.test.ts",
    filter:
      "shardEnv: every non-window shard gets its own XDG_RUNTIME_DIR and portSliceFor's slice",
  },
  {
    what:
      "sibling test processes walk the port slice in lockstep — they race for the same ports",
    file: "src/testing/server-test.ts",
    find: "  return first + (Deno.pid % n);",
    replace: "  return first + (Deno.pid % n) * 0;",
    test: "tests/free-port-no-reissue.test.ts",
    filter: "two processes do not start walking the slice at the same port",
  },
  {
    what:
      "a closed tab's head is handed to the next no-argument collectHead() — a page ships another visitor's title and meta",
    file: "src/air/head.ts",
    find: "  if (last && last.aborted && last.epoch !== _ssrRenderEpoch()) {",
    replace:
      "  if (last && last.aborted && last.epoch !== _ssrRenderEpoch() && Number.isNaN(0)) {",
    test: "tests/air-ssr-concurrent-render-state.test.ts",
    filter:
      "SSR: a closed tab's head is not the no-argument answer once another render is set up",
  },
  {
    what: "collectHead(key) ignores its key — interleaved streams swap heads",
    file: "src/air/head.ts",
    find:
      "  const render = key === undefined ? _collectTarget() : _ssrRenderForKey(key);",
    replace:
      "  const render = key === undefined || !Number.isNaN(0) ? _collectTarget() : _ssrRenderForKey(key);",
    test: "tests/air-ssr-concurrent-render-state.test.ts",
    filter: "SSR: two interleaved streams keep their own <head>",
  },
  {
    what:
      "the app's own Electron copy is shipped instead of aio's tested version — an untested runtime in the product",
    file: "src/build/electron-runtime.ts",
    find: "  return Promise.resolve(DEFAULT_ELECTRON_VERSION);",
    replace:
      "  return installedElectronVersion(_root).then((v) => v ?? DEFAULT_ELECTRON_VERSION);",
    test: "tests/electron-runtime-fetch.test.ts",
    filter:
      "resolveElectronVersion: aio's tested version, whatever the app's copies say",
  },
  {
    what:
      "dev-only diagnostics are bundled into production — every page downloads the dev tools",
    file: "src/build/esbuild-plugin.ts",
    find: '          if (args.kind !== "dynamic-import") return undefined;',
    replace:
      '          if (args.kind !== "dynamic-import" || true) return undefined;',
    test: "tests/bundle-dev-chunk.test.ts",
    filter:
      "dev chunk: the production bundle contains none of the dev-only modules",
  },
  {
    what:
      "the dev chunk stops being fetched from the dev server's own route — dev tools break or leak into prod",
    file: "src/build/esbuild-plugin.ts",
    find: '          if (args.kind !== "dynamic-import") return undefined;',
    replace:
      '          if (args.kind !== "dynamic-import" || true) return undefined;',
    test: "tests/bundle-dev-chunk.test.ts",
    filter: "dev chunk: the bundle asks for it at the dev server's own route",
  },
  {
    what:
      "an access rule returning a promise is GRANTED — an async check that meant to refuse lets everyone in",
    file: "src/server/server-auth.ts",
    find: '    if (typeof answer === "boolean") return answer;',
    replace:
      '    if (typeof answer === "boolean" || isThenable(answer)) return answer as boolean;',
    test: "tests/access-fails-closed.test.ts",
    filter: "a predicate returning a PROMISE is denied, not granted",
  },
  {
    what:
      "onConnect runs as an anonymous client — the presence pattern is refused by the app's own access rule",
    file: "src/server/server-ws.ts",
    find: "      guardHookResult(inServerOrigin(() => hook(user)), failed);",
    replace: "      guardHookResult(hook(user), failed);",
    test: "tests/access-conn-hook-origin.test.tsx",
    filter: "a connection hook calling an access-gated method is server origin",
  },
  {
    what:
      "a refused sync op still runs its listensTo reactions — listeners count an op the owner rejected",
    file: "src/state/cell-compose-reduce.ts",
    find: "    if (listeners && !refusedOp) {",
    replace: "    if (listeners) {",
    test: "tests/refused-action-no-reactions.test.ts",
    filter:
      "refused action: a plain action's listeners run after the owner refused — as in 1.0.9",
  },
  {
    what:
      "a refused plain call stops running its listeners — a 1.0.9 app's reactions silently change",
    file: "src/state/cell-compose-reduce.ts",
    find: "      (action as { _syncOp?: unknown })._syncOp === true;",
    replace:
      "      ((action as { _syncOp?: unknown })._syncOp === true || true);",
    test: "tests/refused-action-no-reactions.test.ts",
    filter:
      "refused action: a plain action's listeners run after the owner refused — as in 1.0.9",
  },
  {
    what:
      'an older build\'s persist:"none" bytes survive in the snapshot and backup copies — the secret is still on disk after the scrub',
    file: "src/server/aio-boot.ts",
    find: "    const gone = await scrubCopy(p, persistKey, staleOf);",
    replace: "    const gone: string[] = [];",
    test: "tests/persist-none-scrub-once.test.ts",
    filter:
      'persist:"none": an older build\'s slice is scrubbed on the first boot, said once — the second boot says and scrubs nothing',
  },
  {
    what:
      "a worker cell's self-started work commits during the shutdown drain — writes land after the app said it was stopping",
    file: "src/server/cell-worker-host.ts",
    find: "      dispatch.close();",
    replace: "      void 0;",
    test: "tests/worker-dispatch-close.test.ts",
    filter:
      "worker close: the worker's own loop drains — new work it starts itself is refused, the in-flight write lands",
  },
  {
    what: "the lock file is world-readable on filesystems without hard links",
    file: "src/server/single-instance-lock.ts",
    find: "    const excl = { createNew: true, write: true, mode: 0o600 };",
    replace: "    const excl = { createNew: true, write: true };",
    test: "tests/single-instance-lock-file-mode.test.ts",
    filter: "lock file mode: 0600 on the no-hard-link fallback",
  },
  {
    what: "the lock file is world-readable on the normal path",
    file: "src/server/single-instance-lock.ts",
    find:
      "  const writeTmp = () => Deno.writeTextFileSync(tmp, text, { mode: 0o600 });",
    replace: "  const writeTmp = () => Deno.writeTextFileSync(tmp, text);",
    test: "tests/single-instance-lock-file-mode.test.ts",
    filter: "lock file mode: 0600 on the hard-link path",
  },
  {
    what:
      "the owner's start time is read in local time — a live app is judged dead and a second instance takes state.db",
    file: "src/server/single-instance-lock.ts",
    find: '      env: { LC_ALL: "C", LANG: "C", TZ: "UTC" },',
    replace: '      env: { LC_ALL: "C", LANG: "C", TZ: "Asia/Kolkata" },',
    test: "tests/lock-start-epoch-tz.test.ts",
    filter:
      "processStartEpoch: lstart is asked for in UTC — exact to the second from any reader's zone",
  },
  {
    what:
      "a failed standalone save reads as a note — the user never learns the change is lost",
    file: "src/standalone-air.ts",
    find:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      "      console.error(\n        `[aio] ✗ ${what} to ${store.kind} FAILED",
    replace:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      "      console.warn(\n        `[aio] ✗ ${what} to ${store.kind} FAILED",
    test: "tests/standalone-persist-filter.test.ts",
    filter: "standalone persist: a throwing `onPersist` is LOUD, not a note",
  },
  {
    what:
      "the scrubbed slice stays in the -wal file — the secret is still on disk while the app runs",
    file: "src/server/aio-boot.ts",
    find:
      '  await db.execute("VACUUM");\n  await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");',
    replace: '  await db.execute("VACUUM");\n  await Promise.resolve();',
    test: "tests/hosts.test.ts",
    filter: 'hosts: server — persist:"none" never kept, last write drained',
  },
  {
    what:
      'the dev checkpoint hands back raw and persist:"none" slices — a restore brings the secret back',
    file: "src/server/aio-boot.ts",
    find:
      "      restorableSlices(s, persisting, initialState as Record<string, unknown>)",
    replace: "      s",
    test: "tests/checkpoint-restore-shape.test.ts",
    filter:
      "checkpoint restore: slices come back in STATE's shape, whole cells only",
  },
  {
    what:
      "profiles: false is silently ignored — an app that refused profiles boots one anyway",
    file: "src/server/app-dirs.ts",
    find:
      "    if (opts.profiles === false) throw new Error(profilesOffError(req));",
    replace: "    if (opts.profiles === false) void profilesOffError(req);",
    test: "tests/profile-runtime-flag.test.ts",
    filter:
      "runtime: profiles:false refuses --profile, AIO_PROFILE and --home (exit 1)",
  },
  {
    what:
      "two homes share one Chromium profile — the second window opens blank",
    file: "src/server/aio-lifecycle.ts",
    find:
      "        title,\n        appDirs(appId).home,\n        registeredProfile(appId),",
    replace:
      "        title,\n        undefined,\n        registeredProfile(appId),",
    test: "tests/electron-profile-per-home.test.ts",
    filter:
      "electron launch: a non-default home opens its OWN Chromium profile (keyed like the lock)",
  },
  {
    what:
      "an am backup hold looks like a stalled boot — an older am may take over the app mid-copy",
    file: "src/am/am-cmd-data.ts",
    find:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      "  let mark = maintenanceMark(`am ${op}`, since);\n  lock.update(mark);",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    replace: "  let mark = maintenanceMark(`am ${op}`, since);\n  void mark;",
    test: "tests/single-instance-lock-maintenance.test.ts",
    filter:
      "maintenance hold: its startedAt keeps moving, so an older `am` never reads it as a stalled boot",
  },
  {
    what:
      "a failed am verb prints its {error} and then a success-shaped document — `| jq .removed` reads a number from a failure",
    file: "src/am/am-output.ts",
    find:
      "sayData(JSON.stringify(fix ? { error: msg, fix } : { error: msg }));",
    replace:
      'sayData(JSON.stringify(fix ? { error: msg, fix } : { error: msg })); sayData(\'{"removed":3,"freed":"1 MB"}\');',
    test: "tests/am-exit-code-sweep.test.ts",
    filter:
      "am exit-code sweep: every verb fails with its exit code, no success doc, and names what failed",
  },
  {
    what:
      "on a terminal a failed am verb prints a ✓ line after its ✗ — a person reads a failure as done",
    file: "src/am/am-output.ts",
    find:
      '    console.error(block("bad", head, body || undefined, fix, { indent: "" }));',
    replace:
      '    console.error(block("bad", head, body || undefined, fix, { indent: "" }));\n    say("✓ removed 3 paths");',
    test: "tests/am-exit-code-sweep.test.ts",
    filter:
      "am exit-code sweep: on a terminal, nothing reads as success after the error (one verb per class)",
  },
  {
    what:
      "am backup copies data/ from under an instance running from another lock scope — a torn backup reported as fine",
    file: "src/am/am-cmd-data.ts",
    find: "  const claim = claimHome(home, { appId, port: 0, key: lock.key });",
    replace:
      '  const claim = claimHome(join(home, "unclaimed"), { appId, port: 0, key: lock.key });',
    test: "tests/am-backup-lock-scope.test.ts",
    filter:
      "am backup: an app running under another lock scope is refused, nothing written",
  },
  {
    what:
      "am restore swaps data/ under an instance running from another lock scope — the live app's store is replaced mid-run",
    file: "src/am/am-cmd-data.ts",
    find: "  const claim = claimHome(home, { appId, port: 0, key: lock.key });",
    replace:
      '  const claim = claimHome(join(home, "unclaimed"), { appId, port: 0, key: lock.key });',
    test: "tests/am-backup-lock-scope.test.ts",
    filter:
      "am restore: an app running under another lock scope is refused, data/ untouched",
  },
  {
    what:
      "the version-store prune forgets the developer's own worktrees outside the store",
    file: "src/am/am-versions.ts",
    find:
      "    if (!stores.some((d) => resolve(r.path).startsWith(d))) continue;",
    replace: "    if (stores.length < 0) continue;",
    test: "tests/am-versions-self-heal.test.ts",
    filter: "ensureVersion drops stale STORE registrations, and only those",
  },
  {
    what:
      "removeVersion runs a repo-wide `git worktree prune` — every momentarily-missing worktree of the developer's is forgotten",
    file: "src/am/am-versions.ts",
    find: '    await git(root, ["worktree", "remove", "-f", "-f", path]);',
    replace:
      '    await git(root, ["worktree", "remove", "-f", "-f", path]);\n    await git(root, ["worktree", "prune"]);',
    test: "tests/am-versions-self-heal.test.ts",
    filter:
      "removeVersion: removes a locked store entry, and prunes nothing else",
  },
  {
    what:
      "a proof row whose commit was rewritten away prints ✓ — evidence nobody can name",
    file: "scripts/proof.ts",
    find: '  if (!commitExists) return { state: "gone", age };',
    replace: '  if (!commitExists && age < 0) return { state: "gone", age };',
    test: "tests/proof-matrix.test.ts",
    filter: "proof matrix: a row whose commit is gone is STALE, however recent",
  },
  {
    what:
      "the aio root ships without name constraints — a CA in the user's trust store vouches for www.google.com",
    file: "src/server/x509.ts",
    find: "      nameConstraints(opts.permittedDns, opts.permittedIpMasks),",
    replace:
      "      // nameConstraints(opts.permittedDns, opts.permittedIpMasks),",
    test: "tests/tls-verifier-claims.test.ts",
    filter:
      "rustls refuses a leaf naming a public host under the aio root — and accepts it without",
  },
  {
    what:
      "a TLS comment again cites tests for NSS and Go that nothing runs — a security claim with no evidence",
    file: "src/server/tls.ts",
    find:
      " *  the key and openssl and rustls refuse the forgery — measured on every run,",
    replace:
      " *  the key and openssl, rustls, NSS and Go refuse the forgery — measured on every run,",
    test: "tests/tls-verifier-claims.test.ts",
    filter:
      "tls/x509 comments: a verifier called measured has a probe, or says by hand",
  },
  // s.$do after its method returned fails loud
  // file modes: the tests can fail under any umask
  {
    what:
      "the lock and control-socket folder is not narrowed to 0700 — any local user can reach the socket and dispatch into the app",
    file: "src/server/single-instance-lock.ts",
    find: 'if (Deno.build.os !== "windows") chmod(dir, 0o700);',
    replace: "void chmod;",
    test: "tests/lock-dir-choose.test.ts",
    filter:
      "_chooseLockDir: the shared dir when private, the uid sibling when not, a refusal when neither",
  },
  {
    what:
      "the journal is rewritten world-readable after compaction — every journalled action payload is readable by other local users",
    file: "src/server/journal.ts",
    find:
      "Deno.writeTextFileSync(tmp, text, { createNew: true, mode: 0o600 });",
    replace: "Deno.writeTextFileSync(tmp, text, { createNew: true });",
    test: "tests/journal-compaction-perms.test.ts",
    filter: "journal: compaction keeps the file owner-only (0600)",
  },
  {
    what:
      "the control-key folder is left readable — the local control credential (raw state, SQL, shutdown) sits where other users can list it",
    file: "src/server/app-key.ts",
    find: 'if (Deno.build.os !== "windows") Deno.chmodSync(dir, 0o700);',
    replace: "void 0;",
    test: "tests/local-control.test.ts",
    filter:
      "control key: minted 0600 in the 0700 data dir, fresh at every boot",
  },
  // no secret in the logs; one shutdown sequence for worker cells
  {
    what:
      'a persist:"none" cell\'s values are written to logs/actions.jsonl on every call — the secret lands on disk through the action log',
    file: "src/diagnostics/mod.ts",
    find: "        ) || unkept(actionCell(action.type, action.payload));",
    replace: "        );",
    test: "tests/persist-none-scrub-once.test.ts",
    filter:
      'persist:"none": an older build\'s slice is scrubbed on the first boot, said once — the second boot says and scrubs nothing',
  },
  {
    what:
      'an older build\'s actions.jsonl keeps a persist:"none" secret after the upgrade',
    file: "src/diagnostics/mod.ts",
    find: "        (type, payload) => unkept(actionCell(type, payload)),",
    replace: "        (_type, _payload) => false,",
    test: "tests/persist-none-scrub-once.test.ts",
    filter:
      'persist:"none": an older build\'s slice is scrubbed on the first boot, said once — the second boot says and scrubs nothing',
  },
  {
    what:
      "no shutdown path closes the worker cells — worker calls keep starting new work during the drain",
    file: "src/server/shutdown.ts",
    find:
      '    if (refs.closeWorkers) {\n      await phase(log, "close worker cells", gate, () => refs.closeWorkers!());\n    }\n',
    replace: "",
    test: "tests/shutdown-worker-order.test.ts",
    filter:
      "shutdown: the worker cells close after onStopping and before dispatch closes",
  },
  {
    what:
      "the worker pool closes before onStopping — the documented way to stop a worker's producers is refused",
    file: "src/server/shutdown.ts",
    find:
      '    if (refs.onStopping) {\n      await phase(log, "hook onStopping", gate, () => refs.onStopping!());\n    }\n    if (refs.closeWorkers) {\n      await phase(log, "close worker cells", gate, () => refs.closeWorkers!());\n    }',
    replace:
      '    if (refs.closeWorkers) {\n      await phase(log, "close worker cells", gate, () => refs.closeWorkers!());\n    }\n    if (refs.onStopping) {\n      await phase(log, "hook onStopping", gate, () => refs.onStopping!());\n    }',
    test: "tests/shutdown-worker-order.test.ts",
    filter:
      "shutdown: onStopping may call a worker cell — the documented way to stop its producers works",
  },
  {
    what:
      "a closed worker cell's calls fall through and run on the main isolate — away from the worker's own resources",
    file: "src/server/cell-worker-pool.ts",
    find:
      "      await Promise.all([...byCell.values()].map((w) => w.close()));",
    replace:
      "      await Promise.all([...byCell.values()].map((w) => w.close()));\n      byCell.clear();",
    test: "tests/shutdown-worker-order.test.ts",
    filter:
      "shutdown: onStopping may call a worker cell — the documented way to stop its producers works",
  },
  {
    what:
      'at logging level debug, a persist:"none" method\'s arguments and state diffs are written to debug.log in cleartext',
    file: "src/server/aio-cells-bridge.ts",
    find:
      "        ...(persist?.cells.filter((c) => !persist.persisting.has(c)) ?? []),",
    replace: "        ...([] as string[]),",
    test: "tests/persist-none-scrub-once.test.ts",
    filter:
      'persist:"none": an older build\'s slice is scrubbed on the first boot, said once — the second boot says and scrubs nothing',
  },
  // field reports: am start, am fix, latest
  {
    what:
      "am start latches the first lock port — a live socket-only app is reported not responding, exit 1, and an agent restarts it",
    file: "src/am/am-cmd-process.ts",
    find:
      "    {\n      // Our own child's lock — and only if it IS our child's (same pid):",
    replace:
      "    if (livePort === undefined) {\n      // Our own child's lock — and only if it IS our child's (same pid):",
    test: "tests/am-start-socket-only-relock.test.ts",
    filter:
      "am start: a child that re-locks {port:N,starting} → {port:0,socketPath} is reported started, exit 0",
  },
  {
    what:
      "am fix in a nested app treats the parent's ../dep/aio as its own — pins the wrong version, makes a dead link, rewrites tasks",
    file: "src/am/am-cmd-fix.ts",
    find: "      : isOwnDepAio(dir, depProvider)",
    replace: "      : depProvider !== null",
    test: "tests/am-fix-nested-app.test.ts",
    filter:
      "am fix in a nested app on the parent's ../dep/aio: no pin, no client/dep/aio link, tasks untouched",
  },
  {
    what:
      "a provisioned release newer than the clone's origin/main is silently passed over — am pin shows an older latest beside it",
    file: "src/am/am-versions.ts",
    find: "  return { latest, offMain };",
    replace: "  return { latest, offMain: offMain.slice(0, 0) };",
    test: "tests/am-versions-latest-off-main.test.ts",
    filter:
      "latestRelease: a provisioned release newer than the clone's origin/main is reported, not silently passed over",
  },
  {
    what:
      "am runs git in whatever repo encloses a non-clone AIO_HOME — fetches, prunes and cuts worktrees in someone else's repository",
    file: "src/am/am-versions.ts",
    find:
      "      ...(cwd !== null ? { GIT_CEILING_DIRECTORIES: gitCeiling(cwd) } : {}),",
    replace: '      ...(cwd !== null ? { GIT_CEILING_DIRECTORIES: "" } : {}),',
    test: "tests/am-versions-no-walk-up.test.ts",
    filter:
      "am versions: a plain AIO_HOME inside an enclosing repo is not a clone, and that repo's .git stays byte-identical",
  },
  {
    what:
      "a git repo that is not an aio checkout is taken as the install clone and provisioned from",
    file: "src/am/am-versions.ts",
    find:
      '  if (!await exists(join(dir, ".git")) || !await exists(join(dir, "mod.ts"))) {',
    replace: '  if (!await exists(join(dir, ".git"))) {',
    test: "tests/am-versions-no-walk-up.test.ts",
    filter:
      "am versions: a repo's own top level is a clone only when it is an aio checkout (mod.ts)",
  },
  {
    what:
      "am upgrade from a plain aio copy inside another repo fetches into it and force-checks-out a tag there — someone else's repository is rewritten",
    file: "src/am/am-cmd-meta.ts",
    find: "    const refused = await notCloneRefusal(root);",
    replace: "    const refused = null as string | null;",
    test: "tests/am-git-never-walks-up.test.ts",
    filter:
      "am upgrade: an install that is a plain copy inside an enclosing repo is refused, exit 1, and that repo's .git is byte-identical",
  },
  {
    what:
      "am fix in an app folder that is not its own repo runs git submodule update --init on the ENCLOSING repo",
    file: "src/am/am-cmd-fix.ts",
    find: '  if (await exists(join(dir, ".gitmodules")) && !ownRepo) {',
    replace:
      '  if (await exists(join(dir, ".gitmodules")) && !ownRepo && dir === "") {',
    test: "tests/am-git-never-walks-up.test.ts",
    filter:
      "am fix: a .gitmodules in an app folder that is not its own repo never initializes the enclosing repo's submodules",
  },
  {
    what:
      "every size warning links a chapter that does not exist — the one hint the app author gets is a dead end",
    file: "src/state/large-state-doc.ts",
    find: '  "docs/persistence/big-data.md#legitimately-large-state";',
    replace: '  "docs/persistence/big-data.md#large-state";',
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state doc: the page every size message names exists, and its anchor lands on a heading",
  },
  {
    what: "size lines stop naming the budget that quiets them",
    file: "src/state/budgets.ts",
    find:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      "      `size is intended, declare it: ${declaration} — see ` +",
    replace: "      `size is intended — see ` +",
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state persist warn: size, threshold, Fix line with the declaration, chapter",
  },
  {
    what:
      "persist ignores a declared cellState — the 1MB warn fires forever for an app that declared its size",
    file: "src/server/persistence.ts",
    find: "  const _warnAt = _declared ?? PERSIST_CELL_WARN_BYTES;",
    replace: "  const _warnAt = PERSIST_CELL_WARN_BYTES;",
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state persist: a DECLARED cellState moves the warn line — under it is quiet",
  },
  {
    what: "a declared 20MB cell still errors every flush past 16MB",
    file: "src/server/persistence.ts",
    find:
      "  const _hardAt = Math.max(PERSIST_CELL_HARD_BYTES, _declared ?? 0);",
    replace: "  const _hardAt = PERSIST_CELL_HARD_BYTES;",
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state persist: a declared cellState above 16MB lifts the hard line",
  },
  {
    what: "a persist breach of a declared budget never reaches /health",
    file: "src/server/persistence.ts",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    find: '      _budgets.record("cellState", size, `cell "${cellName}"`);',
    replace: "      void cellName;",
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state persist: over a DECLARED cellState warns, says so, and records the breach",
  },
  {
    what: "the persist warn loses its fix and chapter",
    file: "src/server/persistence.ts",
    find:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      "          }). ${CELL_SIZE_COST} ` + cellSizeFix(size, _declared !== undefined),",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    replace: "          }). ${CELL_SIZE_COST}`,",
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state persist warn: size, threshold, Fix line with the declaration, chapter",
  },
  {
    what:
      "the every-flush persist ERROR loses its fix line — the author sees a red log on every write and no way out",
    file: "src/server/persistence.ts",
    find: "          cellSizeFix(size, _declared !== undefined),",
    replace: "          String(_declared !== undefined && size),",
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state persist hard: every flush says the fix and the chapter",
  },
  {
    what:
      "the full-state size warning loses its fix line — the author is told it is big, not what to do about it",
    file: "src/server/server-broadcast.ts",
    find: '        cellSizeFix(size, declared, "frame"),',
    replace: "        String(declared && size),",
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state broadcast: the full-state line carries the Fix and the chapter",
  },
  {
    what:
      "the WS connect frame goes unchecked — a persist-off app pushes 12MB on every connect, silently",
    file: "src/server/server-ws.ts",
    find: "        warnBigFullState(msg, () => uiState, deps.getUIState);",
    replace: "        void warnBigFullState;",
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state ws: the frame every client gets FIRST is guarded (persist off)",
  },
  {
    what:
      "the Deno-peer frame refusal gives no way out — a CLI client just loops without saying the ceiling cannot be raised",
    file: "src/server/server-ws.ts",
    find:
      "    `state until the app's is smaller. Fix: this ceiling cannot be raised — ` +",
    replace: "    `state until the app's is smaller. ` +",
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state ws ceiling: the refusal to a Deno peer says it cannot be raised, and the fix",
  },
  {
    what: "a terminal client's reconnect loop is not actionable",
    file: "src/server/cli-client.ts",
    find:
      "    `big to push to a terminal client. Fix (in the app): keep bulk rows in ` +",
    replace: "    `big to push to a terminal client. keep bulk rows in ` +",
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state cli: a terminal client told the frame is too large gets the fix",
  },
  {
    what: "the PRESSURE payload line never names its budget",
    file: "src/vitals/pressure-monitor.ts",
    find:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      "            `intended declare it: ${declareLargeState(bytes)} — see ` +",
    replace: "            `intended — see ` +",
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state pressure: the payload hint names both budgets and the chapter",
  },
  {
    what:
      "the bandwidth PRESSURE hint points nowhere — the author sees pressure lines and no chapter to read",
    file: "src/vitals/pressure-monitor.ts",
    find: "                LARGE_STATE_DOC,",
    replace: '                "",',
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state pressure: the bandwidth hint names visible (not the removed ui:) and the chapter",
  },
  {
    what: "the dev-freeze skip notice loses its doc link",
    file: "src/state/immutable.ts",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    find: "      `${LARGE_STATE_DOC} (logged once).`,",
    replace: "      `(logged once).`,",
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state dev freeze: the skip notice names the fix and the chapter",
  },
  {
    what:
      "an Electron window over the 10MB UDS ceiling is disconnected with no knob named",
    file: "src/server/uds.ts",
    find:
      "              `maxMessageBytes: N } }) — the UDS ceiling follows it, never ` +",
    replace: "              `N } }) — the UDS ceiling follows it, never ` +",
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state uds: an inbound frame over the ceiling names the knob and the chapter",
  },
  {
    what:
      "standalone restore that could not read stored state saves over it — the user's data is gone on the next write",
    file: "src/standalone-air.ts",
    find: "    if (writesRefused !== null) {",
    replace: '    if (writesRefused === "__never__") {',
    test: "tests/standalone-restore-never-overwrites.test.ts",
    filter:
      "restore: a native read error with no localStorage copy never overwrites the file",
  },
  {
    what:
      "a first run (nothing stored) is refused writes — a fresh app never saves",
    file: "src/standalone-air.ts",
    find: "  if (r.raw === null) return { writesRefused: null };",
    replace: '  if (r.raw === null) return { writesRefused: "no data" };',
    test: "tests/standalone-restore-never-overwrites.test.ts",
    filter:
      "restore: nothing stored is a first run — it writes as normal, silently",
  },
  {
    what:
      "the corrupt copy set aside is not byte-exact — the only copy of the data is damaged",
    file: "src/standalone-air.ts",
    find: "      store.write(aside, raw);",
    replace: "      store.write(aside, raw.slice(1));",
    test: "tests/standalone-restore-never-overwrites.test.ts",
    filter:
      "restore: corrupt native JSON is set aside byte-for-byte, loudly, before any write",
  },
  {
    what:
      "a proof row naming an amended draft of a release commit prints ✓ — the README claims proof for code no release shipped",
    file: "scripts/proof.ts",
    find: "    return tags.success && tags.stdout.length > 0;",
    replace: "    return tags.success || tags.stdout.length >= 0;",
    test: "tests/proof-matrix.test.ts",
    filter:
      "proof matrix: commitExists asks the repo — a tagged commit yes; untagged, amended or rewritten no",
  },
  {
    what:
      "a method called from onStop is admitted after the final persist — its write is applied in memory and never saved",
    file: "src/state/dispatch.ts",
    find:
      '      const admitted = isTeardown || (phase === "draining" && isInflight);',
    replace:
      '      const admitted = isTeardown || (phase === "draining" && isInflight) || _inUserStopHook;',
    test: "tests/onstop-dispatch.test.ts",
    filter:
      "onStop: a method called from the hook is refused — its reducer never runs",
  },
  {
    what:
      'the standalone store writes the whole state — a persist: "none" secret is on the phone\'s disk after every change',
    file: "src/standalone-air.ts",
    find: "      getDBState: buildDBStateGetter(composed) as (",
    replace: "      getDBState: ((s: unknown) => s) as unknown as (",
    test: "tests/standalone-persist-filter.test.ts",
    filter: 'standalone persist: a `persist: "none"` cell is never written',
  },
  {
    what:
      "a stale lock is deleted without comparing it to what was judged dead — a live instance that re-published meanwhile loses its lock, and two processes open one state.db",
    file: "src/server/single-instance-lock.ts",
    find: "    if (now !== judged) return false;",
    replace: "    if (now === null) return false;",
    test: "tests/lock-removal-cas.test.ts",
    filter: "lock CAS: removeLockFileIf removes only the exact bytes judged",
  },
  {
    what:
      "a lock is replaced without comparing it to the record read — a newer owner's lock is overwritten, and it looks stale to the next reader",
    file: "src/server/single-instance-lock.ts",
    find: "    if (!now || !sameRecord(expected, now)) return false;",
    replace: "    if (!now) return false;",
    test: "tests/lock-removal-cas.test.ts",
    filter:
      "replaceLockIf: writes only over the record read, onto its current bytes",
  },
  {
    what:
      "the window-hygiene gate stops following cleanup() aliases — a bare aliased cleanup() leaks a timer into the next test of its shard, green alone",
    file: "tests/happy-dom-window-hygiene.test.ts",
    find: "  const names = closerNames(text);",
    replace: '  const names = ["closeWindow"];',
    test: "tests/happy-dom-window-hygiene.test.ts",
    filter: "the gate can actually see both offences",
  },
  {
    what:
      "the packaged AppImage's window carries no CSP meta — an injected script in the desktop app runs with nothing to stop it",
    file: "src/server/server-html-gen.ts",
    find: "  const metaCsp = metaPolicy\n",
    replace: "  const metaCsp = metaPolicy && Date.now() < 0\n",
    test: "tests/hosts.test.ts",
    filter:
      'hosts: electron (packaged AppImage) — persist:"none" never kept, last write drained',
    env: { AIO_BUILD_E2E: "1", AIO_BUILD_ELECTRON: "1" },
  },
  {
    what:
      "the packaged app serves /__aio/snapshot — its window (or anything that reaches the socket) reads raw state, visible.exclude secrets included",
    file: "src/server/server-static.ts",
    find:
      '      !prod && pathname === "/__aio/snapshot" && deps.getSnapshot &&',
    replace:
      '      (!prod || Date.now() > 0) && pathname === "/__aio/snapshot" && deps.getSnapshot &&',
    test: "tests/hosts.test.ts",
    filter:
      'hosts: electron (packaged AppImage) — persist:"none" never kept, last write drained',
    env: { AIO_BUILD_E2E: "1", AIO_BUILD_ELECTRON: "1" },
  },
  {
    what:
      "a local packaged app listens on a TCP port by default — any process on the machine (or a browser tab) can reach it, not only its owner",
    file: "src/server/paths.ts",
    find: "    useElectron && !expose &&",
    replace: "    useElectron && !expose && Date.now() < 0 &&",
    test: "tests/hosts.test.ts",
    filter:
      'hosts: electron (packaged AppImage) — persist:"none" never kept, last write drained',
    env: { AIO_BUILD_E2E: "1", AIO_BUILD_ELECTRON: "1" },
  },
  {
    what: "a retired boot's late call commits into the next test",
    file: "src/standalone-air.ts",
    find: "      if (fence.dead) {",
    replace: "      if (fence.dead && Date.now() < 0) {",
    test: "tests/bootcells-generation-fence.test.ts",
    filter:
      "generation fence: a call a disposed boot started never commits into the next boot, and it is said",
  },
  {
    what:
      "bootCells dispose never retires its boot — a late call from one test commits into the next test's state",
    file: "src/testing/cell-test.ts",
    find: "    standalone._retire(booted);",
    replace: "    void booted;",
    test: "tests/bootcells-generation-fence.test.ts",
    filter:
      "generation fence: a call a disposed boot started never commits into the next boot, and it is said",
  },
  {
    what:
      "testUI dispose never retires its boot — mount A's onInit commits into mount B",
    file: "src/testing/ui-test.ts",
    find: "      standalone._retire(booted);",
    replace: "      void booted;",
    test: "tests/testui-generation-fence.test.tsx",
    filter:
      "testUI generation fence: a call a disposed mount started never commits into the next mount, and it is said",
  },
  {
    what: "fuzz calls warn per method — a fuzz run floods the log",
    file: "src/state/cell-methods-internals.ts",
    find: "  if (supplied === 0 && _fuzzKey !== null && _fuzzKey === key) {",
    replace:
      '  if (supplied === 0 && _fuzzKey !== null && _fuzzKey === "__never__") {',
    test: "tests/fuzz-short-call-quiet.test.ts",
    filter: "fuzz: randomActions is silent per method, one summary line",
  },
  {
    what:
      "a real short call goes silent too — a method called without its payload runs on undefined and nothing says so",
    file: "src/state/cell-methods-internals.ts",
    find: "  if (supplied === 0 && _fuzzKey !== null && _fuzzKey === key) {",
    replace: "  if (supplied === 0) {",
    test: "tests/fuzz-short-call-quiet.test.ts",
    filter: "fuzz: a REAL short call still warns, outside and after a fuzz",
  },
  {
    what:
      "the Android store renames without a directory fsync — a power cut undoes a saved change",
    file: "src/build/android-template.ts",
    find: "\\n            syncDir()\\n",
    replace: "\\n",
    test: "tests/android-native-store-dir-fsync.test.ts",
    filter: "android dir fsync: set() fsyncs the directory AFTER the rename",
  },
  {
    what:
      "a third-party iframe in a standalone APK is never reported, though AioNativeStore reaches it",
    file: "src/standalone-air.ts",
    find: '  if (store.kind === "native") {',
    replace: '  if (store.kind === ("__never__" as string)) {',
    test: "tests/standalone-foreign-iframe-warning.test.ts",
    filter:
      "foreign iframe: a third-party frame in a standalone APK is named, once",
  },
  {
    what:
      "own-origin frames are reported — noise that trains the reader to skip the real warning",
    file: "src/standalone-air.ts",
    find:
      'if (origin === "null" || origin === pageOrigin || said.has(origin)) {',
    replace: 'if (origin === "null" || said.has(origin)) {',
    test: "tests/standalone-foreign-iframe-warning.test.ts",
    filter:
      "foreign iframe: own-origin / srcdoc frames, or no native bridge, are silent",
  },
  {
    what:
      "am binds a running home even when the app is ambiguous — every command in a multi-component project is refused, even help",
    file: "src/am.ts",
    find: "  } else if (!appIsAmbiguous(flags.app)) {",
    replace: "  } else if (!appIsAmbiguous(flags.app) || true) {",
    test: "tests/am-components-lazy-app.test.ts",
    filter:
      "am components: help, --version and project-wide verbs are not refused for want of --app",
  },
  {
    what:
      "am help binds an app home — help with a profile is refused in a multi-component project",
    file: "src/am.ts",
    find: "  if (meta) {",
    replace: "  if (meta && false) {",
    test: "tests/am-components-lazy-app.test.ts",
    filter:
      "am components: help, --version and project-wide verbs are not refused for want of --app",
  },
  {
    what:
      "the project-wide am stop the refusal recommends exits through that same refusal — no way out",
    file: "src/am/am-cmd-process.ts",
    find: "  if (appIsAmbiguous()) return undefined;",
    replace: "  if (appIsAmbiguous() && false) return undefined;",
    test: "tests/am-components-lazy-app.test.ts",
    filter:
      "am components: help, --version and project-wide verbs are not refused for want of --app",
  },
  {
    what:
      "the not-a-target hint ties browser and android — the old --compile --android spelling gets a wrong suggestion",
    file: "src/build/build-target-hint.ts",
    find: 'f === "--compile" ? 0.5 : 1',
    replace: 'f === "--compile" ? 1 : 1',
    test: "tests/build-not-a-target-hint.test.ts",
    filter: "build hint: --compile --android is nearest android, not browser",
  },
  {
    what:
      "a refused direct build.ts call names no nearest target — a release script breaks with no way forward",
    file: "src/build/build-target-hint.ts",
    find: "const hint = near.length === 0",
    replace: "const hint = true",
    test: "tests/build-not-a-target-hint.test.ts",
    filter:
      "build hint: a direct build.ts --compile --android is refused naming --android",
  },
  {
    what:
      "every binary embeds every *.server.ts again — the public relay ships the agent's input-injection code and each desktop app the relay's (remote-desktop report §4)",
    file: "src/build/build-compile.ts",
    find:
      "    (reached.has(c) || under(c) || graphDirs.has(dirOf(c)) ? embed : skipped)",
    replace: "    (true ? embed : skipped)",
    test: "tests/build-server-module-embed.test.ts",
    filter:
      "assetIncludes(root, entry): two sibling targets each embed only their own reachable *.server.ts",
  },
  {
    what:
      "the cli target compiles without its entry and embeds every sibling target's server code in the terminal binary",
    file: "src/build/build-cli.ts",
    find: "  const assets = await assetIncludes(root, cliEntry);",
    replace: "  const assets = await assetIncludes(root);",
    test: "tests/build-server-module-embed.test.ts",
    filter:
      "assetIncludes: every compile path in src/ passes its entry — no target embeds the whole tree",
  },
  {
    what:
      "an own MainActivity.kt that merely MENTIONS AioNativeStore passes as installing it — the standalone APK falls back to localStorage and loses a change on a kill, with nothing said (remote-desktop report §5)",
    file: "src/build/build-android.ts",
    find: "      sources.includes('\"AioNativeStore\"'))",
    replace: '      sources.includes("AioNativeStore"))',
    test: "tests/build-android-own-activity.test.ts",
    filter:
      "own MainActivity.kt: a standalone overlay without the store or insets frame warns for both, naming the fix",
  },
  {
    what:
      "a nested entry pinned to a release makes dev serve the diagnostic page instead of the app, on every boot",
    file: "src/server/graph-validator.ts",
    find: 'const dj = locateDenoJsonAbove(toFileUrl(join(absBaseDir, "/")));',
    replace: 'const dj = locateDenoJsonAbove(toFileUrl("/"));',
    test: "tests/nested-entry-release-pin.test.ts",
    filter:
      "nested entry (src/agent/app.ts) pinned to a framework copy with no node_modules: dev serves the app, not the diagnostic page",
  },
  {
    what:
      "the DNS-rebinding Host gate is off for every HTTP/2 request — a foreign name passes",
    file: "src/server/server-auth.ts",
    find: "  const hostHeader = requestHost(req);",
    replace: '  const hostHeader = req.headers.get("host");',
    test: "tests/host-gate-http2.test.ts",
    filter:
      "host gate over real HTTP/2: a foreign :authority is refused (403), an allowlisted one and a same-origin POST pass",
  },
  {
    what:
      "a same-origin POST over HTTP/2 is refused as cross-origin by the origin check",
    file: "src/server/server-auth.ts",
    find: "    hostHeader: requestHost(req),",
    replace: '    hostHeader: req.headers.get("host"),',
    test: "tests/host-gate-http2.test.ts",
    filter:
      "host gate over real HTTP/2: a foreign :authority is refused (403), an allowlisted one and a same-origin POST pass",
  },
  {
    what:
      "every same-origin login, signup and logout POST over HTTP/2 is refused cross_origin — nobody can sign in",
    file: "src/server/auth-flows.ts",
    find: '    return new URL(origin).host === (requestHost(req) ?? "");',
    replace:
      '    return new URL(origin).host === (req.headers.get("host") ?? "");',
    test: "tests/auth-flow-same-origin-h2.test.ts",
    filter:
      "auth flows over HTTP/2: a same-origin POST is not refused as cross-origin",
  },
  {
    what:
      "the timeline diff builds a key string, a Set entry and a path for every row on every commit again — ~38 ms per one-row edit at 131k rows, paid in prod on every dispatch",
    file: "src/server/timeline.ts",
    find: "      const n = Math.max(aa.length, bb.length);",
    replace:
      "      const n = Math.max(aa.length, bb.length) + new Set(Object.keys(aa)).size * 0;",
    test: "tests/timeline-diff-oracle.test.ts",
    filter:
      "timeline diff: a one-row edit in a 131k-row array does not walk every row",
  },
  {
    what:
      "every UDS patch round serializes the whole view again just to compare lengths — 23 ms a round at 14.7 MB, on the transport every desktop window uses",
    file: "src/server/uds.ts",
    find: "                (client.queuedJson ?? client.lastFullJson)?.length,",
    replace: "                undefined,",
    test: "tests/uds-patch-decider.test.ts",
    filter:
      "uds: a small patch round on a big state does not serialize the view",
  },
  {
    what:
      "the UDS line reader rescans the whole carried frame on every chunk again — quadratic, seconds of main-process CPU to receive one multi-MB state frame in Electron, the server and the CLI",
    file: "src/protocol/line-reader.ts",
    find: '      let nl = chunk.indexOf("\\n");',
    replace:
      '      let nl = (parts.join("") + chunk).indexOf("\\n") < 0 ? -1 : chunk.indexOf("\\n");',
    test: "tests/line-reader.test.ts",
    filter: "line reader: a 4 MB frame in 1 KB chunks is read in linear time",
  },
  {
    what:
      "an app's persist size guard reads whichever app booted last — another app's cellState budget warns about and records breaches on cells this app declared large on purpose",
    file: "src/server/aio-boot.ts",
    find: "    budgets: cfg.budgets,",
    replace: "    budgets: undefined,",
    test: "tests/persist-budgets-per-app.test.ts",
    filter:
      "persist budgets: two apps booted concurrently each judge their cells by their OWN cellState",
  },
  {
    what:
      "a standalone app whose state outgrew localStorage logs a bare DOMException after NOT SAVED — every later change is lost with no size, no fix and no chapter to follow",
    file: "src/standalone-air.ts",
    find: "      const quota = _isQuotaError(e)",
    replace: "      const quota = false && _isQuotaError(e)",
    test: "tests/standalone-large-state-hints.test.ts",
    filter:
      "standalone large state: a full localStorage quota names its size, the Fix and the chapter",
  },
  {
    what:
      "a compiled headless binary claims its bundled App.tsx is missing — the boot report reads as a lost component",
    file: "src/server/lint.ts",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    find: "      isCompiled()\n        ? `headless (not serving a UI${why})`",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    replace: "      false\n        ? `headless (not serving a UI${why})`",
    test: "tests/headless-names-its-client.test.ts",
    filter:
      "headless in a compiled binary: names the reason, never a missing component",
  },
  {
    what:
      "a headless server announces which look a page would get — boot noise about a page it never serves",
    file: "src/server/aio.ts",
    find: "  const themeNote = isHeadless ? null : _themeBootNote(",
    replace: "  const themeNote = false ? null : _themeBootNote(",
    test: "tests/headless-no-theme-note.test.ts",
    filter: "headless boot: no 'default look' line — there is no page to style",
  },
  {
    what:
      "a blown budget warning lands in error.log as an ERROR — one event at two levels, a red line for a warning",
    file: "src/server/aio-run-helpers.ts",
    find:
      '        warn: (msg: string, data?: Record<string, unknown>) =>\n          getLogger()?.pub("warn", "aio", msg, data),\n',
    replace: "",
    test: "tests/budget-warning-one-level.test.ts",
    filter:
      "a blown budget reaches the log file at WARN, the level the console says",
  },
  {
    what:
      "the error box header prints a raw performance.now delta like 95.9382579999999ms beside the rounded message",
    file: "src/diagnostics/error.ts",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    find: "    c.duration != null && `${+c.duration.toFixed(1)}ms`,",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    replace: "    c.duration != null && `${c.duration}ms`,",
    test: "tests/budget-warning-one-level.test.ts",
    filter: "the error box header rounds the duration like its message",
  },
  {
    what:
      "the Host gate ignores the served certificate's names, so every TLS app reached by its own domain gets a 403",
    file: "src/server/server-auth.ts",
    find:
      "  if (opts.certNames?.some((p) => certNameCovers(p, name))) return true;",
    replace:
      "  if (opts.certNames?.some((p) => certNameCovers(p, name)) && false) return true;",
    test: "tests/host-gate-cert-names.test.ts",
    filter:
      "host gate: a name in the served TLS certificate passes over h2 and HTTP/1.1; any other name is 403 with the fix line",
  },
  {
    what:
      "the server never hands the certificate's names to the gate, so the decider is correct but its input is empty",
    file: "src/server/server.ts",
    find: "      certNames: servedCertNames,",
    replace: "      certNames: [],",
    test: "tests/host-gate-cert-names.test.ts",
    filter:
      "host gate: a name in the served TLS certificate passes over h2 and HTTP/1.1; any other name is 403 with the fix line",
  },
  {
    what:
      "the browser import map ignores the shared walk, so a nested entry's page loses its npm packages (blank screen)",
    file: "src/server/server-html-importmap.ts",
    find: "  if (located) {",
    replace: '  if (located && baseDir === "\\0") {',
    test: "tests/import-map-nested-entry.test.ts",
    filter:
      "import map: an entry two folders below deno.json finds the same config the graph check finds",
  },
  {
    what:
      "the WebSocket Origin check reads only the Host header, so a request without one has its own origin refused",
    file: "src/server/server-ws.ts",
    find: "        hostHeader: requestHost(req),",
    replace: '        hostHeader: req.headers.get("host"),',
    test: "tests/ws-origin-reads-request-host.test.ts",
    filter:
      "ws origin check: with no Host header, the URL's authority is this server's own origin",
  },
  {
    what:
      "a layout's fitsSystemWindows is ignored, so a correct overlay is told its page draws under the status bar",
    file: "src/build/build-android.ts",
    find: '    !FITS_SYSTEM_WINDOWS_XML.test(opts.resXml ?? "")',
    replace: '    !FITS_SYSTEM_WINDOWS_XML.test("")',
    test: "tests/build-android-own-activity.test.ts",
    filter:
      'own MainActivity.kt: fitsSystemWindows="true" in the overlay res/ XML counts as insets handling',
  },
  {
    what:
      "a symlinked root makes the whole graph look outside the project, so the binary dies at a sibling server-module import",
    file: "src/build/build-compile.ts",
    find: "    const base = await Deno.realPath(root);",
    replace: "    const base = root;",
    test: "tests/build-server-module-symlink-root.test.ts",
    filter:
      "assetIncludes: a symlinked project root embeds the same *.server.ts as the real one, and says loudly what it skips",
  },
  {
    what:
      "the skipped-module line loses its warning prefix and scrolls past, so the one-line fix is never seen",
    file: "src/build/build-compile.ts",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    find:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      "        `${HEY} not embedding ${plan.skipped.length} *.server.ts ${entry} cannot ` +",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    replace:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      "        `not embedding ${plan.skipped.length} *.server.ts ${entry} cannot ` +",
    test: "tests/build-server-module-symlink-root.test.ts",
    filter:
      "assetIncludes: a symlinked project root embeds the same *.server.ts as the real one, and says loudly what it skips",
  },
  {
    what:
      "the web binary embeds the agent target's server code (input injection) because its folder sits under src/",
    file: "src/build/build-compile.ts",
    find: "    if (siblingOwns(c)) {",
    replace: "    if (siblingOwns(c) && false) {",
    test: "tests/build-server-module-sibling-targets.test.ts",
    filter:
      "assetIncludes (am create shape): the web binary does not embed the agent target's *.server.ts, and vice versa",
  },
  {
    what:
      "manifest.json records the unit's size before its rewrite, so a release pipeline's byte check fails",
    file: "src/build-all.ts",
    find:
      "        for (const p of placed) p.bytes = await sizeOf(join(outDir, p.file));",
    replace: "        // bytes left as staged",
    test: "tests/build-fleet-service-unit-final.test.ts",
    filter:
      "fleet: manifest.json records every placed artifact's size ON DISK, after the unit's rewrite",
  },
  {
    what:
      "the builder prints a finished checkmark on a staged unit path that the fleet then moves away",
    file: "src/build/build-compile.ts",
    find: "  compiled(serviceFile, cfg.root ?? Deno.cwd());",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    replace: "  console.log(`✓ ${serviceFile}`);",
    test: "tests/build-fleet-service-unit-final.test.ts",
    filter:
      "writeServiceFile under the fleet: the unit's path is said as STAGED, never as a finished ✓",
  },
  {
    what:
      "a one-row edit in a 131k-row array allocates 131k paths per commit with the journal on, in prod",
    file: "src/sync/state-patch.ts",
    find: "      if (x !== y) walk(x, y, [...path, i], out);",
    replace: "      walk(x, y, [...path, i], out);",
    test: "tests/state-patch-diff-oracle.test.ts",
    filter:
      "state-patch diff: a one-row edit in a 131k-row array does not walk every row",
  },
  {
    what:
      "app A's pressure monitor records payload breaches into whichever app booted last",
    file: "src/vitals/mod.ts",
    find: "      budgets,",
    replace: "      budgets: budgetsFor(),",
    test: "tests/budgets-owner-ledger.test.ts",
    filter:
      "budgets owner: the vitals pressure monitor records into the ledger it is handed, not the latest boot's",
  },
  {
    what:
      "per-cell size lines size payload from one cell, so the declaration they print never quiets the frame warning",
    file: "src/state/budgets.ts",
    find: "    : declareCellState(bytes);",
    replace: "    : declareLargeState(bytes);",
    test: "tests/large-state-hints.test.ts",
    filter:
      "large-state fix: a per-cell line never sizes payload from one cell — the declaration it prints really quiets it",
  },
  {
    what:
      "a failed shutdown during an update handover is swallowed and the FAILED line never fires",
    file: "src/server/aio.ts",
    find: "      shutdown,",
    replace: "      shutdown: () => shutdown().catch(() => {}),",
    test: "tests/updates-handover-shutdown-fails.test.ts",
    filter:
      "updates handover: aio.ts hands the updates runtime its shutdown unswallowed",
  },
  {
    what:
      "every boot reopens and rescans every store copy instead of only the unverified ones",
    file: "src/server/aio-boot.ts",
    find: "    if (known(p)) continue; // verified before, unchanged since",
    replace:
      "    if (known(p) && !p) continue; // verified before, unchanged since",
    test: "tests/persist-none-scrub-copies-crash.test.ts",
    filter:
      'persist:"none": a crash between the live scrub and the copies\' scrub still scrubs the copies on the next boot — and a verified copy is not reopened',
  },
  {
    what:
      "the biggest frame a client ever gets bypasses the payload budget and the PRESSURE line",
    file: "src/server/server-ws.ts",
    find:
      "        if (pressure) pressure.onBroadcast(meta.id, utf8Size(frame));",
    replace: "        if (pressure) void frame;",
    test: "tests/ws-connect-frame-pressure.test.ts",
    filter:
      "ws connect: the initial whole-state frame is metered against the payload budget",
  },
  {
    what:
      "a whole view re-sent on resync, subs or a user change bypasses the payload budget and PRESSURE",
    file: "src/server/server-ws.ts",
    find:
      "      // Metered: a resync is a whole view, paid in full.\n      deps.vitalsSystem?.pressureMonitor?.onBroadcast(meta.id, utf8Size(frame));",
    replace: "      // Metered: a resync is a whole view, paid in full.",
    test: "tests/ws-connect-frame-pressure.test.ts",
    filter: "ws resync: a whole view re-sent on request is metered too",
  },
  {
    what:
      "a headless server binary ships dist/electron.json, claiming a relay runs Electron",
    file: "src/build/electron-bake.ts",
    find: "    !b.doHeadless;",
    replace: "    true;",
    test: "tests/build-electron-bake.test.ts",
    filter:
      "electron bake: a headless (server-kind) binary carries no electron.json",
  },
  {
    what:
      "am run from a git hook reads and writes the outer repo's tags, worktrees and checkout instead of its own",
    file: "src/am/am-versions.ts",
    find: '      ...gitEnvFor(cwd, { LC_ALL: "C", LANGUAGE: "C" }),',
    replace:
      '      env: { ...gitEnvFor(cwd, { LC_ALL: "C", LANGUAGE: "C" }).env },',
    test: "tests/am-git-env.test.ts",
    filter:
      "am git: an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE never redirects am to another repo",
  },
  {
    what:
      "am fix treats the app's own symlinked dep/aio as a parent's and never repairs its pin, link or tasks",
    file: "src/am/am-cmd-fix.ts",
    find: "  return real(dirname(dirname(provider))) === real(dir);",
    replace: "  return resolve(dirname(dirname(provider))) === resolve(dir);",
    test: "tests/am-fix-nested-app.test.ts",
    filter:
      "isOwnDepAio: the app's own dep/aio through a symlinked absolute path is its own",
  },
  {
    what:
      "am stop --profile in a component project is refused with advice to run the very command refused",
    file: "src/am.ts",
    find: "    if (appIsAmbiguous(flags.app)) {",
    replace: "    if (appIsAmbiguous(flags.app) && false) {",
    test: "tests/am-components-lazy-app.test.ts",
    filter:
      "am components: --profile/--home without a component is refused with --app=<component>, never with the refused verb",
  },
  {
    what:
      "am restart of an app started with --entry stops it and leaves it down",
    file: "src/am/am-cmd-process.ts",
    find:
      "  if (re.entry !== undefined) flags = { ...flags, entry: re.entry };",
    replace: '  if (re.entry === "\\0") flags = { ...flags, entry: re.entry };',
    test: "tests/am-restart-replays-entry.test.ts",
    filter:
      "am restart: an app started with --entry comes back on it; a restart that cannot start leaves the app UP",
  },
  {
    what:
      "a restart that cannot start again still stops the running app first and leaves it down",
    file: "src/am/am-cmd-process.ts",
    find: "    if (cannot) {",
    replace: "    if (cannot && !running) {",
    test: "tests/am-restart-replays-entry.test.ts",
    filter:
      "am restart: an app started with --entry comes back on it; a restart that cannot start leaves the app UP",
  },
  {
    what:
      "components without an appId get the target name, so am waits on an id nothing runs under",
    file: "src/am/am-components.ts",
    find: "      appId: componentAppId(root, abs, declared.appId),",
    replace:
      "      appId: resolveAppId(declared.appId ?? t.appName ?? t.name),",
    test: "tests/am-components-identity.test.ts",
    filter:
      "components: two entries without an appId in a titled project are ONE app — refused up front",
  },
  {
    what:
      "a failed project start hides which components are up and which were never attempted",
    file: "src/am/am-cmd-process.ts",
    find: "    if (line) sayErr(line);",
    replace: '    if (line === "") sayErr(line);',
    test: "tests/am-components-lazy-app.test.ts",
    filter:
      "am components: a failed project start names the component that failed and the ones never tried",
  },
  {
    what:
      "the multi-component refusal names only the first component's --app spelling",
    file: "src/am/am-utils.ts",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    find: 'const pick = labels.map((l) => `--app=${l}`).join(" | ");',
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    replace: "const pick = `--app=${labels[0]}`;",
    test: "tests/am-components-lazy-app.test.ts",
    filter:
      "am components: a single-app verb without --app is refused with the named fix",
  },
  {
    what:
      "am stop exits 0 while the process is still alive, so a restart hits Already running",
    file: "src/am/am-cmd-process.ts",
    find: "  if (flags.wait === undefined && !flags.noWait) {",
    replace: "  if (flags.wait === undefined && flags.noWait) {",
    test: "tests/am-cmd.test.ts",
    filter: "am: cmdStop — by default waits until the process is gone",
  },
  {
    what:
      "a socket-only app's start reports port 0, a door that does not exist",
    file: "src/am/am-cmd-process.ts",
    find: "  const door = socketPath && !port",
    replace: "  const door = socketPath && port < 0",
    test: "tests/am-start-names-socket.test.ts",
    filter:
      "startedReport: a socket-only app is named by its socket, never 'port 0'",
  },
  {
    what:
      "a stale dev checkpoint handed to onCheckpointRestore restores hours-old state into live state without any warning",
    file: "src/server/aio-boot.ts",
    find: "      if (stale) log.warn(stale);",
    replace: "      if (stale) log.info(stale);",
    test: "tests/checkpoint-stale-warn-needs-hook.test.ts",
    filter:
      "checkpoint age: a stale snapshot WITH onCheckpointRestore warns before it is applied",
  },
  {
    what:
      "a dynamic import of a Deno-using file one hop from a cell ships that file in the browser bundle unflagged",
    file: "aiol/checks.ts",
    find:
      "      if (hop && !browserGraph.includes(hop)) browserGraph.push(hop);",
    replace: "      if (hop && !browserGraph.includes(hop)) void hop;",
    test: "tests/aiol-dynamic-import-reach.test.ts",
    filter:
      "aiol: import() of a Deno-using file one hop from a cell is flagged, fix names the .server.ts rename",
  },
  {
    what:
      "library loaded-before guards fire on first load, printing false Multiple instances warnings on every check and dev boot",
    file: "src/build/graph-eval.ts",
    find: "      if (isMarker(p)) return undefined;",
    replace: "      if (isMarker(p) && false) return undefined;",
    test: "tests/graph-eval-window-stub.test.ts",
    filter:
      "graph-eval stub: the three.js loaded-before guard evaluates silently on first load",
  },
  {
    what:
      "am trigger refuses every handle that lives inside a child component, so agents cannot drive nested controls at all",
    file: "src/air/ui-remote.ts",
    find: "  if (hits.length === 1) return { el: hits[0]! };",
    replace: "  if (hits.length === -1) return { el: hits[0]! };",
    test: "tests/am-trigger-handle-resolve.test.ts",
    filter:
      "am trigger: a handle in a child component resolves like testUI (bare, App:, Component:)",
  },
  {
    what:
      "am create refuses --client=, the spelling deno.json and deno task dev use, so users hit an unknown-flag error",
    file: "src/am/am-cmd-create.ts",
    find:
      '    } else if (a.startsWith("--client=") || a.startsWith("--target=")) {',
    replace: '    } else if (a.startsWith("--target=")) {',
    test: "tests/am-create-client-flag.test.ts",
    filter: "am create: --client= picks the target, --target= stays an alias",
  },
  {
    what:
      "doctor calls an incomplete deno.lock complete, so clones silently resolve different aio build and test tooling",
    file: "src/server/lock-coverage.ts",
    find: "    for (const k of Object.keys(a)) if (!(k in b)) out.push(k);",
    replace: "    for (const k of Object.keys(a)) if (!(k in a)) out.push(k);",
    test: "tests/doctor-lock-coverage.test.ts",
    filter:
      "doctor lock coverage: a lock missing aio's tool entries is a WARN naming am fix, and is never written",
  },
  {
    what:
      "am fix caches only the app entry, so the doctor's run-am-fix advice never repairs the lock",
    file: "src/am/am-cmd-fix.ts",
    find: "  return [entry, ...tools];",
    replace: "  return [entry];",
    test: "tests/doctor-lock-coverage.test.ts",
    filter:
      "doctor lock coverage: what am fix caches is the repair — after it, the line PASSes",
  },
  {
    what:
      "a late s.$do from an app timer throws uncaught instead of logging — the timer's throw ends the whole server process",
    file: "src/state/cell-methods-internals.ts",
    find: "  if (_bodyDepth > 0) throw new Error(msg);",
    replace: "  throw new Error(msg);",
    test: "tests/do-after-method-returned.test.ts",
    filter:
      "$do (sync) captured and called after the method returned is refused by name in the log, runs nothing, throws nothing",
  },
  {
    what:
      "a stashed s.$do called inside a later method no longer fails that method — the refusal is only a log line nobody's call sees",
    file: "src/state/cell-methods-internals.ts",
    find: "  _bodyDepth++;",
    replace: "  _bodyDepth += 0;",
    test: "tests/do-after-method-returned.test.ts",
    filter:
      "$do (sync) stashed and called by a LATER method fails that call — no effect, no write",
  },
  {
    what:
      "a late sync s.$do is silent again — the effect a callback scheduled is lost and nothing is logged",
    file: "src/state/cell-methods-internals.ts",
    find: "      if (returned) return refuseLateDo(prefix, key);",
    replace:
      "      if (returned && effects.length < 0) return refuseLateDo(prefix, key);",
    test: "tests/do-after-method-returned.test.ts",
    filter:
      "$do (sync) captured and called after the method returned is refused by name in the log, runs nothing, throws nothing",
  },
  {
    what:
      "a transaction's late s.$do goes into a write-set already published — the effect is dropped and nothing is logged",
    file: "src/state/cell-methods-internals.ts",
    find: "          if (transactional && batcher.closed()) {",
    replace:
      "          if (transactional && batcher.closed() && Date.now() < 0) {",
    test: "tests/do-after-method-returned.test.ts",
    filter:
      "$do (async, transaction) after the call settled is refused by name in the log — not dropped into a published write-set, no throw",
  },
  {
    what:
      "a method a disposed boot started calls a sibling through the cell handle and commits into the next boot's state, silently",
    file: "src/standalone-air.ts",
    find:
      "  if (caller?.dead) _refuseDeadGeneration(type, caller.site, caller.boot);",
    replace: "  void caller;",
    test: "tests/bootcells-generation-fence.test.ts",
    filter:
      "generation fence: a call a disposed boot started never commits into the next boot, and it is said",
  },
  {
    what:
      "a retired boot's refused drain still publishes its stale state and overwrites what the live boot's reads return",
    file: "src/standalone-air.ts",
    find: "      if (fence.dead) return;",
    replace: "      void fence;",
    test: "tests/bootcells-generation-fence.test.ts",
    filter:
      "generation fence: a call a disposed boot started never commits into the next boot, and it is said",
  },
  {
    what:
      "bootCells never installs the boot scope, so a dead boot's handle call is unrecognised and commits into the next test",
    file: "src/testing/cell-test.ts",
    find: "  _armBootScope(standalone._installBootScope);",
    replace: "  void standalone._installBootScope;",
    test: "tests/bootcells-generation-fence.test.ts",
    filter:
      "generation fence: a call a disposed boot started never commits into the next boot, and it is said",
  },
  {
    what:
      "testUI never installs the boot scope, so mount A's late handle call commits into mount B unseen",
    file: "src/testing/ui-test.ts",
    find: "    _armBootScope(standalone._installBootScope);",
    replace: "    void standalone._installBootScope;",
    test: "tests/testui-generation-fence.test.tsx",
    filter:
      "testUI generation fence: a call a disposed mount started never commits into the next mount, and it is said",
  },
  {
    what:
      "a corrupt saved state stays under its key after set-aside, so every short launch adds another full-size copy until the quota fills",
    file: "src/standalone-air.ts",
    find: '  if (setAside) writeNow("reset");',
    replace: '  if (setAside && Date.now() < 0) writeNow("reset");',
    test: "tests/standalone-quarantine-once.test.ts",
    filter:
      "restore: a corrupt value is set aside once — launches that never change anything do not pile up copies",
  },
  {
    what:
      "the umask ratchet is per file again — one wrapped test clears every unwrapped mode assertion beside it",
    file: "tests/mode-tests-force-umask.test.ts",
    find: "  const cs = chunks(src);",
    replace:
      "  if (FORCES_UMASK.test(src)) return null;\n  const cs = chunks(src);",
    test: "tests/mode-tests-force-umask.test.ts",
    filter:
      "mode tests: the scanner catches every spelling, and only a real way out clears it",
  },
  {
    what:
      "bootCells drops an onInit throw into the log only — the test passes with the cell never initialised",
    file: "src/testing/cell-test.ts",
    find: "  ledger.adopt(inits.take());",
    replace: "  void inits;",
    test: "tests/harness-oninit-strict.test.tsx",
    filter:
      "bootCells: an onInit that throws fails the test at settle(), naming the cell and the way out",
  },
  {
    what:
      "testUI shows an onInit throw only as post-test output — the mount passes with the cell never initialised",
    file: "src/testing/ui-test.ts",
    find: "    ledger.adopt(inits.take());",
    replace: "    void inits;",
    test: "tests/harness-oninit-strict.test.tsx",
    filter:
      "testUI: an onInit that throws fails the test — at the mount's own settle",
  },
  {
    what:
      "testCell silently skips a cell's onInit — an onInit that throws, or the work it starts, is never mentioned",
    file: "src/testing/cell-test.ts",
    find: "    _sayOnInitSkipped(f);",
    replace: "    void _sayOnInitSkipped;",
    test: "tests/harness-oninit-strict.test.tsx",
    filter:
      "testCell: a cell with onInit is told, once, that onInit does not run there",
  },
  {
    what:
      "the INIT_ERROR tip stops naming app.dispatch — the reader of a failed onInit is not shown the one door that works there",
    file: "src/diagnostics/error.ts",
    find:
      '        `work from onInit, dispatch it — \\`app.dispatch({ type: "<cell>:<method>", ` +',
    replace: "        `work from onInit, dispatch it — ` +",
    test: "tests/harness-oninit-strict.test.tsx",
    filter:
      "INIT_ERROR tip names app.dispatch and onStart, not a generic guess",
  },
  {
    what:
      "the still-booting refusal stops naming app.dispatch with the cell's own action type — onInit authors get no working fix",
    file: "src/state/cell-catalog.ts",
    // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
    find:
      // aio-ok: ledger text is SOURCE, matched verbatim — never interpolated
      '          `\\`app.dispatch({ type: "${cellName}:${key}", payload: { args: [] } })\\` ` +',
    replace: "          `\\`app.dispatch(...)\\` ` +",
    test: "tests/harness-oninit-strict.test.tsx",
    filter:
      "bootCells: an onInit that throws fails the test at settle(), naming the cell and the way out",
  },
  {
    what:
      "a queued method with nothing ahead of it starts a microtask late, so a sync call made after it runs first and it reads the later state",
    file: "src/state/method-policy.ts",
    find: "    const after = queueTail.get(key);",
    replace: "    const after = queueTail.get(key) ?? Promise.resolve();",
    test: "tests/queue-starts-in-call-order.test.ts",
    filter:
      "call order: a queue call with nothing ahead starts before a call made after it",
  },
  {
    what:
      "a queued method's slot is freed only after its trailing cleanup, so the caller's next call right after await starts after a later call",
    file: "src/state/cell-methods-internals.ts",
    find:
      "        onSettled = () => releaseQueueTail(prefix, _method, next, policyStore);",
    replace: "        onSettled = () => void next;",
    test: "tests/queue-starts-in-call-order.test.ts",
    filter:
      "call order: a queue call with nothing ahead starts before a call made after it",
  },
  {
    what:
      "the serialize mutex always chains, even when idle, so a serialized transaction starts after a sync call made later than it",
    file: "src/state/cell-methods-internals.ts",
    find: "        onSettled = free;",
    replace: "        void free;",
    test: "tests/queue-starts-in-call-order.test.ts",
    filter:
      "call order: a serialize call with nothing ahead starts before a call made after it",
  },
  {
    what:
      "a nested testUI's teardown strands the outer harness: every later call of the live outer test is refused as a torn-down runtime's",
    file: "src/standalone-air.ts",
    find: "          return Promise.resolve(_liveFor(app).dispatch(action));",
    replace: "          return Promise.resolve(app.dispatch(action));",
    test: "tests/access-origin-boundaries.test.tsx",
    filter:
      "access origin: an outer testUI keeps the scope after an inner one is torn down",
  },
  {
    what:
      "am start --app=<component> runs the project's default entry under the component's identity — the free edition registered as PRO, starting forever",
    file: "src/am/am-components.ts",
    find: "      if (c && !componentConflict(components)) {",
    replace:
      '      if (c && !componentConflict(components) && opts.app === "\\0") {',
    test: "tests/am-components.test.ts",
    filter: "plan: --app=<component> is that component — its id AND its entry",
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
  // An EMPTY repo, never the real `.git`: a test that guards the checkout it
  // runs in (the am sweep asserts it registered no `git worktree`) needs a
  // repo to ask, and failing its unmutated baseline would drop every entry
  // behind it. Empty on purpose — no tags, so tag-reading tests skip exactly
  // as they do in any `git archive` copy, and nothing can reach the real one.
  {
    const init = await sh("git", ["init", "-q"], { cwd: dir });
    if (init.code !== 0) throw new Error(`git init failed:\n${init.out}`);
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
      ...m.env,
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

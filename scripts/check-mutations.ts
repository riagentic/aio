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
//   deno task check:mutations --only='a||b'   entries matching any alternative
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
    find: "    if (sha !== opts.expectSha256.toLowerCase()) {",
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
    // aio-ok: the literal SOURCE line this mutation patches in and out
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
      "          state: fieldsAsRestart(\n            restorableSlices(\n              raw.state,\n              cfg.persistingCellIds,\n              initialState as Record<string, unknown>,\n            ),\n            cfg.cellPersist,\n            state as Record<string, unknown>,\n          ),",
    replace: "          state: raw.state as Record<string, unknown>,",
    test: "tests/checkpoint-restore-shape.test.ts",
    filter:
      'checkpoint restore: a checkpoint an OLDER build wrote raw never hands back a persist:"none" slice',
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
    find: "        ) || unkept(actionCell(action.type, action.payload)) ||",
    replace: "        ) ||",
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
    what:
      "a transaction still running at shutdown that never read its signal is discarded — every queued serialized write is silently lost",
    file: "src/state/cell-methods-internals.ts",
    find: "        (!abortedByShutdown(controller.signal) ||",
    replace: "        (true ||",
    test: "tests/shutdown-queued-calls-land.test.ts",
    filter:
      "shutdown: serialized transactional calls queued at close() all land",
  },
  {
    what:
      "a transaction that read its signal and stood down at shutdown commits half of itself to disk",
    file: "src/state/cell-impl.ts",
    find: "        if (_signal) _signalsRead.add(_signal);",
    replace: "        if (_signal) void _signalsRead;",
    test: "tests/shutdown-queued-calls-land.test.ts",
    filter:
      "shutdown: a queued transaction that read $signal and stood down commits nothing",
  },
  {
    what:
      "shutdown never aborts in-flight or queued calls, so a stand-down loop keeps running after close() resolves",
    file: "src/state/method-cancel.ts",
    find: "        shutdownAbort(c);",
    replace: "        void c;",
    test: "tests/shutdown-queued-calls-land.test.ts",
    filter:
      "shutdown: a serialize stand-down loop whose lock frees inside the drain ends it early",
  },
  {
    what:
      "closing one app kills the child processes another app in the same process spawned",
    file: "src/server/spawn.ts",
    find:
      "  return owner === undefined || v.owner === undefined || v.owner === owner;",
    replace: "  return true;",
    test: "tests/two-apps-process-registries.test.ts",
    filter: "two apps: closing B leaves the children A spawned running",
  },
  {
    what:
      "an open sibling app serves a serverFns namespace another app registered behind its auth",
    file: "src/server/server-fns.ts",
    find: "  if (owner !== undefined) _owner.set(ns, owner);",
    replace: "  void owner;",
    test: "tests/two-apps-process-registries.test.ts",
    filter: "two apps: a serverFns namespace A registered is served by A only",
  },
  {
    what:
      "the last booted app's call ceiling bounds every other app's awaited method calls, even after it closes",
    file: "src/state/cell-impl.ts",
    find: "    _ceilingsOf.set(scope, c);",
    replace: "    void _ceilingsOf;",
    test: "tests/two-apps-process-registries.test.ts",
    filter:
      "two apps: each app's call ceiling is its own, and outlives the other's close",
  },
  {
    what:
      "one app's browser console lines are written into another app's client.log, and its own stays empty",
    file: "src/server/client-log.ts",
    find: "  if (scope !== undefined) _logDirOf.set(scope, logDir);",
    replace: "  void scope;",
    test: "tests/two-apps-process-registries.test.ts",
    filter:
      "two apps: a browser's console lines land in its own app's client.log",
  },
  {
    what:
      "signups on one app spend the signup budget of every other app in the process",
    file: "src/server/server-auth.ts",
    find: "  if (scope === undefined) return _processLedger;",
    replace: "  if (scope === undefined || scope) return _processLedger;",
    test: "tests/two-apps-process-registries.test.ts",
    filter: "two apps: the signup budget is counted per app",
  },
  {
    what:
      "a bound method called from outside any app uses the last booted app's call ceiling, not its own",
    file: "src/server/aio-cells-bridge.ts",
    find: "    if (scope) _bindCallScope(dispatch, scope);",
    replace: "    void _bindCallScope;",
    test: "tests/two-apps-process-registries.test.ts",
    filter:
      "two apps: each app's call ceiling is its own, and outlives the other's close",
  },
  {
    what:
      "a top-level serverFns namespace that every app in the process serves is never announced",
    file: "src/server/server-fns.ts",
    find: "  for (const ns of _registry.keys()) announceShared(ns);",
    replace: "  void announceShared;",
    test: "tests/serverfns-shared-namespace-warns.test.ts",
    filter:
      "serverFns: a namespace registered outside any app is named once two apps serve it",
  },
  {
    what:
      "aio's boot pins Deno's ambient context to the booting app, so unwrapped handlers and later tests run as that app forever",
    file: "src/server/lint.ts",
    find: "      await importOutsideApp(esbuildPkg);",
    replace: "      await import(esbuildPkg);",
    test: "tests/app-scope-ends-at-close.test.ts",
    filter: "app scope: an app boots, is called, and closes",
  },
  {
    what:
      "a closed app's scope survives its close through an npm import, so later handlers log and report as a dead app",
    file: "src/server/aio-cells-bridge.ts",
    find: "      if (ownScope) ownScope.closed = true;",
    replace: "      void ownScope;",
    test: "tests/app-scope-ends-at-close.test.ts",
    filter:
      "app scope: an app's method loads an npm module, then the app closes",
  },
  {
    what:
      "snapshot load leaves sync cells undurable, so a restart brings back the writes the load undid",
    file: "src/server/aio.ts",
    find: "        _jumpSyncCells(before, s);",
    replace: "        void 0;",
    test: "tests/snapshot-load-sync-cell-durable.test.ts",
    filter:
      "snapshot load: a sync:true cell's loaded state survives a restart (journal off, close, api)",
  },
  {
    what:
      "the data.replaced-* copy that am restore keeps holds the persist:none secret forever, with no warning",
    file: "src/server/aio-boot.ts",
    find: "      ...replaced,",
    replace: "      ...replaced.slice(0, 0),",
    test: "tests/persist-none-scrub-replaced.test.ts",
    filter:
      'persist:"none": an am restore\'s data.replaced-* copy (and its nested backups) is scrubbed once, said once',
  },
  {
    what:
      "a persist:none cell's secret method arguments are written raw into the durability journal on disk",
    file: "src/server/journal.ts",
    find: "        payload: hide || unstored ? REDACTED : action.payload,",
    replace: "        payload: hide ? REDACTED : action.payload,",
    test: "tests/journal-persist-none-args.test.ts",
    filter:
      'journal: a persist:"none" cell\'s method arguments never reach the journal — its listensTo reactions on persisted cells still survive a SIGKILL',
  },
  {
    what:
      "scrubbing an old journal copy silently loses acked listensTo reactions when that copy is restored",
    file: "src/server/journal.ts",
    find: "    if (listened.has(e.type)) {",
    replace: "    if (listened.has(e.type) && false) {",
    test: "tests/persist-none-scrub-journal-old-listener.test.ts",
    filter:
      'persist:"none": a v1.0.11 journal copy keeps a listened-to call (named in a warning) and scrubs the rest — restoring it recovers every acked reaction',
  },
  {
    what:
      "a backup journal keeps the secret argument when the live store has no snapshot yet",
    file: "src/server/aio-boot.ts",
    find: "        cfg.persistingCellIds && none.length > 0 && openedDbPath &&",
    replace:
      "        migrated && cfg.persistingCellIds && none.length > 0 && openedDbPath &&",
    test: "tests/persist-none-scrub-journal-copies.test.ts",
    filter:
      'persist:"none": a copied journal is scrubbed on a boot whose store holds NO snapshot yet (a crash before the first save, then a backup)',
  },
  {
    what:
      "a forced snapshot load leaves a missing cell without a slice, so every method on it throws until a restart",
    file: "src/server/aio-run-helpers.ts",
    find: "            (parsed as Record<string, unknown>)[k] = init[k];",
    replace: "            void init[k];",
    test: "tests/snapshot-load-sync-cell-durable.test.ts",
    filter:
      "snapshot load --force without a sync cell: the cell is wiped to its initial state live, a restart agrees, and nothing reports a hidden cell",
  },
  {
    what:
      "restoring another profile's archive exits 0 and leaves an app home that refuses to boot",
    file: "src/am/am-cmd-data.ts",
    find: "    if (had !== want && (requested || had !== undefined)) {",
    replace:
      "    if (had !== want && (requested || had !== undefined) && force) {",
    test: "tests/am-restore-profile.test.ts",
    filter: "am restore: every archive/target pair ends bootable or refused",
  },
  {
    what:
      "am restart reports 'did not start' with exit 1 while the relaunched app is up and serving",
    file: "src/am/am-cmd-process.ts",
    find: "    peerOf: { stopped: pf && running ? pf.pid : undefined },",
    replace: "    peerOf: undefined,",
    test: "tests/am-restart-lost-race.test.ts",
    filter:
      "am restart: a racing relaunch that won the lock is reported, not 'did not start'",
  },
  {
    what:
      "a CLI client keeps a stale copy and applies later patches to it after the server refused its full state",
    file: "src/server/cli-client.ts",
    find: '          if (d?.type === "ws-frame-ceiling") {',
    replace: '          if (d?.type === "ws-frame-ceiling-off") {',
    test: "tests/cli-client-frame-ceiling-stale.test.ts",
    filter:
      "cli client: after a refused full state it is out of sync — never a stale copy with new patches",
  },
  {
    what:
      "a dev supervisor whose relaunch lost the lock never steps aside and lingers, invisible to am",
    file: "src/server/dev-restart.ts",
    find:
      "    return l && l.pid !== child && l.pid !== Deno.pid && isLockOwnerAlive(l)",
    replace:
      "    return l && l.pid !== child && l.pid !== Deno.pid && !isLockOwnerAlive(l)",
    test: "tests/dev-restart-race-one-process.test.ts",
    filter:
      "dev restart race: when another start wins the lock, the watcher's supervisor steps aside",
  },
  {
    what:
      "am restart during the dev watcher's relaunch leaves two processes and moves the app to a new port",
    file: "src/server/dev-restart.ts",
    find:
      "    const placed = self ? fileChildPlaceholder(self, child.pid, port) : null;",
    replace: "    const placed = self ? null : null;",
    test: "tests/dev-restart-race-one-process.test.ts",
    filter:
      "dev restart race: am restart during the watcher's relaunch leaves ONE process, on the same port",
  },
  {
    what:
      "a closed app keeps owning its serverFns namespace, so every later app in the process refuses it",
    file: "src/server/server-fns.ts",
    find: "      _owner.delete(ns);",
    replace: "      continue;",
    test: "tests/two-apps-process-registries.test.ts",
    filter:
      "serverFns: a namespace an app registered is served by the next app once the first has closed",
  },
  {
    what:
      "a SIGKILLed or OOM-killed relaunched dev child's lock is deleted, so the abrupt end goes silent",
    file: "src/server/dev-restart.ts",
    find:
      "    if (self && placed !== null) removeLockIf(slotOf(self), placed);",
    replace:
      "    if (self && placed !== null) removeLockIf(slotOf(self), JSON.stringify(readLock(slotOf(self))));",
    test: "tests/dev-restart-race-one-process.test.ts",
    filter:
      "dev restart: a relaunched child killed by SIGKILL leaves its lock, so the next run says it did not shut down cleanly",
  },
  {
    what:
      "a client that goes over the frame ceiling a second time is never told and shows a stale state",
    file: "src/server/server-ws.ts",
    find: "        ) refused = 0;",
    replace: "        ) refused = 1;",
    test: "tests/cli-client-frame-ceiling-stale.test.ts",
    filter:
      "cli client: a second trip over the frame ceiling on a real server is told again — out of sync, not a stale copy",
  },
  {
    what:
      "a prod server-only app is reported not responding, stuck at starting, and killed by the next start as a zombie",
    file: "src/am/am-cmd-process.ts",
    find: '  const health = await get("/__aio/health");',
    replace: '  const health = await get("/");',
    test: "tests/am-start-prod-server-only.test.ts",
    filter:
      "am start --prod: a server-only app (503 at /) is reported started, and a second start refuses instead of killing it",
  },
  {
    what:
      "a build target's own title is ignored and every edition ships under the one deno.json title",
    file: "src/build/build-config.ts",
    find: "  if (displayName) return displayName;",
    replace: "  void displayName;",
    test: "tests/build-target-display-name.test.ts",
    filter:
      "build display name: a per-target title (--display-name=) is the display name",
  },
  {
    what:
      "the fleet drops a target's title on the way to its build, so the edition ships under the project title",
    file: "src/build-all.ts",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    find: '            ? [`--display-name=${t.title ?? flag("display-name")}`]',
    replace: "            ? []",
    test: "tests/build-target-display-name.test.ts",
    filter:
      "build display name: the fleet hands a target's title to its build as --display-name=",
  },
  {
    what:
      "two desktop editions that show one name build silently and the second replaces the first in Applications",
    file: "src/build/build-config.ts",
    find: "      if (a.display === b.display && a.binary !== b.binary) {",
    replace: "      if (a.display === b.display && a.binary === b.binary) {",
    test: "tests/build-target-display-name.test.ts",
    filter:
      "build display name: the fleet warns when two desktop editions would install over each other",
  },
  {
    what:
      "a dev module importing a file outside the app root keeps a relative import the browser cannot reach",
    file: "src/server/server-static.ts",
    find:
      "      if (url === null || _decodePathname(url) === natural) return m;",
    replace: "      return m;",
    test: "tests/dev-import-outside-app-root.test.ts",
    filter:
      "dev import outside the app root: ../ui/Shell.tsx from src/pro/App.tsx loads in dev like the bundle",
  },
  {
    what:
      "the dev source tree above the app root is served whole, not only the files a served module imported",
    file: "src/server/server-static.ts",
    find: "    if (srcTree && !_srcServable.has(filepath)) {",
    replace: "    if (srcTree && _srcServable.size < 0) {",
    test: "tests/dev-import-outside-app-root.test.ts",
    filter:
      "dev import outside the app root: only the imported graph is served, with the app root's guards, and never in prod",
  },
  {
    what:
      "a dev module outside the project source root still gets a dev url and is served from anywhere on disk",
    file: "src/server/server-static.ts",
    find: "  if (srcRoot && _within(srcRoot, file)) {",
    replace: "  if (srcRoot) {",
    test: "tests/dev-import-outside-app-root.test.ts",
    filter:
      "dev import outside the app root: a file outside every root and the source tree has no dev url",
  },
  {
    what:
      "a plain .js/.mjs dev module outside the app root keeps relative imports that name files the dev server never made servable, so they 404",
    file: "src/server/server-static.ts",
    find:
      "      body = _rewriteRelativeImports(body, filepath, pathname, _canonicalUrl);",
    replace: "      body = String(body);",
    test: "tests/dev-import-outside-app-root.test.ts",
    filter:
      "dev import outside the app root: a .js/.mjs module outside the app root has its own relative imports rewritten and served",
  },
  {
    what:
      "editing a module the dev page loads from outside the app root triggers no live reload, leaving a silently stale dev page",
    file: "src/server/server-watcher.ts",
    find: "            if (servedFiles.has(path)) scheduleReload(path);",
    replace: "            if (servedFiles.size < 0) scheduleReload(path);",
    test: "tests/dev-import-outside-app-root.test.ts",
    filter:
      "dev import outside the app root: editing a served ../ui/Shell.tsx live-reloads like an app-root edit",
  },
  {
    what:
      "the webview host-key relay forwards keys the embedder never declared to the host renderer",
    file: "src/electron/electron-shared.ts",
    find: "if (input.type !== 'keyDown' || !set.has(input.key)) return;",
    replace: "if (input.type !== 'keyDown') return;",
    test: "tests/electron-webview-host-keys.test.ts",
    filter:
      "host keys: an undeclared key, and a keyUp, never leave the main process",
  },
  {
    what:
      "the webview host-key relay forwards keyUp too, so every declared key fires twice on the host",
    file: "src/electron/electron-shared.ts",
    find: "if (input.type !== 'keyDown' || !set.has(input.key)) return;",
    replace: "if (!set.has(input.key)) return;",
    test: "tests/electron-webview-host-keys.test.ts",
    filter:
      "host keys: an undeclared key, and a keyUp, never leave the main process",
  },
  {
    what:
      "a key pressed inside a webview guest's iframe never reaches the host element that declared it",
    file: "src/electron/electron-shared.ts",
    // aio-ok: mutation source text — the `${…}` is code to find, not a message
    find: "${tmplHostKeyRelay()}",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    replace: "${tmplHostKeyRelay().slice(0, 0)}",
    test: "tests/electron-webview-host-keys.test.ts",
    filter:
      "host keys: a declared keydown reaches THIS guest's element, with modifiers",
  },
  {
    what:
      "a relayed webview host key loses its ctrl and shift modifiers on the way to the host",
    file: "src/electron/electron-shared.ts",
    find: "ctrlKey: !!input.control, shiftKey: !!input.shift,",
    replace: "ctrlKey: false, shiftKey: false,",
    test: "tests/electron-webview-host-keys.test.ts",
    filter:
      "host keys: a declared keydown reaches THIS guest's element, with modifiers",
  },
  {
    what:
      "the host-key relay reads another webview's declaration and dispatches to the wrong element",
    file: "src/electron/electron-shared.ts",
    // aio-ok: mutation source text — the `${…}` is code to find, not a message
    find: "'if (id === ' + ${gid} + ')",
    // aio-ok: mutation source text — the `${…}` is code to find, not a message
    replace: "'if (id === id || ' + ${gid} + ')",
    test: "tests/electron-webview-host-keys.test.ts",
    filter:
      "host keys: a declared keydown reaches THIS guest's element, with modifiers",
  },
  {
    what:
      "a malformed webview host-key declaration is half-applied silently instead of ignored with a warning",
    file: "src/electron/electron-shared.ts",
    find:
      // aio-ok: mutation source text — the `${…}` is code to find, not a message
      "keys.every((k) => typeof k === 'string' && k.length > 0 && k.length <= ${HOST_KEY_MAX_LEN});",
    replace: "true;",
    test: "tests/electron-webview-host-keys.test.ts",
    filter:
      "host keys: a malformed declaration is IGNORED loudly, never half-applied",
  },
  {
    what:
      "the Browser component accepts an empty hostKeys list instead of throwing a TypeError",
    file: "src/protocol/host-keys.ts",
    find: "  return Array.isArray(keys) && keys.length > 0 &&",
    replace: "  return Array.isArray(keys) &&",
    test: "tests/electron-webview-host-keys.test.ts",
    filter:
      "host keys: <Browser> declares the attribute the shell reads, and validates it",
  },
  {
    what:
      "the Browser component never writes the host-keys attribute, so the shell relays nothing",
    file: "src/ui/browser.ts",
    find: "...(hostKeys ? { [HOST_KEYS_ATTR]: hostKeys } : {}),",
    replace: "...(hostKeys ? {} : {}),",
    test: "tests/electron-webview-host-keys.test.ts",
    filter:
      "host keys: <Browser> declares the attribute the shell reads, and validates it",
  },
  {
    what:
      "a kept-alive webview keeps calling a stale onHostKey handler after the component re-renders",
    file: "src/ui/browser.ts",
    find: "hk._aioHostKey = onHostKey;",
    replace: "hk._aioHostKey = hk._aioHostKey ?? onHostKey;",
    test: "tests/electron-webview-host-keys.test.ts",
    filter:
      "host keys: <Browser onHostKey> receives the relayed event, newest handler wins",
  },
  {
    what:
      "a closed app stays reachable from its process-wide cell definitions, leaking about 110 KB per cycle",
    file: "src/server/aio-cells-bridge.ts",
    find: "    _tombstoneCells(mine, finalState, closedWorkers);",
    replace: "    void _tombstoneCells;",
    test: "tests/closed-app-scope-gc.test.ts",
    filter:
      "closed apps are collected: most scopes finalize, heap per cycle bounded",
  },
  {
    what:
      "after close a cell reads its declared initial state instead of the closed app's final state",
    file: "src/server/aio-cells-bridge.ts",
    find: "  const getState = () => finalState;",
    replace:
      "  const getState = () =>\n    Object.fromEntries(cells.map((c) => [c.__aio.id, c.__aio.state])) as Record<string, unknown>;",
    test: "tests/closed-app-cells-answer-as-before.test.ts",
    filter:
      "closed app: its cells' state reads answer the closed app's FINAL state, frozen — never the declared initial state",
  },
  {
    what:
      "after close a worker cell's call is refused by the main loop instead of its closed worker, by name",
    file: "src/server/aio-cells-bridge.ts",
    find:
      "      crash === undefined ? sealed : (a) => closedWorkerCall(id, crash, a),",
    replace: "      sealed,",
    test: "tests/closed-app-cells-answer-as-before.test.ts",
    filter:
      "closed app: a late call is refused as the closed app refused it — a worker cell by its closed worker, a main cell with DISPATCH_CLOSED",
  },
  {
    what:
      "a second close of an app ends the scope of a later app booted from the same config object",
    file: "src/server/aio-cells-bridge.ts",
    find: "      if (ownScope) ownScope.closed = true;",
    replace:
      "      const later = _scopeOf.get(fc);\n      if (later) later.closed = true;",
    test: "tests/closed-app-release-scoped.test.ts",
    filter:
      "close: a second close of an app never ends the scope of a later app booted from the same config object",
  },
  {
    what:
      "an app's shutdown tombstones a cell another live app re-bound after a harness reset, breaking it for good",
    file: "src/server/aio-cells-bridge.ts",
    find: "      _boundDispatchOf(f) === ours.get(f)",
    replace: "      ours.has(f)",
    test: "tests/closed-app-release-scoped.test.ts",
    filter:
      "close: an app's shutdown releases only the cells still bound to it — never one another app re-bound after a reset",
  },
  {
    what:
      "when the owning app closes its serverFns namespace is served by every app already live, anonymously",
    file: "src/server/server-fns.ts",
    find: "  if (owner === undefined && !_orphaned.has(ns)) return true;",
    replace: "  if (owner === undefined) return true;",
    test: "tests/serverfns-owner-close.test.ts",
    filter:
      "serverFns: when the owning app closes, an app already live beside it never serves its namespace — the next app to boot does",
  },
  {
    what:
      "a closed app's diagnostic-bus subscription keeps the app alive and logs every event once per closed app",
    file: "src/diagnostics/mod.ts",
    find: "    unsubscribeBus?.();",
    replace: "    void unsubscribeBus;",
    test: "tests/closed-app-scope-gc.test.ts",
    filter:
      "closed apps are collected: most scopes finalize, heap per cycle bounded",
  },
  {
    what:
      "the test harness stops sandboxing the home stores, so harness tests write the real version store",
    file: "src/testing/test-strict.ts",
    find: "  _sandboxAppDirs();\n  _sandboxHomeStores();\n",
    replace: "  _sandboxAppDirs();\n",
    test: "tests/test-harness-sandboxes-home-stores.test.ts",
    filter:
      "home stores: under the harness with no AIO_VERSIONS_DIR set, versionsDir() is under the test root, never the real HOME",
  },
  {
    what:
      "tempDir() stops arming the store sandbox, so a test with no harness call writes the real store",
    file: "src/testing/temp-dir.ts",
    find: "  _sandboxHomeStores();\n",
    replace: "  void _sandboxHomeStores;\n",
    test: "tests/test-harness-sandboxes-home-stores.test.ts",
    filter:
      "home stores: tempDir() alone arms the sandbox — the am-version-pin shape, no harness call",
  },
  {
    what:
      "only the version store is sandboxed while the feedback dir, install root and AIO_HOME stay real",
    file: "src/testing/test-strict.ts",
    find: "    for (const k of missing) Deno.env.set(k, env[k]!);",
    replace:
      "    for (const k of missing.slice(0, 1)) Deno.env.set(k, env[k]!);",
    test: "tests/test-harness-sandboxes-home-stores.test.ts",
    filter:
      "home stores: every per-user store a test can write is sandboxed, not just the version store",
  },
  {
    what:
      "the store sandbox arms only once, so a test that deletes the variable re-exposes the real store",
    file: "src/testing/test-strict.ts",
    find:
      "    const missing = HOME_STORE_VARS.filter((k) => !Deno.env.get(k));",
    replace:
      "    if (_storeBase !== undefined) return;\n    const missing = HOME_STORE_VARS.filter((k) => !Deno.env.get(k));",
    test: "tests/test-harness-sandboxes-home-stores.test.ts",
    filter:
      "home stores: a test's own value wins, and a restore that DELETES the var is re-pinned at the next arm",
  },
  {
    what:
      "the shard runner stops pinning the home stores, so a spawned am inherits the real version store",
    file: "scripts/test-shards.ts",
    find: '    ...homeStoreEnv(join(dirname(opts.home), "stores")),',
    replace: "    ...{},",
    test: "tests/test-harness-sandboxes-home-stores.test.ts",
    filter:
      "home stores: the shard runner pins every store per shard, beside (not inside) its apps dir",
  },
  {
    what:
      "the home-clean store diff ignores added entries, so a fake release planted by a test stays green",
    file: "scripts/check-home-clean.ts",
    // aio-ok: mutation source text — the `${…}` is code to find, not a message
    find: "    if (!(p in before)) out.push(`added    ${p}`);",
    replace: "    if (!(p in before)) continue;",
    test: "tests/check-home-clean-stores.test.ts",
    filter:
      "check:home-clean: --against fails when a run ADDS, changes or removes a real store entry",
  },
  {
    what:
      "the home-clean gate misses a version-store entry whose worktree points into a test sandbox",
    file: "scripts/check-home-clean.ts",
    find: "  return roots.some((r) => gitdir.startsWith(r)) ||",
    replace: "  return roots.length < 0 ||",
    test: "tests/check-home-clean-stores.test.ts",
    filter:
      "check:home-clean: a version-store entry whose worktree points into a test sandbox is RED, named",
  },
  {
    what:
      "the home-clean gate stops watching the default version store under the real home directory",
    file: "scripts/check-home-clean.ts",
    find: '    home ? join(home, ".local", "lib", "aio-versions") : undefined,',
    replace: "    undefined,",
    test: "tests/check-home-clean-stores.test.ts",
    filter:
      "check:home-clean: a version-store entry whose worktree points into a test sandbox is RED, named",
  },
  {
    what:
      "the home-clean stamp ignores the worktree link, so re-provisioning a store entry in place stays green",
    file: "scripts/check-home-clean.ts",
    find: '  for (const f of [join(p, ".git"), join(p, "gitdir")]) {',
    replace: "  for (const f of [] as string[]) {",
    test: "tests/check-home-clean-stores.test.ts",
    filter:
      "check:home-clean: --against fails when a run ADDS, changes or removes a real store entry",
  },
  {
    what:
      "the home-clean stamp uses the directory mtime, so a real app rewriting its lockfile fails every run",
    file: "scripts/check-home-clean.ts",
    find: "      return Deno.lstatSync(f).mtime?.getTime() ?? 0;",
    replace:
      "      return Deno.lstatSync(f) && (Deno.lstatSync(p).mtime?.getTime() ?? 0);",
    test: "tests/check-home-clean-stores.test.ts",
    filter:
      "check:home-clean: --against fails when a run ADDS, changes or removes a real store entry",
  },
  {
    what:
      "the linter reports a per-target title as a key aio never reads, though the build asks for it",
    file: "src/server/config.ts",
    find: '  "name",\n  "title",\n  "platforms",',
    replace: '  "name",\n  "platforms",',
    test: "tests/build-target-display-name.test.ts",
    filter:
      "build display name: a per-target title is a known key, and a blank one is unset",
  },
  {
    what:
      "a whitespace-only per-target title reaches the build and clash check as an empty display name",
    file: "src/build-all.ts",
    find: "      ...(o?.title?.trim() ? { title: o.title.trim() } : {}),",
    replace: "      ...(o?.title ? { title: o.title.trim() } : {}),",
    test: "tests/build-target-display-name.test.ts",
    filter:
      "build display name: a per-target title is a known key, and a blank one is unset",
  },
  {
    what:
      "a different app silently takes over a closed app's serverFns namespace and serves it with no warning",
    file: "src/server/server-fns.ts",
    find: "      if (prev !== appId) {",
    replace: "      if (prev !== appId && Date.now() < 0) {",
    test: "tests/serverfns-owner-close.test.ts",
    filter:
      "serverFns: when the owning app closes, an app already live beside it never serves its namespace — the next app to boot does",
  },
  {
    what:
      "a gate run on uncommitted code records a proof row naming a commit that is not the code that ran",
    file: "scripts/proof.ts",
    find:
      '    l.trim() !== "" && !l.slice(3).trim().endsWith("proof-matrix.json")',
    replace: "    false",
    test: "tests/proof-matrix.test.ts",
    filter:
      "proof: a gate run on uncommitted code records nothing — HEAD is not the code that ran",
  },
  {
    what:
      "a JSON module import is fed to the TS transpiler and the dev page becomes the diagnostic page",
    file: "src/server/graph-validator.ts",
    find: 'if (filePath.toLowerCase().endsWith(".json")) {',
    replace: 'if (filePath.toLowerCase().endsWith(".never")) {',
    test: "tests/dev-json-mts-modules.test.ts",
    filter:
      "dev modules: a JSON module import is valid in the graph, and invalid JSON is named as JSON",
  },
  {
    what:
      "dev serves a .mts module raw as octet-stream, which the browser refuses to run",
    file: "src/server/server-static.ts",
    find: '  ".jsx",\n  ".mts",\n]);',
    replace: '  ".jsx",\n]);',
    test: "tests/dev-json-mts-modules.test.ts",
    filter: "dev modules: a .mts module is compiled and served as JavaScript",
  },
  {
    what:
      "one text decoder spans reconnects, so a character cut by a dead UDS connection corrupts the next first frame",
    file: "src/server/cli-client.ts",
    find: "                decoder.decode(value, { stream: true }),",
    replace:
      "                ((globalThis as unknown as { __aioUdsDec?: TextDecoder })\n                  .__aioUdsDec ??= decoder).decode(value, { stream: true }),",
    test: "tests/cli-uds-decoder-per-connection.test.ts",
    filter:
      "uds: a connection cut mid-character does not corrupt the next connection's first frame",
  },
  {
    what:
      "END, SQLite's spelling of COMMIT, skips the writer lock as if it were a read",
    file: "src/db/sql-shape.ts",
    find: "|BEGIN|COMMIT|END|ROLLBACK|",
    replace: "|BEGIN|COMMIT|ROLLBACK|",
    test: "tests/db-sql-shape.test.ts",
    filter: "sql-shape: END — SQLite's spelling of COMMIT — is a write",
  },
  {
    what:
      "a desktop socket client subscribed to one cell is resent its whole view whenever an unrelated cell changes",
    file: "src/server/uds.ts",
    find:
      "            // tests/broadcast-unmatched-subs-sends-nothing.test.ts.\n            continue;\n",
    replace:
      "            // tests/broadcast-unmatched-subs-sends-nothing.test.ts.\n",
    test: "tests/uds-unmatched-subs-sends-nothing.test.ts",
    filter:
      "uds: a round with no patch in a client's subscriptions sends it nothing",
  },
  {
    what:
      "an IPC cell call made while the bridge is still opening is written ahead of older offline-queued calls, reordering intent and risking reject-plus-apply",
    file: "src/browser/browser-air-transport.ts",
    find: "} else if (_ipc && _ipcOpen) {",
    replace: "} else if (_ipc && _ipcConnected) {",
    test: "tests/ipc-connecting-send-order.test.ts",
    filter:
      "air transport: an IPC call made before the bridge opens queues behind older offline calls",
  },
  {
    what:
      "an Array subclass crossing the wire is reported as exact although it arrives as a plain array",
    file: "src/protocol/wire-value.ts",
    find: "if (Object.getPrototypeOf(orig) !== Array.prototype) {",
    replace: "if (Object.getPrototypeOf(orig) === null) {",
    test: "tests/wire-value-array-shape.test.ts",
    filter: "wire-value: an Array subclass is reported like any class instance",
  },
  {
    what:
      "named properties on an array such as RegExp match groups are erased by JSON while reported exact",
    file: "src/protocol/wire-value.ts",
    find: "if (orig.length <= MAX_NODES) {",
    replace: "if (orig.length < 0) {",
    test: "tests/wire-value-array-shape.test.ts",
    filter:
      "wire-value: named properties on an array are reported, not called exact",
  },
  {
    what:
      "forwarded console lines print NaN as null and drop undefined or symbol arguments to empty text",
    file: "src/browser/console-intercept.ts",
    find: '    if (a === null || typeof a !== "object") return String(a);',
    replace:
      '    if (a === null || typeof a !== "object") return JSON.stringify(a) ?? "";',
    test: "tests/console-intercept.test.ts",
    filter:
      "_serialize: NaN, undefined, functions and symbols say what the console says",
  },
  {
    what:
      "an Electron IPC open announced after the client was torn down revives it and reinstalls its transport",
    file: "src/browser/browser-air-transport.ts",
    find: "if (_closed || _terminal) return;",
    replace: "if (_terminal) return;",
    test: "tests/ipc-connecting-send-order.test.ts",
    filter:
      "air transport: an IPC open announced after teardown does not revive the client",
  },
  {
    what:
      "an Electron IPC client stays connected after teardown because only the WebSocket close reset the signal",
    file: "src/browser/browser-air-transport.ts",
    find:
      "  // to the bridge through the installed core transport.\n  _coreSetTransport(null);\n  _coreSetConnected(false);",
    replace:
      "  // to the bridge through the installed core transport.\n  _coreSetTransport(null);",
    test: "tests/ipc-connecting-send-order.test.ts",
    filter:
      "air transport: an IPC open announced after teardown does not revive the client",
  },
  {
    what:
      "the auth POST flows ignore allowedOrigins and refuse an allowlisted dashboard's login with 403 cross_origin",
    file: "src/server/auth-flows.ts",
    find: "allowedOrigins: cfg.allowedOrigins,",
    replace: "allowedOrigins: undefined,",
    test: "tests/auth-flow-origin-allowlist.test.ts",
    filter: "auth flows: an Origin named in allowedOrigins may sign in",
  },
  {
    what:
      "SignIn looks its own error wording up by the translated message so every entry is dead text",
    file: "src/browser/browser-auth-ui.ts",
    find: '(typeof code === "string" ? ERROR_TEXT[code] : undefined) ??',
    replace: '(typeof code === "string" ? ERROR_TEXT["-"] : undefined) ??',
    test: "tests/auth-ui-error-text.test.ts",
    filter:
      "SignIn: a wrong second-factor code shows SignIn's own 'sign in again' text",
  },
  {
    what:
      "a server auth error code with no client sentence reaches the user as raw snake_case text",
    file: "src/browser/auth-client.ts",
    find: "  totp_already_enabled:",
    replace: "  totp_already_enabled_x:",
    test: "tests/auth-ui-error-text.test.ts",
    filter: "auth client: every error code the server sends has a sentence",
  },
  {
    what:
      "an app's own ?token= query parameter masks a valid session cookie so a signed-in user is anonymous and budget-charged",
    file: "src/server/server.ts",
    find: 'if (urlTokenInert) credUrl.searchParams.delete("token");',
    replace: 'if (urlTokenInert) credUrl.searchParams.get("token");',
    test: "tests/auth-url-token-does-not-mask-cookie.test.ts",
    filter:
      "auth: a ?token= app parameter does not mask a valid session cookie",
  },
  {
    what:
      "after an OIDC provider rotates its signing key every SSO login fails until the hour-long JWKS cache expires",
    file: "src/server/auth-oidc.ts",
    find: "_selectJwk(await jwksKeys(jwksUri, true), header.kid);",
    replace: "_selectJwk(await jwksKeys(jwksUri, false), header.kid);",
    test: "tests/oidc-jwks-key-rotation.test.ts",
    filter:
      "oidc: a login signed with a freshly ROTATED key succeeds without waiting out the JWKS cache",
  },
  {
    what:
      "lww-per-key treats a remote-only key like constructor or toString as shared via the prototype chain, merging it against a native function",
    file: "src/sync/merge.ts",
    find: "const inLocal = Object.hasOwn(local, key);",
    replace: "const inLocal = key in local;",
    test: "tests/sync/merge-lww-per-key-own-keys.test.ts",
    filter:
      "lww-per-key: a remote-only key named like an Object.prototype member is kept, not merged against it",
  },
  {
    what:
      "a default-retention cell's compaction sweeps another 7d-retention cell's op tombstones, so that cell's late lost-ack resend is applied twice",
    file: "src/sync/server-handler.ts",
    find: "        retentionMs: sweepRetentionMs(),",
    replace: "        retentionMs: deps.opRetentionMs?.(cell),",
    test: "tests/sync/tombstone-sweep-longest-retention.test.ts",
    filter:
      "tombstone sweep: a default-retention cell's compaction keeps a 7d cell's tombstones, so its 2-day-late resend is re-acked, not re-applied",
  },
  {
    what:
      "the login cookie's Max-Age ignores sessions.ttlMs and expires at 30 days, logging out a longer session early",
    file: "src/server/auth-flows.ts",
    find: "const exp = cfg.sessions.get(token)?.expiresAt;",
    replace: "const exp = undefined as number | undefined;",
    test: "tests/auth-cookie-follows-session-ttl.test.ts",
    filter:
      "auth cookie: Max-Age follows sessions.ttlMs when auth.ttlMs is unset",
  },
  {
    what:
      "a newly staged TOTP secret inherits the old secret's spent step and refuses its first valid enrolment code",
    file: "src/server/auth-users.ts",
    find: '"ELSE 0 END, totp = ?1 WHERE id = ?2"',
    replace: '"ELSE totp_step END, totp = ?1 WHERE id = ?2"',
    test: "tests/totp-reenrol-fresh-replay.test.ts",
    filter:
      "totp: re-enrolling a new secret inside the last code's step is not refused as a replay",
  },
  {
    what:
      "a tray or notification click to the current route pushes a duplicate history entry so Back looks dead",
    file: "src/browser/desktop-notify.ts",
    find: 'if (same) g.history.replaceState(null, "", route);',
    replace: 'if (same) g.history.pushState(null, "", route);',
    test: "tests/navigate-to-same-url-replaces.test.ts",
    filter:
      "navigateTo: the current URL replaces its entry, another URL pushes, popstate fires for both",
  },
  {
    what:
      "db table window planned INSERT before UPDATE so renaming a unique value and reusing it for a new row is refused forever",
    file: "src/db/state-sync.ts",
    find: "stmts.push(...updates, ...inserts);",
    replace: "stmts.push(...inserts, ...updates);",
    test: "tests/db-unique-rename-reuse.test.ts",
    filter:
      "db: renaming a unique value and reusing it for a new row in one window lands",
  },
  {
    what:
      "an empty db table the app emptied on purpose restores the seeded state default on every reboot, resurrecting deleted rows",
    file: "src/server/aio-boot.ts",
    find: "if (rows.length === 0 && !synced?.has(b.table)) {",
    replace: "if (rows.length === 0) {",
    test: "tests/db-emptied-table-stays-empty.test.ts",
    filter:
      "db: a table the app emptied restores empty — the seeded default does not come back",
  },
  {
    what:
      "the boot baseline for a shape map db binding stays a raw row array so every app with a map binding fails to boot",
    file: "src/server/persistence.ts",
    find: "v[t] = inBoundShape(t, rows);",
    replace: "v[t] = rows;",
    test: "tests/db-map-binding-boots.test.ts",
    filter:
      'db: an app with a shape "map" binding boots, persists and restores',
  },
  {
    what:
      "a db.query read outside an open callback transaction runs on the writer connection and sees rows that are later rolled back",
    file: "src/db/async-db.ts",
    find:
      "if (_callbackOpen && !_inOpenCallback() && readerWorkers.length === 0) {",
    replace:
      "if (false && _callbackOpen && !_inOpenCallback() && readerWorkers.length === 0) {",
    test: "tests/db-callback-tx-no-dirty-read.test.ts",
    filter:
      "db: a read outside an open callback transaction never sees its uncommitted rows",
  },
  {
    what:
      "closing a db handle before its first statement leaves it reopenable so a late query spawns an unclosed worker pool",
    file: "src/db/async-db.ts",
    find: "closed = true; // never-opened handle",
    replace: "// never-opened handle",
    test: "tests/db-close-before-use.test.ts",
    filter:
      "db: a handle closed before its first statement refuses later calls",
  },
  {
    what:
      "a db column renamed only in letter case is taken for a missing column and refuses the boot despite holding every value",
    file: "src/db/state-sync.ts",
    find:
      "c.name.toLowerCase() === d.toLowerCase() && !declared.includes(c.name)",
    replace: "c.name === d && !declared.includes(c.name)",
    test: "tests/db-column-case-rename.test.ts",
    filter: "db: a column renamed only in case boots and keeps its values",
  },
  {
    what:
      "a client subscribed to one cell is re-sent its whole view every time an unrelated cell changes after a patch round",
    file: "src/server/server-broadcast.ts",
    find: "unmatched-subs-sends-nothing.test.ts.\n            continue;",
    replace: "unmatched-subs-sends-nothing.test.ts.\n",
    test: "tests/broadcast-unmatched-subs-sends-nothing.test.ts",
    filter:
      "broadcast: a round with no patch in a client's subscriptions sends it nothing",
  },
  {
    what:
      "a change to a visible none cell becomes a force round that re-sends every client its full visible state",
    file: "src/server/aio-dispatch.ts",
    find: "if (validPatches && validPatches.length === 0) return;",
    replace: "if (validPatches && validPatches.length === -1) return;",
    test: "tests/broadcast-hidden-change-sends-nothing.test.ts",
    filter: "broadcast: a change to a visible:none cell sends clients nothing",
  },
  {
    what:
      "a keyed list turning unkeyed anchors later siblings on an emptied DocumentFragment, so a fragment row's following siblings land past the region's end",
    file: "src/air/vdom-diff-children.ts",
    find:
      "          if (_domNodeCount(nc as VNode | string | number) > 0 && node) {\n            lastPlaced = node;\n          }",
    replace: "          if (node !== undefined) lastPlaced = newDom;",
    test: "tests/air-reconciler-position-and-reuse.test.ts",
    filter:
      "reconciler: a keyed list turning unkeyed keeps a fragment row's siblings inside the region",
  },
  {
    what:
      "a zero-node survivor whose following siblings all departed is anchored on a detached node, so its replacement is appended at the parent's end",
    file: "src/air/vdom-diff-children.ts",
    find: "    ) oldDoms[i] = regionEnd;",
    replace: "    ) oldDoms[i] = d;",
    test: "tests/air-reconciler-position-and-reuse.test.ts",
    filter:
      "reconciler: a portal-led fragment wrapped in another keeps its place before the next sibling",
  },
  {
    what:
      "hydrating a signal whose value shrank since SSR leaves the split-off server text on the page, owned by no vnode",
    file: "src/air/renderer-hydrate.ts",
    find: "    _dropSplitTail(el, childIdx);",
    replace: "    void childIdx;",
    test: "tests/air-reconciler-position-and-reuse.test.ts",
    filter:
      "hydrate: a signal that changed since SSR leaves no stale server text behind",
  },
  {
    what:
      "hydrating a ROOT-level signal whose value shrank since SSR leaves the split-off server text at the root, owned by no vnode",
    file: "src/air/renderer-hydrate.ts",
    find: "    } else _dropSplitTail(root, consumed);",
    replace: "    } else void consumed;",
    test: "tests/air-reconciler-position-and-reuse.test.ts",
    filter:
      "hydrate: a root-level signal that changed since SSR leaves no stale server text behind",
  },
  {
    what:
      "a self re-rendering wrapper that re-places its own children unmounts them while on screen, freezes their signal text and leaks portal regions",
    file: "src/air/renderer-rerender.ts",
    find: "  rendered = _detachReused(rendered, oldRendered);",
    replace: "  void _detachReused;",
    test: "tests/air-reconciler-position-and-reuse.test.ts",
    filter:
      "reconciler: a component re-placing its own children keeps them mounted and live",
  },
  {
    what:
      "children forwarded to a parent-rerendered component that re-wraps them are unmounted while on screen and their signal text freezes",
    file: "src/air/vdom-diff.ts",
    find: "  rendered = _detachReused(rendered, ov._rendered);",
    replace: "  void _detachReused;",
    test: "tests/air-reconciler-position-and-reuse.test.ts",
    filter:
      "reconciler: children passed through a component to one that re-wraps them stay mounted and live",
  },
  {
    what:
      "a fragment trusts its attached but MOVED first-node copy, so after a child's keyed reorder a new sibling lands after the footer",
    file: "src/air/vdom-diff.ts",
    find:
      "  if (ov._rendered === undefined) {\n    for (const child of ov.children) {",
    replace:
      "  if (getDom(ov) && isChildOf(getDom(ov), parent)) return getDom(ov);\n  if (ov._rendered === undefined) {\n    for (const child of ov.children) {",
    test: "tests/air-reconciler-position-and-reuse.test.ts",
    filter:
      "reconciler: a child's own keyed reorder does not move its parent fragment's region start",
  },
  {
    what:
      "removing a fragment walks from stale copies after an inner root swap, so its bare text stays on the page forever",
    file: "src/air/vdom-remove.ts",
    find:
      "    let cursor: Node | null = _liveFirstDom(vnode) ?? posDom;\n    for (const child of vnode.children) {\n      const at = _liveFirstDom(child) ?? cursor;",
    replace:
      "    let cursor: Node | null = getDom(vnode) ?? posDom;\n    for (const child of vnode.children) {\n      const at = getDom(child) ?? cursor;",
    test: "tests/air-reconciler-position-and-reuse.test.ts",
    filter:
      "reconciler: removing a region whose inner component swapped its root removes its bare text too",
  },
  {
    what:
      "h() stops marking a vnode built around an already-mounted child, so re-placed children are never detected and get unmounted on screen",
    file: "src/air/vdom-create.ts",
    find: "      (vnode as ReuseMark)[_REUSES] = true;",
    replace: "      void vnode;",
    test: "tests/air-reconciler-position-and-reuse.test.ts",
    filter:
      "reconciler: a component re-placing its own children keeps them mounted and live",
  },
  {
    what:
      "an older install on the same data dir sends a newer install's cached etag, gets 304 and is told it is the latest",
    file: "src/server/updates-runtime.ts",
    find: "const got = await fetchManifest(url, validator);",
    replace: "const got = await fetchManifest(url, trust.etagCurrent);",
    test: "tests/updates-etag-bound-to-install.test.ts",
    filter:
      "updates: a cached 'current' ETag does not tell an OLDER install on the same data dir it is the latest",
  },
  {
    what:
      "a manifest whose sha256 is uppercase hex has every valid artifact download refused as a digest mismatch",
    file: "src/server/updates-check.ts",
    find: "if (sha !== opts.expectSha256.toLowerCase()) {",
    replace: "if (sha !== opts.expectSha256) {",
    test: "tests/updates-sha256-case-blind.test.ts",
    filter:
      "updates: an UPPERCASE manifest digest downloads — the compare is case-blind",
  },
  {
    what:
      "verifyDownload refuses staged bytes that match an uppercase manifest digest, so apply never installs the release",
    file: "src/server/updates-check.ts",
    find: "if (sha256 !== manifest.sha256.toLowerCase()) {",
    replace: "if (sha256 !== manifest.sha256) {",
    test: "tests/updates-sha256-case-blind.test.ts",
    filter:
      "updates: verifyDownload accepts an UPPERCASE digest of the same bytes",
  },
  {
    what:
      "an uppercase manifest digest of the running build is offered back as a same-version rebuild on every check",
    file: "src/server/updates-core.ts",
    find: "localSha.toLowerCase() !== m.sha256.toLowerCase();",
    replace: "localSha !== m.sha256;",
    test: "tests/updates-sha256-case-blind.test.ts",
    filter:
      "updates: an UPPERCASE manifest digest of the RUNNING build is not a rebuild offer",
  },
  {
    what:
      "a git source follows refs/heads/feature/main instead of main, so the rebuilt commit never converges and updates loop",
    file: "src/server/updates-check.ts",
    find:
      // aio-ok: the literal SOURCE line this mutation patches in and out
      "for (const name of [`refs/heads/${ref}`, `refs/tags/${ref}`, ref]) {",
    replace: "for (const name of lines.map((l) => l.name)) {",
    test: "tests/updates-git-ref-exact.test.ts",
    filter:
      "updates: a git source follows EXACTLY the named branch, not one whose name ends with it",
  },
  {
    what:
      "loop firstDegradedAt is never cleared on recovery so hint rule two blames an old queue blip for a network stall",
    file: "src/vitals/loop-probe.ts",
    find: 'if (status === "healthy") firstDegradedAt = null;',
    replace: 'if (status === "healthy") void 0;',
    test: "tests/vitals-loop-first-degraded-resets.test.ts",
    filter:
      "vitals: loop firstDegradedAt clears on recovery, so a later stall is not blamed on an old queue blip",
  },
  {
    what:
      "concurrent puts of the same bytes with different names each report their own name while only one is recorded",
    file: "src/server/blobs.ts",
    find: "name = await recordFirstName(id, opts.name);",
    replace:
      "await Deno.writeTextFile(metaPath(dir, id), JSON.stringify({ name: opts.name })), name = opts.name;",
    test: "tests/blobs-first-name-wins-concurrently.test.ts",
    filter:
      "blobs: concurrent puts of the same bytes agree on ONE recorded name",
  },
  {
    what:
      "a memoized selector whose combiner throws returns the previous inputs' result on the next identical call",
    file: "src/selector.ts",
    find:
      "    const result = (combiner as (...args: unknown[]) => Result)(...inputs);\n    lastInputs = inputs;",
    replace:
      "    lastInputs = inputs;\n    const result = (combiner as (...args: unknown[]) => Result)(...inputs);",
    test: "tests/selector-throwing-combiner-not-cached.test.ts",
    filter:
      "selector: a throwing combiner is not memoized as the previous result",
  },
  {
    what:
      "a CDP connect timeout leaves the websocket connecting so am shot and am eval hang forever after reporting it",
    file: "src/media/cdp.ts",
    find:
      "      try {\n        ws.close();\n      } catch { /* aio-ok: already closing",
    replace:
      "      try {\n        void 0;\n      } catch { /* aio-ok: already closing",
    test: "tests/cdp-connect-timeout-closes-socket.test.ts",
    filter: "cdp: a connect timeout closes the socket, so the process can exit",
  },
  {
    what:
      "schedule.at reads an offset-less ISO time as UTC, silently shifting every existing app on a non-UTC host",
    file: "src/state/schedule.ts",
    find: "const target = new Date(time as string).getTime();",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    replace:
      // aio-ok: the literal SOURCE line this mutation patches in and out
      "const target = new Date(_isZoneLocal(time) ? `${time}Z` : time as string).getTime();",
    test: "tests/schedule-at-offsetless-is-local.test.ts",
    filter:
      "schedule.at: an offset-less ISO time keeps the machine-local reading in every zone",
  },
  {
    what:
      "schedule.backoff with an unset attempt returns ok while the retry it asked for is silently refused later as a NaN after",
    file: "src/state/schedule.ts",
    find: "  if (!Number.isNaN(Number(attempt))) return;",
    replace: "  if (!Number.isNaN(Number(attempt)) || true) return;",
    test: "tests/schedule-backoff-attempt-refused-at-call-site.test.ts",
    filter:
      "schedule.backoff/poll: an attempt that is not a number is refused at the call, by name",
  },
  {
    what:
      "schedule.after with a bare string action returns ok and detonates at fire time as a nameless REDUCE_ERROR",
    file: "src/state/schedule.ts",
    find:
      '    typeof action === "object" && action !== null && typeof t === "string" &&',
    replace:
      '    true || typeof action === "object" && action !== null && typeof t === "string" &&',
    test: "tests/schedule-builder-refuses-non-action.test.ts",
    filter:
      "schedule builders: a string or type-less action is refused at the call, by name",
  },
  {
    what:
      "own.set of a Deno.serve server or ChildProcess keeps no disposer so replace disable and shutdown leave it running",
    file: "src/state/own.ts",
    find: "          (Symbol as { asyncDispose?: symbol }).asyncDispose,",
    replace: "          undefined,",
    test: "tests/own-disposable-shapes.test.ts",
    filter:
      "own.set: standard-disposable and async-factory resources are released",
  },
  {
    what:
      "an async own.set factory hands its Promise to the disposer check so the resource it opens is never released",
    file: "src/state/own.ts",
    find: "        acquireLater(effect.id, got as PromiseLike<unknown>);",
    replace: "        void got;",
    test: "tests/own-disposable-shapes.test.ts",
    filter:
      "own.set: standard-disposable and async-factory resources are released",
  },
  {
    what:
      "an async own.set acquisition replaced while still opening lands late and evicts the newer resource from the slot",
    file: "src/state/own.ts",
    find: "        release(id, disposer);",
    replace: "        disposers.set(id, disposer);",
    test: "tests/own-disposable-shapes.test.ts",
    filter:
      "own.set: an async acquisition superseded while opening is released on arrival",
  },
  {
    what:
      "an own.set factory returning a non-disposer value is dropped silently and its resource leaks with no log",
    file: "src/state/own.ts",
    find: "    if (resource === undefined || resource === null) return null;",
    replace:
      '    if (resource === undefined || resource === null || typeof resource === "number") return null;',
    test: "tests/own-disposable-shapes.test.ts",
    filter:
      "own.set: a factory return that is not a disposer is reported, not dropped silently",
  },
  {
    what:
      'a malformed transaction setting such as "yes" or conflict "Abort" is silently read as off or commit-anyway',
    file: "src/state/cell-methods-factory.ts",
    find: "  refuseMalformedTransaction(name, config.transaction);",
    replace: "  void refuseMalformedTransaction;",
    test: "tests/transaction-config-refused-when-malformed.test.ts",
    filter:
      "cell(): a malformed transaction setting is refused, not silently read as off",
  },
  {
    what:
      'a cell with diagnostics "off" or scope "browser" silently keeps the default recording and server scope',
    file: "src/state/cell-create.ts",
    find: "  refuseUnreadValues(name, config as Record<string, unknown>);",
    replace: "  void refuseUnreadValues;",
    test: "tests/cell-config-unread-values-refused.test.ts",
    filter:
      "cell(): a scope/worker/diagnostics value aio would not read is refused",
  },
  {
    what:
      "a bare ttl 5000 or listensTo value on a cell configures nothing and nothing says so",
    file: "src/state/cell-methods-factory.ts",
    find:
      '      v !== undefined && v !== false && (v === null || typeof v !== "object")',
    replace:
      '      false && v !== undefined && v !== false && (v === null || typeof v !== "object")',
    test: "tests/cell-config-unread-values-refused.test.ts",
    filter:
      "cell(): a bare ttl or listensTo value is refused, not a silent no-op",
  },
  {
    what:
      "am fix is ungated again so a mistyped flag like --dry runs the real mutating repair",
    file: "src/am/am-flags.ts",
    find:
      '  fix: ["--dry-run", "--check", "--no-download", "--migrate-tasks", "--aio"],',
    replace:
      '  fixUngated: ["--dry-run", "--check", "--no-download", "--migrate-tasks", "--aio"],',
    test: "tests/am-dropped-input-r2.test.ts",
    filter: "am fix: a mistyped flag is refused, never a real repair",
  },
  {
    what:
      "am publish is ungated again so --chanel=beta silently publishes to the prod channel",
    file: "src/am/am-flags.ts",
    find: "  publish: [",
    replace: "  publishUngated: [",
    test: "tests/am-dropped-input-r2.test.ts",
    filter: "am publish: a mistyped flag is refused, --data is publish's own",
  },
  {
    what:
      "am publish --channel beta with a space is dropped and the release goes to prod",
    file: "src/am/am-cmd-publish.ts",
    find: "const bare = args.find((a) => PUBLISH_VALUE_FLAGS.includes(a));",
    replace:
      "const bare = args.find((a) => PUBLISH_VALUE_FLAGS.includes(a) && false);",
    test: "tests/am-dropped-input-r2.test.ts",
    filter: "am publish: --channel with a space is refused before any build",
  },
  {
    what:
      "am publish silently ignores a stray positional word such as a channel name",
    file: "src/am/am-cmd-publish.ts",
    find: 'const stray = args.filter((a) => !a.startsWith("-"));',
    replace: 'const stray = args.filter((a) => !a.startsWith("-") && false);',
    test: "tests/am-dropped-input-r2.test.ts",
    filter: "am publish: --channel with a space is refused before any build",
  },
  {
    what:
      "am auth create alice --role admin silently creates a plain non-admin user",
    file: "src/am/am-cmd-auth.ts",
    find: 'if (!a.includes("=")) {',
    replace: 'if (!a.includes("=") && false) {',
    test: "tests/am-dropped-input-r2.test.ts",
    filter: "am auth: a field it would drop is refused",
  },
  {
    what:
      "unknown one-dash flags like am timeline -n 1 are silently ignored with exit 0",
    file: "src/am/am-flags.ts",
    find: "if (/^-[A-Za-z]/.test(a) && !FREE_VALUE_VERBS.has(command)) {",
    replace: "if (/^-[A-Za-z]/.test(a) && FREE_VALUE_VERBS.has(command)) {",
    test: "tests/am-dropped-input-r2.test.ts",
    filter: "am flags: an unknown one-dash flag is refused like a two-dash one",
  },
  {
    what:
      "a positional given to a verb that reads none like am timeline 5 is silently dropped",
    file: "src/am/am-flags.ts",
    find: "if (!NO_POSITIONALS.has(command)) return null;",
    replace: "if (NO_POSITIONALS.has(command)) return null;",
    test: "tests/am-dropped-input-r2.test.ts",
    filter: "am flags: a positional to a verb that reads none is warned about",
  },
  {
    what:
      "an empty --body from an unset shell variable calls the method with no arguments",
    file: "src/am/am-utils.ts",
    find: '  "--body":\n',
    replace: '  "--bodyOff":\n',
    test: "tests/am-dropped-input-r2.test.ts",
    filter: "am dispatch: an empty --body is refused, not a bare call",
  },
  {
    what:
      "am create --template counter with a space is reported as an unknown flag --template",
    file: "src/am/am-cmd-create.ts",
    find: "} else if (CREATE_VALUE_FLAGS.includes(a)) {",
    replace: "} else if (CREATE_VALUE_FLAGS.includes(a) && false) {",
    test: "tests/am-dropped-input-r2.test.ts",
    filter: "am create: a known flag with a space is named, not called unknown",
  },
  {
    what:
      "am top validates its poll interval only at a terminal so --json accepts 2s silently",
    file: "src/am/am-cmd-inspect.ts",
    find: 'const secArg = args.find((a) => !a.startsWith("--"));',
    replace:
      'const secArg = mode !== "pretty" ? undefined : args.find((a) => !a.startsWith("--"));',
    test: "tests/am-dropped-input-r2.test.ts",
    filter: "am top: a bad interval is refused in --json mode too",
  },
  {
    what:
      "compiled cli template binary gets --client=cli prepended so its own serve command never runs",
    file: "src/build/build-compile.ts",
    find: 'return opts.doRemote || opts.declaredClient === "cli"',
    replace: "return opts.doRemote",
    test: "tests/build-cli-argv-stays-the-apps.test.ts",
    filter:
      "cli argv: a cli app that declares client cli gets no baked flag in front of its own args",
  },
  {
    what:
      "a broken compiled artifact on a plain path is blamed on spaces or non-ASCII in its path",
    file: "src/build/build-compile.ts",
    find: "(/[^\\x21-\\x7e]/.test(resolve(bin))",
    replace: "(true",
    test: "tests/build-smoke-diagnosis-fits-the-path.test.ts",
    filter:
      "smoke diagnosis: a plain path is not blamed, a path with a space still is",
  },
  {
    what:
      "a build.platforms string is split into single characters and a non-string out crashes the build",
    file: "src/build-all.ts",
    find: "if (shapeProblems.length > 0) {",
    replace: "if (shapeProblems.length < 0) {",
    test: "tests/build-block-shape-and-typos.test.ts",
    filter:
      "build block: the build refuses a wrong shape before building anything",
  },
  {
    what:
      "a misspelled deno.json build key builds the default silently with no warning at all",
    file: "src/build-all.ts",
    find: "if (strayKeys.length > 0) {",
    replace: "if (strayKeys.length < 0) {",
    test: "tests/build-block-shape-and-typos.test.ts",
    filter: "build block: the build says a misspelled key does nothing",
  },
  {
    what:
      "the documented build.macos key is reported as an unknown key by lint and build",
    file: "src/server/config.ts",
    find: '  "macos",\n]);',
    replace: "]);",
    test: "tests/build-block-shape-and-typos.test.ts",
    filter: "build block keys: the documented build.macos is a known key",
  },
  {
    what:
      "a per-target platforms string is ignored without a word and that target builds for default platforms",
    file: "src/build/build-shape.ts",
    find: "Array.isArray(p) ? problems : warnings,",
    replace: "Array.isArray(p) ? problems : [],",
    test: "tests/build-block-shape-and-typos.test.ts",
    filter: "build block shape: what built on 1.0.11 is warned, never refused",
  },
  {
    what:
      "verifyShipManifest refuses a correctly signed manifest whose sha256 digest is written in uppercase",
    file: "src/build/ship.ts",
    find: "if (sha256 !== String(manifest.sha256).toLowerCase()) {",
    replace: "if (sha256 !== manifest.sha256) {",
    test: "tests/ship-verify-sha256-case-blind.test.ts",
    filter:
      "ship verify: a signed manifest with an UPPERCASE digest verifies the same bytes",
  },
  {
    what:
      "a build with out pointed at a directory of user files deletes them under a green summary",
    file: "src/build-all.ts",
    find: "    if (foreign.length > 0) {\n      const shown",
    replace: "    if (foreign.length < 0) {\n      const shown",
    test: "tests/build-out-never-deletes-user-files.test.ts",
    filter:
      "out dir: a build pointed at a directory of the user's files refuses and deletes nothing",
  },
  {
    what:
      "a compiled deno.jsonc app or commented deno.json takes its appId from the binary file name, so every versioned install starts from empty state",
    file: "src/server/single-instance-lock.ts",
    find:
      "return locateDenoJsonAbove(new URL(Deno.mainModule))?.config ?? null;",
    replace:
      'return JSON.parse(Deno.readTextFileSync(new URL("./deno.json", new URL(Deno.mainModule))));',
    test: "tests/compiled-embedded-config-and-assets.test.ts",
    filter:
      "compiled binary: a deno.jsonc app keeps its appId under a versioned file name, and serves its embedded assets from a foreign cwd",
  },
  {
    what:
      "aio.run assets mounts resolve against the cwd only so a compiled binary launched elsewhere 404s its embedded media",
    file: "src/server/server.ts",
    find: "assetFallbacks: _assetFallbacks(config.assets),",
    replace: "assetFallbacks: undefined,",
    test: "tests/compiled-embedded-config-and-assets.test.ts",
    filter:
      "compiled binary: a deno.jsonc app keeps its appId under a versioned file name, and serves its embedded assets from a foreign cwd",
  },
  {
    what:
      "a compiled binary never tries the embedded copy of a relative asset mount, only the cwd path",
    file: "src/server/paths.ts",
    find: "return embedded === fromCwd ? [fromCwd] : [fromCwd, embedded];",
    replace: "return [fromCwd];",
    test: "tests/compiled-embedded-config-and-assets.test.ts",
    filter:
      "assetDirCandidates: compiled → the live cwd folder first, embedded copy after; otherwise the cwd alone",
  },
  {
    what:
      "a git update of a deno.jsonc app is refused because its compile task is read from deno.json only",
    file: "src/server/updates-rebuild.ts",
    find: "const cfg = (await readDenoJson(dir))?.config as",
    replace:
      'const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))) as',
    test: "tests/updates-rebuild.test.ts",
    filter:
      "git rebuild: a deno.jsonc app's compile task is found (JSONC, both names)",
  },
  {
    what:
      "am fix reports a deno.jsonc app's pinned or refused version as ok because it reads deno.json only",
    file: "src/am/am-cmd-fix.ts",
    find: "declared = (await readDenoJson(dir))?.config.version;",
    replace:
      'declared = (parseJsonc(await Deno.readTextFile(join(dir, "deno.json"))) as { version?: unknown } | null)?.version;',
    test: "tests/compiled-embedded-config-and-assets.test.ts",
    filter:
      "am fix: a deno.jsonc app's pinned version is advised on, not reported ok",
  },
  {
    what:
      "a db.query read outside an open callback transaction waits for it, so a callback awaiting that read deadlocks forever",
    file: "src/db/async-db.ts",
    find: "          : sideRead<QueryResult<T>>(msg);",
    replace:
      "          : _writerLock.then(() => gate<QueryResult<T>>(msg, false));",
    test: "tests/db-callback-tx-outside-read-no-wait.test.ts",
    filter:
      "db: a callback transaction awaiting a read started outside it does not deadlock",
  },
  {
    what:
      "an unrelated db.query read stalls for as long as an open callback transaction awaits anything slow",
    file: "src/db/async-db.ts",
    find: "          : sideRead<QueryResult<T>>(msg);",
    replace:
      "          : _writerLock.then(() => gate<QueryResult<T>>(msg, false));",
    test: "tests/db-callback-tx-outside-read-no-wait.test.ts",
    filter:
      "db: an unrelated read answers while a callback transaction is still open",
  },
  {
    what:
      "schedule.at arms an offset-less time in the machine zone silently, so hosts in different zones fire apart with no trace",
    file: "src/state/schedule.ts",
    find: "if (zoneLocal && !warnedZoneLocal.has(id)) {",
    replace: "if (false && zoneLocal && !warnedZoneLocal.has(id)) {",
    test: "tests/schedule-at-offsetless-is-local.test.ts",
    filter:
      "schedule.at: an offset-less time warns once per id, naming the fix; an explicit one is silent",
  },
  {
    what:
      "a bare -i with no value is refused as an unknown flag suggesting --ui instead of naming the missing value",
    file: "src/am/am-flags.ts",
    find: 'if (bad.includes("-i")) {',
    replace: 'if (false && bad.includes("-i")) {',
    test: "tests/am-dropped-input-r2.test.ts",
    filter: "am flags: a bare -i is named as needing a value, not unknown",
  },
  {
    what:
      "forwarded console lines print a nested NaN as null and drop nested undefined or function keys",
    file: "src/browser/console-intercept.ts",
    find: "      return _render(a, 0, [], budget);",
    replace: "      return JSON.stringify(a);",
    test: "tests/console-intercept.test.ts",
    filter:
      "_serialize: nested NaN, undefined, functions, symbols and cycles keep their console words",
  },
  {
    what:
      "the cheap in-place proof ignores unkeyed ordinals so a reused child whose ordinal shifts is double-mounted and freezes",
    file: "src/air/vdom-reuse.ts",
    find: "    if (_slotKey(c) !== _slotKey(d)) return false;",
    replace: "    if (false) return false;",
    test: "tests/air-reconciler-position-and-reuse.test.ts",
    filter:
      "reconciler: reused children whose unkeyed ordinal shifts at the same index stay mounted and live",
  },
  {
    what:
      "the cheap in-place proof accepts a reused vnode at a slot the old output filled with a different vnode",
    file: "src/air/vdom-reuse.ts",
    find: "      if (c !== d || seen.has(c)) return false;",
    replace: "      if (seen.has(c)) return false;",
    test: "tests/air-lifecycle-differential.test.ts",
    filter:
      "lifecycle differential: mount + self re-renders keep the document, the instances and the subscriptions true",
  },
  {
    what:
      "a hand-written client cli app compiled without its deno.json embedded gets no baked flag and boots as Electron",
    file: "src/build/build-cli.ts",
    find: "declaredClient: embedsConfig ? opts.declaredClient : undefined,",
    replace: "declaredClient: opts.declaredClient,",
    test: "tests/build-cli-argv-stays-the-apps.test.ts",
    filter:
      "cli argv: client cli is baked when the argv does not embed the deno.json that says so",
  },
  {
    what:
      "the build after am publish into a custom out refuses because the ship manifests look like user files",
    file: "src/build/build-shape.ts",
    find:
      'if (e === "manifest.json" || artifacts.has(e) || shipOutput(e)) return true;',
    replace: 'if (e === "manifest.json" || artifacts.has(e)) return true;',
    test: "tests/build-out-never-deletes-user-files.test.ts",
    filter:
      "out dir: a build after am publish into a custom out is not refused",
  },
  {
    what:
      "a publish channel directory written into out by am publish --dir is taken for user files and refused",
    file: "src/build/build-shape.ts",
    find: "const inside = Object.hasOwn(dirs, e) ? dirs[e] : undefined;",
    replace: "const inside = undefined as readonly string[] | undefined;",
    test: "tests/build-out-never-deletes-user-files.test.ts",
    filter:
      "out dir: what am publish wrote beside the artifacts counts as aio's own",
  },
  {
    what:
      "the out refusal suggests --out=release, the very directory am publish stages its release into",
    file: "src/build-all.ts",
    find: '`point "out" at a directory of its own, or move those files out ` +',
    replace:
      '`point "out" at a directory of its own (--out=release), or move those files out ` +',
    test: "tests/build-out-never-deletes-user-files.test.ts",
    filter: "out dir: no refusal points at publish's own default dir",
  },
  {
    what:
      "a per-target true entry that built on 1.0.11 is no longer accepted silently like null",
    file: "src/build/build-shape.ts",
    find: "if (o === null || o === true) continue;",
    replace: "if (o === null) continue;",
    test: "tests/build-block-shape-and-typos.test.ts",
    filter: "build block shape: what built on 1.0.11 is warned, never refused",
  },
  {
    what:
      "a scalar build.targets is refused even when --targets= overrides it, breaking a build that worked on 1.0.11",
    file: "src/build/build-shape.ts",
    find: "      if (opts.targetsOverridden) {",
    replace: "      if (false) {",
    test: "tests/build-block-shape-and-typos.test.ts",
    filter:
      "build block: a scalar targets under --targets= and a true entry still build",
  },
  {
    what:
      "the build never tells the shape check that --targets= overrides build.targets so a scalar is refused",
    file: "src/build-all.ts",
    find: 'const targetsOverridden = flag("targets") !== undefined;',
    replace: "const targetsOverridden = false;",
    test: "tests/build-block-shape-and-typos.test.ts",
    filter:
      "build block: a scalar targets under --targets= and a true entry still build",
  },
  {
    what:
      "a compiled binary serves the stale embedded asset copy over the live cwd folder the app writes into",
    file: "src/server/server-static.ts",
    find:
      "if (r.fallback?.length && !(await _pathExists(resolve(root, rel)))) {",
    replace: "if (r.fallback?.length) {",
    test: "tests/compiled-embedded-config-and-assets.test.ts",
    filter:
      "compiled binary: a deno.jsonc app keeps its appId under a versioned file name, and serves its embedded assets from a foreign cwd",
  },
  {
    what:
      "a :memory: callback transaction awaiting a read started outside it deadlocks forever with no error",
    file: "src/db/async-db.ts",
    find: "? _awaitCallbackThenRead<QueryResult<T>>(msg, sql)",
    replace: "? _writerLock.then(() => gate<QueryResult<T>>(msg, false))",
    test: "tests/db-memory-outside-read-deadlock.test.ts",
    filter:
      "db: :memory: callback awaiting a read started outside it fails by name, not a silent deadlock",
  },
  {
    what:
      "am fix rewrites a commented deno.json with JSON.stringify and silently strips its comments",
    file: "src/am/am-cmd-fix.ts",
    find: ": hasJsonComments(raw)",
    replace: ": false && hasJsonComments(raw)",
    test: "tests/am-fix-commented-deno-json.test.ts",
    filter:
      "am fix: a COMMENTED deno.json is advised, not a raw SyntaxError blocker",
  },
  {
    what:
      "am fix target to client rename re-reads deno.json with JSON.parse and fails on JSONC trailing commas",
    file: "src/am/am-cmd-fix.ts",
    find:
      "const raw = parseDenoJson(\n            await Deno.readTextFile(jsonPath),\n            jsonPath,\n          );\n          const out",
    replace:
      "const raw = JSON.parse(await Deno.readTextFile(jsonPath));\n          const out",
    test: "tests/am-fix-commented-deno-json.test.ts",
    filter:
      "am fix: a deno.json with a trailing comma (JSONC, no comments) is repaired",
  },
  {
    what:
      "am never names the ignored top-level port in a deno.jsonc or a commented deno.json",
    file: "src/am/am-utils.ts",
    find:
      "const cfg = readDenoJsonSync(projectRoot())?.config as\n      | { port?: unknown }\n      | undefined;",
    replace:
      'const cfg = JSON.parse(\n      Deno.readTextFileSync(join(projectRoot(), "deno.json")),\n    ) as { port?: unknown } | undefined;',
    test: "tests/am-deno-json-port-note-jsonc.test.ts",
    filter:
      "am: the ignored deno.json port is named for a commented deno.json and a deno.jsonc",
  },
  {
    what:
      "the opt-in data-component dev stamp is missing on a new root after a self signal re-render",
    file: "src/air/renderer-rerender.ts",
    find: "_stampDevComponent(vnode);\n\n    if (_devStart) {",
    replace: "if (_devStart) {",
    test: "tests/air-dev-stamp-self-rerender.test.tsx",
    filter:
      "air: data-component is re-stamped when a self re-render swaps the root element",
  },
  {
    what:
      "isCompiled says not compiled inside a binary whose framework is imported by absolute path",
    file: "src/server/paths.ts",
    find: "  if (segs.some((seg) => mainModule.includes(seg))) return true;\n",
    replace: "",
    test: "tests/is-compiled-absolute-framework.test.ts",
    filter:
      "isCompiled: an absolute-path framework inside a compiled binary still reads as compiled",
  },
  {
    what:
      "testCell t.init(seed) leaves the seeded slice unfrozen so an in-place mutation of state passes the test and throws in dev and prod",
    file: "src/testing/cell-test.ts",
    find: "[prefix] = deepFreeze(",
    replace: "[prefix] = Object.assign(",
    test: "tests/cell-test-init-seed.test.ts",
    filter: "a seeded state is frozen like every committed state",
  },
  {
    what:
      "the assertion state dump prints a structurally shared value as [Circular] hiding the field the failing assertion was about",
    file: "src/testing/test-format.ts",
    find: "chain[chain.length - 1] !== this",
    replace: "chain[chain.length - 1] === undefined",
    test: "tests/dev-loop-dx-harness.test.ts",
    filter:
      "formatCellState: a SHARED reference prints its value, not [Circular]",
  },
  {
    what:
      "an expectCell failure under a signed-in user dumps the server slice including rows the predicate never saw",
    file: "src/testing/ui-test.ts",
    find: "if (keys.length === 0) {",
    replace: "if (keys.length >= 0) {",
    test: "tests/testui-visible-for-user-parity.test.tsx",
    filter:
      "forUser parity: an expectCell failure prints the view the predicate read, not the server's",
  },
  {
    what:
      "testUI hover on a display:none element runs its onMouseEnter although a browser delivers no event",
    file: "src/testing/ui-test.ts",
    find: "const invisible = _hiddenReason(e);",
    replace: 'const invisible = "";',
    test: "tests/ui-harness-fidelity.test.tsx",
    filter: "strict: hover() and focus() on a hidden element are refused",
  },
  {
    what:
      "testUI focus on a hidden or disabled element runs onFocus or silently passes where a browser refuses focus",
    file: "src/testing/ui-test.ts",
    find: 'act("focus", (e)',
    replace: "act(null, (e)",
    test: "tests/ui-harness-fidelity.test.tsx",
    filter: "strict: hover() and focus() on a hidden element are refused",
  },
  {
    what:
      "testCell passes a parameterized deps-form selector's first argument in the full-state slot so it answers garbage",
    file: "src/testing/cell-test.ts",
    find: "if (isDeps) {",
    replace: "if (isDeps && args.length < 0) {",
    test: "tests/testcell-selectors.test.ts",
    filter: "a parameterized deps selector answers as bootCells does",
  },
  {
    what:
      "under testCell a cell's state getter on the def reads the declared initial so a method reading its own cell sees stale values",
    file: "src/testing/cell-test.ts",
    find: "return own ? own[key] : had.get!.call(f);",
    replace: "return own ? had.get!.call(f) : had.get!.call(f);",
    test: "tests/testcell-selectors.test.ts",
    filter: "a state getter on the def reads the live slice",
  },
  {
    what:
      "a testUI mount refused at its seed leaves its boot live so a later cell call commits into the dead mount's store",
    file: "src/testing/ui-test.ts",
    find: "standalone._retire(bootedHere);",
    replace: "void bootedHere;",
    test: "tests/testui-seed.test.tsx",
    filter: "seed: a mount refused at its seed leaves no live boot behind",
  },
  {
    what:
      "an async args predicate is refused as 'the check returned false' instead of by name",
    file: "src/state/arg-schema.ts",
    find: "if (verdict instanceof Promise) {",
    replace:
      "if (verdict instanceof Promise && verdict.constructor === Object) {",
    test: "tests/arg-predicate-async-refused.test.ts",
    filter:
      "an async args predicate is refused by name, not as 'the check returned false'",
  },
  {
    what:
      "the plain-HTTP expose warning says serving on 0.0.0.0 for an app bound to one host",
    file: "src/server/aio-server.ts",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    find: "serving on ${bindHost} over",
    replace: "serving on 0.0.0.0 over",
    test: "tests/no-tls-warning-names-bound-host.test.ts",
    filter:
      "_noTlsWarning: names the host actually bound, not a hard-coded 0.0.0.0",
  },
  {
    what:
      "a forced snapshot load keeps an undeclared cell in live state that the next restart silently discards",
    file: "src/server/aio-run-helpers.ts",
    find:
      "for (const k of dropped) delete (parsed as Record<string, unknown>)[k];",
    replace: "for (const k of dropped) void k;",
    test: "tests/load-snapshot-force-drops-undeclared.test.ts",
    filter:
      "app.loadSnapshot force: an undeclared cell is dropped, as a restart drops it",
  },
  {
    what:
      "a typo below the head of a nested exclude path silently excludes nothing and leaks the field",
    file: "src/state/cell-helpers.ts",
    find: "if (excludePathCanMatch(decl[segs[0]!], segs, 1)) continue;",
    replace:
      "if (excludePathCanMatch(decl[segs[0]!], segs, 1) || segs.length > 0) continue;",
    test: "tests/nested-exclude-typo-warns.test.ts",
    filter:
      "a nested exclude path whose inner segment matches nothing in a closed declared shape warns, per side",
  },
  {
    what:
      "a typo'd aio.run key under libraryMode calls Deno.exit and kills the test runner",
    file: "src/server/aio.ts",
    find: "  if (!libraryMode) return undefined;",
    replace: "  if (!libraryMode || libraryMode) return undefined;",
    test: "tests/library-mode-config-typo-throws.test.ts",
    filter:
      "libraryMode: an unknown aio.run() key rejects aio.run instead of Deno.exit",
  },
  {
    what:
      "a cell module importing table/pk/text from aio refuses the browser bundle, so the scaffold layout with db: breaks",
    file: "src/browser-air.ts",
    find:
      'export { integer, pk, real, ref, table, text } from "./state/table-schema.ts";',
    replace: 'export {} from "./state/table-schema.ts";',
    test: "tests/browser-bundle-self-export.test.ts",
    filter:
      'browser bundle: every name a cell module imports from "aio" bundles',
  },
  {
    what:
      "every restart of an app with a db: binding logs the bound table as a new or deleted state field",
    file: "src/server/aio-boot.ts",
    find: "boundPaths.length ? omitPaths(schema, boundPaths) : schema,",
    replace: "schema,",
    test: "tests/db-bound-field-not-new-on-restart.test.ts",
    filter:
      "db: a bound array and a bound map are not reported as new fields on restart",
  },
  {
    what:
      "auth-gated blob bytes are served Cache-Control public so shared caches may store and re-serve them",
    file: "src/server/server.ts",
    find: "blobsPrivate: _perUserAuth || !!config.token,",
    replace: "blobsPrivate: false,",
    test: "tests/blobs.test.ts",
    filter:
      "blobs over HTTP: gated blobs are Cache-Control private, open ones public",
  },
  {
    what:
      "editing the server entry app.ts in dev only reloads the browser, so new routes and config silently never apply",
    file: "src/server/server-watcher.ts",
    find: 'if (isServerEntry(path)) serverSideChanged(path, "server entry");',
    replace:
      'if (isServerEntry(path) && false) serverSideChanged(path, "server entry");',
    test: "tests/watcher-server-module.test.ts",
    filter:
      "an edited server entry restarts the app like a cell file, even mid-edit; a plain module does not",
  },
  {
    what:
      "editing a helper module a cell method imports only reloads the browser while the server keeps running the old code",
    file: "src/server/server-watcher.ts",
    find: 'if (hit) serverSideChanged(changedPath, "server module");',
    replace:
      'if (hit && false) serverSideChanged(changedPath, "server module");',
    test: "tests/watcher-server-module.test.ts",
    filter:
      "an edited module in the server entry's import graph restarts; a UI-only module does not",
  },
  {
    what:
      "a compiled app whose import map holds absolute paths builds silently though the binary only runs on the build machine",
    file: "src/build/build-compile.ts",
    find: "  await warnMachineBoundImports(root);\n  if (assets.length) {",
    replace: "  if (assets.length) {",
    test: "tests/build-machine-bound-imports.test.ts",
    filter: "machine-bound imports: every deno compile path runs the check",
  },
  {
    what:
      "the cli target compile never warns that absolute import-map paths pin the binary to this machine",
    file: "src/build/build-cli.ts",
    find:
      "  await warnMachineBoundImports(root);\n  // The deno.json the binary embeds",
    replace: "  // The deno.json the binary embeds",
    test: "tests/build-machine-bound-imports.test.ts",
    filter: "machine-bound imports: every deno compile path runs the check",
  },
  {
    what:
      "an absolute posix import-map path is not detected as machine-bound so the build stays silent",
    file: "src/build/machine-bound-imports.ts",
    find: 'return /^file:/i.test(v) || v.startsWith("/") ||',
    replace: "return /^file:/i.test(v) ||",
    test: "tests/build-machine-bound-imports.test.ts",
    filter:
      "machine-bound imports: absolute paths and file: URLs are flagged, portable specifiers are not",
  },
  {
    what:
      "am fix reports an absolute-path import map as fine though its compiled binary only runs here",
    file: "src/am/am-cmd-fix.ts",
    find: '    bound !== null,\n    "portable import map",',
    replace: '    false,\n    "portable import map",',
    test: "tests/am-fix-machine-bound-imports.test.ts",
    filter:
      "am fix: an absolute-path import map is advised with the relative fix",
  },
  {
    what:
      'a sync op is access-checked as method "sync" with no args, so a deny-list predicate lets any user run an admin-only method via an op frame',
    file: "src/sync/server-handler.ts",
    find:
      "!deps.accessCheck(op.cell, meta.user, op.action, opArgs(op.payload))",
    replace: '!deps.accessCheck(op.cell, meta.user, "sync", [])',
    test: "tests/sync-op-access-predicate-method.test.ts",
    filter:
      "sync op: a predicate rule sees the op's real method — a denied one is refused",
  },
  {
    what:
      'a reconnect-flushed pending op is access-checked as method "sync", so a deny-list predicate lets any user run an admin-only method offline-queued',
    file: "src/sync/server-handler.ts",
    find:
      "              meta.user,\n              pending.action,\n              opArgs(pending.payload),",
    replace:
      '              meta.user,\n              "sync",\n              [],',
    test: "tests/sync-op-access-predicate-method.test.ts",
    filter:
      "sync pending op: the reconnect flush asks the predicate about the real method too",
  },
  {
    what:
      "spawn registry forgets a group when its leader exits, so shutdown never reaps a surviving grandchild worker",
    file: "src/server/spawn.ts",
    find: "(_groupGoneOf.get(handle) ?? handle.status).then(forget, forget);",
    replace: "handle.status.then(forget, forget);",
    test: "tests/spawn-survivor-group-reaped.test.ts",
    filter:
      "spawn: a grandchild outliving its exited parent stays tracked and killAllSpawned reaps it",
  },
  {
    what:
      "spawn kill() SIGKILL escalation is skipped once the leader exits, orphaning a TERM-ignoring grandchild",
    file: "src/server/spawn.ts",
    find: '        toGroup("SIGKILL");',
    replace: '        send("SIGKILL");',
    test: "tests/spawn-survivor-group-reaped.test.ts",
    filter:
      "spawn: kill() escalates to SIGKILL for a TERM-ignoring grandchild even after the parent died",
  },
  {
    what:
      "a cached TLS leaf is reused after the machine root rotates, serving the old root and failing pinned handshakes",
    file: "src/server/tls.ts",
    find: "if (root !== undefined && certs.at(-1) === root) return true;",
    replace: "if (root !== undefined) return true;",
    test: "tests/tls-leaf-reissue-root-and-expiry.test.ts",
    filter:
      "tls: after the machine root is rotated the cached leaf is re-issued under the new root",
  },
  {
    what:
      "a cached TLS leaf near or past its expiry is reused instead of re-issued, breaking every handshake",
    file: "src/server/tls.ts",
    find: "if (notAfter.getTime() - Date.now() < LEAF_RENEW_MS) {",
    replace: "if (notAfter.getTime() - Date.now() < 0) {",
    test: "tests/tls-leaf-reissue-root-and-expiry.test.ts",
    filter:
      "tls: a cached leaf that is about to expire is re-issued, not reused",
  },
  {
    what:
      "a TLS certificate given without its key is silently replaced by the generated self-signed certificate",
    file: "src/server/tls.ts",
    find: "if (!!customCert !== !!customKey) {",
    replace: "if (false) {",
    test: "tests/tls-leaf-reissue-root-and-expiry.test.ts",
    filter:
      "tls: a certificate without its key is refused, never silently replaced by a generated one",
  },
  {
    what:
      'memory.maxHeap "0GB" or "0%" parses to zero and silently means the default ceiling',
    file: "src/server/heap-policy.ts",
    find: "if (size && !(Number(size[1]) > 0)) {",
    replace: "if (size && false) {",
    test: "tests/heap-zero-size-refused.test.ts",
    filter: "heap: a zero size string is refused like the number 0",
  },
  {
    what:
      "openExternal on Windows routes the target through cmd.exe so an ampersand in a URL runs a command",
    file: "src/server/open-external.ts",
    find: '  if (os === "windows") {',
    replace: '  if (os === "windows" && false) {',
    test: "tests/open-external-windows-no-cmd-parse.test.ts",
    filter:
      "openExternal: on Windows the target is never on a cmd.exe command line",
  },
  {
    what:
      "electron webview preload file URLs are sliced not decoded, refusing encoded or Windows paths inside the app",
    file: "src/electron/electron-shared.ts",
    find: "? require('url').fileURLToPath(want)",
    replace: "? want.slice(7)",
    test: "tests/electron-webview-preload-file-url.test.ts",
    filter:
      "electron: a webview preload given as an encoded file: URL inside the app dir is accepted",
  },
  {
    what:
      "aiol rewrites --key=/--cert= flags inside a deno.json task that runs some other program, not the app",
    file: "aiol/fixes.ts",
    find:
      `return want !== "" && taskTokens(cmd).some((t) => normTaskPath(t) === want);`,
    replace: `return true;`,
    test: "tests/aiol-safe-fix-scope.test.ts",
    filter:
      "aiol task flags: a non-app task's --key= is neither reported nor rewritten",
  },
  {
    what:
      "aiol offers a safe fix that repoints a mixed dynamic aio destructure to aio/server, making aio undefined",
    file: "aiol/checks.ts",
    find: `? fix.dynamicDestructureNonServer(dm[1])`,
    replace: `? []`,
    test: "tests/aiol-safe-fix-scope.test.ts",
    filter:
      "aiol dynamic aio/server fix: a mixed destructure is [manual], never repointed",
  },
  {
    what:
      "the dynamic aio/server safe fix repoints a destructure that also takes browser-safe names like aio",
    file: "aiol/fixes.ts",
    find: `if (dynamicDestructureNonServer(inner).length > 0) return whole;`,
    replace: `if (inner === "") return whole;`,
    test: "tests/aiol-safe-fix-scope.test.ts",
    filter:
      "aiol dynamic aio/server fix: the fix itself declines a mixed destructure",
  },
  {
    what:
      "the return-effects safe fix rewrites a return inside a nested callback into s.$do, changing behavior",
    file: "aiol/fixes.ts",
    find: `if (insideNestedFunction(masked, method.bodyOpen, start)) {`,
    replace: `if (masked === "") {`,
    test: "tests/aiol-safe-fix-scope.test.ts",
    filter:
      "aiol return-effects fix: a return inside a nested callback is not rewritten",
  },
  {
    what:
      "the schedule.blocking safe fix treats an aliased blocking import as bound and leaves blocking unresolved",
    file: "aiol/fixes.ts",
    find: `/^(?:blocking|blocking\\s+as\\s+blocking)$/.test(n.trim())`,
    replace: `/\\bblocking\\b/.test(n)`,
    test: "tests/aiol-safe-fix-scope.test.ts",
    filter:
      "aiol schedule.blocking fix: an aliased `blocking as b` import still gets `blocking` bound",
  },
  {
    what:
      "aiol reports Function.prototype.call({ timeout }) as the removed aio call option and rewrites it",
    file: "aiol/fixes.ts",
    find: `(?<!\\.\\s*)\\bcall\\s*\\(`,
    replace: `\\bcall\\s*\\(`,
    test: "tests/aiol-safe-fix-scope.test.ts",
    filter:
      "aiol call-timeout rule: a member `.call({ timeout })` is not aio's call",
  },
  {
    what:
      "a top-level object key preceded by a line comment is invisible to topLevelKeyOffsets and its rules",
    file: "aiol/scan.ts",
    find: `if (b > open + 1 && src[b] === "/" && src[b - 1] === "/") {`,
    replace: `if (b < 0) {`,
    test: "tests/aiol-safe-fix-scope.test.ts",
    filter:
      "aiol call-timeout rule: a commented `timeout:` option is still found",
  },
  {
    what:
      "the key:false migration fix declines forever when aio.run has a nested tls key",
    file: "aiol/fixes.ts",
    find: `if (topLevelKeyOffsets(src, open, "key").length > 0) return false;`,
    replace:
      `if (/[^$\\w.]key\\s*:/.test(masked.slice(open, end + 1))) return false;`,
    test: "tests/aiol-safe-fix-scope.test.ts",
    filter:
      "aiol key:false migration: a nested tls.key does not make the fix decline",
  },
  {
    what:
      "the in-cell timer hint fires on a helper that only mentions cell( inside a comment",
    file: "aiol/checks.ts",
    find: `if (!code.includes("cell(")) continue;`,
    replace: `if (!file.content.includes("cell(")) continue;`,
    test: "tests/aiol-safe-fix-scope.test.ts",
    filter:
      "aiol timer hint: `cell(` and `setTimeout(` only in comments are not cell code",
  },
  {
    what:
      "amui log tail shows the mid-line fragment left by the seek as its first line",
    file: "amui/src/server/proc.server.ts",
    find: `buf.subarray(firstNl === -1 ? 0 : firstNl + 1, off),`,
    replace: `buf.subarray(0, off),`,
    test: "tests/amui-log-tail-fragment.test.ts",
    filter:
      "amui readLogs: a seeked tail starts at a whole line, never a fragment",
  },
  {
    what:
      "the dynamic aio/server rule captures from an enclosing function brace and flags a browser-safe destructure",
    file: "aiol/checks.ts",
    find: `/(?:\\{([^{}]*)\\}\\s*=\\s*await\\s+import`,
    replace: `/(?:\\{([^}]*)\\}\\s*=\\s*await\\s+import`,
    test: "tests/aiol-safe-fix-scope.test.ts",
    filter:
      "aiol dynamic aio/server rule: a browser-safe destructure inside a function body is not flagged",
  },
  {
    what:
      "the dynamic aio/server fix captures from an enclosing function brace and never repoints an in-function import",
    file: "aiol/fixes.ts",
    find:
      `/\\{([^{}]*)\\}\\s*=\\s*await\\s+import\\(\\s*(["'])aio\\2\\s*\\)/g,`,
    replace:
      `/\\{([^}]*)\\}\\s*=\\s*await\\s+import\\(\\s*(["'])aio\\2\\s*\\)/g,`,
    test: "tests/aiol-safe-fix-scope.test.ts",
    filter:
      "aiol dynamic aio/server fix: a server-only destructure inside a function body is repointed",
  },
  {
    what:
      "amui Stop on an am backup/restore maintenance hold SIGTERMs the maintenance op mid-copy",
    file: "amui/src/manager.ts",
    find: `const held = await refuseHold(running);`,
    replace: `const held = null as string | null;`,
    test: "tests/amui-maintenance-hold.test.ts",
    filter:
      "amui stop refuses a maintenance hold instead of SIGTERMing am backup",
  },
  {
    what:
      "amui Restart on an am backup/restore maintenance hold SIGTERMs the maintenance op mid-copy",
    file: "amui/src/manager.ts",
    find: `const heldBy = await refuseHold(running);`,
    replace: `const heldBy = null as string | null;`,
    test: "tests/amui-maintenance-hold.test.ts",
    filter:
      "amui restart refuses a maintenance hold instead of SIGTERMing am backup",
  },
  {
    what:
      "isCompiled reads Deno.mainModule inside a worker cell where it is undefined, so every worker cell crashes at boot",
    file: "src/server/paths.ts",
    find: '    (Deno.mainModule as string | undefined) ?? "",',
    replace: "    Deno.mainModule,",
    test: "tests/worker-peer-access-harness-parity.test.tsx",
    filter: "worker parity: what a REAL worker answers",
  },
  {
    what:
      "the dev checkpoint writes persist-excluded fields (top-level and nested secrets) to logs/checkpoint.json on disk",
    file: "src/server/aio-boot.ts",
    find: "const kept = applyCellFieldFilter(filter, slice);",
    replace: "const kept: Record<string, unknown> | undefined = slice;",
    test: "tests/checkpoint-persist-exclude.test.ts",
    filter:
      "checkpoint: persist-excluded fields (top-level + nested) never reach checkpoint.json; restore gives restart values",
  },
  {
    what:
      "restoring a checkpoint hands back persist-excluded fields from its copy instead of the values a restart gives",
    file: "src/server/aio-boot.ts",
    find: "const next = unpersistedFromBase(filter, base, slice);",
    replace: "const next = slice;",
    test: "tests/checkpoint-persist-exclude.test.ts",
    filter:
      "checkpoint: a raw checkpoint an OLDER build wrote never hands back persist-excluded fields, and is rewritten",
  },
  {
    what:
      "a raw checkpoint an older build left with persist-excluded secrets is never rewritten and stays on disk",
    file: "src/diagnostics/mod.ts",
    find: "JSON.stringify(kept) !== JSON.stringify(recovered.state)",
    replace: "Object.keys(kept).length !== Object.keys(recovered.state).length",
    test: "tests/checkpoint-persist-exclude.test.ts",
    filter:
      "checkpoint: a raw checkpoint an OLDER build wrote never hands back persist-excluded fields, and is rewritten",
  },
  {
    what:
      "the standalone boot ignores the harness persistKey and testUI persist mounts restore a previous run's aio:testui entry",
    file: "src/standalone-air.ts",
    find: 'persistKey: opts.persistKey ?? `aio:${opts.appId ?? "app"}`,',
    replace: 'persistKey: `aio:${opts.appId ?? "app"}`,',
    test: "tests/testui-persist-key-flush.test.tsx",
    filter:
      "testUI persist: a previous run's aio:testui entry is never restored",
  },
  {
    what:
      "testUI persist dispose cancels the pending debounced save so the last change before teardown is lost",
    file: "src/testing/ui-test.ts",
    find: "if (opts.persist) standalone._flushPendingPersist();",
    replace: "if (false) standalone._flushPendingPersist();",
    test: "tests/testui-persist-key-flush.test.tsx",
    filter:
      "testUI persist: dispose flushes the pending save, the next mount restores it",
  },
  {
    what:
      "an async method that writes then throws is logged as no state changed while its earlier writes committed",
    file: "src/state/cell-methods-internals.ts",
    find: "const committed = !transactional && batcher.wrote();",
    replace: "const committed = false;",
    test: "tests/async-rejection-line-truthful.test.ts",
    filter:
      "async throw after writing: the rejection line says the writes stayed",
  },
  {
    what:
      "am trigger hover fires mouseenter handlers on a display:none element that no browser could hover",
    file: "src/air/ui-trigger.ts",
    find:
      "const invisible = hiddenReason(el);\n      if (invisible) {\n        const tag =",
    replace:
      "const invisible = null as string | null;\n      if (invisible) {\n        const tag =",
    test: "tests/am-trigger-hover-focus-guard.test.tsx",
    filter:
      "am trigger: hover on a display:none element is refused, fires nothing",
  },
  {
    what:
      "am trigger focus fires onFocus on a disabled control that a browser never focuses",
    file: "src/air/ui-trigger.ts",
    find: '      assertOperable(el, "focus");',
    replace: "      void 0;",
    test: "tests/am-trigger-hover-focus-guard.test.tsx",
    filter: "am trigger: focus on a disabled control is refused, fires nothing",
  },
  {
    what:
      "declaring version 1 on an unversioned sync cell as the boot hint advises refuses the boot or quarantines the cell",
    file: "src/server/aio-boot.ts",
    find: "const adoptV0 = declared > 0 && !hook;",
    replace: "const adoptV0 = false as boolean;",
    test: "tests/sync/sync-version-advice-followed.test.ts",
    filter:
      "sync version advice: declaring version: 1 on an unchanged v0 cell is silent and keeps every op",
  },
  {
    what:
      "am surface with no client renders an auth app as loading first and SignIn on the next call",
    file: "src/browser/browser-auth-ui.ts",
    find: "return user === undefined && _noSessionPossible() ? null : user;",
    replace: "return user;",
    test: "tests/server-surface-auth-deterministic.test.ts",
    filter:
      "headless surface: an auth app renders the same anonymous branch on every call",
  },
  {
    what:
      "aiol reports a missing test task twice, once from config and once from testing, both fixable",
    file: "aiol/checks.ts",
    find:
      `// Test task: checkConfig owns it (it runs with or without cells). A second`,
    replace:
      `if (!ctx.denoJson?.tasks?.["test"]) report("hint", "testing", 'no "test" task in deno.json', { safeFix: fix.fixAddTestTask }); //`,
    test: "tests/aiol-test-task-once.test.ts",
    filter: "aiol: a missing test task is reported once, not once per area",
  },
  {
    what:
      "amui keys running instances by directory so a second instance from the same dir vanishes from the list",
    file: "amui/src/server/scan.server.ts",
    find: `id: instanceId(i.cwd, i.appId, i.home),`,
    replace: `id: i.cwd,`,
    test: "tests/amui-multi-instance.test.ts",
    filter:
      "amui lists two instances from one directory apart and stops the one selected",
  },
  {
    what:
      "amui stop waits for every instance in the directory to go down so a live sibling reads as a failed stop",
    file: "amui/src/manager.ts",
    find: `const down = r.ok && await awaitDown(path, undefined, pid);`,
    replace: `const down = r.ok && await awaitDown(path);`,
    test: "tests/amui-multi-instance.test.ts",
    filter:
      "amui lists two instances from one directory apart and stops the one selected",
  },
  {
    what:
      "amui resolves a directory shared by two instances to one of them and stops a guessed instance",
    file: "amui/src/manager.ts",
    find: `return n === 1 ? atPath : undefined;`,
    replace: `return atPath;`,
    test: "tests/amui-multi-instance.test.ts",
    filter:
      "amui: a directory two instances share is not a Stop target by itself",
  },
  {
    what:
      "amui restart of a profile instance relaunches without its profile and boots the default instance instead",
    file: "amui/src/manager.ts",
    find: `const r = await startApp(path, "browser", running?.profile);`,
    replace: `const r = await startApp(path, "browser");`,
    test: "tests/amui-multi-instance.test.ts",
    filter:
      "amui restart of a profile instance boots that profile and waits for IT",
  },
  {
    what:
      "amui start/restart counts a sibling instance already up in the directory as the new boot succeeding",
    file: "amui/src/server/proc.server.ts",
    find:
      `if (await registeredAt(dir, undefined, before)) return { up: true };`,
    replace: `if (await registeredAt(dir)) return { up: true };`,
    test: "tests/amui-multi-instance.test.ts",
    filter:
      "amui restart of a profile instance boots that profile and waits for IT",
  },
  {
    what:
      "amui restart waits for every instance in the directory to stop and fails while a sibling runs",
    file: "amui/src/manager.ts",
    find: `if (!await awaitDown(path, undefined, pid)) {`,
    replace: `if (!await awaitDown(path)) {`,
    test: "tests/amui-multi-instance.test.ts",
    filter:
      "amui restart of a profile instance boots that profile and waits for IT",
  },
  {
    what:
      "amui selecting app B keeps app A's state-too-large banner and truncation flags until B loads",
    file: "amui/src/manager.ts",
    find: `      s.detailStateTruncated = false;
      s.detailStateSize = 0;
      s.detailStateLoading = false;
      s.controlError = null;
      s.logTruncated = false;`,
    replace: `      s.detailStateLoading = false;`,
    test: "tests/amui-multi-instance.test.ts",
    filter: "amui select clears the previous app's too-large banner and errors",
  },
  {
    what:
      "the windows directory swap goes back to cmd.exe with every path on its command line, so an install path holding & runs commands",
    file: "src/server/updates-apply.ts",
    find: '  if (os !== "windows") {\n    return {\n      cmd: "/bin/sh",',
    replace:
      '  if (os === os) {\n    return {\n      cmd: os === "windows" ? "cmd.exe" : "/bin/sh",',
    test: "tests/updates-swap-windows.test.ts",
    filter:
      "swap spec (windows): no value reaches a command line cmd.exe re-parses",
  },
  {
    what:
      "the windows swap helper runs with its cwd inside the install so Windows refuses to move the directory",
    file: "src/server/updates-apply.ts",
    find: "? winDirname(v.current)",
    replace: "? v.current",
    test: "tests/updates-swap-windows.test.ts",
    filter:
      "swap spec (windows): no value reaches a command line cmd.exe re-parses",
  },
  {
    what:
      "run.bat sets HERE unquoted so an install path with & ends the SET and runs the rest as a command",
    file: "src/build/build-electron.ts",
    find: 'SET "HERE=%~dp0"',
    replace: "SET HERE=%~dp0",
    test: "tests/updates-swap-windows.test.ts",
    filter:
      "run.bat: every SET is quoted, so an install path with & stays inert",
  },
  {
    what:
      "the Windows spawn branch only adds an abort listener so an already aborted signal never kills the child",
    file: "src/server/spawn.ts",
    find: "  _wireAbort(opts.signal, handle, cmd);",
    replace:
      '  opts.signal?.addEventListener("abort", () => void handle.kill(), { once: true });',
    test: "tests/spawn-abort-wiring.test.ts",
    filter:
      "spawn abort: the Windows branch routes its signal through _wireAbort",
  },
  {
    what:
      "the shared abort wiring ignores a signal that is already aborted when spawn is called",
    file: "src/server/spawn.ts",
    find: "  if (signal.aborted) {\n    kill();\n    return none;",
    replace: "  if (signal.aborted) {\n    return none;",
    test: "tests/spawn-abort-wiring.test.ts",
    filter: "spawn abort: an already-aborted signal kills at once",
  },
  {
    what:
      "the machine root CA is reused past its own expiry so every chain it anchors fails silently",
    file: "src/server/tls.ts",
    find:
      "return notAfter.getTime() - Date.now() < ROOT_RENEW_MS ? notAfter : null;",
    replace: "return notAfter.getTime() < 0 ? notAfter : null;",
    test: "tests/tls-root-expiry.test.ts",
    filter:
      "tls: a machine root that expired is replaced, the leaf re-issued, and am trust named",
  },
  {
    what:
      "a still-valid cached leaf keeps serving an expired machine root because the root is only checked on issue",
    file: "src/server/tls.ts",
    find: "if (haveCA) await loadOrCreateAioRoot();",
    replace: "if (haveCA) void 0;",
    test: "tests/tls-root-expiry.test.ts",
    filter:
      "tls: a machine root that expired is replaced, the leaf re-issued, and am trust named",
  },
  {
    what:
      "a spawn handle re-probes its pgid after the group emptied, so a late kill or abort signals an unrelated recycled process group",
    file: "src/server/spawn.ts",
    find: "if (gone) return false;",
    replace: "if (gone && false) return false;",
    test: "tests/spawn-group-gone.test.ts",
    filter:
      "spawn group gone: kill() and abort after the group emptied never reach a recycled pgid",
  },
  {
    what:
      "the abort listener stays attached after the group is gone, so a later abort still runs kill on a stale handle",
    file: "src/server/spawn.ts",
    find: "    unwire();\n    resolveGone();",
    replace: "    resolveGone();",
    test: "tests/spawn-group-gone.test.ts",
    filter:
      "spawn group gone: kill() and abort after the group emptied never reach a recycled pgid",
  },
  {
    what:
      "a zombie grandchild counts as a live group member, so the registry entry, its poll and a slow kill never go away",
    file: "src/server/spawn.ts",
    find: 'return Deno.build.os === "linux" ? _procGroupHasLive(pgid) : true;',
    replace: 'return Deno.build.os === "linux" ? true : true;',
    test: "tests/spawn-group-gone.test.ts",
    filter:
      "spawn group gone: a group holding only a zombie is forgotten and kill() is prompt",
  },
  {
    what:
      "a nested exclude naming an optional field the declaration omits warns excludes-nothing on correct code",
    file: "src/state/cell-helpers.ts",
    find: "      if (!near) continue;",
    replace: "      if (!near && false) continue;",
    test: "tests/nested-exclude-typo-warns.test.ts",
    filter:
      "a nested exclude naming an optional field the declaration omits is silent, a near-miss still warns",
  },
  {
    what:
      "an android bundle of a cell module declaring a db table fails with No matching export for table",
    file: "src/standalone-air.ts",
    find:
      'export { integer, pk, real, ref, table, text } from "./state/table-schema.ts";',
    replace:
      'export { integer, pk, real, ref, text } from "./state/table-schema.ts";\nexport const table: typeof import("./state/table-schema.ts").table =\n  undefined as never;',
    test: "tests/android-air-surface.test.ts",
    filter:
      "android `aio`: the db schema builders are present, and are THE same objects",
  },
  {
    what:
      "an in-memory outside read fails behind a long but progressing callback transaction, counting queue time",
    file: "src/db/async-db.ts",
    find: "        if (idle < timeoutMs) return armCeiling(timeoutMs - idle);",
    replace:
      "        if (idle < timeoutMs && false) return armCeiling(timeoutMs - idle);",
    test: "tests/db-memory-outside-read-deadlock.test.ts",
    filter:
      "db: :memory: outside read waits out a long transaction that keeps making progress",
  },
  {
    what:
      "an app's server persistKey moves the standalone APK store off aio:<appId>, so saved data is never read",
    file: "src/standalone-air.ts",
    find: "? cfg[_HARNESS_PERSIST_KEY]",
    replace:
      '? cfg[_HARNESS_PERSIST_KEY]\n        : typeof cfg.persistKey === "string"\n        ? cfg.persistKey',
    test: "tests/standalone-persist-key-server-option.test.ts",
    filter:
      "standalone persist: an app's server `persistKey` does not move the aio:<appId> store",
  },
  {
    what:
      "a dev checkout whose path contains deno-compile- is treated as a compiled binary so dev runs as prod",
    file: "src/server/paths.ts",
    find:
      // aio-ok: the literal SOURCE line this mutation patches in and out
      "  if (segs.some((seg) => moduleUrl.includes(seg))) return true;",
    replace: '  if (moduleUrl.includes("/deno-compile-")) return true;',
    test: "tests/is-compiled-absolute-framework.test.ts",
    filter:
      "isCompiled: a dev checkout whose path contains deno-compile- is not compiled",
  },
  {
    what:
      "a Windows binary is not known as compiled, because real Windows keeps .exe in the deno-compile- segment — the app runs dev lint and dies on a missing App.tsx",
    file: "src/server/paths.ts",
    find: ': [...new Set([base, base.replace(/\\.exe$/i, "")])];',
    replace: ': [base.replace(/\\.exe$/i, "")];',
    test: "tests/is-compiled-absolute-framework.test.ts",
    filter:
      "isCompiled: a dev checkout whose path contains deno-compile- is not compiled",
  },
  {
    what:
      "a visibility:visible child of a visibility:hidden parent is refused though a browser paints it and delivers events",
    file: "src/air/ui-trigger.ts",
    find:
      "    if (vis === undefined && node.style?.visibility) {\n      vis = node.style.visibility;\n    }",
    replace:
      '    if (cs?.visibility === "hidden") return "visibility: hidden";',
    test: "tests/ui-visibility-override.test.tsx",
    filter:
      "visibility override and author display on [hidden] are operable, the rest refused",
  },
  {
    what:
      "a hidden-attribute element that author CSS displays is refused though a browser shows it",
    file: "src/air/ui-trigger.ts",
    find: "if (node.hidden === true && !authorDisplay(w, node, display)) {",
    replace:
      "if (node.hidden === true && !authorDisplay || node.hidden === true) {",
    test: "tests/ui-visibility-override.test.tsx",
    filter:
      "visibility override and author display on [hidden] are operable, the rest refused",
  },
  {
    what:
      "an app entry matched as a substring makes another script's task the app and safe-fix rewrites its flags",
    file: "aiol/fixes.ts",
    find:
      'return want !== "" && taskTokens(cmd).some((t) => normTaskPath(t) === want);',
    replace: 'return want !== "" && cmd.includes(entry!);',
    test: "tests/aiol-safe-fix-scope.test.ts",
    filter:
      "aiol task flags: an entry that is a SUBSTRING of another script's path is not that script",
  },
  {
    what:
      "with no detectable app entry a renamed task flag goes unreported and the app fails at boot",
    file: "aiol/checks.ts",
    find:
      "if (!isApp && (entry !== null || !fix.taskRunsScript(cmd))) continue;",
    replace: "if (!isApp) continue;",
    test: "tests/aiol-safe-fix-scope.test.ts",
    filter:
      "aiol task flags: with no detectable entry a renamed flag is still reported, as [manual]",
  },
  {
    what:
      "a testUI seed of an undeclared optional key is warned without naming the declare-it-undefined fix",
    file: "src/testing/ui-test.ts",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    find: "`once declared: declare \\`${bad[0]}: undefined\\` in \\`state:\\``",
    replace: "`once declared`",
    test: "tests/testui-seed-optional-key.test.tsx",
    filter:
      "seed: an undeclared optional key still mounts, warning with `key: undefined` as the fix",
  },
  {
    what:
      "t.init of an undeclared optional key is refused without naming the declare-it-undefined fix",
    file: "src/testing/cell-test.ts",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    find: "`declare \\`${unknown[0]}: undefined\\` in \\`state:\\``",
    replace: "`declare it`",
    test: "tests/testui-seed-optional-key.test.tsx",
    filter: "t.init: an undeclared optional key names the same fix",
  },
  {
    what:
      "the app boot stops handing the report builder each cell's persist filter, so persist-excluded fields and persist:none cells are written into data/reports on disk",
    file: "src/server/aio.ts",
    find: "        _persistFilters: config._cellPersist,",
    replace: "        _persistFilters: undefined,",
    test: "tests/report-persist-exclude.test.ts",
    filter:
      "feedback capture: persist-excluded fields and persist:none cells stay out of the report on disk",
  },
  {
    what:
      "the report timeline screen reads only the visible declaration and ignores persist, so diff values of persist-excluded fields reach the report",
    file: "src/server/report.ts",
    find: "    for (const filters of screens) {",
    replace: "    for (const filters of screens.slice(0, 1)) {",
    test: "tests/report-persist-exclude.test.ts",
    filter:
      "report timeline: diff values and args of writes to a persist-excluded field are withheld",
  },
  {
    what:
      "the state-diff debug log prints the before and after values of a persist-excluded field in cleartext to debug.log on disk",
    file: "src/diagnostics/mod.ts",
    find: "                  to: keptValue(d.cell, c.key, c.to),",
    replace: "                  to: c.to,",
    test: "tests/state-diff-persist-exclude.test.ts",
    filter:
      "state-diff: a persist-excluded field's values stay out of debug.log",
  },
  {
    what:
      "the problem report tails app.log without masking the share-link token, so the app key is written into the report and POSTed to the feedback URL",
    file: "src/server/report.ts",
    find: "    return all.slice(-lines).map(redactLogCredentials);",
    replace: "    return all.slice(-lines);",
    test: "tests/report-log-tail-credentials.test.ts",
    filter: "report logs: the share-link token and the pair code are masked",
  },
  {
    what:
      "the log-credential masker drops the pair code rule, so the one-shot pairing PIN from the boot banner rides out in a problem report",
    file: "src/diagnostics/redact.ts",
    find:
      // aio-ok: the literal SOURCE line this mutation patches in and out
      // aio-ok: the literal SOURCE line this mutation patches in and out
      "  return redactUrlToken(text).replace(PAIR_CODE, `$1${TOKEN_MASK}`);",
    replace: "  return redactUrlToken(text);",
    test: "tests/report-log-tail-credentials.test.ts",
    filter: "report logs: the share-link token and the pair code are masked",
  },
  {
    what:
      "Markdown spreads every child list into h(), so a wide document overflows V8's argument cap and the render throws",
    file: "src/ui/h-spread.ts",
    find: "export const SPREAD_MAX = 8192;",
    replace: "export const SPREAD_MAX = 1e9;",
    test: "tests/ui-markdown-wide.test.ts",
    filter:
      "md wide: 100k siblings in one paragraph, list, link or document all render",
  },
  {
    what:
      "theme danger button keeps a fixed label colour instead of solving it from the fill, unreadable on the dark-mode fill or an app's own danger",
    file: "src/build/app-theme.ts",
    find: "  --aio-on-danger:color(from var(--aio-danger) srgb-linear ",
    replace:
      "  --aio-on-danger:#fff;\n  --aio-unused:color(from var(--aio-danger) srgb-linear ",
    test: "tests/danger-fill-contrast.test.ts",
    filter:
      "danger fill: both stylesheets solve the ink from the fill, in a guarded block",
  },
  {
    what:
      "kit danger button hard-codes a white label that fails AA on the dark-mode danger fill",
    file: "src/ui/styles.ts",
    find:
      ".aio-btn--danger { background: var(--aio-ui-danger); color: var(--aio-ui-on-danger); }",
    replace:
      ".aio-btn--danger { background: var(--aio-ui-danger); color: #fff; }",
    test: "tests/danger-fill-contrast.test.ts",
    filter:
      "danger fill: both stylesheets solve the ink from the fill, in a guarded block",
  },
  {
    what:
      "kit danger label keeps a fixed dark ink in dark mode, so an app's own darker danger fill gets a 3.65:1 label",
    file: "src/ui/styles.ts",
    find:
      "    --aio-ui-on-danger: var(--aio-on-danger, color(from var(--aio-ui-danger) srgb-linear ",
    replace:
      "    --aio-ui-on-danger: var(--aio-on-danger, #1c0d0e);\n    --aio-unused: var(--aio-on-danger, color(from var(--aio-ui-danger) srgb-linear ",
    test: "tests/danger-fill-contrast.test.ts",
    filter:
      "danger fill: both stylesheets solve the ink from the fill, in a guarded block",
  },
  {
    what:
      "Browser hands the renderer a fresh use-action closure each render, so every re-render parks the keepAlive guest out of sight",
    file: "src/ui/browser.ts",
    find: "    use: mountGuest,",
    replace: "    use: (el: HTMLElement) => mountGuest(el),",
    test: "tests/ui-browser.test.ts",
    filter:
      "keepAlive: a re-render leaves the guest on the page, and a src change navigates it",
  },
  {
    what:
      "Browser mounts synchronously before the element has a parent or props, so a parked guest is never restored",
    file: "src/ui/browser.ts",
    find: "  queueMicrotask(() => activate(el, m));",
    replace: "  activate(el, m);",
    test: "tests/ui-browser.test.ts",
    filter:
      "keepAlive: a remount opens the page the last guest was on, and nothing is moved or hidden",
  },
  {
    what:
      "removeDom calls removeChild after an action cleanup already moved the element, throwing and abandoning the render",
    file: "src/air/vdom-remove.ts",
    find:
      "    if (isChildOf(dom, parent)) parent.removeChild(dom);\n  } else if (",
    replace: "    parent.removeChild(dom);\n  } else if (",
    test: "tests/air-remove-detached-teardown.test.ts",
    filter:
      "removeDom: an action teardown that moves its element does not abort the render",
  },
  {
    what:
      "removeDom skips unmount teardown entirely for an element no longer inside its parent, leaking its actions",
    file: "src/air/vdom-remove.ts",
    find:
      '  } else if (\n    typeof vnode === "object" && typeof vnode.tag === "string" && vnode._dom\n  ) {',
    replace:
      '  } else if (\n    false as boolean && typeof vnode === "object" && typeof vnode.tag === "string" && vnode._dom\n  ) {',
    test: "tests/air-remove-detached-teardown.test.ts",
    filter:
      "removeDom: an element taken out of its parent by someone else still has its teardown run",
  },
  {
    what:
      "single-line Skeleton drops id, data-* and aria-* escape-hatch attributes the kit promises to pass through",
    file: "src/ui/controls.ts",
    find:
      '      undefined,\n      rest(props, ["width", "height", "circle", "lines", "class", "style"]),',
    replace: "      undefined,\n      {},",
    test: "tests/ui-controls-edges.test.ts",
    filter:
      "Skeleton: one line keeps the escape-hatch attributes, like many lines do",
  },
  {
    what:
      "Tabs builds DOM ids from raw tab ids so whitespace splits aria-labelledby into missing IDREFs",
    file: "src/ui/controls.ts",
    find: "        /[%\\s]/g,",
    replace: "        /%/g,",
    test: "tests/ui-controls-edges.test.ts",
    filter: "Tabs: a tab id with spaces still names the panel and still arrows",
  },
  {
    what:
      "tooltip bubble centred with a logical inset under a physical translate sits off-centre in RTL",
    file: "src/ui/styles.ts",
    find:
      ".aio-tip__bubble { position: absolute; z-index: 1200; transform: translateX(-50%);",
    replace:
      ".aio-tip__bubble { position: absolute; z-index: 1200; inset-inline-start: 50%; transform: translateX(-50%);",
    test: "tests/ui-controls-edges.test.ts",
    filter:
      "Tooltip: the bubble's centring offset is on the same axis side as its translate",
  },
  {
    what:
      "the transport snapshot ranks clients by gap alone so an ungraded non-heartbeat socket outranks the frozen client and the transport-stall hint never fires",
    file: "src/vitals/mod.ts",
    find: 'const rank = (s: string) => s === "frozen" ? 1 : 0;',
    replace: "const rank = (_s: string) => 0;",
    test: "tests/vitals-wrong-answers.test.ts",
    filter:
      "vitals: a frozen heartbeat client drives the transport snapshot even when an ungraded socket has a larger gap",
  },
  {
    what:
      "the diag reporter maps any transport alert to disconnect while some other client is frozen so a recovery prints DISCONNECTED",
    file: "src/vitals/diag-reporter.ts",
    find: 'if (alert.layer === "transport" && alert.status === "frozen") {',
    replace:
      'if (alert.layer === "transport" && transport.clients.some((c) => c.status === "frozen")) {',
    test: "tests/vitals-wrong-answers.test.ts",
    filter:
      "vitals: a client's recovery is reported as a recovery while another client is still frozen",
  },
  {
    what:
      "per-layer recovery dedup swallows the second transport client's recovery as a repeat of the first one",
    file: "src/vitals/diag-reporter.ts",
    find: 'if (alert.layer === "transport") {',
    replace: "if (false) {",
    test: "tests/vitals-wrong-answers.test.ts",
    filter:
      "vitals: a client's recovery is reported as a recovery while another client is still frozen",
  },
  {
    what:
      "a disconnect event reports the gap of the first frozen row instead of the client whose freeze raised the alert",
    file: "src/vitals/diag-reporter.ts",
    find: "detail.frozenFor = alert.measured;",
    replace:
      'detail.frozenFor = _transport.clients.find((c) => c.status === "frozen")?.frozenFor;',
    test: "tests/vitals-wrong-answers.test.ts",
    filter:
      "vitals: a disconnect reports the gap of the client that froze, not of whichever frozen client is listed first",
  },
  {
    what:
      "the diag formatter swaps the degraded and warning RTT labels so a 300ms round trip prints warning",
    file: "src/vitals/diag-formatter.ts",
    find: "const t = DEFAULT_THRESHOLDS.transport;",
    replace: "const t = { degraded: 500, warning: 100, frozen: 2000 };",
    test: "tests/vitals-wrong-answers.test.ts",
    filter:
      "vitals: the formatter grades an RTT on the transport tiers (degraded below warning)",
  },
  {
    what:
      "the client transport probe never clears firstDegradedAt so one slow boot round trip stays the degraded start forever",
    file: "src/vitals/transport-probe.ts",
    find: 'if (next === "healthy") firstDegradedAt = null;',
    replace: 'if (next === "healthy") void 0;',
    test: "tests/vitals-wrong-answers.test.ts",
    filter:
      "vitals: client transport firstDegradedAt clears when RTT is healthy again",
  },
  {
    what:
      "the queue saturation hint prints the raw floating drain rate with sixteen digits of fake precision",
    file: "src/vitals/hints.ts",
    find: "const drain = Math.round(snap.loop.drainRate * 10) / 10;",
    replace: "const drain = snap.loop.drainRate;",
    test: "tests/vitals-wrong-answers.test.ts",
    filter: "vitals: the queue-saturation hint prints a readable drain rate",
  },
  {
    what:
      "vitals thresholds.render and custom transport degraded or warning tiers are accepted and silently dropped with no warning",
    file: "src/vitals/mod.ts",
    find: "warnUnreadThresholds(config.thresholds);",
    replace: "void warnUnreadThresholds;",
    test: "tests/vitals-wrong-answers.test.ts",
    filter:
      "vitals: a threshold nothing reads is said out loud, not accepted and dropped",
  },
  {
    what:
      "cost report flags truncated whenever a ring ever wrapped even though the requested window lost no samples",
    file: "src/vitals/cost-meter.ts",
    find: "ring.wrapped && (ring.oldest()?.at ?? Infinity) >= from",
    replace: "ring.wrapped",
    test: "tests/vitals-wrong-answers.test.ts",
    filter:
      "vitals: am cost does not claim dropped samples for a window its wrapped ring still covers",
  },
  {
    what:
      "the standalone/Android runtime never runs a cell's onMigrate, so an APK update that renames a field loses the stored value",
    file: "src/standalone-air.ts",
    find: ".filter((f) => f.__aio.version > 0 || f.__aio.onMigrate)",
    replace: ".filter((f) => f.__aio.version < 0 && !!f.__aio.onMigrate)",
    test: "tests/standalone-migrate-restore.test.ts",
    filter: "standalone restore: onMigrate runs on an older stored shape",
  },
  {
    what:
      "the standalone/Android runtime never runs a cell's per-cell onRestore repair hook on a restored slice",
    file: "src/standalone-air.ts",
    find: "composed.cells.filter((f) => f.__aio.onRestore).map(",
    replace: "composed.cells.filter((f) => f.__aio.onRestore && false).map(",
    test: "tests/standalone-migrate-restore.test.ts",
    filter: "standalone restore: a cell's onRestore repairs its restored slice",
  },
  {
    what:
      "a standalone app-level onRestore that mutates and returns nothing sets the whole state to undefined and crashes boot",
    file: "src/standalone-air.ts",
    find: "const next = config.onRestore(state) as unknown;",
    replace:
      "const next = config.onRestore(state) as unknown;\n      state = next as S;",
    test: "tests/standalone-migrate-restore.test.ts",
    filter:
      "standalone restore: an app onRestore that mutates and returns nothing keeps the state",
  },
  {
    what:
      "a stored cell the standalone build no longer declares is dropped at restore and deleted from the store by the first write",
    file: "src/standalone-air.ts",
    find:
      "if (restorable.has(k) || (declared !== undefined && !(k in declared))) {",
    replace: "if (restorable.has(k)) {",
    test: "tests/standalone-migrate-restore.test.ts",
    filter:
      "standalone restore: a stored cell this build does not declare is preserved",
  },
  {
    what:
      "the standalone version stamp regresses on a downgrade so a later roll-forward reruns onMigrate over migrated data",
    file: "src/standalone-air.ts",
    find: "stamp[c] = Math.max(info.version, stamp[c] ?? 0);",
    replace: "stamp[c] = info.version;",
    test: "tests/standalone-migrate-restore.test.ts",
    filter: "standalone restore: a downgrade keeps the newer build's fields",
  },
  {
    what:
      "a standalone cell's onRestore is not handed what its shaping onPersist stored, so the documented onPersist/onRestore pair loses the value",
    file: "src/standalone-air.ts",
    find: "stored: migratedRaw.get(id) ?? raw[id],",
    replace: "stored: migratedRaw.get(id),",
    test: "tests/standalone-migrate-restore.test.ts",
    filter:
      "standalone restore: onRestore sees what a shaping onPersist stored",
  },
  {
    what:
      "the standalone restore drops a renamed stored field with no version bump in silence, where the server warns",
    file: "src/standalone-air.ts",
    find: "if (drift.length > 0) {\n        console.warn(",
    replace: "if (drift.length < 0) {\n        console.warn(",
    test: "tests/standalone-migrate-restore.test.ts",
    filter:
      "standalone restore: a renamed field with no version bump is said, not dropped in silence",
  },
  {
    what:
      "worker cell host re-runs onInit on every re-seed init message (snapshot load, time travel) and at spawn",
    file: "src/server/cell-worker-host.ts",
    find:
      '      post({ t: "ready", cell: name });\n      return;\n    }\n    if (msg.t === "start") {',
    replace:
      '      post({ t: "ready", cell: name });\n      started = false;\n    }\n    if (msg.t === "start" || msg.t === "init") {',
    test: "tests/worker-reseed-no-reinit.test.ts",
    filter: "worker cell: a re-seed (snapshot load) does not re-run onInit",
  },
  {
    what:
      "main isolate never tells worker cells to start so their onInit never runs once wired",
    file: "src/server/aio.ts",
    find: "        workerPool.start();\n",
    replace: "        void workerPool;\n",
    test: "tests/worker-reseed-no-reinit.test.ts",
    filter: "worker cell: onInit's dispatch at boot lands on the main isolate",
  },
  {
    what:
      "scheduler dispatches a worker cell's scheduled action through the raw main loop, running its method on the main isolate",
    file: "src/server/aio.ts",
    find: "    (action) => appDispatch(action as A),\n",
    replace: "    (action) => dispatch(action as A),\n",
    test: "tests/worker-cell-schedule-routing.test.ts",
    filter:
      "real workers: a scheduled tick runs the worker cell's method in its worker",
  },
  {
    what:
      "a closed worker cell's refusal carries no DISPATCH_CLOSED code so shutdown ticks log ERROR and keep ticking",
    file: "src/server/cell-worker.ts",
    find: '    (err as Error & { code?: string }).code = "DISPATCH_CLOSED";\n',
    replace: "    (err as Error & { code?: string }).code = undefined;\n",
    test: "tests/worker-cell-schedule-routing.test.ts",
    filter:
      "closed worker cell: a tick it refuses during shutdown stops its schedule quietly",
  },
  {
    what:
      "scheduler reads paused time travel's DISPATCH_CLOSED as shutdown and cancels every schedule ticking during a pause",
    file: "src/state/schedule.ts",
    find:
      '      const paused = (e as { reason?: unknown })?.reason === "tt-paused";\n',
    replace:
      '      const paused = (e as { reason?: unknown })?.reason === "tt-paused-x";\n',
    test: "tests/schedule-survives-tt-pause.test.ts",
    filter:
      "schedule: a tick refused by PAUSED time travel keeps the schedule armed",
  },
  {
    what:
      "worker cell calls bypass the paused time travel door so the method runs and its writes are silently dropped",
    file: "src/server/cell-worker-pool.ts",
    find: "      if (opts.isPaused?.()) return dispatchFn(action);\n",
    replace:
      "      if (opts.isPaused?.() && false) return dispatchFn(action);\n",
    test: "tests/worker-cell-tt-paused.test.ts",
    filter:
      "real workers: paused time travel refuses a worker cell's call before it runs",
  },
  {
    what:
      "a one-shot schedule due during paused time travel gives up after three retries with an ERROR",
    file: "src/state/schedule.ts",
    find: "              paused ? retryCount : retryCount + 1,\n",
    replace: "              paused ? retryCount + 1 : retryCount + 1,\n",
    test: "tests/schedule-survives-tt-pause.test.ts",
    filter:
      "schedule: a tick refused by PAUSED time travel keeps the schedule armed",
  },
  {
    what:
      "amui Logs tab of a profile instance tails the default home's log dir instead of the instance's own",
    file: "amui/src/manager.ts",
    find: "          proj.running?.home ?? null,\n",
    replace: "          null,\n",
    test: "tests/amui-multi-instance.test.ts",
    filter:
      "amui Logs tab of a profile instance tails that instance's own log dir",
  },
  {
    what:
      "am state miss hint lists the ROOT keys even when the typo is one level down",
    file: "src/am/am-cmd-state.ts",
    find: "  for (const seg of segs) {",
    replace: "  for (const seg of segs.slice(0, 0)) {",
    test: "tests/am-state-miss-hint.test.ts",
    filter: "am state: a miss names the keys where the path stopped resolving",
  },
  {
    what:
      "outError pretty mode joins a multi-line refusal's lines into one reflowed paragraph",
    file: "src/am/am-output.ts",
    find: '      ? msg.slice(cut).replace(/^(?: +|\\n)/, "").trimEnd()',
    replace: '      ? msg.slice(cut).replace(/\\n/g, " ").trim()',
    test: "tests/am-error-keeps-line-breaks.test.ts",
    filter:
      "am error: a multi-line refusal keeps its line breaks on a terminal",
  },
  {
    what:
      "fmt wrap drops each line's leading indentation so indented examples lose their layout",
    file: "src/diagnostics/fmt.ts",
    find: "    const ind = /^ */.exec(raw)![0];",
    replace: '    const ind = "";',
    test: "tests/am-error-keeps-line-breaks.test.ts",
    filter:
      "fmt wrap: an indented line keeps its indent, continuation lines too",
  },
  {
    what:
      "headless am surface hint teaches am surface 0 though the index is a counter",
    file: "src/am/am-cmd-inspect.ts",
    find: "`am surface (it reads the newest client)`",
    replace: "`am surface 0`",
    test: "tests/docs-no-client-index.test.ts",
    filter: "am's own hints never teach `am surface 0` / `am trigger 0`",
  },
  {
    what:
      "am help logs splits the filter example from its effect, leaving an orphan line",
    file: "src/am/am-help-text.ts",
    find:
      'e.g. "am logs error"\n                          keeps error events\n',
    replace: 'e.g. "am logs error"\n',
    test: "tests/am-help-logs-sentence.test.ts",
    filter:
      "am help logs: the filter example is one sentence, not an orphan line",
  },
  {
    what:
      "am --port naming a sibling profile instance still reaches the default instance's socket",
    file: "src/am/am-http.ts",
    find: "    if (own.length === 1) return own[0]!;",
    replace: "    if (own.length === -1) return own[0]!;",
    test: "tests/am-port-picks-instance.test.ts",
    filter:
      "controlEndpoint: a port that names a sibling instance reaches THAT instance",
  },
  {
    what:
      "no-lock message for a running id lists it twice and never names the profile or home",
    file: "src/am/am-cmd-process.ts",
    find: "    if (same.length > 0) {",
    replace: "    if (same.length > 99) {",
    test: "tests/am-no-lock-names-sibling-homes.test.ts",
    filter: "am: a lock miss on a running id names the homes it runs from",
  },
  {
    what:
      "controlEndpoint ignores the instance pid so zero-port profile calls reach the default socket",
    file: "src/am/am-http.ts",
    find: "    if (hit) return hit;",
    replace: "    if (hit && pid < 0) return hit;",
    test: "tests/amui-profile-uds-target.test.ts",
    filter:
      "controlEndpoint: a pid picks that instance's socket among zero-port siblings",
  },
  {
    what:
      "amui State tab of a zero-port profile instance reads the default instance's state",
    file: "amui/src/manager.ts",
    find: '        trojanGet(port, "state", appId, undefined, pid),',
    replace: '        trojanGet(port, "state", appId),',
    test: "tests/amui-profile-uds-target.test.ts",
    filter:
      "amui talks to a zero-port profile instance on ITS socket, not the default's",
  },
  {
    what:
      "am doctor tells a stale profile instance to restart the default instance instead",
    file: "src/am/am-cmd-doctor.ts",
    find: '      .replace("am stop ", "am restart "),',
    // aio-ok: the literal SOURCE line this mutation patches in and out
    replace: "      .replace(/.*/, `am restart --app=${inst.appId}`),",
    test: "tests/am-doctor.test.ts",
    filter: "doctor: a stale profile instance's fix restarts THAT instance",
  },
  {
    what:
      "the contacts example's update takes id from an untyped patch, so two rows share a primary key and the cell stops persisting",
    file: "examples/contacts/src/cell.ts",
    find: "        id: row.id,",
    replace: "        id: (patch as Partial<Contact>).id ?? row.id,",
    test: "tests/example-contacts.test.ts",
    filter: "an update cannot rewrite a contact's id",
  },
  {
    what:
      "the cli-tool example's own usage refusals ignore --json, printing plain stderr where a script expects parseable JSON",
    file: "examples/cli-tool/src/app.ts",
    find: "fail(msg, { code: EXIT.usage, json: a.json });",
    replace: "fail(msg, { code: EXIT.usage });",
    test: "tests/cli-toolkit-build.test.ts",
    filter: "cli-tool: the example's own usage refusals honour --json",
  },
  {
    what:
      "the updates example's report-a-problem path stops telling the user where the saved report went",
    file: "examples/updates/src/App.tsx",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    find: "? ` Thanks — saved to ${feedback.last.path}.`",
    replace: '? " Thanks."',
    test: "tests/example-updates-ui.test.tsx",
    filter:
      "example updates: a user can report a problem, and is told where it went",
  },
  {
    what:
      "the tutorial teaches the retired cell `ui` filter, which cell() refuses, instead of `visible`",
    file: "docs/basics/tutorial.md",
    find: "Both `persist` and `visible` accept:",
    replace: "Both `persist` and `ui` accept:",
    test: "tests/docs-cell-visible-not-retired-ui.test.ts",
    filter:
      "getting-started docs name the cell filter `visible`, never the retired `ui`",
  },
  {
    what:
      "aiol's untested-cell hint names a bare file with no tests/ directory, steering tests beside the source",
    file: "aiol/checks.ts",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    find: '  return `tests/${rel.replace(/\\.[cm]?[jt]sx?$/, "")}.test.ts`;',
    // aio-ok: the literal SOURCE line this mutation patches in and out
    replace: '  return `${rel.replace(/\\.[cm]?[jt]sx?$/, "")}.test.ts`;',
    test: "tests/aiol-finds-tests-dir.test.ts",
    filter:
      "aiol: the untested-cell hint names the tests/ file that mirrors the cell",
  },
  {
    what:
      "the docs link gate stops walking examples/README.md, so its dead heading links ship unnoticed",
    file: "scripts/check-docs.ts",
    find:
      'for (const rel of ["README.md", "CLAUDE.md", "examples/README.md"]) {',
    replace: 'for (const rel of ["README.md", "CLAUDE.md"]) {',
    test: "tests/docs-truth-gate.test.ts",
    filter: "the examples README is walked, and every link in it lands",
  },
  {
    what:
      "aiol's scattered-cells hint recommends the forbidden src/cells/ spelling and a structure.md page that does not exist",
    file: "aiol/checks.ts",
    find: "consider one src/cell/ directory, one file per cell",
    replace: "consider organizing in a src/cells/ (or src/cell/) directory",
    test: "tests/docs-cell-folder-one-spelling.test.ts",
    filter:
      "aiol's scattered-cells hint names `src/cell/` and a page that exists",
  },
  {
    what:
      "the cookbook puts recipe cells in src/cells/, the folder spelling the structure page forbids",
    file: "docs/basics/cookbook.md",
    find: "// src/cell/tasks.ts\n",
    replace: "// src/cells/tasks.ts\n",
    test: "tests/docs-cell-folder-one-spelling.test.ts",
    filter: "docs spell the cell folder `cell/`, never `cells/`",
  },
  {
    what:
      "concepts.md rule AIO7 teaches returning schedule/own effects from a method, a form refused since alpha76",
    file: "docs/basics/concepts.md",
    find: "(or schedule/own effects handed to `s.$do(…)`)",
    replace: "(or returned schedule/own effects)",
    test: "tests/docs-stale-terms.test.ts",
    filter: "docs never mention removed APIs as if they were current",
  },
  {
    what:
      "a state write from an AIR event handler is caught and never reaches the AIO2 read-only hint",
    file: "src/air/vdom-events.ts",
    find:
      "      // `error` event the read-only hint also listens to.\n      devHooks.readOnlyHint?.(err);\n",
    replace: "      // `error` event the read-only hint also listens to.\n",
    test: "tests/air-readonly-hint-reaches-handler-writes.test.tsx",
    filter:
      "a stray top-level state write from a click handler prints the AIO2 hint",
  },
  {
    what:
      "the read-only hint ignores the getter-only TypeError a top-level cell state write throws",
    file: "src/air/dev-readonly-hint.ts",
    find: "if (!/read.?only|only a getter|getter-only/i.test(msg)) return;",
    replace: "if (!/read.?only|getter-only/i.test(msg)) return;",
    test: "tests/air-readonly-hint-reaches-handler-writes.test.tsx",
    filter:
      "a stray top-level state write from a click handler prints the AIO2 hint",
  },
  {
    what:
      "a non-filter visible value like true dies as a bare in-operator TypeError naming neither cell nor fix",
    file: "src/state/cell-helpers.ts",
    find: "  if (bad?.refused) throw new Error(bad.msg);\n  return v;",
    replace: "  return v;",
    test: "tests/cell-filter-shape-is-named.test.ts",
    filter:
      "visible: a non-filter value is refused naming the cell and the four forms",
  },
  {
    what:
      "a typo'd visible key like exlude is accepted silently and resolves to visible all, leaking every field",
    file: "src/state/cell-helpers.ts",
    find: "if (VISIBLE_KEYS.includes(key)) continue;",
    replace: "if (VISIBLE_KEYS.includes(key) || key.length > 0) continue;",
    test: "tests/cell-filter-shape-is-named.test.ts",
    filter:
      "a typo'd visible key, or a non-filter persist, is warned — naming the fix",
  },
  {
    what:
      "a cell's persist: true kills the boot with a bare in-operator TypeError instead of naming the cell and fix",
    file: "src/server/aio-composition.ts",
    find: "if (bad?.refused) throw new Error(bad.msg);",
    replace: "void bad;",
    test: "tests/cell-filter-shape-is-named.test.ts",
    filter:
      "the boot refuses `persist: true` on a cell naming the cell and the fix",
  },
  {
    what:
      "perf.log prints a queue-depth loop alert's action counts as milliseconds again",
    file: "src/vitals/mod.ts",
    find: 'driver === "queue" ? "actions" : "ms",',
    replace: '"ms",',
    test: "tests/logger-vitals.test.ts",
    filter:
      "vitals: a queue-depth loop alert is written to perf.log in actions, not ms",
  },
  {
    what:
      "the /__aio/vitals queue gauge is drawn against a fixed 1000 capacity instead of the configured frozen threshold",
    file: "src/server/server-static.ts",
    find: "vs.thresholds.queue.frozen,",
    replace: "1000,",
    test: "tests/vitals-dashboard-thresholds.test.ts",
    filter:
      "vitals dashboard: gauge capacities are the configured frozen thresholds",
  },
  {
    what:
      "the /__aio/vitals reduce-time gauge is drawn against a fixed 100ms capacity instead of the configured loop frozen threshold",
    file: "src/server/server-static.ts",
    find: "vs.thresholds.loop.frozen,",
    replace: "100,",
    test: "tests/vitals-dashboard-thresholds.test.ts",
    filter:
      "vitals dashboard: gauge capacities are the configured frozen thresholds",
  },
  {
    what:
      "Table spreads every row into one h() call so a 130k-row table throws RangeError",
    file: "src/ui/mod.ts",
    find: '    : el(\n      "tbody",\n      null,\n      rows.map(',
    replace: '    : h(\n      "tbody",\n      null,\n      ...rows.map(',
    test: "tests/ui-kit-wide-lists.test.ts",
    filter: "ui wide: a 130k-row Table and a 130k-option Select render",
  },
  {
    what:
      "Select spreads every option into one h() call so a 130k-option select throws RangeError",
    file: "src/ui/mod.ts",
    find: "  }, opts);",
    replace: "  }, [h(Fragment, null, ...opts)]);",
    test: "tests/ui-kit-wide-lists.test.ts",
    filter: "ui wide: a 130k-row Table and a 130k-option Select render",
  },
  {
    what:
      "the shared kit spread helper hands any number of children to h() as spread arguments again",
    file: "src/ui/h-spread.ts",
    find: "  if (kids.length <= SPREAD_MAX) return h(tag, props, ...kids);",
    replace: "  if (kids.length >= 0) return h(tag, props, ...kids);",
    test: "tests/ui-kit-wide-lists.test.ts",
    filter: "ui wide: a 130k-row Table and a 130k-option Select render",
  },
  {
    what:
      "every keyed --expose boot warns that URL token auth is insecure while printing its own ?token= share link",
    file: "src/server/aio-lifecycle.ts",
    find:
      '  // No boot-time "?token= is insecure" alarm: aio itself prints the `?token=`',
    replace:
      '  if (expose && token) {\n    log.warn(\n      "token auth via URL query parameter is insecure in expose mode — use an Authorization header instead",\n    );\n  }\n  // No boot-time "?token= is insecure" alarm: aio itself prints the `?token=`',
    test: "tests/boot-bind-report.test.ts",
    filter:
      "boot report: an --expose boot with a key does not call its own ?token= share link insecure",
  },
  {
    what:
      "am dispatch to a client-scoped cell answers unknown cell not booted instead of naming its scope",
    file: "src/server/server-trojan.ts",
    find:
      '          if (getRegisteredCells().get(cell)?.__aio.scope === "client") {',
    replace:
      '          if (getRegisteredCells().get(cell)?.__aio.scope === "server") {',
    test: "tests/trojan-dispatch-validate.test.ts",
    filter:
      "trojan dispatch: a client-scoped cell says it lives in the browser, not 'not booted'",
  },
  {
    what:
      "the --width refusal claims a browser page takes its size from ui width and height",
    file: "src/server/aio-cli.ts",
    find:
      "        ? `A browser tab has no size an app can set — aio.run({ ui: { width, height } }) sizes the Electron window only.`",
    replace:
      "        ? `A browser page takes its size from aio.run({ ui: { width, height } }).`",
    test: "tests/electron-only-flags.test.ts",
    filter: "electron-only: --cdp and --width/--height join the family",
  },
  {
    what:
      "the disk example's up() only climbs POSIX paths, a silent no-op on Windows drive and UNC paths",
    file: "examples/disk/src/cell.ts",
    find:
      '  const cut = Math.max(rest.lastIndexOf("/"), rest.lastIndexOf("\\\\"));',
    replace: '  const cut = rest.lastIndexOf("/");',
    test: "tests/example-disk.test.ts",
    filter: "example disk: parentOf climbs POSIX, drive and UNC paths",
  },
  {
    what:
      "a queue-driven slow alert prints its action count as a reduce time in ms, a queue flood reads as a fast dispatch",
    file: "src/vitals/diag-reporter.ts",
    find: 'slow: unit === "actions"',
    replace: 'slow: unit === "never"',
    test: "tests/vitals-wrong-answers.test.ts",
    filter:
      "vitals: a queue-driven slow alert names its numbers in actions, not ms",
  },
  {
    what:
      "a transport recovery with no disconnect before it is printed as an event, a recovery from nothing",
    file: "src/vitals/diag-reporter.ts",
    find: "if (openDisconnects === 0) return; // no prior degradation",
    replace: "// no prior degradation",
    test: "tests/audit-static-fixes.test.ts",
    filter: "M7: recovery from nothing is still not an event",
  },
  {
    what:
      "the android local-assets step stops warning that a packaged APK never runs app.ts so its aio.run options are silently dropped",
    file: "src/build/build-android.ts",
    find: "  await _warnRunOptions(cfg);\n",
    replace: "  await Promise.resolve(cfg);\n",
    test: "tests/android-run-options-warning.test.ts",
    filter:
      "android build: the local-assets step warns about the scaffold's ui.theme",
  },
  {
    what:
      "a worker cell's $pending keeps counting a concurrency first adopter until the running call it adopted finishes",
    file: "src/server/cell-worker-host.ts",
    find: '    if (id !== undefined) post({ t: "adopted", id });',
    replace: "    if (id !== undefined) void id;",
    test: "tests/worker-pending-policy-parity.test.ts",
    filter: "worker $pending: a REAL worker counts only calls that run",
  },
  {
    what:
      "a worker cell's adopted call is released from $pending twice, hiding another call that is still running",
    file: "src/server/cell-worker-pool.ts",
    find: "      if (released) return; // adopted AND settled — decrement once",
    replace: "      if (released && !type) return;",
    test: "tests/worker-pending-policy-parity.test.ts",
    filter: "worker $pending: a REAL worker counts only calls that run",
  },
  {
    what:
      "an async onInit that rejects is left unobserved, crashing a worker cell's thread and skipping INIT_ERROR",
    file: "src/state/cell-compose-registry.ts",
    find: "          then.call(r, undefined, failed);",
    replace: "          void then;",
    test: "tests/worker-oninit-failures.test.ts",
    filter:
      "worker onInit: a REAL worker survives a rejecting onInit and reports every cell error",
  },
  {
    what:
      "a worker cell's INIT_ERROR and EFFECT_ASYNC_ERROR never reach the app's onError sink on the main isolate",
    file: "src/server/cell-worker.ts",
    find: "        if (deps.reportError) deps.reportError(err);",
    replace: "        if (deps.reportError) void err;",
    test: "tests/worker-oninit-failures.test.ts",
    filter:
      "worker onInit: a REAL worker survives a rejecting onInit and reports every cell error",
  },
  {
    what:
      "the worker pool is not handed the app's error sink so worker cell errors only reach a log line",
    file: "src/server/aio.ts",
    find: "    reportError: (err) => reportAioError(err, _reportOpts),",
    replace: "    reportError: undefined,",
    test: "tests/worker-oninit-failures.test.ts",
    filter:
      "worker onInit: a REAL worker survives a rejecting onInit and reports every cell error",
  },
  {
    what:
      "the cells bridge skips a worker cell's onInit on main even when the pool cannot spawn its worker, so onInit runs nowhere",
    file: "src/server/cell-worker-pool.ts",
    find: "  return hostableEntry(workerEntry ?? Deno.mainModule);",
    replace: '  return workerEntry !== "" || hostableEntry(Deno.mainModule);',
    test: "tests/worker-oninit-failures.test.ts",
    filter:
      "worker onInit: an entry no worker can spawn from still runs onInit (on main)",
  },
  {
    what:
      "the test harness ignores an async onInit that rejects, so a broken boot passes green once the runtime handles it",
    file: "src/testing/test-strict.ts",
    find:
      "          then.call(r, undefined, (e: unknown) => {\n            record({ cell, err: initFailureError(cell, e) });\n          }),",
    replace: "          then.call(r, undefined, (_e: unknown) => {}),",
    test: "tests/harness-oninit-strict.test.tsx",
    filter:
      "bootCells: an async onInit that rejects fails the test at settle()",
  },
  {
    what:
      "the torn-down-runtime refusal names a built-in Promise frame instead of the test line that booted the runtime",
    file: "src/standalone-air.ts",
    find: "|deno\\.land|<anonymous>/;",
    replace: "|deno\\.land/;",
    test: "tests/bootcells-generation-fence.test.ts",
    filter:
      "generation fence: a call a disposed boot started never commits into the next boot, and it is said",
  },
  {
    what:
      "setTotpSecret's invalid-secret error quotes the first 12 characters of the credential",
    file: "src/server/auth-users.ts",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    find: "            `${clean.length} characters` +",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    replace:
      // aio-ok: the literal SOURCE line this mutation patches in and out
      "            `${JSON.stringify(String(secretB32).slice(0, 12))} ${clean.length} characters` +",
    test: "tests/auth-budget-ttl-and-verdicts.test.ts",
    filter: "setTotpSecret: the refusal never quotes the secret's characters",
  },
  {
    what:
      "am reads the control key from the default home instead of the addressed profile instance's home",
    file: "src/am/am-http.ts",
    find: "    const r = readControlKey(appId, home);",
    replace: "    const r = readControlKey(appId);",
    test: "tests/am-creds-follow-instance-home.test.ts",
    filter:
      "am --port: a profile instance is shown ITS OWN control key and app key, over TCP",
  },
  {
    what:
      "am reads the shared app key from the default home instead of the addressed profile instance's home",
    file: "src/am/am-http.ts",
    find: "      const p = appKeyPath(appId, home);",
    replace: "      const p = appKeyPath(appId);",
    test: "tests/am-creds-follow-instance-home.test.ts",
    filter:
      "amui by pid: a zero-port profile instance is shown ITS OWN keys over its socket",
  },
  {
    what:
      "the control target drops the lock's home so credentials come from the default instance",
    file: "src/am/am-http.ts",
    find: "  const home = pf?.home;",
    replace: "  const home = undefined as string | undefined;",
    test: "tests/am-creds-follow-instance-home.test.ts",
    filter:
      "amui by pid: a zero-port profile instance is shown ITS OWN keys over its socket",
  },
  {
    what:
      "controlKeyPath ignores the instance home and names the default home's control key",
    file: "src/server/app-key.ts",
    find: '  return join(appDirs(appId, home).data, "control.key");',
    replace: '  return join(appDirs(appId).data, "control.key");',
    test: "tests/am-creds-follow-instance-home.test.ts",
    filter:
      "am --port: a profile instance is shown ITS OWN control key and app key, over TCP",
  },
  {
    what:
      "dev boot refuses drift that this very declaration's own methods wrote and persisted",
    file: "src/server/aio-boot.ts",
    find:
      "      const structural = allStructural.filter((d) => !selfWritten.includes(d));",
    replace: "      const structural = allStructural;",
    test: "tests/drift-app-written-no-brick.test.ts",
    filter: "shape drift the app itself wrote does not brick the next dev boot",
  },
  {
    what:
      "persistence never stamps the written cell's declared-shape fingerprint beside its slice",
    file: "src/server/persistence.ts",
    find: "        if (fp !== undefined && merged[cell] !== fp) {",
    replace:
      '        if (fp !== undefined && merged[cell] !== fp && cell === "\\u0000") {',
    test: "tests/drift-app-written-no-brick.test.ts",
    filter: "shape drift the app itself wrote does not brick the next dev boot",
  },
  {
    what:
      "shape fingerprint ignores the declaration so a changed declaration no longer refuses",
    file: "src/state/cell-migrate.ts",
    find: '  return (h >>> 0).toString(16).padStart(8, "0");',
    replace: '  return text ? "00000000" : (h >>> 0).toString(16);',
    test: "tests/drift-app-written-no-brick.test.ts",
    filter: "shape drift the app itself wrote does not brick the next dev boot",
  },
  {
    what:
      "am instances LISTENING shows only uds and hides the TCP port of an app with both wires",
    file: "src/am/am-cmd-process.ts",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    find: '        ? (inst.port > 0 ? `:${inst.port} + uds` : "uds")',
    replace: '        ? "uds"',
    test: "tests/am-instances-listening-both-wires.test.ts",
    filter:
      "am instances: LISTENING shows the TCP port AND the socket when an app has both",
  },
  {
    what:
      "a falsy visible/persist warning claims the default all even when cellDefaults fills the absent value",
    file: "src/state/cell-helpers.ts",
    find:
      // aio-ok: the literal SOURCE line this mutation patches in and out
      // aio-ok: the literal SOURCE line this mutation patches in and out
      "`\\`cellDefaults.${kind}\\` if the app sets one, else the default ` +",
    replace: "`the default ` +",
    test: "tests/cell-filter-shape-is-named.test.ts",
    filter:
      "a FALSY visible/persist is read as absent — kept (it booted on 1.0.11), and said",
  },
  {
    what:
      "a standalone store from before version stamps, already in the declared shape, runs onMigrate from v0 and corrupts current data",
    file: "src/standalone-air.ts",
    find:
      "          if (drift.length === 0) {\n            storedVersions[c] = info.version;",
    replace:
      "          if (drift.length < 0) {\n            storedVersions[c] = info.version;",
    test: "tests/standalone-migrate-restore.test.ts",
    filter:
      "standalone restore: a store from before version stamps, already in the declared shape, is not migrated from v0",
  },
  {
    what:
      "a standalone store with no versioned cell omits the __versions marker so a later first version is never migrated",
    file: "src/standalone-air.ts",
    find: "      __versions: stamp,",
    replace:
      "      ...(Object.keys(stamp).length ? { __versions: stamp } : {}),",
    test: "tests/standalone-migrate-restore.test.ts",
    filter:
      "standalone restore: a stamped store with no versioned cell still migrates a cell's first version",
  },
  {
    what:
      "a regex literal holding a quote in app.ts hides the aio.run call so the android build warns about nothing",
    file: "src/build/android-run-options.ts",
    find: '} else if (c === "/" && regexMayStart(out)) {',
    replace: '} else if (c === "/" && out.length < 0 && regexMayStart(out)) {',
    test: "tests/android-run-options-warning.test.ts",
    filter:
      "android run options: a regex literal holding a quote does not hide the call",
  },
  {
    what:
      "an async onInit that rejects after the harness boot is recorded where nothing reads it, so the test passes green",
    file: "src/testing/test-strict.ts",
    find: "      sink = (f) => ledger.adopt(f);",
    replace: "      sink = undefined;",
    test: "tests/harness-oninit-strict.test.tsx",
    filter:
      "bootCells: an async onInit that rejects after the boot still fails the test",
  },
  {
    what:
      "the AIO2 read-only hint knows only V8 wording so Firefox and Safari writes print no hint",
    file: "src/air/dev-readonly-hint.ts",
    find: "/read.?only|only a getter|getter-only/i",
    replace: "/read.only|which has only a getter/i",
    test: "tests/air-readonly-hint-reaches-handler-writes.test.tsx",
    filter: "the AIO2 hint recognises every engine's read-only write error",
  },
  {
    what:
      "a snapshot load keeps this build's shape stamp on a drifted slice, so the next dev boot calls a stale renamed field app-written and drops it instead of refusing",
    file: "src/server/aio-run-helpers.ts",
    find: "if (foreign.length) refs.persistence.unstampShapes?.(foreign);",
    replace: "void foreign;",
    test: "tests/drift-app-written-no-brick.test.ts",
    filter:
      "a snapshot loaded from another declaration still refuses the next dev boot",
  },
  {
    what:
      "a snapshot load stops adding the shape stamp but leaves the one an earlier write left, so a stale field still reads app-written",
    file: "src/server/persistence.ts",
    find: "            delete merged[cell];\n            nextShapes = merged;",
    replace: "            void merged;",
    test: "tests/drift-app-written-no-brick.test.ts",
    filter:
      "a snapshot loaded from another declaration still refuses the next dev boot",
  },
  {
    what:
      "a pid naming no live instance falls back to the default instance's socket, so Stop on a dead profile row shuts down its sibling",
    file: "src/am/am-http.ts",
    find: "  if (pid !== undefined) return null;\n  return liveLock(appId);",
    replace: "  return liveLock(appId);",
    test: "tests/amui-profile-uds-target.test.ts",
    filter:
      "controlEndpoint: a pid that names no live instance never falls back to a sibling's socket",
  },
  {
    what:
      "amui stop falls back to SIGTERM on a bare pid no live lock holds, killing whatever unrelated process reused it",
    file: "amui/src/server/proc.server.ts",
    find: "  if (!instances(appId).some((i) => i.alive && i.pid === pid)) {",
    replace: "  if (!instances(appId).some((i) => i.alive) && false) {",
    test: "tests/amui-profile-uds-target.test.ts",
    filter: "amui stop never signals a pid no live instance of the app holds",
  },
  {
    what:
      "an exposed sessions-only app is not counted as per-user auth, so a stale shared app.key is never cleared and dead keys get advertised",
    file: "src/server/aio.ts",
    find: "const _perUserAuth = !!users || !!_resolveUser || !!sessionStore;",
    replace: "const _perUserAuth = !!users || !!_resolveUser || authEnabled;",
    test: "tests/auth-sessions-only-expose-key.test.ts",
    filter: "sessions-only app clears a stale shared key like users mode does",
  },
  {
    what:
      "an explicit key on an exposed sessions-only app is resolved and advertised by share link and pair code although it can only 401",
    file: "src/server/aio.ts",
    find: "(expose && !users && !_resolveUser && !_sessionsOnly)",
    replace: "(expose && !users && !_resolveUser)",
    test: "tests/auth-sessions-only-expose-key.test.ts",
    filter:
      "sessions-only app ignores an explicit key instead of advertising it",
  },
  {
    what:
      "the TLS control listener ignores the local control credential so am gets 401 on exposed per-user apps",
    file: "src/server/server.ts",
    find:
      "url.pathname.startsWith(TROJAN_PREFIX) && localControlAuthorized(req)",
    replace:
      "url.pathname.startsWith(TROJAN_PREFIX) && localControlAuthorized(undefined)",
    test: "tests/tls-control-listener-local-control.test.ts",
    filter:
      "control listener (TLS): the local control credential opens the trojan on a per-user app",
  },
  {
    what:
      "am auth revoke passes the raw operator spelling to revokeUser so a padded id revokes zero sessions",
    file: "src/am/am-cmd-auth.ts",
    find: "const n = sessionStore().revokeUser(rec!.id);",
    replace: "const n = sessionStore().revokeUser(id!);",
    test: "tests/am-auth-revoke-normalized-id.test.ts",
    filter: "am auth revoke: a padded id revokes the account's sessions",
  },
  {
    what: "2FA step refunds its work unit on success",
    file: "src/server/auth-flows.ts",
    find:
      "        refundAuthWork(clientKey);\n        return issueSession({ id: rec.id, role: rec.role });",
    replace: "        return issueSession({ id: rec.id, role: rec.role });",
    test: "tests/auth-successful-steps-refund-work.test.ts",
    filter: "auth work meter: a successful second-factor step refunds its unit",
  },
  {
    what: "password change refunds its work unit on success",
    file: "src/server/auth-flows.ts",
    find:
      "      refundAuthWork(clientKey);\n      try {\n        await cfg.users.setPassword",
    replace: "      try {\n        await cfg.users.setPassword",
    test: "tests/auth-successful-steps-refund-work.test.ts",
    filter: "auth work meter: a successful password change refunds its unit",
  },
  {
    what: "TOTP enable refunds its work unit on success",
    file: "src/server/auth-flows.ts",
    find:
      "      refundAuthWork(clientKey);\n      log.warn(`[aio] auth: TOTP enabled",
    replace: "      log.warn(`[aio] auth: TOTP enabled",
    test: "tests/auth-successful-steps-refund-work.test.ts",
    filter:
      "auth work meter: successful TOTP enable and disable refund their units",
  },
  {
    what: "TOTP disable refunds its work unit on success",
    file: "src/server/auth-flows.ts",
    find:
      "        refundAuthWork(clientKey); // a correct password (see `login`)",
    replace: "        // mutated",
    test: "tests/auth-successful-steps-refund-work.test.ts",
    filter:
      "auth work meter: successful TOTP enable and disable refund their units",
  },
  {
    what:
      "a restarted server's new boot id reloads the page at once, discarding every offline-queued call still paced or unsent",
    file: "src/browser/browser-air-transport.ts",
    find:
      "if (handleControlFrame(f, _bootId, _protoMismatch, _reloadWhenDrained)) {",
    replace: "if (handleControlFrame(f, _bootId, _protoMismatch)) {",
    test: "tests/air-boot-reload-waits-for-queue.test.ts",
    filter:
      "boot reload after a server restart waits until the replayed offline queue has landed",
  },
  {
    what:
      "the IPC connect watchdog bails once the page ever connected, so an unanswered reconnect never retries",
    file: "src/browser/browser-air-transport.ts",
    find: "    if (_closed || _ipcOpen) return;",
    replace: "    if (_closed || _wasConnected) return;",
    test: "tests/ipc-watchdog-guards-reconnects.test.ts",
    filter:
      "air transport: the IPC watchdog retries an unanswered RECONNECT, not only the first connect",
  },
  {
    what:
      "a 1008 close for a revoked session is reported as a message-budget breach telling devs to raise wsLimits",
    file: "src/browser/browser-air-transport.ts",
    find: "        hint: revoked\n",
    replace: "        hint: false\n",
    test: "tests/air-1008-names-the-real-reason.test.ts",
    filter:
      "browser transport: a 1008 'session revoked' close is not reported as a message-budget breach",
  },
  {
    what:
      "am sql read-only guard scans the query through the SQL lexer, so a -- or /* inside a string literal cannot hide a DELETE",
    file: "src/server/server-trojan.ts",
    find: "const scrubbed = maskSql(query, true);",
    replace:
      "const scrubbed = query.replace(/--[^\\n]*/g, \"\").replace(/\\/\\*[\\s\\S]*?\\*\\//g, \"\").replace(/'(?:[^']|'')*'/g, \"''\");",
    test: "tests/am-sql-read-only-lexer.test.ts",
    filter:
      "am sql: a `--` inside a string literal cannot smuggle a write past the read-only guard",
  },
  {
    what:
      "the trigger-body lexer reads whole identifiers so end_at or case_no columns are not taken for END or CASE keywords",
    file: "src/db/async-db.ts",
    find:
      "if (!/[A-Za-z_]/.test(c)) continue;\n    let j = i;\n    while (j < sql.length && /[\\w$]/.test(sql[j]!)) j++;",
    replace:
      "if (!/[A-Za-z]/.test(c)) continue;\n    let j = i;\n    while (j < sql.length && /[A-Za-z]/.test(sql[j]!)) j++;",
    test: "tests/db-one-statement-per-entry.test.ts",
    filter:
      "db: a trigger touching end_*/case_*/begin_* columns is ONE statement",
  },
  {
    what:
      "a callback transaction whose own BEGIN was refused never sends ROLLBACK, which would undo the app's open transaction",
    file: "src/db/async-db.ts",
    find: "if (begun) {",
    replace: "if (true) {",
    test: "tests/db-callback-tx-foreign-begin.test.ts",
    filter:
      "db: a callback transaction whose BEGIN is refused never rolls back the transaction already open",
  },
  {
    what:
      "boot schema reconcile warns when a declared db column type differs from the stored column affinity",
    file: "src/db/state-sync.ts",
    find: "if (_affinity(stored.type) === _affinity(want)) continue;",
    replace: 'if (_affinity(stored.type) !== "") continue;',
    test: "tests/db-retyped-column-warns.test.ts",
    filter:
      "db schema: a column retyped between runs is named at boot, not coerced in silence",
  },
  {
    what:
      "disabling a worker cell runs onDestroy and the state reset on the main isolate copy only, leaving the worker copy stale",
    file: "src/state/cell-compose-registry.ts",
    find: "if (f && remote?.owns(name)) {",
    replace: "if (f && remote?.owns(name) && Math.random() > 2) {",
    test: "tests/worker-disable-lifecycle.test.ts",
    filter:
      "worker disable/enable: lifecycle runs in the worker, same results as main",
  },
  {
    what:
      "enabling a worker cell runs its onInit on the main isolate instead of in the worker that owns it",
    file: "src/state/cell-compose-registry.ts",
    find: "if (remote?.owns(name)) {\n          remote.enable(name);",
    replace:
      "if (remote?.owns(name) && Math.random() > 2) {\n          remote.enable(name);",
    test: "tests/worker-disable-lifecycle.test.ts",
    filter:
      "worker disable/enable: lifecycle runs in the worker, same results as main",
  },
  {
    what:
      "a worker cell's lifecycle init and destroy actions are posted to the worker, so a restart's late reset wipes onInit",
    file: "src/server/cell-worker-pool.ts",
    find:
      "if (!owner || lifecycleTypes.has(action.type)) return dispatchFn(action);",
    replace:
      "if (!owner || (false && lifecycleTypes.has(action.type))) return dispatchFn(action);",
    test: "tests/worker-disable-lifecycle.test.ts",
    filter:
      "worker disable/enable: lifecycle runs in the worker, same results as main",
  },
  {
    what:
      "the sync engine drops any broadcast under its own session prefix as its echo, so a forged op under that prefix never reaches its screen",
    file: "src/sync/sync-engine.ts",
    find: "      if (_issuedIds.has(op.id)) {",
    replace: "      if (isOwnSessionOp(op.id)) {",
    test: "tests/sync/session-prefix-bound.test.ts",
    filter:
      "an op frame under a connected client's session prefix reaches that client's screen",
  },
  {
    what:
      "the server catch-up omits every op under the requester's session prefix, including ones another connection submitted while it was away",
    file: "src/sync/server-handler.ts",
    find: "? o.id.startsWith(ownPrefix) && !_foreign.has(o.id)",
    replace: "? o.id.startsWith(ownPrefix)",
    test: "tests/sync/session-prefix-bound.test.ts",
    filter:
      "an op under a disconnected client's session prefix reaches that client's catch-up",
  },
  {
    what:
      "an op frame taken from another connection under a bound session prefix is not marked foreign, so the owner's catch-up omits it",
    file: "src/sync/server-handler.ts",
    find: "if (serverTs !== null && sessionOwnedElsewhere(op.id, socket)) {",
    replace: "if (serverTs !== null && false) {",
    test: "tests/sync/session-prefix-bound.test.ts",
    filter:
      "an op frame under a disconnected client's session prefix reaches that client's catch-up",
  },
  {
    what:
      "any connection announcing a public session nonce takes over its binding without the session's private key",
    file: "src/sync/server-handler.ts",
    find: "if (held === undefined || held.key === key) {",
    replace: 'if (held === undefined || held.key !== "") {',
    test: "tests/sync/session-prefix-bound.test.ts",
    filter:
      "an op under a disconnected client's session prefix reaches that client's catch-up",
  },
  {
    what:
      "a subscription naming a cell id the server does not have is accepted in silence and yields an empty view",
    file: "src/protocol/broadcast-utils.ts",
    find: "if (known.has(id) || _unknownSubsSaid.has(id)) continue;",
    replace: "if (true) continue;",
    test: "tests/ws-subs-unknown-cell-warns.test.ts",
    filter:
      "ws: a subscription to an unknown cell id is warned once, naming the known ids",
  },
  {
    what:
      "the unknown subscription id warning repeats for every client that sends the same typo'd cell id",
    file: "src/protocol/broadcast-utils.ts",
    find: "if (known.has(id) || _unknownSubsSaid.has(id)) continue;",
    replace: "if (known.has(id)) continue;",
    test: "tests/ws-subs-unknown-cell-warns.test.ts",
    filter:
      "ws: a subscription to an unknown cell id is warned once, naming the known ids",
  },
  {
    what:
      "a UDS client subscription to an unknown cell id is accepted in silence while the WS path warns",
    file: "src/server/uds.ts",
    find: 'warnUnknownSubs(parsed, knownSubIds(), "uds");',
    replace: "void parsed;",
    test: "tests/ws-subs-unknown-cell-warns.test.ts",
    filter:
      "uds: a subscription to an unknown cell id is warned, naming the known ids",
  },
  {
    what:
      "dev reload socket reloads immediately on a new boot id, discarding the offline queue a restart replays",
    file: "src/server/server-html-scripts.ts",
    find: "typeof window.__aioReloadWhenDrained === 'function' ? ",
    replace: "false ? ",
    test: "tests/air-dev-boot-reload-waits-for-queue.test.ts",
    filter:
      "dev reload socket waits for the offline queue before reloading on a new boot id",
  },
  {
    what:
      "a tab whose session was revoked keeps reconnecting with the dead credential and never shows signed out",
    file: "src/browser/browser-air-transport.ts",
    find: "        if (out) _signedOut();",
    replace: "        if (out && false) _signedOut();",
    test: "tests/air-revoked-session-stops-reconnecting.test.ts",
    filter: "revoked session: the tab stops reconnecting and shows signed out",
  },
  {
    what:
      "a testUI seed of an undeclared key throws again instead of warning, refusing input that mounted on 1.0.11",
    file: "src/testing/ui-test.ts",
    find: "          console.warn(\n            `[aio] seed: cell",
    replace: "          throw new Error(\n            `[aio] seed: cell",
    test: "tests/testui-seed-optional-key.test.tsx",
    filter:
      "seed: an undeclared optional key still mounts, warning with `key: undefined` as the fix",
  },
  {
    what:
      "a plain range value is written before its signal-bound min/max/step so the browser clamps it to the default bounds",
    file: "src/air/vdom-props.ts",
    find:
      '      if (k === "value" && el.tagName === "INPUT") {\n        for (const b of _INPUT_BOUNDS) {',
    replace:
      '      if (k === "value" && el.tagName === "NOPE") {\n        for (const b of _INPUT_BOUNDS) {',
    test: "tests/air-range-value-after-bounds.test.ts",
    filter: "a range input's value lands after SIGNAL-bound min/max/step too",
  },
  {
    what:
      "a signal-bound range value binds before a signal-bound max in source order and mounts clamped to 100",
    file: "src/air/signal-binding.ts",
    find:
      '  if (el.tagName === "INPUT") {\n    const vi = entries.findIndex(([k]) => k === "value");',
    replace:
      '  if (el.tagName === "NOPE") {\n    const vi = entries.findIndex(([k]) => k === "value");',
    test: "tests/air-range-value-after-bounds.test.ts",
    filter: "a range input's value lands after SIGNAL-bound min/max/step too",
  },
  {
    what:
      "an aliased import { aio as app } hides app.run options from the android APK warning scan",
    file: "src/build/android-run-options.ts",
    find: '      if (a[1]) names.push(a[1].replace(/\\$/g, "\\\\$"));',
    replace: "      if (a[1] && !a[1]) names.push(a[1]);",
    test: "tests/android-run-options-warning.test.ts",
    filter: "android run options: an aliased aio import is still read",
  },
  {
    what:
      "a keepAlive remount ignores the page the last guest browsed to and restarts at src",
    file: "src/ui/browser.ts",
    find: "    navigate(wv, kept.at);",
    replace: "    navigate(wv, kept.src);",
    test: "tests/ui-browser.test.ts",
    filter:
      "keepAlive: a remount opens the page the last guest was on, and nothing is moved or hidden",
  },
  {
    what:
      "removeDom calls removeChild after an action teardown moved the element, aborting the rest of the render",
    file: "src/air/vdom-remove.ts",
    find:
      "    if (isChildOf(dom, parent)) parent.removeChild(dom);\n  } else if (",
    replace: "    parent.removeChild(dom);\n  } else if (",
    test: "tests/air-remove-detached-teardown.test.ts",
    filter:
      "removeDom: an action teardown that moves its element does not abort the render",
  },
  {
    what:
      "a one-shot schedule whose sync method throws is re-run by the refusal retry three more times",
    file: "src/state/schedule.ts",
    find: '      if (code === "REDUCE_ERROR") {',
    replace: '      if (code === "REDUCE_ERROR_MUTANT") {',
    test: "tests/schedule-oneshot-method-throw.test.ts",
    filter:
      "schedule: a one-shot whose method throws runs it once, sync or async",
  },
  {
    what:
      "an async onInit still pending at harness teardown is never tracked so its late rejection goes unseen",
    file: "src/testing/test-strict.ts",
    find:
      // aio-ok: the literal SOURCE line this mutation patches in and out
      "      for (const [p, cell] of running) ledger.track(`${cell}.onInit()`, p);",
    replace: "      for (const [p, cell] of running) void [p, cell];",
    test: "tests/harness-oninit-strict.test.tsx",
    filter:
      "bootCells: an async onInit still pending at `await using` teardown fails the test",
  },
  {
    what:
      "testUI dispose no longer waits for a pending async onInit so its rejection is lost",
    file: "src/testing/test-strict.ts",
    find:
      // aio-ok: the literal SOURCE line this mutation patches in and out
      "      for (const [p, cell] of running) ledger.track(`${cell}.onInit()`, p);",
    replace: "      for (const [p, cell] of running) void [p, cell];",
    test: "tests/harness-oninit-strict.test.tsx",
    filter: "testUI: an async onInit still pending at dispose() fails the test",
  },
  {
    what:
      "a real worker cell's sync method throw is not counted toward the app circuit breaker",
    file: "src/server/cell-worker.ts",
    find: '        if (msg.code === "REDUCE_ERROR") deps.countError?.();',
    replace:
      '        if (msg.code === "REDUCE_ERROR_MUTANT") deps.countError?.();',
    test: "tests/worker-circuit-breaker.test.ts",
    filter:
      "worker circuitBreaker: a real worker cell trips like the in-isolate one",
  },
  {
    what:
      "a real worker cell's async method rejection is not counted toward the app circuit breaker",
    file: "src/server/cell-worker.ts",
    find: '  "EFFECT_ASYNC_ERROR",\n]);',
    replace: '  "EFFECT_ASYNC_ERROR_MUTANT",\n]);',
    test: "tests/worker-circuit-breaker.test.ts",
    filter:
      "worker circuitBreaker: a real worker cell trips like the in-isolate one",
  },
  {
    what:
      "a self re-render inside a Portal wires its click handlers to the mount root, so portal clicks die",
    file: "src/air/renderer-rerender.ts",
    find: "    _setDelegationRoot(inst._delegationRoot);",
    replace: "    void inst._delegationRoot;",
    test: "tests/air-portal-self-rerender-events.test.ts",
    filter:
      "a stateful component inside a Portal keeps its click handlers across self re-renders",
  },
  {
    what:
      "a style object value ending in !important is passed to setProperty as the value and silently dropped",
    file: "src/air/prop-write.ts",
    find: "  const m = /\\s*!\\s*important\\s*$/i.exec(value);",
    replace: "  const m = null as RegExpExecArray | null;",
    test: "tests/air-style-important.test.ts",
    filter:
      "a style object value ending in !important is applied on mount, diff and signal paths",
  },
  {
    what:
      "a select whose value prop is removed is set to empty and shows blank instead of its default option",
    file: "src/air/vdom-props.ts",
    find: '    if ("value" in prev) _resetSelect(el as HTMLSelectElement);',
    replace: '    if ("value" in prev) (el as HTMLSelectElement).value = "";',
    test: "tests/air-select-value-removed.test.ts",
    filter:
      "removing a select's value prop restores the default selection a fresh render shows",
  },
  {
    what:
      "the select reset ignores an option selected through its selected prop and picks the first option",
    file: "src/air/prop-write.ts",
    find: "  return o.defaultSelected || _selectedByProp.has(o);",
    replace: "  return o.defaultSelected;",
    test: "tests/air-select-value-removed.test.ts",
    filter:
      "removing a select's value prop restores the default selection a fresh render shows",
  },
  {
    what:
      "an input's value prop is written before its max prop so a range value is clamped",
    file: "src/air/vdom-props.ts",
    find: "    if (vi >= 0) entries.push(entries.splice(vi, 1)[0]!);",
    replace: "    if (vi < 0) entries.push(entries.splice(vi, 1)[0]!);",
    test: "tests/air-range-value-after-bounds.test.ts",
    filter:
      "a range input's value is written after its min/max/step on mount and diff",
  },
  {
    what:
      "SSR emits pre and textarea content starting with a newline unchanged so the parser drops it",
    file: "src/air/ssr-utils.ts",
    find: '    ? "\\n" + content',
    replace: "    ? content",
    test: "tests/air-ssr-pre-leading-newline.test.ts",
    filter:
      "SSR doubles the leading newline of pre and textarea content for the parser to drop",
  },
  {
    what:
      "a mounting portal appends children after a nested same-target portal so the two regions interleave",
    file: "src/air/vdom-render.ts",
    find: "          if (childDom) target.insertBefore(childDom, end);",
    replace: "          if (childDom) target.appendChild(childDom);",
    test: "tests/air-nested-portal-same-target.test.ts",
    filter:
      "nested same-target portals never interleave — updates land in place and unmount leaves nothing",
  },
  {
    what:
      "a portal diff appends new tail children after a nested same-target portal it just created",
    file: "src/air/vdom-diff.ts",
    find: "      if (anchor) {\n        let total = 0;",
    replace:
      "      if (anchor && ov.children.length < 0) {\n        let total = 0;",
    test: "tests/air-nested-portal-same-target.test.ts",
    filter:
      "nested same-target portals never interleave — updates land in place and unmount leaves nothing",
  },
  {
    what:
      "a portal moved to a new target appends children after a nested same-target portal, interleaving regions",
    file: "src/air/vdom-diff.ts",
    find: "      if (dom) target.insertBefore(dom, end);",
    replace: "      if (dom) target.appendChild(dom);",
    test: "tests/air-nested-portal-same-target.test.ts",
    filter:
      "nested same-target portals never interleave — updates land in place and unmount leaves nothing",
  },
  {
    what:
      "a virtual list with overscan 0 drops the partly visible bottom row when scrolled off a boundary",
    file: "src/air/virtual-list.ts",
    find:
      "      ((scrollTop % safeItemHeight) + containerHeight) / safeItemHeight,",
    replace: "      containerHeight / safeItemHeight,",
    test: "tests/virtual-list.test.ts",
    filter:
      "virtualList: overscan 0 renders the partly visible bottom row when scrolled off a row boundary",
  },
  {
    what:
      "the dev static server serves a module that imports the aio/server-only marker, source and secrets included",
    file: "src/server/server-static.ts",
    find: "if (DEV_MODULE.has(ext) && _declaresServerOnly(body)) {",
    replace: 'if (DEV_MODULE.has(ext) && _declaresServerOnly("")) {',
    test: "tests/static-server-only-marker.test.ts",
    filter:
      "static: a module marked aio/server-only is a 404, like *.server.ts",
  },
  {
    what:
      "a write method that matches no route gets the static file or the app shell with 200 instead of 405",
    file: "src/server/server-static.ts",
    find: '    if (method === "GET" || method === "HEAD") return null;',
    replace:
      '    if (method === "GET" || method === "HEAD" || method) return null;',
    test: "tests/static-write-method-405.test.ts",
    filter:
      "static: POST/PUT/DELETE to a file or a client route is 405, GET/HEAD unchanged",
  },
  {
    what:
      "an oversized websocket frame whose JSON has spaces after colons is dropped without settling its caller's ack",
    file: "src/server/server-ws.ts",
    find: '  const _CID_RE = /"cid"\\s*:\\s*"([A-Za-z0-9._:-]{1,64})"/;',
    replace: '  const _CID_RE = /"cid":"([A-Za-z0-9._:-]{1,64})"/;',
    test: "tests/ws-dropped-frame-settles-call.test.ts",
    filter:
      "ws: an oversized frame from a peer that spaces its JSON still settles its caller",
  },
  {
    what:
      "a route key containing ? or # booted silently though it can never match any request",
    file: "src/server/server.ts",
    find: 'if (key.includes("?") || key.includes("#")) {',
    replace: 'if (key.includes("\\u0000")) {',
    test: "tests/route-key-query-warns.test.ts",
    filter: "routes: a key with ? or # warns at boot that it can never match",
  },
  {
    what:
      "a foreign unshift during an await silently re-addresses a held row, so the method's write lands on a different row",
    file: "src/state/cell-impl.ts",
    find: "      if (moved !== null) _stale.log.push({ p: key, moved });",
    replace: "      if (moved !== null) void key;",
    test: "tests/proxy-foreign-move.test.ts",
    filter:
      "foreign move: a row held across an await is refused after another action's unshift",
  },
  {
    what:
      "the method's own write-set commit is judged as a foreign commit, refusing a row fetched after its own overwrite",
    file: "src/state/cell-impl.ts",
    find: "      _stale.seen = now === _stale.seen ? NOT_SEEN : now;",
    replace: "      void now;",
    test: "tests/proxy-foreign-move.test.ts",
    filter:
      "foreign move: a row fetched after the method's own overwrite stays valid",
  },
  {
    what:
      "a held row still sitting in its own slot is refused because some other rows of the array moved",
    file: "src/state/cell-impl.ts",
    find: "        a[i] !== b[i] &&\n",
    replace: "",
    test: "tests/proxy-foreign-move.test.ts",
    filter: "foreign move: random foreign programs never redirect a held write",
  },
  {
    what:
      "the lowest re-addressed slot ignores a row's old index, so a row moved away from the held slot goes unnoticed",
    file: "src/state/cell-impl.ts",
    find: "    if (k !== undefined) low = Math.min(low, j, k);",
    replace: "    if (k !== undefined) low = Math.min(low, j);",
    test: "tests/proxy-foreign-move.test.ts",
    filter: "foreign move: random foreign programs never redirect a held write",
  },
  {
    what:
      "op ids are a bare counter again so a peer can pre-empt this client's next id and the server dedup swallows its acked write",
    file: "src/sync/sync-engine.ts",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    find: '}.${randomUuid().replaceAll("-", "").slice(0, 12)}`;',
    replace: "}`;",
    test: "tests/sync/op-id-unguessable.test.ts",
    filter:
      "a peer cannot pre-empt this client's next op id and swallow its write",
  },
  {
    what:
      "ops arriving through sync-req pendingOps are never compacted so the op-log grows past compactOps forever",
    file: "src/sync/server-handler.ts",
    find: "                await tryCompact(pending.cell);\n",
    replace: "",
    test: "tests/sync/pending-ops-compact.test.ts",
    filter:
      "ops flushed through sync-req pendingOps are compacted past compactOps",
  },
  {
    what:
      "a multi-statement db.transaction batch entry runs as 1.0.11 did but the dropped statements are warned once, naming the entry",
    file: "src/db/async-db.ts",
    find:
      "            n > 1 && _multiEntrySaid.size < 100 && !_multiEntrySaid.has(s.sql)",
    replace:
      "            n > 99 && _multiEntrySaid.size < 100 && !_multiEntrySaid.has(s.sql)",
    test: "tests/db-one-statement-per-entry.test.ts",
    filter:
      "db: a transaction entry holding two statements runs as 1.0.11 did, and says what it dropped",
  },
  {
    what:
      "a page reading only client-scope cells sends no subs frame and stays on the wildcard, streaming every server delta",
    file: "src/state/cell-reactive.ts",
    find:
      'trackPath(def.__aio.scope === "client" ? CLIENT_ONLY_SUB : def.__aio.id);',
    replace: 'if (def.__aio.scope !== "client") trackPath(def.__aio.id);',
    test: "tests/ws-subs-unknown-cell-warns.test.ts",
    filter:
      "client: a page reading only client-scope cells subscribes to no server cell, silently",
  },
  {
    what:
      "reading a scope client cell subscribes the server to an id it never has, tripping the unknown-cell warning",
    file: "src/state/cell-reactive.ts",
    find:
      'trackPath(def.__aio.scope === "client" ? CLIENT_ONLY_SUB : def.__aio.id);',
    replace: "trackPath(def.__aio.id);",
    test: "tests/ws-subs-unknown-cell-warns.test.ts",
    filter:
      "client: reading a client-scope cell does not subscribe the server to it",
  },
  {
    what:
      "testUI seed with a key the cell does not have lands silently so the fixture looks pinned and pins nothing",
    file: "src/testing/ui-test.ts",
    find: "if (bad.length > 0) {",
    replace: "if (bad.length < 0) {",
    test: "tests/testui-named-opts.test.tsx",
    filter: "seed: an unknown key is warned, at mount and mid-test",
  },
  {
    what:
      "a browser POST navigation to a client route (payment return URL, form_post) gets a 405 page instead of the 1.0.11 shell",
    file: "src/server/server-static.ts",
    find: '      : mode === "navigate";',
    replace: '      : mode === "navigate-x";',
    test: "tests/static-write-method-405.test.ts",
    filter:
      "static: a POST navigation to a client route still gets the shell (1.0.11), a fetch POST stays 405",
  },
  {
    what:
      "a signed-out tab keeps presenting the refused URL token after a cookie sign-in and never reconnects",
    file: "src/browser/browser-shared.ts",
    find: "  if (tokenParam === _refusedUrlToken) tokenParam = null;",
    replace:
      "  if (tokenParam === _refusedUrlToken && false) tokenParam = null;",
    test: "tests/air-revoked-session-stops-reconnecting.test.ts",
    filter: "revoked session: the tab stops reconnecting and shows signed out",
  },
  {
    what:
      "a signed-out tab ignores a sign-in made in another tab and stays signed out when focused again",
    file: "src/browser/browser-air-transport.ts",
    find: '  globalThis.addEventListener?.("focus", onFocus);',
    replace: '  globalThis.addEventListener?.("focus-x", onFocus);',
    test: "tests/air-signed-out-resumes-on-focus.test.ts",
    filter:
      "revoked session: a sign-in in another tab resumes this one when it is focused",
  },
  {
    what:
      "a circuit breaker trip is reported as an anonymous EFFECT_ERROR so its tip is the wrong sync-effect advice",
    file: "src/state/cell-compose-registry.ts",
    find: "{ name: CIRCUIT_BREAKER_TRIP },",
    replace: '{ name: "Error" },',
    test: "tests/circuit-breaker-trip-tip.test.ts",
    filter:
      "circuit breaker trip: its own truthful tip, not the sync-effect one",
  },
  {
    what:
      "a db write rejected by requestTimeoutMs no longer warns that it may still commit, inviting double writes",
    file: "src/db/async-db.ts",
    find: 'const mayCommit = msg.type === "open"',
    replace: 'const mayCommit = msg.type !== "open"',
    test: "tests/db-timeout-may-commit.test.ts",
    filter:
      "db timeout: a timed-out write says it may still commit — and it does",
  },
  {
    what:
      "the dev reload socket keeps retrying with the dead token after sign-out, charging the failed-auth budget",
    file: "src/server/server-html-scripts.ts",
    find: "_devOut = true; clearTimeout(_devT);",
    replace: "_devOut = true;",
    test: "tests/dev-ws-signed-out-stops.test.ts",
    filter:
      "dev reload socket: stops presenting a dead token once signed out, resumes on sign-in",
  },
  {
    what:
      "after sign-in the dev reload socket re-presents the refused URL token and is charged again",
    file: "src/server/server-html-scripts.ts",
    find: "if (_tk === _deadTk) _tk = null",
    replace: "if (_tk === _deadTk) _tk = _tk",
    test: "tests/dev-ws-signed-out-stops.test.ts",
    filter:
      "dev reload socket: after sign-in it never re-presents the refused URL token",
  },
  {
    what:
      "the transport never announces signed-out so the dev reload socket keeps retrying the dead token",
    file: "src/browser/browser-air-transport.ts",
    find: "globalThis.dispatchEvent?.(new Event(SIGNED_OUT_EVENT));",
    replace: "void SIGNED_OUT_EVENT;",
    test: "tests/dev-ws-signed-out-stops.test.ts",
    filter:
      "dev reload socket: stops presenting a dead token once signed out, resumes on sign-in",
  },
  {
    what:
      "a pending onInit at harness teardown is mislabelled as an un-awaited call told to await the call",
    file: "src/testing/test-strict.ts",
    find: 'const inits = methods.filter((m) => m.endsWith(".onInit()"));',
    replace: 'const inits = methods.filter((m) => m.endsWith(".never()"));',
    test: "tests/harness-oninit-teardown-warning.test.tsx",
    filter:
      "bootCells: an onInit still running at teardown is named as the cell's onInit, not an un-awaited call",
  },
  {
    what:
      "a POST form navigation without fetch metadata headers gets 405 instead of the 1.0.11 app shell",
    file: "src/server/server-static.ts",
    find: '? (req!.headers.get("accept") ?? "").includes("text/html")',
    replace: "? false",
    test: "tests/static-write-method-405.test.ts",
    filter:
      "static: a POST navigation WITHOUT fetch metadata (plain-http LAN origin, older Safari) still gets the shell",
  },
  {
    what:
      "a focus-probe resume after another tab's sign-in leaves the dev reload socket parked forever",
    file: "src/browser/browser-air-transport.ts",
    find:
      "      globalThis.dispatchEvent?.(new Event(SIGNED_IN_EVENT));\n    });",
    replace: "    });",
    test: "tests/dev-ws-resumes-on-focus-signin.test.ts",
    filter:
      "dev reload socket: resumes when a sign-in in another tab resumes the transport on focus",
  },
  {
    what:
      "multi-statement transaction entries past the warn cap are warned about on every single call",
    file: "src/db/async-db.ts",
    find: "n > 1 && _multiEntrySaid.size < 100 && !_multiEntrySaid.has(s.sql)",
    replace: "n > 1 && !_multiEntrySaid.has(s.sql)",
    test: "tests/db-one-statement-per-entry.test.ts",
    filter: "db: the multi-statement entry warning stays bounded past its cap",
  },
  {
    what:
      "a sign-in after teardown resurrects a signed-out client nobody subscribes to",
    file: "src/browser/browser-air-transport.ts",
    find: "    if (!_tornDown) _tryConnect();",
    replace: "    _tryConnect();",
    test: "tests/air-signed-out-teardown-stays-down.test.ts",
    filter:
      "signed out, then torn down: a later sign-in does not resurrect the client",
  },
  {
    what: "am auth users reports every account as unlocked",
    file: "src/am/am-cmd-auth.ts",
    find: "locked: lockout?.locked(u.id) ?? false,",
    replace: "locked: false,",
    test: "tests/am-auth.test.ts",
    filter:
      'am auth users: shows who is locked out, and no email stays "—" in JSON',
  },
  {
    what:
      "a bare --mirror flag path-pins the checkout am runs from instead of the newest release",
    file: "src/am/am-cmd-create.ts",
    find: "if (opts.mirror === undefined) {",
    replace: "if (!opts.mirror) {",
    test: "tests/am-create-existing-app-data.test.ts",
    filter:
      "am create --mirror (bare): links and path-pins the checkout am runs from",
  },
  {
    what:
      "backup and restore stop-it-first hints name the profile the verb was aimed at",
    file: "src/am/am-cmd-data.ts",
    find:
      // aio-ok: the literal SOURCE line this mutation patches in and out
      "if (profile !== undefined) return `--app=${appId} --profile=${profile}`;",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    replace: "if (profile !== undefined) return `--app=${appId}`;",
    test: "tests/am-data-profile-hint.test.ts",
    filter:
      "am backup/restore --profile: the 'stop it first' hint names the profile",
  },
  {
    what:
      "each component launches as the client its build target kind means, not the project's",
    file: "src/am/am-components.ts",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    find: ": [...flags, `--client=${c.client}`];",
    replace: ": [...flags];",
    test: "tests/am-components.test.ts",
    filter: "components: each one launches as the client its kind means",
  },
  {
    what:
      "amui reads the app shell from the deno.json client key, falling back to target",
    file: "amui/src/server/scan.server.ts",
    find: "const shell = j.client ?? j.target ?? null;",
    replace: "const shell = j.target ?? null;",
    test: "amui/src/amui.test.ts",
    filter:
      "readProjectMeta: reads the shell from `client` (the old `target` still works)",
  },
  {
    what:
      "apps amui starts or runs tasks for never inherit amui's own port and supervisor env",
    file: "amui/src/server/proc.server.ts",
    find:
      "  delete env.AIO_PORT;\n  delete env.AIO_PARENT_PID;\n  delete env.AIO_DEV_SUPERVISED;\n",
    replace: "",
    test: "amui/src/amui.test.ts",
    filter:
      "startApp / runTask: the runtime env of amui itself never reaches the app",
  },
  {
    what:
      "the fleet build refuses the documented --analyze flag as unknown so deno task build --analyze never prints a report",
    file: "src/build/build-flags.ts",
    find:
      '  // `deno task build --analyze`, and the fleet refused it as unknown.\n  "--analyze",\n',
    replace:
      "  // `deno task build --analyze`, and the fleet refused it as unknown.\n",
    test: "tests/build-flag-passthrough.test.ts",
    filter:
      "build flags: every builder boolean that is not a target reaches the child build",
  },
  {
    what:
      "the fleet accepts --analyze but never hands it to the child builder so no bundle report is printed",
    file: "src/build-all.ts",
    find: '        if (analyze) args.push("--analyze");\n',
    replace: "        if (analyze) args.push();\n",
    test: "tests/build-flag-passthrough.test.ts",
    filter:
      "build flags: every builder boolean that is not a target reaches the child build",
  },
  {
    what:
      "a systemd unit is written for Windows and macOS server binaries, which have no systemd and collide in dist",
    file: "src/build/build-compile.ts",
    find: '  if (cfg.os === "windows" || cfg.os === "darwin") {\n',
    replace: '  if (cfg.os === "plan9") {\n',
    test: "tests/build-service-unit-platforms.test.ts",
    filter:
      "fleet: a server target built for several platforms places one unit per Linux binary",
  },
  {
    what:
      "every platform's unit is named <name>.service so a multi-platform server build collides and crashes the fleet",
    file: "src/build/build-compile.ts",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    find: "    `${artifact}.service`,\n  );",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    replace: "    `${binaryName}.service`,\n  );",
    test: "tests/build-service-unit-platforms.test.ts",
    filter:
      "fleet: a server target built for several platforms places one unit per Linux binary",
  },
  {
    what:
      "the fleet looks up the unit under the bare name so a cross-built linux unit gets no install steps",
    file: "src/build-all.ts",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    find: "          `${artifactName(r.binary, r.platform)}.service`,",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    replace: "          `${r.binary}.service`,",
    test: "tests/build-service-unit-platforms.test.ts",
    filter:
      "fleet: a server target built for several platforms places one unit per Linux binary",
  },
  {
    what:
      "the dropped-targets note repeats a multi-platform target once per platform in its list",
    file: "src/build-all.ts",
    find: "    const dropped = [...new Set(previousTargets)].filter((t) =>",
    replace: "    const dropped = [...previousTargets].filter((t) =>",
    test: "tests/build-service-unit-platforms.test.ts",
    filter: "fleet: the 'no longer holds' note names each dropped target once",
  },
  {
    what:
      "the suggested --targets= command repeats every multi-platform target once per platform",
    file: "src/build-all.ts",
    find:
      "            [\n              ...new Set([\n                ...dropped,",
    replace: "            [\n              ...([\n                ...dropped,",
    test: "tests/build-service-unit-platforms.test.ts",
    filter: "fleet: the 'no longer holds' note names each dropped target once",
  },
  {
    what:
      "the applicationId of a placed APK is derived from its versioned file name (app.aio.<bin>013dev)",
    file: "src/build/build-android.ts",
    find: '    stripVersionToken(name.replace(/\\.apk$/, "")),',
    replace: '    name.replace(/\\.apk$/, ""),',
    test: "tests/dev-android-launch-id.test.ts",
    filter:
      "dev:android: launches the dev APK's package, not its versioned file name",
  },
  {
    what:
      "dev:android ignores deno.json android.applicationId when launching and launches a package that does not exist",
    file: "src/dev-android.ts",
    find: "  const appId = apkApplicationId(apk, android?.applicationId);",
    replace: "  const appId = apkApplicationId(apk, undefined);",
    test: "tests/dev-android-launch-id.test.ts",
    filter:
      "dev:android: an explicit android.applicationId is the package launched",
  },
  {
    what: "dev:android prints '✓ launched' when am start failed",
    file: "src/dev-android.ts",
    find:
      "  if (start.code !== 0 || /Error/.test(start.out + start.err)) {\n    console.error(",
    replace: "  if (start.code !== 0) {\n    console.error(",
    test: "tests/dev-android-launch-id.test.ts",
    filter: "dev:android: a launch that failed is reported, never '✓ launched'",
  },
  {
    what:
      "install:android ignores deno.json android.applicationId when launching and the launch after install fails",
    file: "src/android-install.ts",
    find: "  const appId = apkApplicationId(apk, explicit);",
    replace: "  const appId = apkApplicationId(apk, undefined);",
    test: "tests/dev-android-launch-id.test.ts",
    filter:
      "install:android: launches the project's explicit android.applicationId",
  },
  {
    what:
      "Field no longer treats Switch and RadioGroup as controls, so a Switch or RadioGroup inside a labelled Field renders unnamed",
    file: "src/ui/mod.ts",
    find: "v.tag === Checkbox || v.tag === Switch || v.tag === RadioGroup;",
    replace: "v.tag === Checkbox;",
    test: "tests/ui-field-names-kit-controls.test.ts",
    filter: "Field names a Switch and a RadioGroup inside it",
  },
  {
    what:
      "the default icon hue hashes the display title as written instead of its appId slug, so the taskbar icon and the theme accent differ",
    file: "src/build/app-icon.ts",
    find: 'const s = slugify(name || "app");',
    replace: 'const s = (name || "app").trim().toLowerCase();',
    test: "tests/app-icon-hue-identity.test.ts",
    filter: "app icon: a title and the appId it resolves to draw one hue",
  },
  {
    what:
      "Textarea onChange silently hands the DOM Event to a handler the docs promised the value to, with no dev hint",
    file: "src/ui/mod.ts",
    find: 'typeof props.onChange === "function" && !_textareaChangeWarned &&',
    replace: 'typeof props.onChange === "string" && !_textareaChangeWarned &&',
    test: "tests/ui-textarea-onchange-event.test.ts",
    filter: "Textarea onChange: still the Event, and dev says so once",
  },
  {
    what:
      "Link overwrites the author's onClick with the router handler so the author's click handler never runs",
    file: "src/air/router.ts",
    find: 'if (typeof own === "function") own(e);',
    replace: 'if (typeof own === "function" && Math.random() > 2) own(e);',
    test: "tests/router-link-class-and-onclick.test.ts",
    filter:
      "Link runs the author's onClick, and its preventDefault stops routing",
  },
  {
    what:
      "NavLink drops the author's class attribute and renders only the active class on its own page",
    file: "src/air/router.ts",
    find:
      ': [rest.class, rest.className].filter(Boolean).join(" ") || undefined;',
    replace: ': [rest.className].filter(Boolean).join(" ") || undefined;',
    test: "tests/router-link-class-and-onclick.test.ts",
    filter: "NavLink keeps the author's class beside the active one",
  },
  {
    what:
      "Spinner's default aria-label \"Loading\" overrides the caller's aria-label again",
    file: "src/ui/mod.ts",
    find: '"aria-label": props["aria-label"] ?? "Loading",',
    replace: '"aria-label": "Loading",',
    test: "tests/ui-caller-aria-label-wins.test.ts",
    filter:
      "kit: a caller's aria-label wins over Spinner/Avatar/Pagination defaults",
  },
  {
    what:
      "Avatar's name overrides the caller's aria-label/title again so a screen reader announces the wrong name",
    file: "src/ui/mod.ts",
    find: '"aria-label": common["aria-label"] ?? name,',
    replace: '"aria-label": name,',
    test: "tests/ui-caller-aria-label-wins.test.ts",
    filter:
      "kit: a caller's aria-label wins over Spinner/Avatar/Pagination defaults",
  },
  {
    what:
      "Pagination's default aria-label overrides the caller's again so two pagers on one page share one name",
    file: "src/ui/mod.ts",
    find: '"aria-label": props["aria-label"] ?? "Pagination",',
    replace: '"aria-label": "Pagination",',
    test: "tests/ui-caller-aria-label-wins.test.ts",
    filter:
      "kit: a caller's aria-label wins over Spinner/Avatar/Pagination defaults",
  },
  {
    what:
      "a worker cell's patch batch of a redacted cell is written to actions.jsonl in cleartext",
    file: "src/diagnostics/mod.ts",
    find:
      "(action.type === WORKER_PATCH_ACTION &&\n            redact.redactsCell(",
    replace: '(action.type === "" &&\n            redact.redactsCell(',
    test: "tests/redact-worker-patch-sinks.test.ts",
    filter: "redact: a worker cell's patch batch stays out of actions.jsonl",
  },
  {
    what:
      "a worker cell's patch batch of a redacted cell is written to debug.log in cleartext",
    file: "src/diagnostics/logger-observe.ts",
    find: "(type === WORKER_PATCH_ACTION && typeof payload.cell",
    replace: '(type === "" && typeof payload.cell',
    test: "tests/redact-worker-patch-sinks.test.ts",
    filter: "redact: a worker cell's patch batch stays out of debug.log",
  },
  {
    what:
      "the trust file holding the pinned key is rewritten in place on every current check, so a crash mid-write bricks boot",
    file: "src/server/updates-check.ts",
    find:
      "    writeTrustFile(trustPath(dataDir), { ...readTrust(dataDir), ...patch });",
    replace:
      "    Deno.writeTextFileSync(trustPath(dataDir), JSON.stringify({ ...readTrust(dataDir), ...patch }, null, 2));",
    test: "tests/updates-trust-atomic-write.test.ts",
    filter:
      "updates trust: an interrupted etag write leaves the pinned key readable",
  },
  {
    what:
      "a manifest fetched through a redirect to plain http is judged pinnable by the configured URL",
    file: "src/server/updates-check.ts",
    find: "if (transportAuthenticatesHost(pinFrom)) pinFrom = at;",
    replace: "if (transportAuthenticatesHost(pinFrom)) pinFrom = url;",
    test: "tests/updates-tofu-redirect-downgrade.test.ts",
    filter:
      "updates: a manifest redirected to plain http off-machine never pins its key",
  },
  {
    what:
      "trust on first use pins a key judged by the configured URL instead of the redirect leg",
    file: "src/server/updates-runtime.ts",
    find: "pinKey(deps.dataDir, m.publicKey, got.pinFrom);",
    replace: "pinKey(deps.dataDir, m.publicKey, url);",
    test: "tests/updates-tofu-redirect-downgrade.test.ts",
    filter:
      "updates: a manifest redirected to plain http off-machine never pins its key",
  },
  {
    what:
      "feedback delivery POST has no deadline so a silent collector hangs capture forever",
    file: "src/server/feedback-boot.ts",
    find: "signal: AbortSignal.timeout(_feedbackDelivery.timeoutMs),",
    replace: "signal: undefined,",
    test: "tests/feedback-delivery-timeout.test.ts",
    filter:
      "feedback: a collector that never answers fails delivery, it does not hang capture",
  },
  {
    what:
      "feedback auto-capture listener does not opt into prod errors so shipped apps never capture",
    file: "src/server/feedback-boot.ts",
    find: "}, { prodErrors: true });",
    replace: "}, { prodErrors: false });",
    test: "tests/feedback-auto-capture-prod.test.ts",
    filter:
      "feedback: an error is captured automatically in prod, exactly as in dev",
  },
  {
    what:
      "the error reporter is wired to the diagnostic bus only in dev so prod errors reach nobody",
    file: "src/server/server.ts",
    find: "  setDiagEmit(diagEmit);",
    replace: "  if (!prod) setDiagEmit(diagEmit);",
    test: "tests/feedback-auto-capture-prod.test.ts",
    filter:
      "feedback: an error is captured automatically in prod, exactly as in dev",
  },
  {
    what:
      "the prod diagnostic bus drops error events instead of forwarding them to opted-in listeners",
    file: "src/diagnostics/diagnostic-bus.ts",
    find: 'if (event.severity === "error") _emitProdError(event);',
    replace: 'if (event.severity === "error") return;',
    test: "tests/feedback-auto-capture-prod.test.ts",
    filter:
      "feedback: an error is captured automatically in prod, exactly as in dev",
  },
  {
    what:
      "a worker cell's routed calls never reach the owner's health row, so lastAction stays undefined forever",
    file: "src/server/cell-worker-pool.ts",
    find: "opts.breaker?.note?.(cell, action.type);",
    replace: "void 0;",
    test: "tests/worker-differential-fuzz.test.ts",
    filter:
      "worker differential fuzz: a worker cell's health names the method it last ran",
  },
  {
    what:
      "health endpoint reads the process-global last booted app's cells instead of its own app's composition",
    file: "src/server/aio-cells-bridge.ts",
    find: "_cellHealth: (state) => composed.registry.health(state),",
    replace:
      "_cellHealth: (Object.assign(globalThis, { __aioH: composed }), (state) => ((globalThis as unknown as { __aioH: typeof composed }).__aioH).registry.health(state)),",
    test: "tests/health-cells-per-app.test.ts",
    filter: "health: each app's /__aio/health lists its own cells",
  },
  {
    what:
      "worker patch batches are storm-tracked under the shared internal type and dropped by the breaker, desyncing worker and main state",
    file: "src/server/aio-cells-bridge.ts",
    find: "if (type === WORKER_PATCH_ACTION) {",
    replace: 'if (type === "never" as string) {',
    test: "tests/worker-dispatch-storm.test.ts",
    filter: "worker dispatch storm: a streaming worker cell keeps every commit",
  },
  {
    what:
      "a breaker trip whose onDestroy throws re-trips recursively from its own rollback until the stack overflows",
    file: "src/state/cell-compose-registry.ts",
    find: "cbApp && !tripping.has(name)",
    replace: "cbApp",
    test: "tests/circuit-breaker-destroy-throws.test.ts",
    filter: "circuit breaker: a trip whose onDestroy throws rolls back once",
  },
  {
    what:
      "a crashed worker cell leaves the health endpoint reporting healthy with the dead cell active",
    file: "src/server/cell-worker.ts",
    // aio-ok: the literal SOURCE line this mutation patches in and out
    find: "degraded(`cell-worker:${name}`, { after: 1 }).fail(err);",
    replace: "void degraded;",
    test: "tests/worker-crash-health.test.ts",
    filter: "worker crash: /__aio/health reports the dead cell as degraded",
  },
  {
    what:
      "am auth users JSON changes the frozen email field from the 1.0.11 dash to null",
    file: "src/am/am-cmd-auth.ts",
    find: '          email: u.email ?? "—",',
    replace: "          email: u.email ?? (null as unknown as string),",
    test: "tests/am-auth.test.ts",
    filter:
      'am auth users: shows who is locked out, and no email stays "—" in JSON',
  },
  {
    what:
      "am start forces --client=electron on electron-kind components so a headless box refuses mid-loop",
    file: "src/am/am-components.ts",
    find: '  browser: "browser",\n  cli: "cli",',
    replace: '  browser: "browser",\n  electron: "electron",\n  cli: "cli",',
    test: "tests/am-components.test.ts",
    filter: "components: each one launches as the client its kind means",
  },
  {
    what:
      "a worker cell breaker trip whose onDestroy throws still calls onTrip and reports tripped though rolled back",
    file: "src/state/cell-compose-registry.ts",
    find: "          if (ok) reportTrip(name, count);",
    replace: "          void ok, reportTrip(name, count);",
    test: "tests/worker-lifecycle-edges.test.ts",
    filter: "worker circuit breaker: a trip whose onDestroy throws is no trip",
  },
  {
    what:
      "Link folds a signal class or className into a static string, losing the documented signal binding",
    file: "src/air/router.ts",
    find: "const bound = isSignal(rest.class) || isSignal(rest.className);",
    replace: "const bound = isSignal(rest.class) && isSignal(rest.className);",
    test: "tests/router-link-signal-class.test.ts",
    filter: "Link keeps a signal class bound",
  },
  {
    what:
      "a caller passing aria-label undefined blanks the Spinner status name instead of keeping Loading",
    file: "src/ui/mod.ts",
    find: '"aria-label": props["aria-label"] ?? "Loading",',
    replace: '"aria-label": props["aria-label"],',
    test: "tests/ui-default-names-undefined-prop.test.ts",
    filter:
      "kit: an undefined aria-label keeps the Spinner/Avatar/Pagination default",
  },
  {
    what:
      "the dev Electron window icon hashes the runtime title so its hue differs from the appId theme",
    file: "src/server/aio-lifecycle.ts",
    find: "  return appIconPngBase64(title, 256, appId);",
    replace: "  return appIconPngBase64(title, 256);",
    test: "tests/dev-window-icon-hue.test.ts",
    filter: "dev window icon: hue is the appId's, not the title's",
  },
  {
    what:
      "the icon rasterizer draws its hue from the letter name instead of the appId key",
    file: "src/build/app-icon.ts",
    find: "  const hue = hueOf(id);",
    replace: "  const hue = hueOf(name);",
    test: "tests/dev-window-icon-hue.test.ts",
    filter: "dev window icon: hue is the appId's, not the title's",
  },
  {
    what:
      "the packaged default icon png takes its hue from the display title instead of the appId",
    file: "src/build/build-helpers.ts",
    find: "await appIconPng(appName, 512, id)",
    replace: "await appIconPng(appName, 512)",
    test: "tests/dev-window-icon-hue.test.ts",
    filter: "packaged default icon: hue is the appId's, not the title's",
  },
  {
    what:
      "the generated macOS icns takes its hue from the display title instead of the appId",
    file: "src/build/macos-app.ts",
    find: "png = await appIconPng(name, size, id);",
    replace: "png = await appIconPng(name, size);",
    test: "tests/dev-window-icon-hue.test.ts",
    filter: "packaged default icon: hue is the appId's, not the title's",
  },
  {
    what:
      "dev never warns when a dark OS darkens the aio tokens while the page stays white and kit text is unreadable",
    file: "src/air/dark-os-light-page.ts",
    find: "  return lum(page) > 0.5;",
    replace: "  return false;",
    test: "tests/dark-os-light-page.test.ts",
    filter: "dark OS + dark tokens + unpainted page (tokens default) warns",
  },
  {
    what:
      "a keyed child that occupied no node (a Portal) is diffed with no position, so its same-key element replacement is appended at the parent's end",
    file: "src/air/vdom-diff-children.ts",
    find: "      diffFn(parent, nc, oc, ctx, isSvg, slot);",
    replace: "      diffFn(parent, nc, oc, ctx, isSvg, slot && null);",
    test: "tests/air-keyed-portal-row-becomes-element.test.ts",
    filter:
      "a keyed row turning from a Portal into an element keeps its place in the list",
  },
  {
    what:
      "tearing down a never-mounted portal walks its target from firstChild and deletes the target's own content on a hydration fallback",
    file: "src/air/vdom-remove.ts",
    find:
      "    if (target && vnode._anchor) {\n      // Walk from the portal's own region anchor, not `target.firstChild` —\n      // that is the OTHER portal's content when two share a target, and\n      // removing this portal by it deleted their nodes instead of its own.\n      let cursor: Node | null = _advance(vnode._anchor, 1);",
    replace:
      "    if (target) {\n      // Walk from the portal's own region anchor, not `target.firstChild` —\n      // that is the OTHER portal's content when two share a target, and\n      // removing this portal by it deleted their nodes instead of its own.\n      let cursor: Node | null = vnode._anchor\n        ? _advance(vnode._anchor, 1)\n        : target.firstChild;",
    test: "tests/air-hydrate-fallback-unmounted-portal.test.ts",
    filter: "hydrate mismatch fallback leaves the target's own content alone",
  },
  {
    what:
      "a boundary retiring its region steps the cursor from a child the failed diff already detached, firing a false lost-cursor dev warning",
    file: "src/air/vdom-diff-boundary.ts",
    find: "    if (own && !isChildOf(own, parent)) {",
    replace: "    if (own && !isChildOf(own, parent) && children.length < 0) {",
    test: "tests/air-boundary-fallback-sweeps-region.test.ts",
    filter:
      "a boundary falling back leaves none of its old text beside the fallback",
  },
  {
    what:
      "a boundary decides whether to sweep its old region AFTER the failed child diff detached its first node, leaving old text beside the fallback",
    file: "src/air/vdom-diff-boundary.ts",
    find: "  known: boolean,\n): void {\n",
    replace:
      "  _known: boolean,\n): void {\n  const known = isChildOf(getDom(ov), parent);\n",
    test: "tests/air-boundary-fallback-sweeps-region.test.ts",
    filter:
      "a boundary falling back leaves none of its old text beside the fallback",
  },
  {
    what:
      "an empty region hydrating over an unclaimed server text remainder inserts a second anchor and leaves orphans, duplicating the following text",
    file: "src/air/renderer-hydrate.ts",
    find:
      "      _dropSplitTail(parent, childIndex); // see `_dropSplitTail`\n      const domNode = parent.childNodes[childIndex];",
    replace: "      const domNode = parent.childNodes[childIndex];",
    test: "tests/air-hydrate-text-tail-before-region.test.ts",
    filter:
      "hydrate: a shorter client text before an empty region leaves no duplicate",
  },
  {
    what:
      "Field overwrites a Switch's own string label with the field heading as its accessible name",
    file: "src/ui/mod.ts",
    find: 'p.label.trim() !== "";',
    replace: 'p.label.trim() === "(never)";',
    test: "tests/ui-field-names-kit-controls.test.ts",
    filter:
      "Field keeps a Switch's own label and still names a Checkbox as 1.0.11 did",
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
    find: "    hostHeader: requestHost(req),\n    secure: cfg.secure,",
    replace:
      '    hostHeader: req.headers.get("host"),\n    secure: cfg.secure,',
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
      "a reducer's first import() pins its boot's fence as the next test's context, and that test's first cell call is refused as a torn-down runtime's",
    file: "src/testing/boot-refusals.ts",
    find: "  _bootAls.enterWith(undefined);",
    replace: "  void _bootAls;",
    test: "tests/boot-scope-first-import.test.ts",
    filter:
      "boot scope: a reducer's first import() of a module never leaks its boot into the next test (testUI, testCell, bootCells)",
  },
  {
    what:
      "a worker cell's first import() pins the worker scope as the next test's context, and that body's peer read is refused as the worker's",
    file: "src/testing/boot-refusals.ts",
    find: "  _workerScope.enterWith(undefined);",
    replace: "  void _workerScope;",
    test: "tests/boot-scope-first-import.test.ts",
    filter:
      "worker scope: a worker cell's first import() of a module never makes the next test's body read as the worker's code",
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
    find: "  inits.pipe(ledger);\n  /** Drain until nothing is in flight.",
    replace: "  void inits;\n  /** Drain until nothing is in flight.",
    test: "tests/harness-oninit-strict.test.tsx",
    filter:
      "bootCells: an onInit that throws fails the test at settle(), naming the cell and the way out",
  },
  {
    what:
      "testUI shows an onInit throw only as post-test output — the mount passes with the cell never initialised",
    file: "src/testing/ui-test.ts",
    find: "    inits.pipe(ledger);",
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
  {
    what:
      "editing a .js/.mjs/.jsx module the dev server serves never reloads the page, so the developer stares at stale code",
    file: "src/server/server-watcher.ts",
    find: "    if (!RELOAD_EXT.has(ext) && !servedFiles.has(path)) return;",
    replace: "    if (!RELOAD_EXT.has(ext)) return;",
    test: "tests/dev-served-modules-reload.test.ts",
    filter:
      "dev reload: an edit to a served .js/.mjs/.jsx module reloads the page, unserved build output does not",
  },
  {
    what:
      "a module served from a serveDirs or share root outside the app is never watched, so editing it leaves a stale page",
    file: "src/server/server.ts",
    find: "    onModuleServed: (file) => watcher?.watchServed(file),",
    replace: "    onModuleServed: undefined,",
    test: "tests/dev-served-modules-reload.test.ts",
    filter:
      "dev reload: a module served from a serveDirs root outside the app reloads the page on edit",
  },
  {
    what:
      "smoke passes an eagerly-linked module served 200 with a non-JavaScript content type, which the browser refuses at boot",
    file: "src/testing/smoke-test.ts",
    find: "    if (!_isJsMime(type)) {",
    replace: '    if (!_isJsMime(type) && type === "\\0") {',
    test: "tests/smoke-module-mime.test.ts",
    filter:
      "smoke: a module served 200 with a non-JavaScript Content-Type fails, naming the file, the type and the importer chain",
  },
  {
    what:
      "a <webview> guest (not a window) is granted every permission the app asks for — a wallet's embedded dApp reads the clipboard",
    file: "src/electron/electron-shared.ts",
    find:
      "  if (!wc || typeof wc.getType !== 'function' || wc.getType() !== 'window') return false;",
    replace: "  if (!wc) return false;",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: a <webview> guest is denied clipboard-read and friends, and it is said once",
  },
  {
    what:
      "a foreign-origin or data: frame inside the app window gets the app page's permissions",
    file: "src/electron/electron-shared.ts",
    find: "  return !requesting || __aioOrigin(requesting) === own;",
    replace: "  return true;",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: the app's own page keeps them; a foreign or data: frame in it does not",
  },
  {
    what:
      "a <webview> partition session is never guarded, so a partitioned guest keeps every permission",
    file: "src/electron/electron-shared.ts",
    find: "app.on('session-created', __aioGuardSession);",
    replace: "",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: every session is guarded — a <webview> partition too, once each",
  },
  {
    what:
      "a denied permission is refused silently, so a dev never learns why the embedded page broke",
    file: "src/electron/electron-shared.ts",
    find: "    if (!ok) __aioPermDenied(permission, requesting);",
    replace: "",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: a <webview> guest is denied clipboard-read and friends, and it is said once",
  },
  {
    what: "a guest's fullscreen request (an embedded video) is refused too",
    file: "src/electron/electron-shared.ts",
    find: "  if (permission === 'fullscreen') return true;",
    replace: "",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: a <webview> guest is denied clipboard-read and friends, and it is said once",
  },
  {
    what:
      "in a real Electron, a guest's permission REQUEST is granted though the check says denied",
    file: "src/electron/electron-shared.ts",
    find: "    cb(ok);",
    replace: "    cb(true);",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions e2e: a real foreign <webview> guest is denied clipboard-read, geolocation and notifications the app window keeps",
    env: { ELECTRON_E2E: "1" },
  },
  {
    what: "build.minify leaves every server local name in the binary",
    file: "src/build/minify-server.ts",
    find: "    minify: true,",
    replace: "    minify: false,",
    test: "tests/build-minify.test.ts",
    filter:
      "minify: a module loses its comments and local names, keeps function names and JSX",
  },
  {
    what:
      "a minified server renames functions, so anything reading fn.name behaves differently from the unminified app",
    file: "src/build/minify-server.ts",
    find: "    keepNames: true,",
    replace: "    keepNames: false,",
    test: "tests/build-minify.test.ts",
    filter:
      "minify: a module loses its comments and local names, keeps function names and JSX",
  },
  {
    what:
      "a worker the builder includes by its real path is staged where no module looks for it, so the minified binary dies with Module not found",
    file: "src/build/minify-server.ts",
    find: "      if (seen) return join(seen, relative(d, rp));",
    replace: "      if (seen) return rp;",
    test: "tests/build-minify.test.ts",
    filter:
      "minify: the stage keeps the layout, follows the app's symlinked path, drops the client map",
  },
  {
    what:
      "the client source map, with every original UI name and path, ships inside a minified binary",
    file: "src/build/minify-server.ts",
    find: "    if (e.name === BUNDLE_MAP) continue;",
    replace: "",
    test: "tests/build-minify.test.ts",
    filter:
      "minify: the stage keeps the layout, follows the app's symlinked path, drops the client map",
  },
  {
    what:
      "a minified build skips the type check, so a type error ships instead of failing the build",
    file: "src/build/minify-server.ts",
    find: '  if (!argv.includes("--no-check")) {',
    replace: "  if (false) {",
    test: "tests/build-minify.test.ts",
    filter:
      "minify: a type error in the ORIGINAL still fails the build, and no stage is left",
  },
  {
    what:
      'build.minify: "true" (a string) is taken as on, so a typo is never reported',
    file: "src/build/minify-server.ts",
    find: '  if (v === undefined || typeof v === "boolean") return v === true;',
    replace:
      '  if (v === undefined || typeof v === "boolean" || v === "true") return v === true;',
    test: "tests/build-minify.test.ts",
    filter:
      "minify: build.minify is off by default, on only for a real true, and a string is refused",
  },
  {
    what: "build.minify is read but the compile runs the readable tree anyway",
    file: "src/build/minify-server.ts",
    find: "  if (!minify) return await run(argv);",
    replace: "  return await run(argv);",
    test: "tests/build-e2e-minify.test.ts",
    filter:
      "build e2e: build.minify ships no server comment or local name, and the binary still boots, runs a method and keeps its state",
    env: { AIO_BUILD_E2E: "1" },
  },
  {
    what:
      "the minified staging copy of the app's source is left inside the project after a build",
    file: "src/build/minify-server.ts",
    find: "    await st.dispose();",
    replace: "    void st;",
    test: "tests/build-e2e-minify.test.ts",
    filter:
      "build e2e: build.minify ships no server comment or local name, and the binary still boots, runs a method and keeps its state",
    env: { AIO_BUILD_E2E: "1" },
  },
  {
    what:
      "an app or desktop binary ships its server source readable although deno.json says build.minify",
    file: "src/build/build-compile.ts",
    find: "  const minify = await minifyDeclared(root);",
    replace: "  const minify = false;",
    test: "tests/build-minify.test.ts",
    filter:
      "minify: every compile path (app, Electron, Windows exe, cli) runs through runCompile with build.minify",
  },
  {
    what:
      "a cli binary ships its server source readable although deno.json says build.minify",
    file: "src/build/build-cli.ts",
    find: "  const minify = await minifyDeclared(root);",
    replace: "  const minify = false;",
    test: "tests/build-minify.test.ts",
    filter:
      "minify: every compile path (app, Electron, Windows exe, cli) runs through runCompile with build.minify",
  },
  {
    what:
      "the fuses are written ON instead of off, so the shipped Electron still runs as Node",
    file: "src/electron/electron-fuses.ts",
    find: 'const OFF = 0x30; // "0"',
    replace: 'const OFF = 0x31; // "1"',
    test: "tests/electron-fuses.test.ts",
    filter:
      "fuses: RunAsNode, NODE_OPTIONS and --inspect go off; every other byte stays",
  },
  {
    what:
      "NODE_OPTIONS stays honoured by the shipped Electron, so code can be injected at launch",
    file: "src/electron/electron-fuses.ts",
    find: '  2: "EnableNodeOptionsEnvironmentVariable",\n',
    replace: "",
    test: "tests/electron-fuses.test.ts",
    filter:
      "fuses: RunAsNode, NODE_OPTIONS and --inspect go off; every other byte stays",
  },
  {
    what: "a binary with two fuse wires is patched at a guess",
    file: "src/electron/electron-fuses.ts",
    find: "  if (find(bytes, at + 1) >= 0) {",
    replace: "  if (false) {",
    test: "tests/electron-fuses.test.ts",
    filter:
      "fuses: a wire that is missing, doubled, of another version or too short is refused",
  },
  {
    what:
      "fusing writes THROUGH a hard link, changing the shared runtime cache (and dev) along with the package",
    file: "src/electron/electron-fuses.ts",
    find: "}.fusing`;",
    replace: "}`;",
    test: "tests/electron-fuses.test.ts",
    filter:
      "fuses: the file is replaced, not written through \u2014 a hard-linked cache copy stays as it was",
  },
  {
    what: "the desktop packages ship Electron with its fuses on",
    file: "src/build/build-electron.ts",
    find: "    await fuseElectronFile(electronFuseBinary(electronDst, os));",
    replace: "    void electronFuseBinary;",
    test: "tests/electron-fuses.test.ts",
    filter:
      "fuses: every desktop package fuses the runtime it copies, before packaging",
  },
  {
    what: "the self-contained exe unpacks its Electron with the fuses on",
    file: "src/electron/electron-runtime-fetch.ts",
    find: "if (opts.embedded) await fuseElectronFile(",
    replace: "if (false) await fuseElectronFile(",
    test: "tests/electron-embedded-runtime.test.ts",
    filter:
      "embedded runtime: the carried runtime is unpacked with its fuses off, apart from an unfused one already cached",
  },
  {
    what:
      "the self-contained exe reuses an unfused runtime a download or an older app cached under the same name",
    file: "src/electron/electron-runtime-fetch.ts",
    find: '(opts.embedded ? FUSED_SUFFIX : "")',
    replace: '(opts.embedded ? "" : "")',
    test: "tests/electron-embedded-runtime.test.ts",
    filter:
      "embedded runtime: the carried runtime is unpacked with its fuses off, apart from an unfused one already cached",
  },
  {
    what:
      "am prune cannot identify a -fused runtime, so it is never reclaimable",
    file: "src/build/electron-cache.ts",
    find: "(?:-([a-z0-9]+))?(?:-fused)?$/",
    replace: "(?:-([a-z0-9]+))?$/",
    test: "tests/electron-fuses.test.ts",
    filter: "fuses: am prune knows a -fused runtime as the same Electron",
  },
  {
    what:
      "an app that opens its files before aio.run under --profile opens the everyday home while aio moves to the profile's",
    file: "src/server/resolve-home.ts",
    find: "request: homeRequest(),",
    replace: "request: {},",
    test: "tests/resolve-home.test.ts",
    filter: "resolveHome === aio.run: --profile=tasks",
  },
  {
    what:
      "an explicit dbPath outside the profile home silently opens the everyday database under the profile's lock and logs",
    file: "src/server/aio.ts",
    find: "if (split) throw new Error(split);",
    replace: "if (split) log.debug(split);",
    test: "tests/resolve-home.test.ts",
    filter:
      "boot refuses an explicit dbPath outside the profile home (config and --db-path)",
  },
  {
    what:
      "a test display whose cookie file is stale reads as usable, so every Electron test of a release check is refused an hour later",
    file: "src/server/nested-display.ts",
    find: "      return (await conn.read(b)) === 1 && b[0] === 1;",
    replace: "      return (await conn.read(b)) === 1 && b[0] !== 7;",
    test: "tests/nested-display.test.ts",
    filter:
      "nestedDisplayAccepts: the server's own answer — a stale cookie file is refused, the right one accepted",
  },
  {
    what:
      "a refused dbPath still records the profile, so a second app in the process that catches the refusal runs half-profiled",
    file: "src/server/aio.ts",
    find: "      if (split) throw new Error(split);",
    replace:
      "      recordAppDirs(_earlyAppId, plan);\n      if (split) throw new Error(split);",
    test: "tests/resolve-home.test.ts",
    filter:
      "a refused dbPath leaves no profile recorded — a second app that catches it is not left half-profiled",
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
  // `--only=a||b` runs the entries matching ANY of the alternatives — one
  // pass for a batch of rows (a hunt round's), not one scratch setup per row.
  const alts = only?.toLowerCase().split("||").filter(Boolean) ?? [];
  const entries = LEDGER.filter((m) => {
    if (alts.length === 0) return true;
    const hay = (m.what + m.file + m.test).toLowerCase();
    return alts.some((a) => hay.includes(a));
  });

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

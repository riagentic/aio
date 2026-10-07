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

import { LEDGER_1 } from "./mutations/ledger-1.ts";
import { fromFileUrl } from "@std/path";

export const LEDGER: readonly Mutation[] = [
  // The oldest rows live in scripts/mutations/ledger-1.ts (this file must
  // stay under aiol's 512 KB per-file limit, or it is not linted at all).
  ...LEDGER_1,
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
    find: "      refundAuthWork(clientKey);\n      let changed: boolean;",
    replace: "      let changed: boolean;",
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
    find: "    const queued = op.hlc[2] === deps.clientId &&",
    replace:
      "    if (isOwnSessionOp(op.id)) return; const queued = op.hlc[2] === deps.clientId &&",
    test: "tests/sync/session-prefix-bound.test.ts",
    filter:
      "an op frame under a connected client's session prefix reaches that client's screen",
  },
  {
    what:
      "the server catch-up omits every op under the requester's session prefix, including ones another connection submitted while it was away",
    file: "src/sync/server-handler.ts",
    find: "? sessionPrefix(o.id) === ownPrefix && !_foreign.has(o.id)",
    replace: "? sessionPrefix(o.id) === ownPrefix",
    test: "tests/sync/session-prefix-bound.test.ts",
    filter:
      "an op under a disconnected client's session prefix reaches that client's catch-up",
  },
  {
    what:
      "a client id extending another client's session prefix hides its ops from that client's catch-up (prefix compared with startsWith)",
    file: "src/sync/server-handler.ts",
    find: "? sessionPrefix(o.id) === ownPrefix && !_foreign.has(o.id)",
    replace: "? o.id.startsWith(ownPrefix) && !_foreign.has(o.id)",
    test: "tests/sync/session-prefix-clientid-dash.test.ts",
    filter:
      "a client id that extends the victim's session prefix cannot hide ops from the victim's catch-up",
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
    find:
      '        if (msg.code === "REDUCE_ERROR" && !entry?.callId) deps.countError?.();',
    replace:
      '        if (msg.code === "REDUCE_ERROR_MUTANT" && !entry?.callId) deps.countError?.();',
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
    find: "if (isServerOnlySource(filepath, () => body)) {",
    replace: 'if (isServerOnlySource(filepath, () => "")) {',
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
    find: "  return type === WORKER_PATCH_ACTION && typeof cell",
    replace: '  return type === "" && typeof cell',
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
  // No row for `if (target && vnode._anchor)` in vdom-remove.ts (a
  // never-mounted portal must not walk its target from firstChild): since
  // 90d743fc9 the walk's own `gone` skip holds the same case — no anchor is
  // "gone", and a child with no live node under the target is released, not
  // removed. Either one alone keeps the target's content; with both off
  // tests/air-hydrate-fallback-unmounted-portal.test.ts is red (measured
  // 2026-10-07). One line cannot be disabled to show it, so it has no row.
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
      "        _dropSplitTail(parent, childIndex); // see `_dropSplitTail`\n      }\n      const domNode = parent.childNodes[childIndex];",
    replace: "      }\n      const domNode = parent.childNodes[childIndex];",
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
    filter: "android dir fsync: write() fsyncs the directory AFTER the rename",
  },
  {
    what:
      "a third-party iframe in a standalone APK is never reported, though AioNativeStore reaches it",
    file: "src/standalone-air.ts",
    find: "  if (store.exposedToFrames) {",
    replace: "  if (store.exposedToFrames && false) {",
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
    find: "    sources.includes('\"AioNativeStore\"');",
    replace: '    sources.includes("AioNativeStore");',
    test: "tests/build-android-own-activity.test.ts",
    filter:
      "own MainActivity.kt: a standalone overlay without the store, fetch bridge or insets frame warns for each, naming the fix",
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
    find: "    const bases = [await Deno.realPath(root), resolve(root)];",
    replace: "    const bases = [resolve(root)];",
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
    find: "      if (!hop || graph.has(hop)) continue;",
    replace: "      if (!hop || graph.has(hop) || hop) continue;",
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
    find:
      "    for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) out.push(k);",
    replace:
      "    for (const k of Object.keys(a)) if (!Object.hasOwn(a, k)) out.push(k);",
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
    find: "  if (!caller?.dead) return undefined;",
    replace: '  if (!caller?.dead || type !== "") return undefined;',
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
      "a real timer a disposed mount's component armed commits into the next mount through the re-bound handle, silently",
    file: "src/testing/boot-refusals.ts",
    find: "  _fenceTimers();",
    replace: "  void _fenceTimers;",
    test: "tests/testui-timer-fence.test.tsx",
    filter:
      "testUI: a timer a disposed mount armed never writes into the next mount, and its refusal names where it was armed",
  },
  {
    what:
      "the torn-down-runtime refusal names only the boot, never the method or timer that started the call",
    file: "src/standalone-air.ts",
    find: "  const origin = _bootScope?.origin?.();",
    replace: "  const origin = undefined;",
    test: "tests/testui-timer-fence.test.tsx",
    filter:
      "testUI: a timer a disposed mount armed never writes into the next mount, and its refusal names where it was armed",
  },
  {
    what:
      "the torn-down-runtime refusal counts every boot so far as the boots since the refused one",
    file: "src/standalone-air.ts",
    find: "  const since = _bootCount - boot;",
    replace: "  const since = _bootCount;",
    test: "tests/testui-timer-fence.test.tsx",
    filter:
      "testUI: a timer a disposed mount armed never writes into the next mount, and its refusal names where it was armed",
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
    find: "            Promise.resolve(_liveFor(app).dispatch(action));",
    replace: "            Promise.resolve(app.dispatch(action));",
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
    find:
      "  return !requesting || __aioOrigin(requesting) === __aioOrigin(cur);",
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
    find: "    if (!ok) __aioPermDenied(wc, permission, requesting);",
    replace: "",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: a <webview> guest is denied clipboard-read and friends, and it is said once",
  },
  {
    what: "a guest's fullscreen request (an embedded video) is refused too",
    file: "src/electron/electron-shared.ts",
    find:
      "    return permission === 'fullscreen' || __aioAppPage(wc, requesting);",
    replace: "    return __aioAppPage(wc, requesting);",
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
    // The e2e twin needs Electron + a display; the fakeMain unit test runs the
    // same tmplPermissionGuard fragment and refuses a guest's clipboard ask.
    filter:
      "permissions: a <webview> guest is denied clipboard-read and friends, and it is said once",
  },
  {
    what:
      "electron.permissions is ignored: the app page keeps every permission and guests keep fullscreen, while the app believes it declared a deny-by-default policy",
    file: "src/electron/electron-shared.ts",
    find:
      "    __aioPermAllow[permission].includes('app') && __aioAppPage(wc, requesting);",
    replace: "    __aioAppPage(wc, requesting);",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: with electron.permissions the app page gets exactly the list, a guest nothing — each denial said",
  },
  {
    what:
      "with electron.permissions set, an openWindow child window showing a dApp counts as the app's own page, so a wallet's \"app\" grant (clipboard) reaches the dApp",
    file: "src/electron/electron-shared.ts",
    find:
      "  if (__aioPermAllow !== null && __aioChildWindows.has(wc)) return false;",
    replace: "",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: with electron.permissions the app page gets exactly the list, a guest nothing — each denial said",
  },
  {
    what:
      "without electron.permissions an openWindow child window loses what its own origin had in 1.0.12, so an existing app's dApp window breaks on upgrade",
    file: "src/electron/electron-shared.ts",
    find:
      "  if (__aioPermAllow !== null && __aioChildWindows.has(wc)) return false;",
    replace: "  if (__aioChildWindows.has(wc)) return false;",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: the app's own page keeps them; a foreign or data: frame in it does not",
  },
  {
    what:
      "the packaged shell never marks its openWindow child windows, so they pass as the app's own page",
    file: "src/electron/electron-shared.ts",
    find: '  __aioChildWindows.add(wc); // never "app" (tmplPermissionGuard)',
    replace: "",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: electron.permissions reaches both app mains (dev and packaged share the UDS one)",
  },
  {
    what:
      "electron.permissions never reaches the packaged (UDS) main process, so the shipped app runs the default policy the author opted out of",
    file: "src/electron/electron-uds.ts",
    // aio-ok: the ledger quotes generated-template SOURCE verbatim
    find: "${tmplPermissionGuard(opts.meta?.permissions)}",
    // aio-ok: the ledger quotes generated-template SOURCE verbatim
    replace: "${tmplPermissionGuard()}",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: electron.permissions reaches both app mains (dev and packaged share the UDS one)",
  },
  {
    what:
      "electron.permissions never reaches the WebSocket-transport main process, so that window grants every permission the app believed it had denied",
    file: "src/electron/electron-scripts.ts",
    // aio-ok: the ledger quotes generated-template SOURCE verbatim
    find: "${tmplPermissionGuard(meta?.permissions)}",
    // aio-ok: the ledger quotes generated-template SOURCE verbatim
    replace: "${tmplPermissionGuard()}",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: electron.permissions reaches both app mains (dev and packaged share the UDS one)",
  },
  {
    what:
      "electron.permissions is dropped between the config and the window meta — the config-bridge class on a security key",
    file: "src/electron/electron-shared.ts",
    find: "    permissions: cfg?.permissions ?? null,",
    replace: "    permissions: null,",
    test: "tests/electron-sandbox-policy.test.ts",
    filter: "electron config: every key of the block reaches the window's meta",
  },
  {
    what:
      "a misspelled or unknown electron.permissions entry boots, and the app runs a policy other than the one it wrote",
    file: "src/server/config.ts",
    find: "    ? electronPermissionsRefusal(obj.permissions)",
    replace: "    ? null",
    test: "tests/electron-sandbox-policy.test.ts",
    filter:
      "electron config: permissions — only Electron names, scoped to app, or the boot is refused",
  },
  {
    what:
      'an unknown permission scope ("guest") is accepted, reading as a grant to guests that never happens',
    file: "src/server/config.ts",
    find: '    const bad = scopes.find((s) => s !== "app");',
    replace: '    const bad = scopes.find((s) => s === "\\0");',
    test: "tests/electron-sandbox-policy.test.ts",
    filter:
      "electron config: permissions — only Electron names, scoped to app, or the boot is refused",
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
    find: "  if (v === undefined) return true;",
    replace: '  if (v === undefined || v === "true") return true;',
    test: "tests/build-minify.test.ts",
    filter:
      "minify: build.minify is ON by default, off only for a real false, and a string is refused",
  },
  {
    what: "build.minify is read but the compile runs the readable tree anyway",
    file: "src/build/minify-server.ts",
    find: "  if (!minify) return await run(argv);",
    replace: "  if (!minify || argv.length >= 0) return await run(argv);",
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
      "homeWasRequested() answers false under --profile/--home/AIO_PROFILE, so an app counts a requested profile from its own dev default",
    file: "src/server/resolve-home.ts",
    find: "  return asksForHome(homeRequest());",
    replace: "  return false;",
    test: "tests/resolve-home.test.ts",
    filter:
      "homeWasRequested(): every request form, incl. --home=~/.<appId>-tasks",
  },
  {
    what:
      "the cycle check follows dynamic import() edges again and warns about the documented escape hatch out of a real cycle",
    file: "src/server/graph-validator.ts",
    find:
      "        if (staticSpecs.has(spec)) staticDeps.push(resolution.path);",
    replace: "        staticDeps.push(resolution.path);",
    test: "tests/graph-validator.test.ts",
    filter:
      "validateGraph: a loop closed only by a dynamic import() is no cycle",
  },
  {
    what: "the browser check stops reporting all-static import cycles",
    file: "src/server/graph-validator.ts",
    find: "  errors.push(...staticCycles(entrypoint, staticEdges));",
    replace: "",
    test: "tests/graph-validator.test.ts",
    filter: "validateGraph: the same three files all static still warn",
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
    find: "    if (split) throw new Error(split);",
    replace:
      "    recordAppDirs(_earlyAppId, plan);\n    if (split) throw new Error(split);",
    test: "tests/resolve-home.test.ts",
    filter:
      "a refused dbPath leaves no profile recorded — a second app that catches it is not left half-profiled",
  },
  {
    what:
      "renameWords reads the code mask of the original text in later passes, leaving a renamed word unrenamed and its import orphaned",
    file: "aiol/fixes.ts",
    find: "    const mask = codeMask(out);",
    replace: "    const mask = codeMask(src);",
    test: "tests/aiol-rename-words-offsets.test.ts",
    filter:
      "renameWords: several renames read the mask of the text each pass scans",
  },
  {
    what:
      "an aiol suppression marker written for one list element silently covers the next sibling too",
    file: "aiol/checks.ts",
    find: "  if (/[=([]$/.test(above)) {",
    replace: "  if (/[=(,[]$/.test(above)) {",
    test: "tests/aiol-marker-sibling.test.ts",
    filter:
      "isSuppressed: a marker for one list element does not cover the next",
  },
  {
    what:
      "a type-only re-export from @std/* in a cell file fails the lint gate as a server-only import",
    file: "aiol/checks.ts",
    find:
      "      if (st.typeOnly) continue; // import type / export type: erased (above)",
    replace:
      '      if (st.typeOnly && st.kind === "import") continue; // import type / export type: erased (above)',
    test: "tests/aiol-export-type-reexport.test.ts",
    filter:
      'aiol: `export type {…} from "@std/fs"` in a cell file is not an error',
  },
  {
    what:
      "a mismatch inside a hydrating boundary ends the walk before a later thrower runs, so a server-rendered fallback discards the whole page",
    file: "src/air/renderer-hydrate.ts",
    find: "  if (!_attempt) return -1;\n  _attempt.missed = true;",
    replace: "  return -1;\n  _attempt!.missed = true;",
    test: "tests/air-hydrate-error-boundary-late-thrower.test.ts",
    filter:
      "hydrate: a late thrower's earlier sibling does not discard the server page",
  },
  {
    what:
      "a boundary falling back during hydrate keeps the null-slot comments its discarded children inserted beside the fallback",
    file: "src/air/renderer-hydrate.ts",
    find:
      "        for (let i = mine.undo.length - 1; i >= 0; i--) mine.undo[i]!();",
    replace: "        void mine.undo;",
    test: "tests/air-hydrate-error-boundary-late-thrower.test.ts",
    filter:
      "hydrate: a late thrower's null siblings leave no stray comment beside the fallback",
  },
  {
    what:
      "a hydrating boundary's children write props and listeners straight onto server nodes that turn out to be the fallback's",
    file: "src/air/renderer-hydrate.ts",
    find: "  _write(() => _hydrateProps(el, vnode.props));",
    replace: "  _hydrateProps(el, vnode.props);",
    test: "tests/air-hydrate-error-boundary-late-thrower.test.ts",
    filter:
      "hydrate: a late thrower's sibling that matches the fallback's tag writes nothing onto it",
  },
  {
    what:
      "a container build killed mid-compile leaves a foreign lock that no one-shot recovery ever judges dead — its node_modules links never come back",
    file: "src/server/pid-lock.ts",
    find:
      "  return seen.has(resolve(path)) ? !observedStale(path) : touchedRecently(path);",
    replace: "  return !observedStale(path);",
    test: "tests/build.test.ts",
    filter:
      "build: another namespace's lock and journal untouched for 2 min are recovered",
  },
  {
    what:
      "a live build's lock that looks 2 min old (a lagging host clock) has its link moves undone mid-compile by recovery",
    file: "src/server/pid-lock.ts",
    find:
      "  return seen.has(resolve(path)) ? !observedStale(path) : touchedRecently(path);",
    replace: "  return touchedRecently(path);",
    test: "tests/build.test.ts",
    filter: "build: recovery trusts a watched foreign lock over its old mtime",
  },
  {
    what:
      "another pid namespace's live unpack (a container's pid 7) has its stage deleted because pid 7 is dead HERE",
    file: "src/electron/electron-runtime-fetch.ts",
    find:
      "      id.pid === Deno.pid || id.ns !== ownPidNs() || isLockOwnerAlive(id)",
    replace: "      id.pid === Deno.pid || isLockOwnerAlive(id)",
    test: "tests/electron-runtime-fetch.test.ts",
    filter:
      "ensureElectronRuntime: a killed unpack's stage is removed; a LIVE one is not",
  },
  {
    what:
      "a long Electron unpack's stage goes stale and the next unpacker deletes it under the live one",
    file: "src/electron/electron-runtime-fetch.ts",
    find: "    const stopFresh = keepFresh(stage);",
    replace: "    const stopFresh = () => {};",
    test: "tests/electron-runtime-fetch.test.ts",
    filter: "ensureElectronRuntime: a long unpack heartbeats its stage",
  },
  {
    what:
      "a container's in-flight lock temp (pid 7, dead HERE) is swept mid-write at the next acquire",
    file: "src/server/single-instance-lock.ts",
    find:
      "  if ((ns === undefined ? undefined : parseInt(ns, 16)) === ownPidNs()) {",
    replace: '  if (ns !== "" || ownPidNs() === ownPidNs()) {',
    test: "tests/lock-temp-pid-namespace.test.ts",
    filter:
      "lock acquire sweep: another pid namespace's in-flight temp is kept until untouched for 10 min",
  },
  {
    what:
      "a lock dir prune deletes another pid namespace's live watch sentinel and in-flight temp",
    file: "src/server/single-instance-lock.ts",
    find:
      "  if ((ns === undefined ? undefined : parseInt(ns, 16)) === ownPidNs()) {",
    replace: '  if (ns !== "" || ownPidNs() === ownPidNs()) {',
    test: "tests/lock-temp-pid-namespace.test.ts",
    filter:
      "lock dir prune: another pid namespace's temp and sentinel are kept until untouched for 10 min",
  },
  {
    what:
      "am publish reads only a file's first bytes, so every .dmg (known by its koly trailer) is skipped and a release ships with no macOS at all",
    file: "src/am/am-cmd-publish.ts",
    find: "      : new Uint8Array([...read(0, 8), ...read(size - 512, 512)]);",
    replace: "      : read(0, 8);",
    test: "tests/am-publish.test.ts",
    filter:
      "am publish: a .dmg is the download, the .app.tar.gz is the electron-app release",
  },
  {
    what:
      "a .dmg with no update manifest for its platform is published silently, and those installs never update",
    file: "src/am/am-cmd-publish.ts",
    find: "  if (stranded.length > 0) sayErr(strandedWarning(stranded));",
    replace: "  void strandedWarning;",
    test: "tests/am-publish.test.ts",
    filter:
      "am publish: a .dmg whose platform got no manifest is warned on stderr",
  },
  {
    what:
      "a macOS .app looks for its install beside the executable instead of the enclosing X.app, so an electron-app release finds nothing to replace",
    file: "src/server/updates-apply.ts",
    find: "  if (app) return app;",
    replace: "  void app;",
    test: "tests/macos-app-self-update.test.ts",
    filter: "installDir: a bundle executable walks up to the enclosing .app",
  },
  {
    what:
      "a translocated (read-only) .app downloads the whole release and then fails the swap, instead of telling the user to move it to /Applications",
    file: "src/server/updates-runtime.ts",
    find: "    if (stuck) throw new Error(stuck);",
    replace: "    void stuck;",
    test: "tests/updates-e2e.test.ts",
    filter:
      "updates e2e: a translocated .app refuses before downloading, naming /Applications",
  },
  {
    what:
      "a downloaded .app whose code signature does not verify is swapped in, leaving an app macOS will not open",
    file: "src/server/updates-runtime.ts",
    find: "      const smoked = !sealed.ok ? sealed : exe === null",
    replace: "      const smoked = exe === null",
    test: "tests/updates-e2e.test.ts",
    filter:
      "updates e2e: a .app whose code signature does not verify is refused and v1 stays",
  },
  {
    what:
      "a swapped .app is relaunched by exec'ing the bundle folder instead of through LaunchServices, so the new version never opens",
    file: "src/server/updates-runtime.ts",
    find: '                launcher: "/usr/bin/open",',
    replace: "",
    test: "tests/updates-e2e.test.ts",
    filter:
      "updates e2e: a .app release is unpacked AS the bundle, seal-checked, and relaunched via open -n",
  },
  {
    what:
      "a refused unattended install (bad seal, translocated app) is never logged: the cell swallows it into state",
    file: "src/server/updates-boot.ts",
    find: '      if (c.status === "error") fail(refused, c.error);',
    replace: "      if (c.status === null) fail(refused, c.error);",
    test: "tests/updates-boot-check-backoff.test.ts",
    filter:
      "updates: a refused auto-install is logged and backs off like any failure",
  },
  {
    what:
      "each directory update (electron-zip, a macOS .app) leaks one whole old install, forever",
    file: "src/server/updates-boot.ts",
    find:
      "  _confirm.pruned = pruneOld(\n    pending!.artifact ?? artifactPath(),\n    KEEP_OLD,\n    dataDir,\n  ).catch(",
    replace:
      "  _confirm.pruned = Promise.resolve(void [KEEP_OLD, pruneOld]).catch(",
    test: "tests/updates-rollback.test.ts",
    filter:
      "boot: confirming a directory update keeps only the newest KEEP_OLD rollbacks",
  },
  {
    what:
      "swap-rollback: the helper swaps a never-started version back while it is still running (the old version starts beside it)",
    file: "src/server/updates-apply.ts",
    find: '    kill -s "$sig" $ps 2>/dev/null',
    replace: "    : $ps",
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "first-boot rollback: helper claims first — the running new version is stopped before the swap back, and its boot then loses",
  },
  {
    what:
      "swap-rollback: a helper that lost the first-boot claim rolls back anyway — a version that booted is swapped out under itself",
    file: "src/server/updates-apply.ts",
    find: 'mv -f "$token" "$failed" 2>/dev/null || exit 0',
    replace: 'cp "$token" "$failed" 2>/dev/null || exit 0',
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "first-boot rollback: new version claims first, even at the timeout instant — the helper steps aside",
  },
  {
    what:
      "swap-rollback: a boot that lost the first-boot claim keeps running while the helper puts the old version back",
    file: "src/server/updates-boot.ts",
    find: '  if (claim === undefined || claim === "lost") {',
    replace: '  if (claim === undefined || claim === ("x" as string)) {',
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "first-boot rollback: a boot that lost the token exits without touching the data dir",
  },
  {
    what:
      "swap failure: a move that fails leaves NO app running and the marker behind",
    file: "src/server/updates-apply.ts",
    find:
      '  3) note "the new version could not be moved into place"\n     rm -rf "$new"\n     exec "$launch" "$@" ;;',
    replace: "  3) exit 1 ;;",
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "swap failure: the new version cannot be moved into place — the old one is started, and the record says why",
  },
  {
    what:
      "swap failure: a leftover copy that cannot be removed gets the running version moved INSIDE it",
    file: "src/server/updates-apply.ts",
    find:
      '[ -e "$prev" ] || [ -L "$prev" ] || { swap_in "$cur" "$new" "$prev"; r=$?; }',
    replace: '{ swap_in "$cur" "$new" "$prev"; r=$?; }',
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "swap failure: an earlier copy that cannot be removed — nothing moves, the old one is started",
  },
  {
    what:
      "judge: the old version finding the pending marker counts it as the new build's boot (and later confirms it healthy)",
    file: "src/server/updates-boot.ts",
    find: "    pending.fromExe === (deps.exe ?? exeIdentity());",
    replace: '    pending.fromExe === "never";',
    test: "tests/updates-boot-judge-hardening.test.ts",
    filter:
      "judge: the OLD version finding the marker is not the new one's boot — recorded as failed, never confirmed",
  },
  {
    what:
      "judge: a file error recording a boot attempt kills the boot, which the next boot counts as a failed build",
    file: "src/server/updates-boot.ts",
    find:
      // aio-ok: mutation source text — the `${…}` is code to find, not a message
      "        `${pending.from} → ${pending.to} (${e}) — booting anyway, uncounted`,\n      );\n      return false;",
    replace:
      // aio-ok: mutation source text — the `${…}` is code to find, not a message
      "        `${pending.from} → ${pending.to} (${e}) — booting anyway, uncounted`,\n      );\n      throw e;",
    test: "tests/updates-boot-judge-hardening.test.ts",
    filter: "judge: an attempt that cannot be recorded does not kill the boot",
  },
  {
    what:
      "judge: a Windows directory install tries to move the folder it runs from (every in-app rollback of one failed)",
    file: "src/server/updates-boot.ts",
    find: '  if ((deps.os ?? Deno.build.os) === "windows" && isDir(current)) {',
    replace: '  if ((deps.os ?? Deno.build.os) === "aix" && isDir(current)) {',
    test: "tests/updates-boot-judge-hardening.test.ts",
    filter:
      "judge: a Windows directory install is rolled back by the swap helper, not in-app",
  },
  {
    what:
      "judge: a new build that reports the old version (a repository rebuild, a pinned version) records its own good update as failed and drops its rollback",
    file: "src/server/updates-boot.ts",
    find: "    pending.fromExe === (deps.exe ?? exeIdentity());",
    replace: "    appVersion === pending.from;",
    test: "tests/updates-boot-judge-hardening.test.ts",
    filter:
      "judge: a new build reporting the old version is judged as the new build, not the old",
  },
  {
    what:
      "judge: a torn or null update-failed.json throws out of the first-boot claim, and every boot exits",
    file: "src/server/updates-apply.ts",
    find: '    setAsideRecord(path, f, logger);\n    return "none";',
    replace: "    throw new Error(f);",
    test: "tests/updates-boot-judge-hardening.test.ts",
    filter:
      "judge: a torn or null update-failed.json never stops the boot — set aside, the boot counted",
  },
  {
    what:
      "judge: the failed record is written in place — a reader can see half of it, and a read-only leftover is never replaced",
    file: "src/server/updates-boot.ts",
    find: "    writeRecordAtomic(failedUpdatePath(dataDir), p);",
    replace:
      "    Deno.writeTextFileSync(failedUpdatePath(dataDir), JSON.stringify(p));",
    test: "tests/updates-boot-judge-hardening.test.ts",
    filter:
      "judge: the failed record is replaced atomically, never written in place",
  },
  {
    what:
      "judge: a Windows helper rollback whose move failed restarts the bad build, and the record still says rolled back",
    file: "src/server/updates-boot.ts",
    find: "      failedExe: deps.exe ?? exeIdentity(),",
    replace: "      failedExe: undefined,",
    test: "tests/updates-boot-judge-hardening.test.ts",
    filter:
      "judge: a Windows helper rollback that did not happen is said as a FAILED rollback on the next boot",
  },
  {
    what:
      "swap-rollback: a new version built with aio <= 1.0.12 (it claims through the marker, never the token) is stopped and rolled back after the wait",
    file: "src/server/updates-apply.ts",
    find: '  claimed "$token" && { rm -f "$token"; exit 0; }',
    replace: "  :",
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "first-boot rollback: a new version that rewrites the marker (aio <= 1.0.12) keeps running, without the wait",
  },
  {
    what:
      "swap-rollback: an aio <= 1.0.12 boot at the claim instant is stopped and rolled back although it booted",
    file: "src/server/updates-apply.ts",
    find: 'claimed "$failed" && { rm -f "$failed"; exit 0; }',
    replace: ":",
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "first-boot rollback: an aio <= 1.0.12 boot at the claim instant keeps the new version",
  },
  {
    what:
      "swap helper (windows): a broken WMI ends the helper after the old version exited — no app running",
    file: "src/server/updates-apply.ts",
    find: "}) } catch { @() }",
    replace: "}) } finally {}",
    test: "tests/updates-swap-windows.test.ts",
    filter:
      "swap spec (windows): WMI failure, a held file, and an aio <= 1.0.12 claim never end with no app",
  },
  {
    what:
      "swap helper (windows): a held marker ends the helper after it stopped the new version — no app running",
    file: "src/server/updates-apply.ts",
    find: "Remove-File $mark\n",
    replace: "[IO.File]::Delete($mark)\n",
    test: "tests/updates-swap-windows.test.ts",
    filter:
      "swap spec (windows): WMI failure, a held file, and an aio <= 1.0.12 claim never end with no app",
  },
  {
    what:
      "swap helper (windows): a new version built with aio <= 1.0.12 is stopped and rolled back after the wait",
    file: "src/server/updates-apply.ts",
    find: "  if (Test-Claimed $token) { Remove-File $token; exit 0 }\n",
    replace: "",
    test: "tests/updates-swap-windows.test.ts",
    filter:
      "swap spec (windows): WMI failure, a held file, and an aio <= 1.0.12 claim never end with no app",
  },
  {
    what:
      "am publish: --data / --no-data are ignored on a Mac — the bundle's own answer is published instead",
    file: "src/am/am-cmd-publish.ts",
    find: '      const probed = p.probe === "app" && !dataFlag && !noData',
    replace: '      const probed = p.probe === "app"',
    test: "tests/am-publish.test.ts",
    filter:
      "am publish: on a Mac, --data and --no-data outrank asking the .app",
  },
  {
    what:
      "am publish: a host .app built on another Mac is exec'd here as if this Mac had built it",
    file: "src/am/am-cmd-publish.ts",
    find: '      (key === "host" && (build!.builtOn ?? here) === here);',
    replace: '      key === "host";',
    test: "tests/am-publish.test.ts",
    filter:
      "am publish: a host .app built on another Mac is not asked on this one",
  },
  {
    what:
      "updates: a zip install asks a channel without a kind manifest for it on EVERY check — twice the requests, forever",
    file: "src/server/updates-check.ts",
    find: "    kindAbsentUntil.set(kind, Date.now() + KIND_ABSENT_MS);",
    replace: "    void KIND_ABSENT_MS;",
    test: "tests/updates-kind-manifest.test.ts",
    filter:
      "kind manifest: a channel that answered absent is not asked again each check",
  },
  {
    what:
      "updates: a zip install's channel that answers in 6 s is cut off by a short probe deadline and read as absent",
    file: "src/server/updates-check.ts",
    find: "    got: await fetchManifest(url, etagFor(url), { timeoutMs }),",
    replace:
      "    got: await fetchManifest(url, etagFor(url), { timeoutMs: timeoutMs ?? 5_000 }),",
    test: "tests/updates-kind-manifest.test.ts",
    filter:
      "kind manifest: a slow channel's answer is waited for, like the manifest's",
  },
  {
    what:
      "updates: a kind probe that timed out is read as absent — a zip install is offered the platform's manifest",
    file: "src/server/updates-check.ts",
    find: '        !(e instanceof DOMException && e.name === "TimeoutError")',
    replace: "        (e instanceof DOMException || true)",
    test: "tests/updates-kind-manifest.test.ts",
    filter:
      "kind manifest: a kind fetch that times out fails the check — never the platform's manifest",
  },
  {
    what:
      "updates: a 403, 408 or 429 from the channel is cached as no kind manifest for a day",
    file: "src/server/updates-check.ts",
    find: '        absent: res.status === 410 ? "no-such-file" : "this-time",',
    replace: '        absent: res.status < 500 ? "no-such-file" : "this-time",',
    test: "tests/updates-kind-manifest.test.ts",
    filter:
      "kind manifest: a channel that answered absent is not asked again each check",
  },
  {
    what:
      "updates: an $APPIMAGE inherited from an AppImage parent is taken as this process's own artifact",
    file: "src/server/paths.ts",
    find: '    return exe.startsWith(dir + SEPARATOR) ? "own" : "foreign";',
    replace: '    return "own";',
    test: "tests/updates-targets.test.ts",
    filter:
      "appimage: $APPIMAGE counts only for a process running inside $APPDIR",
  },
  {
    what:
      "am publish: --data / --no-data are ignored for an artifact run directly — the run's answer is published instead",
    file: "src/am/am-cmd-publish.ts",
    find:
      '        ...(p.probe === "exec" && !dataFlag && !noData ? {} : probed',
    replace: '        ...(p.probe === "exec" ? {} : probed',
    test: "tests/am-publish.test.ts",
    filter:
      "am publish: --data and --no-data outrank running the host artifact; no flag still runs it",
  },
  {
    what:
      "judge: the next boot overwrites the swap helper's truthful failed record of the same update",
    file: "src/server/updates-boot.ts",
    find:
      "    if (helper?.startedAt === pending.startedAt && helper.to === pending.to) {",
    replace: "    if (false) {",
    test: "tests/updates-boot-judge-hardening.test.ts",
    filter:
      "judge: the old version keeps the swap helper's record of the same update, and only drops the marker",
  },
  {
    what:
      "updates: after a failed rollback that restarted the old copy, the boot log says it is still the new version",
    file: "src/server/updates-boot.ts",
    find: "              failed.fromExe === (deps.exe ?? exeIdentity())",
    replace: '              failed.fromExe === "never"',
    test: "tests/updates-boot-judge-hardening.test.ts",
    filter:
      "judge: a failed rollback that restarted the old version from its set-aside copy says so",
  },
  {
    what:
      "swap helper (unix): with no cmp on the PATH, a dead new version is read as having claimed and is kept",
    file: "src/server/updates-apply.ts",
    find: '  a=$(cat "$mark") && b=$(cat "$1") || return 1\n  [ "$a" != "$b" ]',
    replace: '  ! cmp -s "$mark" "$1"',
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "first-boot rollback: cmp fails to run — still no claim, the dead version is put back",
  },
  {
    what:
      "swap helper (unix): a marker the helper cannot read counts as the new version's claim",
    file: "src/server/updates-apply.ts",
    find: '  a=$(cat "$mark") && b=$(cat "$1") || return 1',
    replace: '  a=$(cat "$mark") && b=$(cat "$1") || return 0',
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "first-boot rollback: the marker cannot be read — still no claim, the dead version is put back",
  },
  {
    what:
      "swap helper (unix): when neither version can be moved back, the record is written and no app is started",
    file: "src/server/updates-apply.ts",
    find: '  start "$@"\n}\n# The new version claimed',
    replace: "  exit 1\n}\n# The new version claimed",
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "first-boot rollback: neither version can be moved back — the record says so, and the old one is started where it is",
  },
  {
    what:
      "swap helper (unix): when neither version can be moved into place, the helper exits and leaves no app running",
    file: "src/server/updates-apply.ts",
    find: 'nor the old one back"\n     start "$@" ;;',
    replace: 'nor the old one back"\n     exit 1 ;;',
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "swap failure: neither version can be moved into place — the record says why, and the old one is started where it is",
  },
  {
    what:
      "swap helper (unix): a launcher outside the install is still handed the moved-away install path",
    file: "src/server/updates-apply.ts",
    find: 'a="$1"; shift; [ "$a" = "$cur" ] && a="$d"; set -- "$@" "$a"',
    replace: 'a="$1"; shift; set -- "$@" "$a"',
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "swap failure: a launcher outside the install is handed the copy that is left",
  },
  {
    what:
      "swap helper (windows): when neither version can be moved back, the record is written and no app is started",
    file: "src/server/updates-apply.ts",
    find: "  } catch {}\n  Start-Any\n}",
    replace: "  } catch {}\n}",
    test: "tests/updates-swap-windows.test.ts",
    filter:
      "swap spec (windows): the first-boot watchdog and the swap-failure path, in order",
  },
  {
    what:
      "swap helper (windows): the helper's read of the marker locks out the new build's rename of it",
    file: "src/server/updates-apply.ts",
    find: "([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)",
    replace: "[IO.FileShare]::Read",
    test: "tests/updates-swap-windows.test.ts",
    filter:
      "swap spec (windows): no move back still starts a copy, and every read lets the app rename the file",
  },
  {
    what:
      "swap helper (windows): a failed windowless start reports a later call's error code, not its own",
    file: "src/server/no-console.ts",
    find: "        codes.push(k32.symbols.GetLastError());",
    replace: "        codes.push(0);",
    test: "tests/no-console.test.ts",
    filter:
      "startWindowless: each failed CreateProcessW's error is read right after it",
  },
  {
    what:
      "swap-rollback: a move back that fails ends the helper with no app running, and the record says rolled back",
    file: "src/server/updates-apply.ts",
    find:
      '  3) unrolled "the old version could not be moved back into place" "$@" ;;',
    replace: "  3) exit 1 ;;",
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "first-boot rollback: the old version cannot be moved back — the version in place is started, and the record says the rollback failed",
  },
  {
    what:
      "swap helper (windows): a move back that fails ends the helper with no app running",
    file: "src/server/updates-apply.ts",
    find:
      "if ($r -eq 1) { Set-Unrolled 'the new version could not be moved out of the way'; exit 1 }",
    replace: "if ($r -eq 1) { exit 1 }",
    test: "tests/updates-swap-windows.test.ts",
    filter:
      "swap spec (windows): the first-boot watchdog and the swap-failure path, in order",
  },
  {
    what:
      "judge: an executable the swap does not replace (a deno run) is recorded as the old build — every good update is judged not taken",
    file: "src/server/updates-apply.ts",
    find: "    const inside = exe === dir || exe.startsWith(dir + SEPARATOR);",
    replace: "    const inside = true;",
    test: "tests/updates-boot-judge-hardening.test.ts",
    filter:
      "judge: the old build's identity is recorded only when the swap replaces the running executable",
  },
  {
    what:
      "failed record: an unreadable update-failed.json is reported on every boot, forever",
    file: "src/server/updates-apply.ts",
    find: "    moveFileSync(path, aside);",
    replace: "    void aside;",
    test: "tests/updates-boot-judge-hardening.test.ts",
    filter: "failed record: an unreadable one is said ONCE and moved aside",
  },
  {
    what:
      "failed record: a swap that could not be made is reported as a version that never started",
    file: "src/server/updates-boot.ts",
    find: "        : failed.swapFailed\n",
    replace: '        : failed.swapFailed === "never"\n',
    test: "tests/updates-boot-judge-hardening.test.ts",
    filter: "failed record: the words match what happened, and the OS",
  },
  {
    what:
      "updates: a swap helper that cannot start is logged as an installed update, the marker kept, and the app gone",
    file: "src/server/updates-runtime.ts",
    find: "            clearPending(deps.dataDir);\n",
    replace: "",
    test: "tests/updates-e2e.test.ts",
    filter:
      "updates e2e: a swap helper that cannot start — not installed, undone, this version restarts",
  },
  {
    what:
      "swap-rollback (windows): the PowerShell helper never watches the first boot — a bare Start-App",
    file: "src/server/updates-apply.ts",
    find: "  if (-not [IO.File]::Exists($token)) { exit 0 }\n",
    replace: "",
    test: "tests/updates-swap-windows.test.ts",
    filter:
      "swap spec (windows): the first-boot watchdog and the swap-failure path, in order",
  },
  {
    what:
      "macOS: an app already in /Applications is told to move to /Applications",
    file: "src/server/updates-apply.ts",
    find: '  return dirname(app) === "/Applications"',
    replace: '  return dirname(app) === "/nowhere"',
    test: "tests/macos-app-self-update.test.ts",
    filter:
      "translocation guard: an unwritable /Applications says whose folder it is",
  },
  {
    what:
      "swap helper (windows): the cmd.exe fallback carries the 8.8 KB encoded script on its command line — cmd refuses it and nothing runs",
    file: "src/server/updates-apply.ts",
    find: '  const i = args.indexOf("-EncodedCommand");',
    replace: "  const i = -1 as number;",
    test: "tests/no-console.test.ts",
    filter:
      "swap helper (windows): started windowless, else through cmd.exe — never a detached PowerShell",
  },
  {
    what:
      "swap helper (windows): the helper is a detached PowerShell again — no console, it runs nothing, and no update or rollback happens",
    file: "src/server/updates-apply.ts",
    find:
      '    "cmd.exe",\n    swapHelperOptions(["/d", "/c", cmd, ...via.args], {',
    replace: "    cmd,\n    swapHelperOptions([...args], {",
    test: "tests/no-console.test.ts",
    filter:
      "swap helper (windows): started windowless, else through cmd.exe — never a detached PowerShell",
  },
  {
    what:
      "swap helper (windows): a windowless start is followed by a second helper — two swaps race over one install",
    file: "src/server/updates-apply.ts",
    find: '  if (typeof started === "number") return;',
    // A second helper after the windowless one — and it type-checks (a bare
    // fall-through reads `started.startsWith` on a number).
    replace:
      '  if (typeof started === "number") return start("cmd.exe", { args: [] });',
    test: "tests/no-console.test.ts",
    filter:
      "swap helper (windows): started windowless, else through cmd.exe — never a detached PowerShell",
  },
  {
    what:
      "swap helper (windows): the install is moved while Electron from it still runs — the move fails and the update is lost",
    file: "src/server/updates-apply.ts",
    find:
      "for ($i = 0; $i -lt 150 -and @(Get-Running).Count -gt 0; $i++) { Start-Sleep -Milliseconds 200 }\n",
    replace: "",
    test: "tests/updates-swap-windows.test.ts",
    filter:
      "swap spec (windows): the first-boot watchdog and the swap-failure path, in order",
  },
  {
    what:
      "the Mac build never packs the signed .app as the update artifact, so no macOS install can ever self-update",
    file: "src/build/dmg.ts",
    find: "    ...(opts.sign && opts.updateOut",
    replace: "    ...(!opts.sign && opts.updateOut",
    test: "tests/macos-app-self-update.test.ts",
    filter:
      "dmg: the update tarball is packed right after signing, only when signed",
  },
  {
    what:
      "another pid namespace's app lock is judged by a pid that means nothing here",
    file: "src/server/single-instance-lock.ts",
    find: "  if (lock.ns !== undefined && lock.ns !== ownPidNs()) {",
    replace: "  if (lock.ns === -1) {",
    test: "tests/lock-foreign-namespace-hold.test.ts",
    filter:
      "app lock, foreign pid namespace, no hold (a placeholder): alive only until a boot that long counts as stuck",
  },
  {
    what:
      "a dead container's app lock reads alive forever (its hold is never probed)",
    file: "src/server/single-instance-lock.ts",
    find: "      if (f.tryLockSync(true)) return false;",
    replace: "      if (f.tryLockSync(true)) return true;",
    test: "tests/lock-foreign-namespace-hold.test.ts",
    filter:
      "app lock, foreign pid namespace: alive while its hold is locked — even when its pid is ours — never taken, never signalled; dead once the hold is free",
  },
  {
    what:
      "a container's live pid equal to ours reads as our own lock (taken over, released, overwritten)",
    file: "src/server/single-instance-lock.ts",
    find: "    (lock.ns === undefined || lock.ns === ownPidNs());",
    replace: "    (lock.ns === undefined || lock.ns !== -1);",
    test: "tests/lock-foreign-namespace-hold.test.ts",
    filter:
      "app lock, foreign pid namespace: alive while its hold is locked — even when its pid is ours — never taken, never signalled; dead once the hold is free",
  },
  {
    what: "a pid from another pid namespace is signalled here",
    file: "src/server/single-instance-lock.ts",
    find: "  if (lock.ns === undefined || lock.ns === ownPidNs()) return null;",
    replace: "  if (lock.ns !== -1) return null;",
    test: "tests/lock-foreign-namespace-hold.test.ts",
    filter:
      "app lock, foreign pid namespace: alive while its hold is locked — even when its pid is ours — never taken, never signalled; dead once the hold is free",
  },
  {
    what: "a takeover (killExisting) probes and signals a live container's app",
    file: "src/server/single-instance-lock.ts",
    find: "      if (foreign) {",
    replace: '      if (foreign === "") {',
    test: "tests/lock-foreign-namespace-hold.test.ts",
    filter:
      "app lock, foreign pid namespace: alive while its hold is locked — even when its pid is ours — never taken, never signalled; dead once the hold is free",
  },
  {
    what:
      "the app lock records no hold, so another namespace cannot see the owner alive",
    file: "src/server/single-instance-lock.ts",
    find: "      ...(this._hold ? { hold: basename(this._hold.path) } : {}),",
    replace: '      ...(this._hold === null ? { hold: basename("") } : {}),',
    test: "tests/lock-foreign-namespace-hold.test.ts",
    filter:
      "app lock, foreign pid namespace: alive while its hold is locked — even when its pid is ours — never taken, never signalled; dead once the hold is free",
  },
  {
    what: "a lock CAS for our pid 7 rewrites a container's pid 7",
    file: "src/server/single-instance-lock.ts",
    find:
      "  if (was.ns !== undefined && now.ns !== undefined && was.ns !== now.ns) {",
    replace: "  if (was.ns === -1) {",
    test: "tests/lock-foreign-namespace-hold.test.ts",
    filter: "app lock CAS: the same pid in another namespace is another owner",
  },
  {
    what:
      "on Windows the relaunched successor dies with the exiting app, so an installed update just closes the app",
    file: "src/server/no-console.ts",
    find: '  return os === "windows" ? { detached: true } : {};',
    replace: "  return {};",
    test: "tests/no-console.test.ts",
    filter:
      "outliving children: the successor and the swap helper are detached on Windows",
  },
  {
    what:
      "download progress is dispatched per chunk — thousands of dispatch+persist+broadcast rounds for one desktop update",
    file: "src/server/updates-check.ts",
    find: "        if (pct > reported) {",
    replace: "        if (pct >= reported) {",
    test: "tests/updates-fetch.test.ts",
    filter:
      "updates: download progress is reported per whole percent, not per chunk",
  },
  {
    what:
      "a refused install's error is wiped by the poll's next check of the same release, leaving no trace in the UI",
    file: "src/state/updates-cell.ts",
    find: "          s.error = slot.applyFailed.error;",
    replace: "          s.error = null;",
    test: "tests/updates-cell.test.ts",
    filter:
      "a refused install stays visible across the poll's next check of the same release",
  },
  {
    what: "a refused install (a tampered download) is never logged",
    file: "src/server/updates-runtime.ts",
    find: "    apply: loggingFailure(async (opts: ApplyOpts = {}) => {",
    replace: "    apply: (async (opts: ApplyOpts = {}) => {",
    test: "tests/updates-e2e.test.ts",
    filter:
      "updates e2e: a SAME-SIZE tampered artifact is refused by its digest",
  },
  {
    what:
      "am publish refuses every Windows Electron build (exe + zip for one platform) instead of publishing the exe and offering the zip for download",
    file: "src/am/am-cmd-publish.ts",
    find: "  const runnable = files.filter((f) => !/\\.zip$/i.test(f));",
    replace: "  const runnable = files;",
    test: "tests/am-publish.test.ts",
    filter:
      "am publish: Windows electron's exe + zip: the exe is the platform's update, the zip gets its own kind manifest",
  },
  {
    what:
      "an error offers the same choice twice ('--target=electron (or --target=electron)')",
    file: "src/am/am-cmd-publish.ts",
    find: "  const u = [...new Set(values)].map(show);",
    replace: "  const u = values.map(show);",
    test: "tests/am-publish.test.ts",
    filter: "am publish: choiceList never offers the same choice twice",
  },
  {
    what:
      "a sub-minute update cadence is reported as 'every 0m' — it reads as never",
    file: "src/server/boot-facts.ts",
    find: "      : u.intervalMs % 1000 === 0",
    replace: "      : false",
    test: "tests/boot-facts.test.ts",
    filter: "boot report: a sub-minute cadence is said exactly, never '0m'",
  },
  {
    what:
      "every restart reports a cell's UNPERSISTED fields as 'not in the stored data — new, or a method deleted it'",
    file: "src/server/aio-boot.ts",
    find: "      ? applyCellFieldFilter(filter, declState)",
    replace: "      ? declState",
    test: "tests/persist-filtered-field-not-new-on-restart.test.ts",
    filter:
      "persist: fields a cell never persists are not reported as new on restart — a new one still is",
  },
  {
    what:
      "every refused auto-install is logged twice — by the runtime and by the boot's retry line",
    file: "src/server/updates-boot.ts",
    find:
      "        await unattendedInstall(runtime, () => updatesCell().apply());",
    replace: "        await updatesCell().apply();",
    test: "tests/updates-boot-check-backoff.test.ts",
    filter:
      "updates: a refused auto-install through the real runtime is ONE line",
  },
  {
    what:
      "the update's smoke probe spawns on the app's thread — Windows' antivirus scan inside CreateProcess freezes the app 16–20 s",
    file: "src/server/updates-apply.ts",
    find: "    out = await probeOffThread(path, args, timeoutMs);",
    replace:
      '    new Deno.Command(path, { args, stdout: "null", stderr: "null" }).spawn();\n    out = await probeOffThread(path, args, timeoutMs);',
    test: "tests/updates-apply.test.ts",
    filter: "smoke test: the probe's spawn never blocks the app's thread",
  },
  {
    what:
      "updates:apply keeps the 30 s call ceiling — a slow install is reported as failed while it goes on and restarts the app",
    file: "src/state/updates-cell.ts",
    // THE enforcing line is the pause in `unbounded()`: it lifts every
    // pending deadline, the method's own included, so `long: ["check",
    // "apply"]` is belt and braces — mutating it leaves the suite green.
    find: "  const resume = pauseCallDeadlines();",
    replace: "  const resume = () => {};",
    test: "tests/updates-apply-from-method.test.ts",
    filter:
      "updates: an app method awaiting a slow check and install is not 'stopped waiting'",
  },
  {
    what:
      "a packaged Electron app's main-process warnings (a permission DENIED, an openWindow, a main-process crash) go to a stderr nobody reads, never app.log",
    file: "src/electron/electron-shared.ts",
    find: "for (const __aioLv of ['warn', 'error']) {",
    replace: "for (const __aioLv of []) {",
    test: "tests/electron-renderer-log.test.ts",
    filter:
      "shells: the main process's console.warn/error reach the app log, one tagged line each",
  },
  {
    what:
      "the parent never recognises a tagged main-process line, so a packaged app's DENIED warnings print raw and miss app.log",
    file: "src/electron/electron-renderer-log.ts",
    find: "  const mm = MAIN_LINE.exec(line);",
    replace: '  const mm = MAIN_LINE.exec("");',
    test: "tests/electron-renderer-log.test.ts",
    filter:
      "classifier: a tagged main-process warn/error is forwarded under `electron`; other levels stay raw",
  },
  {
    what:
      "a timer the test body arms inside a nested testUI is fenced to that inner mount and refused once it closes, though the outer mount lives",
    file: "src/standalone-air.ts",
    find: "  return () => _fences.get(_liveBoots[0]?.app as object);",
    replace:
      "  return () => _fences.get(_liveBoots[_liveBoots.length - 1]?.app as object);",
    test: "tests/testui-timer-fence-nested.test.tsx",
    filter:
      "testUI: a test-body timer armed inside a nested mount reaches the live outer mount",
  },
  {
    what:
      "a dead boot's timer call is refused by a synchronous throw out of the timer — no .catch sees it and the uncaught error kills the test file",
    file: "src/standalone-air.ts",
    find:
      "  const p = Promise.reject(_deadGeneration(type, caller.site, caller.boot));",
    replace:
      "  const p: Promise<never> = _refuseDeadGeneration(type, caller.site, caller.boot);",
    test: "tests/testui-timer-fence-nested.test.tsx",
    filter:
      "testUI: a timer the nested mount's METHOD armed is refused once that mount closes — the outer mount untouched, 'none since'",
  },
  {
    what:
      'the torn-down-runtime refusal says "0 since" when no boot came after the refused one',
    file: "src/standalone-air.ts",
    find: '      since || "none"',
    replace: "      since",
    test: "tests/testui-timer-fence-nested.test.tsx",
    filter:
      "testUI: a timer the nested mount's METHOD armed is refused once that mount closes — the outer mount untouched, 'none since'",
  },
  {
    what:
      "a timer an INNER mount's re-render armed (the test body's write re-rendered it) goes to the outer mount and commits there once the inner closes",
    file: "src/testing/boot-refusals.ts",
    find:
      "  return (root ? _rootFences.get(root) : undefined) ?? outer?.fence ??",
    replace: "  return outer?.fence ??",
    test: "tests/testui-timer-fence-nested.test.tsx",
    filter:
      "testUI: a timer the INNER mount's component armed (on mount, from a click, from its own timer) is refused once it closes — never committed into the outer mount",
  },
  {
    what:
      "a timer an INNER mount's click handler armed goes to the outer mount — the handle's driving never marks its mount active",
    file: "src/testing/boot-refusals.ts",
    find: "  return fence ? _mountAls.run(fence, fn) : fn();",
    replace: "  return fn();",
    test: "tests/testui-timer-fence-nested.test.tsx",
    filter:
      "testUI: a timer the INNER mount's component armed (on mount, from a click, from its own timer) is refused once it closes — never committed into the outer mount",
  },
  {
    what:
      "a queued action (click/type) runs outside its mount, so the timer its handler arms goes to the outer mount",
    file: "src/testing/ui-test.ts",
    find: "    const run = _tail.then(() => _inMount(mountFence, fn));",
    replace: "    const run = _tail.then(fn);",
    test: "tests/testui-timer-fence-nested.test.tsx",
    filter:
      "testUI: a timer the INNER mount's component armed (on mount, from a click, from its own timer) is refused once it closes — never committed into the outer mount",
  },
  {
    what:
      "a timer a nested mount's METHOD armed is attributed by the driving/outer mount instead of the method's own boot",
    file: "src/testing/boot-refusals.ts",
    find:
      "  return (root ? _rootFences.get(root) : undefined) ?? outer?.fence ??\n",
    replace: "  return (root ? _rootFences.get(root) : undefined) ??\n",
    test: "tests/testui-timer-fence-nested.test.tsx",
    filter:
      "testUI: a timer the nested mount's METHOD armed is refused once that mount closes — the outer mount untouched, 'none since'",
  },
  {
    what:
      "acquire takes over a container's live lock that names our pid as our own placeholder",
    file: "src/server/single-instance-lock.ts",
    find: "      if (isOwnLock(existing) || _handedOver(existing)) {",
    replace: "      if (existing.pid === Deno.pid || _handedOver(existing)) {",
    test: "tests/lock-foreign-namespace-hold.test.ts",
    filter:
      "app lock, foreign pid namespace, the record naming OUR pid: never taken over, updated or released as ours",
  },
  {
    what: "update() writes into a container's live lock that names our pid",
    file: "src/server/single-instance-lock.ts",
    find: "      if (!existing || !isOwnLock(existing)) {",
    replace: "      if (!existing || existing.pid !== Deno.pid) {",
    test: "tests/lock-foreign-namespace-hold.test.ts",
    filter:
      "app lock, foreign pid namespace, the record naming OUR pid: never taken over, updated or released as ours",
  },
  {
    what: "release() removes a container's live lock that names our pid",
    file: "src/server/single-instance-lock.ts",
    find: "    if (now && isOwnLock(now)) {",
    replace: "    if (now && now.pid === Deno.pid) {",
    test: "tests/lock-foreign-namespace-hold.test.ts",
    filter:
      "app lock, foreign pid namespace, the record naming OUR pid: never taken over, updated or released as ours",
  },
  {
    what:
      "check-orphans judges a container's lock by a bare pid: a live container's lock is removed, a host pid named by a dead one is signalled",
    file: "scripts/check-orphans.ts",
    find: "        if (ownerAlive(lock, dir)) {",
    replace: "        if (pid > 0 && alive(pid)) {",
    test: "tests/check-orphans-foreign-ns.test.ts",
    filter:
      "check-orphans: a foreign-namespace lock is judged by its hold — a live host pid is never reported (signalled), a live container's lock never removed",
  },
  {
    what:
      "check-orphans reports (and clean:tmp SIGTERMs) a live container's app by a pid that is a stranger here",
    file: "scripts/check-orphans.ts",
    find:
      "          if (foreignOwnerRefusal({ pid, ns: lock?.ns }) !== null) continue;",
    replace: "          void foreignOwnerRefusal;",
    test: "tests/check-orphans-foreign-ns.test.ts",
    filter:
      "check-orphans: a foreign-namespace lock is judged by its hold — a live host pid is never reported (signalled), a live container's lock never removed",
  },
  {
    what:
      'a page that only queries a permission (navigator.permissions.query) is refused in silence — the dev never learns why it reads "denied"',
    file: "src/electron/electron-shared.ts",
    find: "      if (!ok) __aioPermDenied(wc, permission, requestingOrigin);",
    replace: "      if (!ok) void 0;",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: a denied CHECK is said once per origin and permission; an allowed one stays quiet",
  },
  {
    what:
      "Chromium's own permission checks at every load and navigation are logged as DENIED, telling a dev to grant media/web-app-installation/geolocation the app never used",
    file: "src/electron/electron-shared.ts",
    find:
      "const __aioProbed = new Set(['media', 'web-app-installation', 'geolocation']);",
    replace: "const __aioProbed = new Set();",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: a denied CHECK is said once per origin and permission; an allowed one stays quiet",
  },
  {
    // Two defences, each enough alone (streams swallow 'error'; Node's console
    // ignores a write error) — so one row disables both.
    what:
      "a dead stderr pipe (the aio server gone) loops EPIPE -> uncaughtException -> console.error in the Electron main process, calling app.quit() tens of thousands of times a second",
    file: "src/electron/electron-shared.ts",
    find:
      "  try { __aioS.on('error', () => {}); } catch {}\n}\nfor (const __aioLv of ['warn', 'error']) {\n  const __aioOut = console[__aioLv].bind(console);",
    replace:
      "  void __aioS;\n}\nfor (const __aioLv of ['warn', 'error']) {\n  const __aioOut = (x) => process.stderr.write(x + '\\\\n');",
    test: "tests/electron-renderer-log.test.ts",
    // Needs node_modules/electron (ELECTRON_RUN_AS_NODE). Asserts the
    // CONSEQUENCE of the dead-pipe handlers: with them removed the process
    // spins uncaughtException → app.quit() and never writes its report.
    // The tagging unit test alone still passes under this mutant (tags are
    // applied before __aioOut), so it cannot guard this invariant.
    filter:
      "shells: a dead stderr pipe never loops EPIPE → uncaughtException → console.error",
  },
  {
    what:
      "a main-process line carrying the app's share link writes its key (?token=) into app.log, which is copied into bug reports",
    file: "src/electron/electron-shared.ts",
    find: "      const s = __aioRedact(require('util').format(...a));",
    replace: "      const s = require('util').format(...a);",
    test: "tests/electron-renderer-log.test.ts",
    filter:
      "shells: the main process's console.warn/error reach the app log, one tagged line each",
  },
  {
    what:
      "a permission denial prints the full requesting URL, so the app's own ?token= key lands in app.log",
    file: "src/electron/electron-shared.ts",
    find:
      "      ? \"the app's own page \" + origin + ' — electron.permissions does not grant it; add \"' +",
    replace:
      "      ? \"the app's own page \" + requesting + ' — electron.permissions does not grant it; add \"' +",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: a denial names the origin only — never the app's key — and the lines are bounded",
  },
  {
    what:
      "the said-denials set grows without bound while a guest browses, and every new origin adds an app.log line forever",
    file: "src/electron/electron-shared.ts",
    find: "  if (__aioPermSaid.size >= 256) {",
    replace: "  if (__aioPermSaid.size >= 1e9) {",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: a denial names the origin only — never the app's key — and the lines are bounded",
  },
  {
    what:
      "the parent files a main-process warning under the `renderer` category, so app.log blames the page for what the shell said",
    file: "src/electron/electron-spawn.ts",
    find: "          log.warn(r.from, r.text);",
    replace: '          log.warn("renderer", r.text);',
    test: "tests/electron-renderer-log.test.ts",
    filter:
      "forwardStderr: tagged lines reach the log sink under their category",
  },
  {
    what:
      "the classifier names a main-process line `renderer`, so app.log blames the page for what the shell said",
    file: "src/electron/electron-renderer-log.ts",
    find: 'text: mm[2]!, from: "electron" };',
    replace: 'text: mm[2]!, from: "renderer" };',
    test: "tests/electron-renderer-log.test.ts",
    filter:
      "forwardStderr: tagged lines reach the log sink under their category",
  },
  {
    what:
      "denials are deduped per URL, not per origin, so every page of a guest repeats the same DENIED line into app.log",
    file: "src/electron/electron-shared.ts",
    find:
      "  const key = (app ? 'app ' : 'embedded ') + permission + ' ' + origin;",
    replace:
      "  const key = (app ? 'app ' : 'embedded ') + permission + ' ' + requesting;",
    test: "tests/electron-permission-guard.test.ts",
    filter:
      "permissions: a denied CHECK is said once per origin and permission; an allowed one stays quiet",
  },
  {
    what:
      "an Electron/Node deprecation warning lands in app.log at ERROR, so a harmless deprecation reads as a failure",
    file: "src/electron/electron-shared.ts",
    find: "? 'warn' : __aioLv;",
    replace: "? __aioLv : __aioLv;",
    test: "tests/electron-renderer-log.test.ts",
    filter:
      "shells: the main process's console.warn/error reach the app log, one tagged line each",
  },
  {
    what:
      "a build record listing one target twice for a platform offers '--target=browser or --target=browser' instead of saying rebuild",
    file: "src/am/am-cmd-publish.ts",
    find: "          (owner === t.target",
    replace: "          (false",
    test: "tests/am-publish.test.ts",
    filter:
      "am publish: one target recorded twice for a platform says rebuild, not pick",
  },
  {
    what:
      "a Mac-built .app.tar.gz published on a Mac is never asked its data contract, so every Mac install holding data refuses every release",
    file: "src/am/am-cmd-publish.ts",
    find: '      ? (runsHere && here.startsWith("macos") ? "app" : null)',
    replace: "      ? null",
    test: "tests/am-publish.test.ts",
    filter:
      "am publish: on a Mac, a Mac-built .app.tar.gz is unpacked and asked its data contract",
  },
  {
    what:
      "a Mac .app nobody here can ask goes out with no data contract, silently, instead of being refused like aio ship",
    file: "src/am/am-cmd-publish.ts",
    find: "    macBlind.length > 0 && !dataFlag && !noData &&",
    replace: "    false && !dataFlag && !noData &&",
    test: "tests/am-publish.test.ts",
    filter:
      "am publish: a Mac .app nobody here can ask is refused without --data/--no-data",
  },
  {
    what:
      "a release published with no data contract says so only in the human text — a --json CI log never hears it",
    file: "src/am/am-cmd-publish.ts",
    find: "  if (blind.length > 0) sayErr(noContractWarning(blind, noData));",
    replace: "  void noContractWarning;",
    test: "tests/am-publish.test.ts",
    filter:
      "am publish: a Mac .app nobody here can ask is refused without --data/--no-data",
  },
  {
    what:
      "the documented `ship --target=electron-app` is refused by the CLI as an unknown target",
    file: "src/build/ship.ts",
    find: "  if (target !== undefined && !isReleaseTarget(target)) {",
    replace: "  if (target !== undefined && !isUpdateTarget(target)) {",
    test: "tests/ship-electron-app-target.test.ts",
    filter: "ship: --target=electron-app is accepted by the CLI",
  },
  {
    what:
      "shipping target electron-app is refused as an unknown target by the programmatic door",
    file: "src/build/ship.ts",
    find: "  if (opts.target !== undefined && !isReleaseTarget(opts.target)) {",
    replace:
      "  if (opts.target !== undefined && !isUpdateTarget(opts.target)) {",
    test: "tests/ship-electron-app-target.test.ts",
    filter:
      "ship: --target=electron-app is accepted by shipRelease (the door shipApp delegates to)",
  },
  {
    what:
      "a Windows zip is published download-only, so every install unpacked from it sees every release as incompatible, forever",
    file: "src/am/am-cmd-publish.ts",
    find: "    const zips = pick.downloads.filter((f) => /\\.zip$/i.test(f));",
    replace: "    const zips: string[] = [];",
    test: "tests/am-publish.test.ts",
    filter:
      "am publish: Windows electron's exe + zip: the exe is the platform's update, the zip gets its own kind manifest",
  },
  {
    what:
      "the zip's manifest is written under the platform's name, overwriting the exe's — exe installs are then offered a zip they refuse",
    file: "src/am/am-cmd-publish.ts",
    find:
      "        ...(p.manifestName ? { manifestName: p.manifestName } : {}),",
    replace: "",
    test: "tests/am-publish.test.ts",
    filter:
      "am publish: Windows electron's exe + zip: the exe is the platform's update, the zip gets its own kind manifest",
  },
  {
    what:
      "an electron-zip install never reads its kind manifest, so it is offered only the exe's binary release and never updates",
    file: "src/server/updates-check.ts",
    find: '  if (installed !== "electron-zip") return read(platformUrl);',
    replace:
      '  if (installed !== "electron-zip" || platformUrl.length >= 0) return read(platformUrl);',
    test: "tests/updates-kind-manifest.test.ts",
    filter:
      "kind manifest: an electron-zip install reads its own, else the platform's",
  },
  {
    what:
      "a channel with no kind manifest leaves a zip install asking for a file that does not exist — every check an error",
    file: "src/server/updates-check.ts",
    find: '  if (own.got.kind !== "error" || !own.got.absent) return own;',
    replace: '  if (own.got.kind !== "error" || own.got.absent) return own;',
    test: "tests/updates-kind-manifest.test.ts",
    filter: "kind manifest: over HTTP only a 2xx kind manifest is read",
  },
  {
    what:
      "the runtime asks for the platform manifest whatever the install kind, so a zip install is never offered its release",
    file: "src/server/updates-runtime.ts",
    find: "      installedTarget(),",
    replace: '      "binary",',
    test: "tests/updates-kind-manifest.test.ts",
    filter:
      "kind manifest: a zip install is OFFERED the zip release beside a binary one",
  },
  {
    what:
      "Windows unpacks with Expand-Archive, which refuses the updater's `.zip-<version>` download — every electron-zip update fails after verifying",
    file: "src/server/updates-apply.ts",
    find:
      // aio-ok: mutation source text — the `${…}` is code to find, not a message
      '      "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +\n      `[System.IO.Compression.ZipFile]::ExtractToDirectory(${q(archive)}, ${\n        q(dest)\n      })`,',
    replace:
      // aio-ok: mutation source text — the `${…}` is code to find, not a message
      "      `Expand-Archive -LiteralPath ${q(archive)} -DestinationPath ${\n        q(dest)\n      } -Force`,",
    test: "tests/updates-apply.test.ts",
    filter:
      "unpack: the Windows command takes the updater's .zip-<version> name",
  },
  {
    what:
      "a `'` in the install path ends the PowerShell string early — the unpack command is broken for that user",
    file: "src/server/updates-apply.ts",
    find:
      // aio-ok: mutation source text — the `${…}` is code to find, not a message
      "    `'${s.replace(/['\\u2018\\u2019\\u201A\\u201B]/g, \"$&$&\")}'`;",
    // aio-ok: mutation source text — the `${…}` is code to find, not a message
    replace: "    `'${s}'`;",
    test: "tests/updates-apply.test.ts",
    filter:
      "unpack: the Windows command takes the updater's .zip-<version> name",
  },
  {
    what:
      "a release is signed for a name the artifact does not run as (deno.json title vs aio.run({ appId }) in code) — every install refuses every release, and the publisher is told nothing",
    file: "src/build/ship.ts",
    find: "  if (name === runsAs) return null;",
    replace: "  if (name.length >= 0) return null;",
    test: "tests/ship-identity.test.ts",
    filter:
      "shipApp: refuses a release named for an id the artifact does not run as",
  },
  {
    what:
      "a `visible: { publicFields }` declaration is not counted as deciding the read side — a cell with `access` is nagged every boot, and refused under --expose, although its author declared `visible`",
    file: "src/server/aio-composition.ts",
    find: "        f.__aio.uiPublicFields !== undefined,",
    replace: "        f.__aio.uiPublicFields === null,",
    test: "tests/visibility-report.test.ts",
    filter:
      "visibilityReport — any part of a `visible` object decides the read side, per cell or app-wide",
  },
  {
    what:
      "isCompiled: an inherited $APPIMAGE (a host AppImage's terminal) runs a dev checkout as a shipped binary",
    file: "src/server/paths.ts",
    find:
      '    appImageOwner(execPath, appImage, Deno.env.get("APPDIR")) === "foreign"',
    replace:
      '    appImageOwner(execPath, appImage, Deno.env.get("APPDIR")) === "foreign" && false',
    test: "tests/is-compiled-inherited-appimage.test.ts",
    filter:
      "isCompiled: an inherited $APPIMAGE does not make a dev checkout a binary",
  },
  {
    what:
      "update confirm: a build that dies in the app's onStart was confirmed healthy before it died",
    file: "src/server/aio.ts",
    find: "    slot.confirm = pendingConfirmer(_dirs.data, log);",
    replace: "    pendingConfirmer(_dirs.data, log)();",
    test: "tests/update-confirm-after-app-onstart.test.ts",
    filter:
      "update confirm: a build that exits in the app's onStart is NOT confirmed",
  },
  {
    what:
      "replayArgs: every update relaunch added one more baked --client= to the argv",
    file: "src/server/updates-apply.ts",
    find: '    (i === lastClient || !a.startsWith("--client="))',
    replace: '    (i === lastClient || !a.startsWith("--client=") || true)',
    test: "tests/update-confirm-after-app-onstart.test.ts",
    filter:
      "replayArgs: keeps only the last --client= and drops the relaunch flag",
  },
  {
    what:
      "updates: a rolled-back release was dismissed only by a poll — check: false offered it again",
    file: "src/state/updates-cell.ts",
    find: "          s.dismissed = slot.rolledBack;",
    replace: "          s.dismissed = s.dismissed;",
    test: "tests/updates-cell.test.ts",
    filter:
      "a release this machine rolled back is dismissed at boot, even with no poll — a manual check does not offer it",
  },
  {
    what:
      "updates: the boot never handed the rolled-back release to ready() to dismiss",
    file: "src/server/updates-boot.ts",
    find: "    void readyUpdates(slot, rolledBack?.to).then((done) => {",
    replace: "    void readyUpdates(slot).then((done) => {",
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "first-boot rollback: the next boot names it and never auto-installs that version again",
  },
  {
    what:
      "logger: a line logged right before Deno.exit() never reached app.log (the file sink's timer never ran)",
    file: "src/diagnostics/logger-core.ts",
    find: "    for (const l of [..._unflushed]) flushAtExit(l);",
    replace: "    for (const l of [..._unflushed]) void l;",
    test: "tests/logger-flush-at-exit.test.ts",
    filter: "logger: a line logged right before Deno.exit() reaches app.log",
  },
  {
    what:
      "relaunch: the successor inherited an AppImage runtime's keep-alive pipe, keeping the old mount alive",
    file: "src/server/updates-apply.ts",
    find: '  const sh = os === "linux" ? shell() : null;',
    replace: '  const sh = os === "linux" && false ? shell() : null;',
    test: "tests/relaunch-closes-inherited-fds.test.ts",
    filter:
      "relaunch: the successor does not inherit the predecessor's descriptors (an AppImage keep-alive pipe) — via /bin/bash",
  },
  {
    what:
      "relaunch: under dash (Debian's /bin/sh) an inherited fd >= 10 killed the shell before it started the successor",
    file: "src/server/updates-apply.ts",
    find:
      `  'case $n in [3-9]) eval "exec $n>&-";; esac; done; exec "$0" "$@"';`,
    replace:
      `  'case $n in [3-9]|[1-9][0-9]*) eval "exec $n>&-";; esac; done; exec "$0" "$@"';`,
    test: "tests/relaunch-closes-inherited-fds.test.ts",
    filter:
      "relaunch: the successor does not inherit the predecessor's descriptors (an AppImage keep-alive pipe) — via /bin/dash",
  },
  {
    what:
      "update confirm: a late confirm (an async onStart settling) confirmed the NEXT update's marker, dropping its rollback",
    file: "src/server/updates-boot.ts",
    find: "    if (!atExit) return confirmPendingUpdate(dataDir, log, judged);",
    replace: "    if (!atExit) return confirmPendingUpdate(dataDir, log);",
    test: "tests/update-confirm-after-app-onstart.test.ts",
    filter:
      "update confirm: a late confirm leaves the NEXT update's marker alone (an install this build ran)",
  },
  {
    what:
      "update confirm: a clean quit while an async onStart still ran left a healthy build unconfirmed — two quick quits rolled it back",
    file: "src/server/aio.ts",
    find: "      if (Deno.exitCode === 0) confirmOnce(true);",
    replace: "      if (Deno.exitCode === 0 && false) confirmOnce(true);",
    test: "tests/update-confirm-after-app-onstart.test.ts",
    filter:
      "update confirm: a quit (exit 0) while an async onStart still runs IS confirmed — two quick quits no longer roll a healthy build back",
  },
  {
    what:
      "replayArgs: the old build's baked --client= was replayed and overrode the new build's own",
    file: "src/server/updates-apply.ts",
    find:
      '  const own = baked && head[0]?.startsWith("--client=") ? head.slice(1) : head;',
    replace: "  const own = head;",
    test: "tests/update-confirm-after-app-onstart.test.ts",
    filter:
      "replayArgs: a compiled binary's own bake is dropped — the NEW build bakes its own, a user's --client= still wins",
  },
  {
    what:
      "logger: a log directory removed under a running logger was not recreated at exit — its last lines (a crash reason) were lost",
    file: "src/diagnostics/logger-core.ts",
    find:
      "      Deno.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });",
    replace: "      void 0;",
    test: "tests/logger-flush-at-exit.test.ts",
    filter:
      "logger: a log directory removed under a running logger is recreated at exit — its last lines land in app.log",
  },
  {
    what:
      "updates: the rolled-back record was deleted before its dismissal landed — a failed dispatch offered it again",
    file: "src/server/updates-boot.ts",
    find: "    void readyUpdates(slot, rolledBack?.to).then((done) => {",
    replace:
      "    void (readyUpdates(slot, rolledBack?.to).catch(() => {}), Promise.resolve(true)).then((done) => {",
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "first-boot rollback: a dismissal that fails keeps the rolled-back record — the next boot dismisses it again",
  },
  {
    what:
      "updates: auto-install reinstalled the release this machine rolled back when its dismissal did not land",
    file: "src/server/updates-boot.ts",
    find: "    if (config.auto && available.version === rolledBackTo) {",
    replace:
      "    if (config.auto && available.version === rolledBackTo && false) {",
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "first-boot rollback: a dismissal that fails keeps the rolled-back record — the next boot dismisses it again",
  },
  {
    what:
      "update confirm: a build confirmed at a clean exit was never confirmed by the next boot — its kept-aside copy was never pruned",
    file: "src/server/updates-boot.ts",
    find: "  if (pending.confirmedAt) {",
    replace: '  if (pending.confirmedAt === "never") {',
    test: "tests/update-confirm-after-app-onstart.test.ts",
    filter:
      "update confirm: a quit (exit 0) while an async onStart still runs IS confirmed — two quick quits no longer roll a healthy build back",
  },
  {
    what:
      "relaunch: bash sourced $BASH_ENV before starting the successor — a script there that exits ended the handover",
    file: "src/server/updates-apply.ts",
    find: '      ...(bash ? ["-p", "-c", script] : ["-c", script]),',
    replace: '      ...(bash ? ["-c", script] : ["-c", script]),',
    test: "tests/relaunch-closes-inherited-fds.test.ts",
    filter:
      "relaunch: the successor does not inherit the predecessor's descriptors (an AppImage keep-alive pipe) — via /bin/bash",
  },
  {
    what:
      "replayArgs: a relaunch flag an older aio appended past `--` was replayed into the app's own argv",
    file: "src/server/updates-apply.ts",
    find: "args.slice(end).filter((a) => !a.startsWith(RELAUNCH_FLAG))",
    replace: "args.slice(end)",
    test: "tests/update-confirm-after-app-onstart.test.ts",
    filter:
      "replayArgs: a compiled binary's own bake is dropped — the NEW build bakes its own, a user's --client= still wins",
  },
  {
    what:
      "judge: the old file started by hand after a clean-exit confirm recorded the healthy update as failed",
    file: "src/server/updates-boot.ts",
    find: "  if (pending.confirmedAt) {",
    replace: "  if (pending.confirmedAt && !oldFile) {",
    test: "tests/updates-boot-judge-hardening.test.ts",
    filter:
      "judge: a marker its build stamped confirmed at a clean exit is confirmed by the next boot — the OLD file started by hand after it records no failed update",
  },
  {
    what:
      "relaunch: bash -p rode an exported SHELLOPTS into every bash the app starts",
    file: "src/server/updates-apply.ts",
    // aio-ok: mutation source text — the `${…}` is code to find, not a message
    find: "export const CLOSE_FDS_EXEC_BASH = `set +p; ${CLOSE_FDS_EXEC_ALL}`;",
    replace: "export const CLOSE_FDS_EXEC_BASH = CLOSE_FDS_EXEC_ALL;",
    test: "tests/relaunch-closes-inherited-fds.test.ts",
    filter:
      "relaunch: bash's -p does not ride an exported SHELLOPTS into the successor",
  },
  {
    what:
      "am upgrade: refused an update its build had already confirmed at a clean exit",
    file: "src/am/am-cmd-remove.ts",
    find: "  if (!pending?.confirmedAt) return pending;",
    replace: "  if (pending) return pending;",
    test: "tests/am-upgrade-update-in-flight.test.ts",
    filter:
      "am upgrade: an unproven in-app update is in flight; one stamped confirmed at a clean exit is not, and is cleared",
  },
  {
    what:
      "relaunch: a busybox /bin/sh got the 3–9 script — an inherited two-digit fd (the AppImage keep-alive) stayed open",
    file: "src/server/updates-apply.ts",
    find: '    : sh.name === "busybox"',
    replace: '    : sh.name === "never"',
    test: "tests/relaunch-closes-inherited-fds.test.ts",
    // The via-busybox runtime twin needs /usr/bin/busybox; this unit asserts
    // relaunchCommand picks CLOSE_FDS_EXEC_ALL when the shell name is busybox.
    filter:
      "relaunch: bash first, then /bin/sh; started directly off Linux or with no shell",
  },
  {
    what:
      "relaunch: the shell hop changed the successor's environment (dropped my-var, reset IFS, replaced SHELLOPTS)",
    file: "src/server/updates-apply.ts",
    find: "      ...(via ? [via.bin, ...envRestoreArgs(via.env)] : []),",
    replace: "      ...(via ? [] : []),",
    test: "tests/relaunch-closes-inherited-fds.test.ts",
    filter:
      "relaunch: the successor gets the environment it would have inherited directly — via /bin/dash",
  },
  {
    what:
      "judge: a kept .old-* copy started by hand after a clean-exit confirm was taken for the new build (and pruned under itself)",
    file: "src/server/updates-boot.ts",
    find:
      "      oldFile || (appVersion !== undefined && appVersion !== pending.to)",
    replace: "      oldFile",
    test: "tests/updates-boot-judge-hardening.test.ts",
    filter:
      "judge: a marker its build stamped confirmed at a clean exit is confirmed by the next boot — the OLD file started by hand after it records no failed update",
  },
  {
    what:
      "updates: an oversize download named only rounded sizes (148.7 MB vs 148.7 MB)",
    file: "src/server/updates-check.ts",
    find:
      // aio-ok: mutation source text — the `${…}` is code to find, not a message
      "              } (${opts.expectSize} bytes) the manifest promised (${seen} ` +",
    // aio-ok: mutation source text — the `${…}` is code to find, not a message
    replace: "              } the manifest promised (${seen} ` +",
    test: "tests/updates-size-mismatch-bytes.test.ts",
    filter: "updates: an oversize download names the exact promised byte count",
  },
  {
    what:
      "lock prune: an untagged watch file of a dead pid kept a gone root's lock dir (six per suite run)",
    file: "src/server/single-instance-lock.ts",
    find: "          (rootGone && !isProcessAlive(Number(m[1]))))",
    replace: "          (rootGone && Number(m[1]) < 0))",
    test: "tests/lock-prune-untagged-root-gone.test.ts",
    filter:
      "lock prune: an untagged watch file of a dead pid keeps a live root's dir, and goes once the root is gone",
  },
  {
    what:
      "lock prune: dropping a temp dir judged its lock dirs as if the root still lived",
    file: "src/server/single-instance-lock.ts",
    find:
      "    if (name.includes(tag) && pruneDeadLockDirAt(join(base, name), true)) n++;",
    replace:
      "    if (name.includes(tag) && pruneDeadLockDirAt(join(base, name))) n++;",
    test: "tests/lock-prune-untagged-root-gone.test.ts",
    filter:
      "lock prune: dropping a temp dir removes its tagged lock dir holding an untagged dead watch file",
  },
  {
    what: "release stamp: the check's own lock-file rewrite voided every stamp",
    file: "scripts/release-stamp.ts",
    find: '    await run("reset", "-q", "HEAD", "--", ...LOCK_FILES);',
    replace: "    void LOCK_FILES;",
    test: "tests/release-stamp.test.ts",
    filter:
      "release stamp: a lock file the check's own run rewrote does not void the stamp; a committed one does",
  },
  {
    what:
      "unpack warning: a host AppImage's inherited $APPDIR is reported as this app's unsafe unpack dir",
    file: "src/server/app-dirs.ts",
    find: '    appImage: appImageOwner(execPath, appImage, appDir) === "own"',
    replace:
      '    appImage: appImageOwner(execPath, appImage, appDir) !== "own" || true',
    test: "tests/is-compiled-inherited-appimage.test.ts",
    filter:
      "checkUnpackLocation: a host AppImage's inherited unpack dir is not reported as ours",
  },
  {
    what:
      "the hidden console's helper is a shell again — its PING.EXE child outlives it for 30 s with the install as its working directory, and an update taken then cannot move the folder",
    file: "src/server/no-console.ts",
    find:
      // aio-ok: the literal SOURCE line this mutation patches in and out
      '      `${systemRoot}\\\\System32\\\\PING.EXE`,\n      "-n",\n      "30",\n      "127.0.0.1",\n    ]),',
    replace:
      '      "cmd.exe",\n      "/d",\n      "/c",\n      "ping -n 30 127.0.0.1 >nul",\n    ]),',
    test: "tests/no-console.test.ts",
    filter:
      "adoptHiddenConsole: the helper is one process outside the install, and it is ended",
  },
  {
    what:
      "the hidden console's helper starts in the app's working directory — it holds the install folder while it lives",
    file: "src/server/no-console.ts",
    find: "        utf16z(helper.cwd),",
    replace: "        null,",
    test: "tests/no-console.test.ts",
    filter:
      "adoptHiddenConsole: the helper is one process outside the install, and it is ended",
  },
  {
    what:
      "swap helper (windows): one process still running has no .Count on PowerShell 5.1 — the wait ends while it runs",
    file: "src/server/updates-apply.ts",
    find: "-and @(Get-Running).Count -gt 0;",
    replace: "-and (Get-Running).Count -gt 0;",
    test: "tests/powershell-scripts-wellformed.test.ts",
    filter: "generated PowerShell: a count is only ever taken of an array",
  },
  {
    what:
      "swap helper (windows): a swap that is given up leaves its staged tree — a whole copy of the app per failed update",
    file: "src/server/updates-apply.ts",
    find: "(Get-Held)); Remove-Dir $new; Start-App; exit 1 }",
    replace: "(Get-Held)); Start-App; exit 1 }",
    test: "tests/updates-swap-windows.test.ts",
    filter:
      "swap spec (windows): a held install is waited for, and a swap given up says why and leaves no staged tree",
  },
  {
    what:
      "a release whose swap could not be made is dismissed after one try — a good release is hidden for good by a file that was in use",
    file: "src/server/updates-boot.ts",
    find:
      "  const offeredAgain = swapFailures > 0 && swapFailures < MAX_FAILED_SWAPS;",
    replace: "  const offeredAgain = swapFailures < 0;",
    test: "tests/updates-failed-swap-retry.test.ts",
    filter:
      "failed swap: the release stays on offer, counted — it is not dismissed",
  },
  {
    what:
      "a release whose swap keeps failing is offered for ever — with auto, the app restarts itself at every poll",
    file: "src/server/updates-boot.ts",
    find:
      "  const offeredAgain = swapFailures > 0 && swapFailures < MAX_FAILED_SWAPS;",
    replace: "  const offeredAgain = swapFailures > 0;",
    test: "tests/updates-failed-swap-retry.test.ts",
    filter:
      "failed swap: the count is per release, and the last allowed failure dismisses it with what to do",
  },
  {
    what:
      "auto: a release whose swap just failed is installed again in the boot that follows — a restart loop",
    file: "src/server/updates-boot.ts",
    find: "    if (config.auto && available.version === swapRetry) {",
    replace: '    if (config.auto && available.version === swapRetry + "!") {',
    test: "tests/updates-failed-swap-retry.test.ts",
    filter:
      "failed swap (auto): not installed again in the boot that follows the failure — at the next check",
  },
  {
    what:
      "the boot sweep deletes a leftover under its own name — an install staging the same version again finds its tree being deleted",
    file: "src/server/updates-owned.ts",
    find:
      "      Deno.renameSync(e.path, at);\n      ledger = [...ledger.filter((x) => x !== e), aside];\n      claimed.push({ name: basename(e.path), at });",
    replace:
      "      ledger = ledger.filter((x) => x !== e);\n      claimed.push({ name: basename(e.path), at: e.path });",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: one is moved out of its name before anything is deleted — under a name that is on record",
  },
  {
    what:
      "the look at what older builds left is taken at every boot — a copy of the app somebody makes later under such a name is removed",
    file: "src/server/updates-owned.ts",
    find: "  if (rec.adopted) return null;\n",
    replace: "",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "older builds: what 1.0.16 left beside a directory install is taken onto the record ONCE — then swept and pruned as before",
  },
  {
    what:
      "a directory update's digest and release time are recorded before the swap — when it fails, the old version runs under the new release's date",
    file: "src/server/updates-runtime.ts",
    find: "      forgetInstalledDigest(deps.dataDir);\n      deferHandOver(",
    replace:
      "      recordInstalledSha256(deps.dataDir, m.sha256, m.releasedAt);\n      deferHandOver(",
    test: "tests/updates-e2e.test.ts",
    filter:
      "updates e2e: a .zip release is verified, unpacked, and handed to the swapper",
  },
  {
    what:
      "a zip install's check is two requests again — the kind manifest probed for, then fetched, on every poll",
    file: "src/server/updates-check.ts",
    find: "  const own = await read(kind);",
    replace: "  await read(kind);\n  const own = await read(kind);",
    test: "tests/updates-kind-manifest.test.ts",
    filter:
      "kind manifest: a channel that has one is asked ONCE per check — never probed, then fetched",
  },
  {
    what:
      "openExternal starts its launcher in the app's working directory — on Windows the program it opens holds the install folder, and the next update cannot move it",
    file: "src/server/open-external.ts",
    find: "    cwd: neutralCwd(),\n",
    replace: "",
    test: "tests/spawn-cwd-outside-install.test.ts",
    filter:
      "spawn sites: every child takes neutralCwd(), or says why it keeps the app's working directory",
  },
  {
    what:
      "openExternal hands Windows a relative path while its launcher runs elsewhere — the file beside the app is not found",
    file: "src/server/open-external.ts",
    find: "env: { AIO_OPEN_TARGET: fromHere(target) },",
    replace: "env: { AIO_OPEN_TARGET: target },",
    test: "tests/spawn-cwd-outside-install.test.ts",
    filter:
      "openExternal: a path goes out absolute, decided in the app's working directory — anything else as given",
  },
  {
    what:
      "an installed app's window runs with the install folder as its working directory — whatever it opens holds the folder on Windows, and an update fails",
    file: "src/electron/electron-spawn.ts",
    find: "      cwd: packagedCwd(neutralCwd()),\n",
    replace: "",
    test: "tests/spawn-cwd-outside-install.test.ts",
    filter:
      "spawn sites: every child takes neutralCwd(), or says why it keeps the app's working directory",
  },
  {
    what:
      "a source run's window is started in the Windows directory too — dev and the app directory part ways",
    file: "src/electron/electron-spawn.ts",
    find: "  return compiled ? neutral : undefined;",
    replace: "  return neutral;",
    test: "tests/spawn-cwd-outside-install.test.ts",
    filter:
      "the window: an installed app's runs outside the install, a source run's where it was started",
  },
  {
    what:
      "the window's main script is not told the app's working directory — a child window's preload resolves against C:\\Windows",
    file: "src/electron/electron-spawn.ts",
    find: "      env: { ...childEnv.env, AIO_APP_CWD: Deno.cwd() },",
    replace: "      env: childEnv.env,",
    test: "tests/spawn-cwd-outside-install.test.ts",
    filter:
      "the window: it is told the app's working directory, and a source run starts it there",
  },
  {
    what:
      "the zip fallback is run without the paths it reads from its environment — a Windows host with no zip packs nothing",
    file: "src/build/build-electron.ts",
    find: '        env,\n        cwd: cmd === "zip"',
    replace: '        cwd: cmd === "zip"',
    test: "tests/powershell-scripts-wellformed.test.ts",
    filter:
      "generated PowerShell: with no zip, the fallback is run with both paths in its environment",
  },
  {
    what:
      "a download's staging folder is made with no record of it — a download cut off by a kill stays beside the install for good",
    file: "src/server/updates-check.ts",
    find: "  if (opts.owner) made(opts.owner, stage);\n",
    replace: "",
    test: "tests/updates-abandoned-downloads.test.ts",
    filter:
      "downloads: the staging folder is on record as the very folder that was made, and a later boot removes it",
  },
  {
    what:
      "the boot sweep removes what another running copy of the app is still making",
    file: "src/server/updates-owned.ts",
    find: "    e.boot === BOOT || (e.pid !== Deno.pid && alive(e.pid));",
    replace: "    e.boot === BOOT;",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: one somebody is still working on is left — this run's, another live process's — and an earlier run of the SAME pid is not somebody",
  },
  {
    what:
      "the boot sweep takes an old-format staging folder whatever its age — a download in flight in an older build is deleted under it",
    file: "src/server/updates-check.ts",
    find: "    return Date.now() - newest > OLD_STAGE_AGE_MS;",
    replace: "    return Date.now() - newest > -1;",
    test: "tests/updates-abandoned-downloads.test.ts",
    filter:
      "downloads: a folder of the old name goes only with the exact shape, untouched for an hour",
  },
  {
    what:
      "no boot looks for what an unfinished update left — a whole copy of the app per failed swap, a download that was cut off",
    file: "src/server/updates-boot.ts",
    find:
      "    sweepLeftovers(\n      deps.dataDir,\n      here ?? deps.artifact ?? artifactPath(),\n      deps.log,\n    );",
    replace: "    void sweepLeftovers;",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: a boot of a directory install with no update in flight removes them, and says which — and which it left",
  },
  {
    what:
      "a swap given up on macOS/Linux records which move failed and never why",
    file: "src/server/updates-apply.ts",
    find: '    elif held=$(mv "$1" "$3" 2>&1); then',
    replace: '    elif mv "$1" "$3" 2>/dev/null; then',
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "swap failure: the record carries what the failing move said — one line, bounded, still JSON",
  },
  {
    what:
      "what a failing move printed reaches the failed record with its quotes — the record is not JSON, and the next boot cannot read why",
    file: "src/server/updates-apply.ts",
    find: "  fi | tr '\\\\001-\\\\037' ' ' | tr '\"\\\\\\\\' \"'/\"",
    replace: "  fi | tr '\\\\001-\\\\037' ' '",
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "swap failure: the record carries what the failing move said — one line, bounded, still JSON",
  },
  {
    what:
      "the trust store is renamed into place once — a scanner holding it for a moment on Windows loses the pinned key's update",
    file: "src/server/updates-check.ts",
    find: "    renameOverSync(tmp, path);",
    replace: "    Deno.renameSync(tmp, path);",
    test: "tests/updates-file-replace-retries.test.ts",
    filter: "updates: the trust store is written through a held-open moment",
  },
  {
    what:
      "the rollback record is renamed into place once — held for a moment on Windows, the swap goes ahead with no way back",
    file: "src/server/updates-apply.ts",
    find: "  renameOverSync(tmp, path);",
    replace: "  Deno.renameSync(tmp, path);",
    test: "tests/updates-file-replace-retries.test.ts",
    filter:
      "updates: the rollback record is written through a held-open moment",
  },
  {
    what:
      "a verified download is renamed to its name once — a scanner reading the new file on Windows throws the whole download away",
    file: "src/server/updates-check.ts",
    find: "    await moveFile(staged, opts.dest);",
    replace: "    await Deno.rename(staged, opts.dest);",
    test: "tests/updates-file-replace-retries.test.ts",
    filter:
      "updates: a verified download reaches its name through a held-open moment",
  },
  {
    what:
      "a sweep goes by the record alone — a folder the user put under a name the updater once used is deleted",
    file: "src/server/updates-owned.ts",
    find: "    if (e.is !== is) return false; // the kind is part of it",
    replace: "    if (false) return false; // the kind is part of it",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: the record alone is not enough — what has the name now must be the very thing that was made",
  },
  {
    what:
      "where the app is pid 1 at every boot, its own leftovers are never removed — the pid on the record is always alive",
    file: "src/server/updates-owned.ts",
    find: "    e.boot === BOOT || (e.pid !== Deno.pid && alive(e.pid));",
    replace: "    e.boot === BOOT || alive(e.pid);",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: one somebody is still working on is left — this run's, another live process's — and an earlier run of the SAME pid is not somebody",
  },
  {
    what:
      "something of the user's under a name the update needs is taken for the updater's — and removed",
    file: "src/server/updates-owned.ts",
    find: "  if (isOwn(dataDir, path)) return;",
    replace: "  return;",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: something that is not ours under a name the update needs refuses the update — it is not removed",
  },
  {
    what:
      "the staged tree is unpacked with no record that it is the updater's — a failed swap's 400 MB tree stays for good",
    file: "src/server/updates-runtime.ts",
    find: "      made(deps.dataDir, staged);\n      const unpacked = isMacApp",
    replace: "      const unpacked = isMacApp",
    test: "tests/updates-e2e.test.ts",
    filter:
      "updates e2e: a .zip update's staged tree is on record as the very folder it unpacked into, and its own leftover is replaced",
  },
  {
    what:
      "pruning counts and deletes every `<install>.old-…` beside the app — a folder of the user's with that prefix goes with the old versions",
    file: "src/server/updates-apply.ts",
    find: '      if (!kept || kept.state === "filling") continue;\n',
    replace: '      if (kept?.state === "filling") continue;\n',
    test: "tests/updates-apply.test.ts",
    filter: "prune: `.old-` DIRECTORIES are pruned too, not just files",
  },
  {
    what:
      "a kept copy cut off while it was being written counts as one of the versions kept — a whole one is pruned to make room for half a build",
    file: "src/server/updates-apply.ts",
    find: '      if (!kept || kept.state === "filling") continue;\n',
    replace: "      if (!kept) continue;\n",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "kept copies: one cut off while it was being written is no version — prune does not count it, a rollback refuses it, the next start removes it",
  },
  {
    what:
      "a kept copy cut off while it was being written stays forever — no start removes it",
    file: "src/server/updates-owned.ts",
    find: '} else if (e.role !== "temp" && e.state !== "filling") {\n',
    replace: '} else if (e.role !== "temp") {\n',
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "kept copies: one cut off while it was being written is no version — prune does not count it, a rollback refuses it, the next start removes it",
  },
  {
    what: "a rollback moves a half-written copy over the running build",
    file: "src/server/updates-apply.ts",
    find:
      '  if (dataDir && ownEntry(dataDir, previous)?.state === "filling") {',
    replace: "  if (false) {",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "kept copies: one cut off while it was being written is no version — prune does not count it, a rollback refuses it, the next start removes it",
  },
  {
    what:
      "a kept copy that came out short is recorded as a whole build, and the update goes on",
    file: "src/server/updates-apply.ts",
    find: "      if (got !== want) {",
    replace: "      if (false) {",
    test: "tests/updates-apply.test.ts",
    filter:
      "swap: the kept copy is done only when it is whole — before the new build goes in; a short one stops the update",
  },
  {
    what:
      "the kept copy is recorded as whole only after the new build is in — a kill between leaves a whole copy the record calls half",
    file: "src/server/updates-apply.ts",
    find: "    copied();\n    await moveFile(opts.staged, opts.current);",
    replace: "    await moveFile(opts.staged, opts.current);\n    copied();",
    test: "tests/updates-apply.test.ts",
    filter:
      "swap: the kept copy is done only when it is whole — before the new build goes in; a short one stops the update",
  },
  {
    what:
      "the one-time look at what older builds left is not said — what it took is taken unseen",
    file: "src/server/updates-boot.ts",
    find: "    if (taken !== null) {",
    replace: "    if (taken !== null && taken.length < 0) {",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "older builds: the look is said, naming what it took — and taken again when the record is lost or its mark is gone",
  },
  {
    what:
      "a look taken again after its mark was lost takes what is on the record already, over what the record says of it",
    file: "src/server/updates-owned.ts",
    find: "    if (rec.made.some((e) => e.path === path)) continue;\n",
    replace: "",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "older builds: the look is said, naming what it took — and taken again when the record is lost or its mark is gone",
  },
  {
    what:
      "a run from source takes the files beside the `deno` it runs on as an older build's leftovers",
    file: "src/server/updates-boot.ts",
    find: '  if (classifyTarget({ execPath: install }) === "source") return;\n',
    replace: "",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "older builds: a run from source does not look beside the `deno` it runs on — no update is ever applied there",
  },
  {
    what:
      "pruning leaves what it deleted on the record — the list names an old version that is gone until a later start drops it",
    file: "src/server/updates-apply.ts",
    find: "      () => forget(dataDir, f.path),\n",
    replace: "      () => {},\n",
    test: "tests/updates-apply.test.ts",
    filter:
      "prune: what it deletes leaves the record in the same step — one it cannot delete stays on it",
  },
  {
    what:
      "pruning drops an old version from the record even when it could not delete it — what is left is no longer provably ours",
    file: "src/server/updates-apply.ts",
    find:
      "      () => {}, // aio-ok: held open — kept, and on record, for a later prune\n",
    replace: "      () => forget(dataDir, f.path),\n",
    test: "tests/updates-apply.test.ts",
    filter:
      "prune: what it deletes leaves the record in the same step — one it cannot delete stays on it",
  },
  {
    what:
      "a file is proven by its identity alone — on NTFS a file made again under a deleted one's name can carry the same identity, and is removed",
    file: "src/server/updates-owned.ts",
    find: '    if (is.startsWith("dir:")) return true;\n',
    replace:
      '    if (is.startsWith("dir:") || is.startsWith("file:")) return true;\n',
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: a file with the same identity but other bytes is not ours — NTFS gives a file made again under a deleted one's name its creation time, and Deno rounds its file number",
  },
  {
    what: "the size stands in for a file's bytes before it is removed",
    file: "src/server/updates-owned.ts",
    find: "    return deep\n      ? sumOf(path) === e.sum\n",
    replace: "    return false\n      ? sumOf(path) === e.sum\n",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: a file with the same identity but other bytes is not ours — NTFS gives a file made again under a deleted one's name its creation time, and Deno rounds its file number",
  },
  {
    what:
      "pruning deletes an old version on its identity and size, not its bytes",
    file: "src/server/updates-apply.ts",
    find: "    if (!ownEntry(dataDir, f.path)) continue;\n",
    replace: "",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: a file with the same identity but other bytes is not ours — NTFS gives a file made again under a deleted one's name its creation time, and Deno rounds its file number",
  },
  {
    what:
      "a name the update needs that cannot be looked at (access denied) is taken for nothing — the update downloads, then fails on it",
    file: "src/server/updates-owned.ts",
    find: "    if (e instanceof Deno.errors.NotFound) return;\n    // Denied",
    replace: "    return;\n    // Denied",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: a name the update needs that cannot even be looked at is in the way — refused before anything is downloaded",
  },
  {
    what:
      "the failed build a rollback set aside is recorded without its bytes — a start can never prove and remove it",
    file: "src/server/updates-apply.ts",
    find: "{ is: identity(current), sum: sumOf(current) }",
    replace: "{ is: identity(current) }",
    test: "tests/updates-apply.test.ts",
    filter:
      "rollback: the build that failed is set aside under a name that is on record first, as the very file — with its bytes, and off the record once deleted",
  },
  {
    what: "the failed build a rollback deleted stays on the record",
    file: "src/server/updates-apply.ts",
    find: "      () => dataDir && forget(dataDir, gone),\n",
    replace: "      () => {},\n",
    test: "tests/updates-apply.test.ts",
    filter:
      "rollback: the build that failed is set aside under a name that is on record first, as the very file — with its bytes, and off the record once deleted",
  },
  {
    what:
      "a directory update writes the install's identity on the kept-aside name before the helper moved it — a held file stops the move, and the old copy is 'not ours' forever, refusing every update",
    file: "src/server/updates-apply.ts",
    find: "      moving: true,\n",
    replace: "",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: the copy a directory update keeps aside is an intent until it is moved — a held file that stops the helper leaves the old copy ours, and the next try goes ahead",
  },
  {
    what: "a start never settles a move that was only intended",
    file: "src/server/updates-owned.ts",
    find: '    else if (e.state === "moving") {',
    replace: "    else if (false) {",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: the copy a directory update keeps aside is an intent until it is moved — a held file that stops the helper leaves the old copy ours, and the next try goes ahead",
  },
  {
    what: "an intended move that did not happen stays on the record",
    file: "src/server/updates-owned.ts",
    find: "        : ledger.filter((x) => x !== e);\n    } else if",
    replace: "        : ledger;\n    } else if",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: the copy a directory update keeps aside is an intent until it is moved — a held file that stops the helper leaves the old copy ours, and the next try goes ahead",
  },
  {
    what:
      "only the first entry for a path is asked whether it is the thing there",
    file: "src/server/updates-owned.ts",
    find:
      "  return readOwned(dataDir).find((e) =>\n    e.path === path && matches(e, path, deep)\n  );",
    replace:
      "  const e = readOwned(dataDir).find((e) => e.path === path);\n  return e !== undefined && matches(e, path, deep) ? e : undefined;",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: the copy a directory update keeps aside is an intent until it is moved — a held file that stops the helper leaves the old copy ours, and the next try goes ahead",
  },
  {
    what:
      "a refused update leaves entries for a download and a tree it never made",
    file: "src/server/updates-runtime.ts",
    find:
      // aio-ok: the literal SOURCE line this mutation patches in and out
      "    for (const p of [download, staged, `${current}.old-${deps.appVersion}`]) {",
    replace: "    for (const p of [download, staged]) {",
    test: "tests/updates-e2e.test.ts",
    filter:
      "updates e2e: a file of the user's where the old version is kept refuses a single-file update — nothing is downloaded, nothing changes",
  },
  {
    what:
      "a start never gives back the one-click .exe's stamp an older updater dropped — opening that .exe reinstalls the old version over the update",
    file: "src/server/updates-boot.ts",
    find: "    repairSfxStamp(install, dataDir, log);\n",
    replace: "",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "sfx stamp: an install whose stamp an older updater dropped takes it from the newest kept copy on record that has one — at a start, and at a swap",
  },
  {
    what: "a swap carries no stamp when the running tree has lost it",
    file: "src/server/updates-apply.ts",
    find:
      "  if (opts.pending) repairSfxStamp(opts.current, opts.pending.dataDir);\n",
    replace: "",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "sfx stamp: an install whose stamp an older updater dropped takes it from the newest kept copy on record that has one — at a start, and at a swap",
  },
  {
    what: "the stamp is taken from a copy the updater cannot vouch for",
    file: "src/server/updates-apply.ts",
    find:
      "      basename(e.path).startsWith(kept) && !!ownEntry(dataDir, e.path) &&",
    replace: "      basename(e.path).startsWith(kept) &&",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "sfx stamp: an install whose stamp an older updater dropped takes it from the newest kept copy on record that has one — at a start, and at a swap",
  },
  {
    what: "the oldest stamp is taken, not the newest",
    file: "src/server/updates-apply.ts",
    find: "    .sort((a, b) => b.at - a.at);",
    replace: "    .sort((a, b) => a.at - b.at);",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "sfx stamp: an install whose stamp an older updater dropped takes it from the newest kept copy on record that has one — at a start, and at a swap",
  },
  {
    what:
      "an install with no stamp anywhere is silent about what opening the .exe will do",
    file: "src/server/updates-apply.ts",
    find: "  if (stamped.length === 0) {\n    logger.warn(",
    replace: "  if (stamped.length === 0) {\n    return;\n    logger.warn(",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "sfx stamp: none anywhere is said, with what it costs — and an install the .exe did not make is not asked",
  },
  {
    what: "every install is taken for one the one-click .exe made",
    file: "src/server/updates-apply.ts",
    find: '  return basename(dir).startsWith("win-") &&',
    replace: '  return true || basename(dir).startsWith("win-") &&',
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "sfx stamp: none anywhere is said, with what it costs — and an install the .exe did not make is not asked",
  },
  {
    what: "a kept copy replaced by hand stays on the record",
    file: "src/server/updates-owned.ts",
    find: "      if (!matches(e, e.path, false)) {",
    replace: "      if (false) {",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: the record alone is not enough — what has the name now must be the very thing that was made",
  },
  {
    what: "a copy of ours that cannot be looked at is dropped from the record",
    file: "src/server/updates-owned.ts",
    find: "      unreadable.set(basename(e.path), denied);\n      continue;",
    replace: "      unreadable.set(basename(e.path), denied);",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: one that cannot be looked at (access denied) is said as that, never as not made by this app's updater, and stays on the record",
  },
  {
    what:
      "a name that cannot be looked at is called 'not made by this app's updater'",
    file: "src/server/updates-owned.ts",
    find: "        unreadable.set(d.name, denied);\n        continue;",
    replace: "        unreadable.set(d.name, denied);",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: one that cannot be looked at (access denied) is said as that, never as not made by this app's updater, and stays on the record",
  },
  {
    what: "a swap that never began dismisses the release after one try",
    file: "src/server/updates-runtime.ts",
    find: "                fromExe: exeIdentity(),\n",
    replace: "",
    test: "tests/updates-e2e.test.ts",
    filter:
      "updates e2e: a swap helper that cannot start — not installed, undone, this version restarts",
  },
  {
    what:
      "a swap helper that could not be started leaves its script in the temp directory, never to be removed",
    file: "src/server/updates-apply.ts",
    find: "        Deno.removeSync(scriptPath);\n",
    replace: "        void scriptPath;\n",
    test: "tests/updates-apply.test.ts",
    filter:
      "directory swap: a helper that cannot be started leaves no script behind",
  },
  {
    what:
      "the updater's own new copy at a kept name is called 'something else has the name now'",
    file: "src/server/updates-owned.ts",
    find: "        if (!ours) dropped.push(basename(e.path));\n",
    replace: "        dropped.push(basename(e.path));\n",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: the copy a directory update keeps aside is an intent until it is moved — a held file that stops the helper leaves the old copy ours, and the next try goes ahead",
  },
  {
    what:
      "the Windows helper removes a tree THROUGH a junction in it — the folder the link points at is emptied",
    file: "src/server/updates-apply.ts",
    find:
      "  if (-not ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) {",
    replace: "  if ($true) {",
    test: "tests/updates-swap-windows.test.ts",
    filter:
      "swap spec (windows): a tree is removed without following a link in it",
  },
  {
    what:
      "an error the Windows helper does not expect ends it with no app started",
    file: "src/server/updates-apply.ts",
    find: "  if (-not $script:started) { try { Start-Any } catch {} }\n",
    replace: "",
    test: "tests/updates-swap-windows.test.ts",
    filter:
      "swap spec (windows): no way out of the helper leaves no app started",
  },
  {
    what:
      "after an exchange the unix helper retries — the install's name holds the old and the new version in turn for ten seconds",
    file: "src/server/updates-apply.ts",
    find:
      '      mv -T --exchange "$2" "$1" 2>/dev/null && return 4\n      return 2',
    replace: '      mv -T --exchange "$2" "$1" 2>/dev/null || return 2',
    test: "tests/updates-first-boot-rollback.test.ts",
    filter:
      "swap failure: after an exchange, a copy that cannot be set aside is exchanged back ONCE — the record names that move and why",
  },
  {
    what:
      "a single-file swap cut off before its trust write leaves the new build under the old one's digest — every check offers it to itself",
    file: "src/server/updates-apply.ts",
    find:
      "      fromExe: opts.pending.exe,\n      sha256: opts.pending.sha256,\n      releasedAt: opts.pending.releasedAt,\n      attempts: 0,\n      startedAt: new Date().toISOString(),\n    });\n  };",
    replace:
      "      fromExe: opts.pending.exe,\n      attempts: 0,\n      startedAt: new Date().toISOString(),\n    });\n  };",
    test: "tests/updates-directory-digest-at-confirm.test.ts",
    filter:
      "single-file update: the digest rides on the marker too, and a confirm after a kill mid-swap records it",
  },
  {
    what:
      'after a third-strike dismissal and undismiss(), one more failure dismisses at once — "4 times in a row"',
    file: "src/server/updates-boot.ts",
    find:
      "      if (swapFailures >= MAX_FAILED_SWAPS) {\n        writeTrust(deps.dataDir, { failedSwaps: undefined });\n      }\n",
    replace: "",
    test: "tests/updates-failed-swap-retry.test.ts",
    filter:
      "failed swap: the count is per release, and the last allowed failure dismisses it with what to do",
  },
  {
    what:
      "a launch refused for a flag its client cannot honour is counted as a boot attempt of the update — typed three times, a healthy update is rolled back",
    file: "src/server/aio.ts",
    find: "    returnBootAttempt(_dirs.data, log);\n",
    replace: "",
    test: "tests/updates-boot-attempt-returned.test.ts",
    filter:
      "boot attempt: a launch refused for a flag its client cannot honour is not counted — however often",
  },
  {
    what:
      "a refused launch gives back a boot attempt it did not count — an earlier boot's failure is forgotten, and a build that never comes up is never rolled back",
    file: "src/server/updates-boot.ts",
    find: "  if (!p || p.startedAt !== counted) return;",
    replace: "  if (!p) return;",
    test: "tests/updates-boot-attempt-returned.test.ts",
    filter:
      "boot attempt: only the one this process counted is given back, and only once",
  },
  {
    what:
      "an older build's leftover is taken over under any name after the prefix — a hand copy `<install>.staged-mycopy` is removed",
    file: "src/server/updates-owned.ts",
    find:
      "const OLD_NAME = /^\\.(?:(staged|old|zip|new)-\\d[0-9A-Za-z.+-]*|failed-\\d+)$/;",
    replace: "const OLD_NAME = /^\\.(?:(staged|old|zip|new)-.+|failed-\\d+)$/;",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "older builds: what 1.0.16 left beside a directory install is taken onto the record ONCE — then swept and pruned as before",
  },
  {
    what:
      "a file number alone is taken as proof of what a path is — on a file system with no creation time the next object made there is removed as the updater's",
    file: "src/server/updates-owned.ts",
    find: "  if (born === undefined) return null;\n",
    replace: "",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "leftovers: on a file system that gives no creation time nothing is removed on the record's word — it is kept, and said with its size",
  },
  {
    what:
      "an older build's tree is taken over while another copy of the app is still unpacking it",
    file: "src/server/updates-owned.ts",
    find:
      '    if (old?.[1] !== "old" && Date.now() - touched < OLD_STAGE_AGE_MS) {',
    replace: "    if (false) {",
    test: "tests/updates-orphaned-staged-trees.test.ts",
    filter:
      "older builds: a leftover younger than an hour is not taken yet — somebody may be making it — and the look stays open until it can be",
  },
  {
    what:
      "a test that installs programs into the developer's real home passes every release check while the disk fills",
    file: "scripts/check-home-clean.ts",
    find: "      if (INSTALL_SHAPE.test(n)) out.push(join(dir, n));",
    replace: "      if (!n) out.push(join(dir, n));",
    test: "tests/check-home-clean-stores.test.ts",
    filter:
      "check:home-clean: a test-shaped INSTALL in the real home is RED, named — the user's own apps are not",
  },
  {
    what:
      "the home-clean gate stops looking in the default install root, where each leaked test program is 110 MB",
    file: "scripts/check-home-clean.ts",
    find: '    home ? join(home, "app") : undefined,',
    replace: "    undefined,",
    test: "tests/check-home-clean-stores.test.ts",
    filter:
      "check:home-clean: a test-shaped INSTALL in the real home is RED, named — the user's own apps are not",
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

const ROOT = fromFileUrl(new URL("../", import.meta.url));

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

/** `--jobs=<n>` as a worker count: 4 when absent, a whole number ≥ 1, or a
 *  throw. `Number("0")` workers took nothing off the queue and `Number("x")`
 *  made an array of NaN length — either way no row was checked, and the run
 *  printed "0/N invariants are genuinely guarded" and exited 0. Pure. */
export function mutationJobs(raw: string | undefined): number {
  if (raw === undefined) return 4;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(
      `check:mutations: --jobs=${raw} is not a whole number of workers ≥ 1`,
    );
  }
  return Number(raw);
}

/** Green is "every selected row was KILLED" — not "none was seen to survive".
 *  The exit used to count survivors and broken rows, so a run that checked
 *  nothing (or lost a row on the way) had none of either and passed. Pure. */
export function allKilled(killed: number, selected: number): boolean {
  return selected > 0 && killed === selected;
}

/** The run's exit code, from what each worker reported and how many rows
 *  were selected: 0 only when there is one report per selected row and every
 *  one says killed. A survivor, a broken row, a row no worker reported on, a
 *  report too many, and an empty selection are all 1. Pure — the one place
 *  the verdicts become the gate's answer. */
export function mutationExitCode(
  results: readonly { verdict: "killed" | "survived" | "invalid" }[],
  selected: number,
): 0 | 1 {
  const killed = results.filter((r) => r.verdict === "killed").length;
  return results.length === selected && allKilled(killed, selected) ? 0 : 1;
}

// ─── main ──────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = Deno.args;
  const only = args.find((a) => a.startsWith("--only="))?.slice(7);
  let jobs: number;
  try {
    jobs = mutationJobs(args.find((a) => a.startsWith("--jobs="))?.slice(7));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    Deno.exit(1);
  }
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
  const killed = results.filter((r) => r.verdict === "killed").length;
  console.log(
    `\n${killed}/${entries.length} ` +
      `invariants are genuinely guarded  (${secs}s)`,
  );
  Deno.exit(mutationExitCode(results, entries.length));
}

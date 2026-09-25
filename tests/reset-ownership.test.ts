// Who resets what — the gate for a whole bug class.
//
// `runtime-reset.ts` opens with "tests get hermeticity from a single call
// instead of remembering five scattered _reset* functions (forgetting one =
// cross-test bleed)". The intent was right and the practice drifted: src/ grew
// ~55 module-scope `_reset*` functions and the "one call" owns a fraction of
// them. Every one of the rest is a memory a test author has to hold, and the
// ones nobody holds are silent cross-test bleed — which is exactly how a field
// report came to believe "cells leak state between tests" when the leak was a
// module-level `signal()` nothing restored.
//
// Fixing that instance was a patch. THIS is the class: module-scope mutable
// state whose lifetime nobody owns. So every `_reset*` in src/ must be
// classified here, and a new one fails this gate until someone decides which it
// is. The ledger is the point — reading it should be uncomfortable where it is
// still `MANUAL`.
import { assertEquals } from "@std/assert";

type Owner =
  /** Called by `_resetAioRuntime` — per-test hygiene, the one call. */
  | "RUNTIME"
  /** Called by src/ code that owns the lifetime (boot, dispose, reconnect). */
  | "LIFECYCLE"
  /** Called by a harness (testUI / cell-test / bootCells) at mount time. */
  | "HARNESS"
  /** Deliberately called by the individual test that needs it, with a reason. */
  | "MANUAL";

/** The ledger. A `_reset*` exported from src/ MUST appear here. */
const OWNERS: Record<string, [Owner, string]> = {
  // ── the one call ────────────────────────────────────────────────
  _resetAioRuntime: ["RUNTIME", "the entry point itself"],
  _resetCellBindings: ["RUNTIME", "cell→signal bindings"],
  _resetClientSourceMap: [
    "MANUAL",
    "the seam a test uses to install a fake map. `_resetAioRuntime` already " +
    "clears the REAL one (`clearClientSourceMap()`) every reset, which is " +
    "the bleed that matters — a map from one test remapping another test's " +
    "forwarded positions. This is the same clear under a test-only name",
  ],
  _resetHead: [
    "HARNESS",
    "the live <head> owners and the remembered base title. testUI's mount " +
    "reset clears them beside _resetAioRuntime; a page left mounted by one " +
    "test must not title the next test's document.",
  ],
  // `_resetHeadSsr` and `_resetSsrSelect` used to be here. They cleared the
  // collected <head> and the open-<select> stack at the start of every
  // top-level server render — which is what a module-wide scope shared by
  // every render needs, and what made two concurrent `renderToStream`s
  // corrupt each other. Both are per-render state now (air/ssr-render.ts), so
  // there is nothing to forget and no reset to own.
  _resetSsrRenders: [
    "HARNESS",
    "the server renders themselves — which one a no-argument collectHead() " +
    "answers for, and which are still live. `_resetHead` calls it, so the " +
    "harness's head reset covers the server half too: without it a test " +
    "that rendered nothing could read the PREVIOUS test's page out of " +
    "collectHead().",
  ],
  _resetCss: [
    "MANUAL",
    "scoped-CSS rules live in src/ui/, and neither src/state/ (where " +
    "_resetAioRuntime is) nor src/testing/ may import ui — the boundary " +
    "matrix. Loosening a red gate to save one line is the wrong trade, so the " +
    "one test file that defines classes clears them itself. A leaked class is " +
    "also inert: the name is a hash of the rule, so nothing can collide with it",
  ],
  _resetDarkOsLightPage: [
    "MANUAL",
    "a once-per-page dev warning. Only dev-diagnostics installs the check " +
    "(never testUI), so it never fires in another test; the one test file " +
    "that drives it resets it between cases",
  ],
  _resetDevOverlay: [
    "MANUAL",
    "the overlay installs ONCE per page and is never uninstalled by the " +
    "product — a reset exists only so the one test file that installs it can " +
    "put the globals back. It arms nothing unless a test turns dev mode on " +
    "and hands it a document",
  ],
  _resetCallTimeouts: ["RUNTIME", "per-call timeout registry"],
  _resetNegativeDurationWarnings: [
    "RUNTIME",
    "once-per-id negative backoff/poll duration warnings",
  ],
  _resetDegraded: ["RUNTIME", "process-global degraded registry"],
  _resetBigStateWarnings: [
    "MANUAL",
    "the once-per-cell big-state latch. It lives in src/server/ and the one " +
    "call — _resetAioRuntime — is in src/state/, which may not import server " +
    "(the boundary matrix). Loosening a red gate to save one line is the " +
    "wrong trade, so the one test that fires the warning clears it itself",
  ],
  _resetBudgetMisses: [
    "RUNTIME",
    "per-cell budget-violation counts — three misses promote a cell to " +
    "'repeat offender', and carrying them between tests changes a later " +
    "test's message",
  ],
  _resetMethodCancel: ["RUNTIME", "cancellation registry"],
  _resetSubs: ["RUNTIME", "subscription registry"],
  _resetRootSignals: ["RUNTIME", "module-scope signal state"],
  _resetContrastAudit: [
    "HARNESS",
    "the dev contrast audit's per-pair memory — same warn-dedup class as the " +
    "RUNTIME entries, and it cannot join them: it lives in src/air/ and the " +
    "one call (_resetAioRuntime) is in src/state/, which may not import air. " +
    "testUI's mount clears it, which is every UI test",
  ],
  _resetSelectorAudit: [
    "HARNESS",
    "the #id-selector audit's per-id memory — see _resetContrastAudit",
  ],
  _resetUntrackedReadWarnings: [
    "HARNESS",
    "the untracked-lifecycle-read memory, keyed per (component, value) — see " +
    "_resetContrastAudit",
  ],
  _resetSelectorHints: ["RUNTIME", "warn dedup — order-dependent unreset"],
  _resetTransactionHints: ["RUNTIME", "warn dedup — order-dependent unreset"],
  _resetReturnEffectHints: ["RUNTIME", "warn dedup — order-dependent unreset"],
  _resetArrayRefStats: ["RUNTIME", "diagnostic counters"],
  _resetPerfThrottle: ["RUNTIME", "error-report throttle"],
  _resetActionWarnings: ["RUNTIME", "warn dedup — order-dependent unreset"],
  _resetSwallowedRefusals: [
    "RUNTIME",
    "warn dedup — order-dependent unreset",
  ],
  _resetShortCallWarnings: [
    "RUNTIME",
    "warn dedup — order-dependent unreset",
  ],

  // ── owned by a lifecycle in src/ ────────────────────────────────
  _resetSignals: ["LIFECYCLE", "state-core / standalone boot"],
  _resetTransport: ["LIFECYCLE", "state-core transport swap"],
  _resetMessageState: ["LIFECYCLE", "state-core"],
  _resetInitialStateFlag: ["LIFECYCLE", "state-core"],
  _resetState: ["LIFECYCLE", "standalone runtime (harness mount + dispose)"],
  _resetAppDirs: ["LIFECYCLE", "app-dir registration"],
  _reset: ["LIFECYCLE", "protocol-router / time-travel panel own theirs"],

  // ── owned by a harness ──────────────────────────────────────────
  _resetAuthUi: ["HARNESS", "testUI installs and restores the ambient user"],
  _resetHomePin: [
    "MANUAL",
    "tests/am-uds-only-app.test.ts un-pins the --home lock between cases",
  ],
  _resetLifecycleFacts: [
    "MANUAL",
    "tests/lifecycle-restart.test.ts resets the process facts between cases",
  ],
  _resetSurfaceWarnings: [
    "HARNESS",
    "duplicate-`t` report dedup; testUI clears it at mount so every test " +
    "hears about its own surface. src/state's one call may not reach " +
    "src/air (boundaries), and the live `am` tier wants warn-once per process",
  ],
  _resetCellRegistry: [
    "MANUAL",
    "deliberately NOT in the one call — clearing it disarms every later " +
    "testUI in the file (see runtime-reset.ts); only a registration test wants it",
  ],

  // ── still manual: each is a memory someone has to hold ──────────
  // Everything below is the unfinished part of this class. A MANUAL entry is
  // not a blessing — it is a debt with a name. Prefer moving one up to RUNTIME
  // over adding another here.
  _resetForwardedHandles: ["MANUAL", "advisory-only observation; test-local"],
  // Once-per-Host warn dedup for the DNS-rebinding refusal. MANUAL on purpose:
  // production never wants it cleared — forgetting which Hosts were reported is
  // exactly what would make that log floodable by attacker-chosen input — so
  // only the test that proves "once per Host, and bounded" resets it.
  _resetHostWarnings: ["MANUAL", "warn dedup; clearing it in prod is the bug"],
  _resetParsedCli: [
    "MANUAL",
    "memoized boot-path parse; lives in src/server, which src/state's one " +
    "call may not import (boundaries). Only a test parsing the DEFAULT " +
    "Deno.args twice needs it — every other test passes an explicit array " +
    "and never touches the cache",
  ],
  _resetConfigConflicts: [
    "MANUAL",
    "the once-per-process dedup for config COUPLING reports (server/config.ts). " +
    "Same boundary as _resetParsedCli: src/state's one call may not import " +
    "src/server. And the dedup is what it is FOR — aio.run() validates the " +
    "CellsConfig on the way in and the composed AioConfig on the way through, " +
    "so one boot sees every conflict twice. Only a test that asserts the " +
    "reporting half needs to forget it",
  ],
  _resetPortSlice: [
    "MANUAL",
    "the set of ports freePort() has already issued, plus the round-robin " +
    "cursor. It must NOT be reset per test — the whole point is that no port " +
    "is handed to two callers in one PROCESS, and a per-test clear would " +
    "restore exactly the bug it exists to remove (a shard's slice wraps, and " +
    "a file that stops its server between tests gets its port handed to " +
    "another file, which keeps it: `port 20000 already in use`, reading as a " +
    "product failure). Cross-test bleed is the FEATURE. Only " +
    "tests/free-port-no-reissue.test.ts calls it, to drive the allocator " +
    "through slice exhaustion without a 12,000-port loop, and it restores " +
    "the env it borrowed.",
  ],
  _resetTargetGuess: [
    "MANUAL",
    "the `am` target guess (`_discoveredTarget`) plus the once-per-target " +
    "stderr echo. Lives in src/am, which src/state's one call may not import " +
    "(boundaries) — and the memo is what it is FOR: one `am` invocation says " +
    "where it is pointing ONCE, so clearing it per command would echo the " +
    "same resolution on every port lookup. Only tests/am-verb-target.test.ts, " +
    "which re-points AIO_APPS_DIR between cases, needs to forget it",
  ],
  _resetPendingFactories: ["MANUAL", "own-effect factories; lifecycle-shaped"],
  _resetServerOnlyStatic: [
    "MANUAL",
    "build-scoped, not runtime: the bundler calls it at the START of each " +
    "esbuild run so one build's server-only-import findings cannot be " +
    "attributed to the next. Nothing in the app runtime touches it",
  ],
  _resetFeedbackRate: [
    "LIFECYCLE",
    "the feedback report budget; `installFeedbackRuntime` clears it, and that is what boot and every teardown already call",
  ],
  _resetMachineHostname: [
    "MANUAL",
    "one memoized `Deno.hostname()` for the Host gate. A machine does not rename itself mid-process, so nothing needs to forget it; only a test asserting the gate's rule against a controlled hostname does",
  ],
  _resetReadOnlyHint: ["MANUAL", "lives in src/air — state must not import it"],
  _resetInitialShapeKeys: ["MANUAL", "protocol shape-drift keys"],
  _resetSchedules: ["MANUAL", "schedule registry; harness uses virtual time"],
  _resetSsrIdCounter: ["MANUAL", "SSR id counter; per-render test"],
  _resetStateVersion: ["MANUAL", "wire version pin"],
  // The process-exit memo (`stopProcess`). MANUAL because clearing it is only
  // ever right for the test that captured the exit: in a real process there is
  // exactly one exit, and forgetting it would let a second signal start a
  // second shutdown over the first one's half-released locks.
  _resetStopProcess: ["MANUAL", "process-exit memo; a second exit is the bug"],
  // `aio/ui` control ids (aria-controls / aria-labelledby pairs). MANUAL
  // because the counter is deliberately monotonic within a page — resetting it
  // per test is what makes an ASSERTION on an id readable, and resetting it in
  // product code would hand two live components the same id. It delegates to
  // the renderer's SSR id counter: the ids are `useId()`s now, so a MOUNT
  // restarts them on its own (the counter is per root) and only the SSR path
  // is process-wide.
  // The open-modal stack (`aio/ui` Modal). MANUAL because a modal that
  // outlives its test would keep answering Escape for the next one — which is
  // the bug the stack exists to prevent, one level up — while in product code
  // the stack IS the state: clearing it would orphan every open dialog's
  // handler and leave Escape doing nothing.
  // Which unattributable writes `reactiveDB` has already reported. MANUAL
  // because the dedupe is per PROCESS on purpose — the same statement repeats
  // on every write, and the warning is about a live query that has gone stale,
  // not about one call. A test that wants to OBSERVE it has to clear it;
  // clearing it in product code would repeat the line on every write of a hot
  // path, which is the flooding the dedupe exists to stop.
  _resetReactiveWarnings: [
    "MANUAL",
    "stale-query warn dedup; repeating it is the bug",
  ],
  _resetModalStack: ["MANUAL", "open-modal stack; a stale entry is the bug"],
  _resetControlIds: ["MANUAL", "aria id counter; a collision is the bug"],
  // The once-per-process frozen-write explanation. MANUAL because the whole
  // point is that it is said ONCE: resetting it per test is what lets a test
  // assert the paragraph, and resetting it in product code would repeat it on
  // every tick of a hot path.
  _resetFrozenWriteHint: ["MANUAL", "warn dedup; repeating it is the bug"],
  // The process-wide SIGINT/SIGTERM install. MANUAL because a SECOND install
  // in one process is the bug it guards: the handlers are added once, at the
  // top of the first app's boot, and adding them again would stack a listener
  // per app on a signal that already stops all of them.
  _resetProcessSignals: ["MANUAL", "signal install; a second one is the bug"],
  _resetStateReady: ["MANUAL", "client readiness latch"],
  _resetStatus: ["MANUAL", "client status"],
  _resetTracking: ["MANUAL", "telemetry opt-in"],
  _resetToasts: ["MANUAL", "aio/ui toast queue"],
  _resetMarkdownWarnings: [
    "MANUAL",
    "aio/ui <Markdown> dropped-href report dedup; lives in src/ui, which src/state's one call may not import",
  ],
  _resetDevTools: ["MANUAL", "devtools bridge"],
  _resetTestDisplay: ["MANUAL", "test display"],
  _resetBlobStores: ["MANUAL", "db blob stores"],
  _resetDbReports: ["MANUAL", "db report cache"],
  _resetEnsured: ["MANUAL", "db ensure cache"],
  _resetServerFns: ["MANUAL", "serverFn registry"],
  _resetSfnClient: ["MANUAL", "serverFn client"],
  _resetServerTsForTest: ["MANUAL", "server timestamp pin"],
  _resetAuthFails: ["MANUAL", "auth lockout counters"],
  _resetTotpReplay: ["MANUAL", "TOTP replay window"],
  _resetOidcCaches: ["MANUAL", "OIDC JWKS cache"],
  _resetInstanceVerify: ["MANUAL", "instance verification"],
  _resetSecurityWarnings: ["MANUAL", "boot security warn dedup"],
  _resetImportMapWarnings: ["MANUAL", "import-map warn dedup"],
  _resetEventWarnings: ["MANUAL", "event warn dedup"],
  _resetBrowserSync: ["MANUAL", "browser sync client"],
  _resetVendorCache: ["MANUAL", "build vendor cache"],
};

async function exportedResets(dir: string): Promise<Set<string>> {
  const found = new Set<string>();
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      for (const n of await exportedResets(path)) found.add(n);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      const src = await Deno.readTextFile(path);
      for (const m of src.matchAll(/export function (_reset\w*)\s*\(/g)) {
        found.add(m[1]!);
      }
    }
  }
  return found;
}

Deno.test("every module-scope reset in src/ has a declared owner", async () => {
  const actual = await exportedResets(
    new URL("../src", import.meta.url).pathname,
  );
  const undeclared = [...actual].filter((n) => !(n in OWNERS)).sort();
  assertEquals(
    undeclared,
    [],
    `New module-scope reset(s) with no owner: ${undeclared.join(", ")}.\n` +
      `Module-scope mutable state whose lifetime nobody owns is silent ` +
      `cross-test bleed. Add each to OWNERS in tests/reset-ownership.test.ts:\n` +
      `  RUNTIME   — call it from _resetAioRuntime (preferred: per-test hygiene)\n` +
      `  LIFECYCLE — src/ code already owns when it runs\n` +
      `  HARNESS   — a harness calls it at mount\n` +
      `  MANUAL    — each test calls it, and say WHY that is right`,
  );

  // The ledger must not rot in the other direction either: an entry for a
  // reset that no longer exists is a stale claim about the codebase.
  const stale = Object.keys(OWNERS).filter((n) => !actual.has(n)).sort();
  assertEquals(stale, [], `OWNERS names resets that no longer exist: ${stale}`);
});

Deno.test("_resetAioRuntime actually calls everything filed under RUNTIME", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/state/runtime-reset.ts", import.meta.url).pathname,
  );
  const body = src.slice(src.indexOf("export function _resetAioRuntime"));
  const missing = Object.entries(OWNERS)
    .filter(([name, [owner]]) =>
      owner === "RUNTIME" && name !== "_resetAioRuntime" &&
      !body.includes(`${name}(`)
    )
    .map(([n]) => n);
  assertEquals(
    missing,
    [],
    `filed as RUNTIME but not called by the one call: ${missing.join(", ")}`,
  );
});

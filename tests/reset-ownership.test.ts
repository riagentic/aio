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
  _resetCallTimeouts: ["RUNTIME", "per-call timeout registry"],
  _resetDegraded: ["RUNTIME", "process-global degraded registry"],
  _resetMethodCancel: ["RUNTIME", "cancellation registry"],
  _resetSubs: ["RUNTIME", "subscription registry"],
  _resetRootSignals: ["RUNTIME", "module-scope signal state"],
  _resetSelectorHints: ["RUNTIME", "warn dedup — order-dependent unreset"],
  _resetTransactionHints: ["RUNTIME", "warn dedup — order-dependent unreset"],
  _resetReturnEffectHints: ["RUNTIME", "warn dedup — order-dependent unreset"],
  _resetArrayRefStats: ["RUNTIME", "diagnostic counters"],
  _resetPerfThrottle: ["RUNTIME", "error-report throttle"],

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
  _resetHints: ["MANUAL", "aiol hint dedup"],
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

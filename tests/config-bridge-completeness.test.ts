// Every option in `aio.run({ … })` must actually reach the runtime.
//
// This bug class landed FOUR times, always silently:
//
//   • `strictOrigin` — typed, documented, validated, dropped at the bridge:
//     the WS origin check never saw it.
//   • `redactActions` — shipped with its own tests and docs; `journal: true,
//     redactActions: […]` wrote the passphrase to disk anyway.
//   • `appDir` — the bridge read it for the LOGGER only, so logs went to the
//     configured directory and ALL DATA to the default one. An exemption in
//     this very test ("some consumer reads it directly") masked it.
//   • `renderBudget` — same exemption trick: the consumer named in the
//     exemption read the BRIDGED config, which never carried it.
//
// The grep-based version of this test could be satisfied by a lie. The bridge
// is now a mechanical spread (fail-closed: an unknown option rides through by
// default), and this test PROVES it at runtime: a sentinel value per
// documented option goes in, and must come out of buildLegacyConfig — no
// source-text matching, no exemption escape hatch for passthrough keys.
import { assert, assertEquals } from "@std/assert";
import { VALID_FEATURES_CONFIG_KEYS } from "../src/server/config.ts";
import { buildLegacyConfig } from "../src/server/aio-cells-bridge.ts";
import { composeCellsWiring } from "../src/server/aio-composition.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

/** Keys the bridge CONSUMES (they become something else and must NOT ride
 *  through raw) or REWRITES under a new name. Each is asserted below — an
 *  entry that stops being true fails the test, so this list cannot rot. */
const CONSUMED: Record<string, "dropped" | "renamed" | "wrapped"> = {
  cells: "dropped", // composed into reduce/execute
  cellDefaults: "dropped", // applied per cell at composition time
  localFirst: "dropped", // applyLocalFirst at composition time
  isolate: "dropped", // composition-time worker isolation switch
  logging: "dropped", // became the logger instance
  dispatchStorm: "dropped", // became the storm detector inside beforeReduce
  diagnostics: "renamed", // → _diagnostics
  onCheckpointRestore: "renamed", // → _onCheckpointRestore
  beforeReduce: "wrapped", // storm guard wraps the user hook
  onAction: "wrapped", // logger.observe wraps the user hook
  onStart: "wrapped", // cells runner fires the user hook later
  onStop: "wrapped", // logger flush + destroyAll wrap the user hook
  onRestore: "wrapped", // migration pipeline wraps the user hook
};

Deno.test("config bridge: every documented option comes OUT of the bridge", () => {
  _resetAioRuntime();
  const c = cell("bridge-probe", { state: { n: 0 }, methods: {} });
  const { composed } = composeCellsWiring({
    // deno-lint-ignore no-explicit-any
    cellEntries: [c] as any,
  });

  // One sentinel per documented option — unique, so a value that leaks into
  // the wrong key is caught too.
  const fc: Record<string, unknown> = { appId: "bridge-probe-app" };
  const sentinels = new Map<string, string>();
  for (const key of VALID_FEATURES_CONFIG_KEYS) {
    if (key.startsWith("_")) continue;
    const v = `sentinel:${key}`;
    sentinels.set(key, v);
    fc[key] = v;
  }

  const out = buildLegacyConfig({
    // deno-lint-ignore no-explicit-any
    fc: fc as any,
    composed,
    beforeReduce: undefined,
    // The wiring layer upstream folds fc.onRestore into this composed hook —
    // model that: the bridge must forward IT, not the raw fc value.
    onRestore: (s) => s,
    autoGetUIState: undefined,
    autoGetDBState: (s) => s,
    cellPatchStrategies: new Map(),
    cellFilterFieldsMap: new Map(),
    cellReportOpts: {},
    logger: null,
    appRef: { current: null },
  }) as unknown as Record<string, unknown>;

  const missing: string[] = [];
  const mangled: string[] = [];
  for (const [key, sentinel] of sentinels) {
    const kind = CONSUMED[key];
    if (kind === "dropped") {
      if (out[key] === sentinel) mangled.push(`${key} (should be consumed)`);
      continue;
    }
    if (kind === "renamed") {
      if (out[`_${key}`] !== sentinel && out[key] === sentinel) {
        mangled.push(`${key} (rename regressed to raw passthrough)`);
      }
      continue;
    }
    if (kind === "wrapped") {
      if (typeof out[key] !== "function" && out[key] !== sentinel) {
        missing.push(`${key} (wrapper gone AND value gone)`);
      }
      continue;
    }
    if (out[key] !== sentinel) missing.push(key);
  }
  assertEquals(
    missing,
    [],
    "these options are accepted from the developer and then go NOWHERE — " +
      "the mechanical spread in buildLegacyConfig should carry them; if a key " +
      "is genuinely consumed, add it to CONSUMED with how",
  );
  assertEquals(mangled, [], "consumed/renamed keys behaving unexpectedly");

  // Renames actually land under their new names.
  assertEquals(out._diagnostics, "sentinel:diagnostics");
  assertEquals(out._onCheckpointRestore, "sentinel:onCheckpointRestore");
  // Wrapped hooks exist as functions (the wrapper is the point).
  assert(typeof out.beforeReduce === "function");
  assert(typeof out.onStart === "function");
  assert(typeof out.onStop === "function");
  _resetAioRuntime();
});

Deno.test("config bridge: no CONSUMED entry outlives the key it excuses", () => {
  for (const key of Object.keys(CONSUMED)) {
    assert(
      VALID_FEATURES_CONFIG_KEYS.has(key),
      `"${key}" is listed as consumed but is no longer a config key — drop it`,
    );
  }
});

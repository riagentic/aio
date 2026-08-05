import { assertEquals, assertExists } from "@std/assert";
import { initDiagnostics } from "../../src/diagnostics/mod.ts";

const TEST_DIR = await Deno.makeTempDir();

Deno.test("mod: diagnostics=false returns null", () => {
  const hooks = initDiagnostics(false, false, TEST_DIR);
  assertEquals(hooks, null);
});

Deno.test("mod: dev mode returns hooks", () => {
  const hooks = initDiagnostics({}, false, `${TEST_DIR}/dev`);
  assertExists(hooks);
  assertEquals(typeof hooks!.afterAction, "function");
  assertEquals(typeof hooks!.onStart, "function");
  assertEquals(typeof hooks!.onStop, "function");
  assertEquals(typeof hooks!.onError, "function");
  assertEquals(typeof hooks!.getRecoveredState, "function");
  assertEquals(typeof hooks!.setHealthGetter, "function");
});

Deno.test("mod: prod mode returns hooks (crash handler always on)", () => {
  const hooks = initDiagnostics({}, true, `${TEST_DIR}/prod`);
  assertExists(hooks);
  assertEquals(typeof hooks!.afterAction, "function");
  // Clean up crash handler
  if (hooks!.uninstallCrashHandler) hooks!.uninstallCrashHandler();
});

Deno.test("mod: getRecoveredState returns null when no checkpoint", () => {
  const hooks = initDiagnostics({}, false, `${TEST_DIR}/no-cp`);
  assertExists(hooks);
  assertEquals(hooks!.getRecoveredState(), null);
  if (hooks!.uninstallCrashHandler) hooks!.uninstallCrashHandler();
});

Deno.test("mod: onStart initializes cell tracking", () => {
  const hooks = initDiagnostics(
    { dev: { crashHandler: false, checkpoint: false, actionLog: false } },
    false,
    `${TEST_DIR}/track`,
  );
  assertExists(hooks);
  hooks!.onStart(["counter", "wallet"]);
  // onError should increment
  hooks!.onError("counter");
  hooks!.onError("counter");
  hooks!.onError("wallet");
  // No direct way to assert without health getter, but it shouldn't throw
});

// Diagnostics observe; they never decide. A writer that throws must not (a)
// reach the caller — the runtime's afterAction chain continues into work that
// IS load-bearing (the sync-cell durability fold, the journal, the timeline) —
// nor (b) take the other writers down with it.
Deno.test("mod: a throwing diagnostics writer never propagates, and the others still run", async () => {
  const dir = `${TEST_DIR}/observe-only`;
  await Deno.mkdir(dir, { recursive: true });
  const hooks = initDiagnostics(
    {
      dev: {
        stateDiffs: true,
        checkpoint: { debounce: 0 },
        actionLog: false,
        crashHandler: false,
      },
    },
    false,
    dir,
  );
  assertExists(hooks);
  // A slice whose value cannot even be READ — computeDiffs throws on it.
  const hostile: Record<string, unknown> = {};
  Object.defineProperty(hostile, "x", {
    get() {
      throw new Error("state-diff down");
    },
    enumerable: true,
  });

  const errs: string[] = [];
  const real = { log: console.log, error: console.error };
  const cap = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  console.log = cap;
  console.error = cap;
  try {
    hooks!.afterAction({ c: {} }, { c: hostile }, { type: "c:go" });
  } finally {
    console.log = real.log;
    console.error = real.error;
  }
  await hooks!.onStop();

  // …the checkpoint (a later stage) still wrote, so the failure was contained
  const cp = JSON.parse(await Deno.readTextFile(`${dir}/checkpoint.json`));
  assertEquals(cp.recentActions, ["c:go"], "later writers still ran");
  // …and it was reported, not swallowed
  assertEquals(
    errs.some((l) => l.includes("state-diff") && l.includes("down")),
    true,
    `the failure is loud; got: ${errs.join(" | ")}`,
  );
});

// alpha70 — one import path per symbol, and nothing accepted that is not read.
//
// Every removal here is a duplicate home or an alias that had been "through
// beta" since alpha52. The pins are the ABSENCE of the old spelling on the old
// entry (a re-export that quietly grows back is the regression) and the
// presence on the one canonical entry, so the two cannot drift apart again.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  MEMORY_CONFIG_KEYS,
  type MemoryConfig,
  validateMemoryConfig,
} from "../src/diagnostics/memory-monitor.ts";
import * as internal from "../src/testing/internal.ts";
import denoJson from "../deno.json" with { type: "json" };

// deno-lint-ignore no-explicit-any
type Mod = Record<string, any>;
const load = (p: string): Promise<Mod> => import(p) as Promise<Mod>;

Deno.test("alpha70: aio/db is types-only — no runtime value survives on it", async () => {
  const db = await load("../src/db/mod.ts");
  assertEquals(Object.keys(db), [], "aio/db must export nothing at runtime");
  const server = await load("../src/server-entry.ts");
  for (
    const v of [
      "createDB",
      "DEFAULT_PRAGMAS",
      "initSchema",
      "loadTables",
      "syncTables",
      "reactiveDB",
    ]
  ) {
    assert(server[v] !== undefined, `${v} lives on aio/server`);
  }
});

Deno.test("alpha70: one home — ship on aio/ship, appDirs/updates runtime on aio/server + aio/updates, harnesses on aio/testing", async () => {
  const build = await load("../src/build.ts");
  const ship = await load("../src/build/ship.ts");
  for (
    const v of [
      "shipApp",
      "buildShipManifest",
      "verifyShipManifest",
      "generateSigningKey",
      "manifestReport",
      "permissionFlags",
    ]
  ) assertEquals(build[v], undefined, `${v} left aio/build`);
  for (const v of ["shipApp", "buildShipManifest", "verifyShipManifest"]) {
    assertEquals(typeof ship[v], "function", `${v} on aio/ship`);
  }
  assertEquals(typeof build.scanCapabilities, "function", "scanner stays");

  const testing = await load("../src/cell-test.ts");
  for (const v of ["appDirs", "installUpdatesRuntime", "testgen"]) {
    assertEquals(testing[v], undefined, `${v} left aio/testing`);
  }
  for (const v of ["ensureAppDirs", "registerAppDirs", "_resetAppDirs"]) {
    assertEquals(typeof testing[v], "function", `${v} (a test seam) stays`);
  }
  assertEquals(
    typeof (await load("../src/server-entry.ts")).appDirs,
    "function",
  );
  assertEquals(
    typeof (await load("../src/updates.ts")).installUpdatesRuntime,
    "function",
  );

  const air = await load("../src/air.ts");
  for (const v of ["testComponent", "setDocument"]) {
    assertEquals(air[v], undefined, `${v} left aio/air`);
    assertEquals(typeof testing[v], "function", `${v} on aio/testing`);
  }

  const core = await load("../mod.ts");
  assertEquals(core.testCell, undefined, "testCell left the core entry");
  assertEquals(typeof testing.testCell, "function");

  const extras = await load("../src/extras/mod.ts");
  assertEquals(extras.lint, undefined, "extras.lint alias removed");
  assertEquals(typeof extras.checkCells, "function");
});

Deno.test("alpha70: aiol's programmatic surface is lintProject/LintReport", async () => {
  const aiol = await load("../aiol/mod.ts");
  assertEquals(typeof aiol.lintProject, "function");
  assertEquals(aiol.lint, undefined, "the bare `lint` is gone");
  const r: import("../aiol/types.ts").LintReport = await aiol.lintProject(
    await Deno.makeTempDir(),
  );
  assert(Array.isArray(r.issues));
});

Deno.test("alpha70: memory.gcStressRatio is refused BY NAME with the registry message; unknown keys get a did-you-mean", () => {
  const e = assertThrows(
    () => validateMemoryConfig({ gcStressRatio: 0.05 }),
    Error,
  );
  assertStringIncludes(
    e.message,
    "memory.gcStressRatio was removed in alpha70",
  );
  assertStringIncludes(e.message, "never read");
  assertStringIncludes(e.message, "am pin v1.0.0-alpha69");
  const t = assertThrows(
    () => validateMemoryConfig({ warnTreshold: 0.5 }),
    Error,
  );
  assertStringIncludes(t.message, 'did you mean "warnThreshold"');
  validateMemoryConfig({ warnThreshold: 0.5, interval: 1000 }); // clean: no throw
});

Deno.test("alpha70: MEMORY_CONFIG_KEYS is exactly the MemoryConfig type", () => {
  // Compile-time: every key of the type is in the set (the set is typed by
  // `keyof MemoryConfig`, so a key the monitor stops reading fails here), and
  // the removed key is not a key of the type.
  const all: Record<keyof MemoryConfig, true> = {
    enabled: true,
    interval: true,
    warnThreshold: true,
    criticalThreshold: true,
    trendWindow: true,
    machineWarnFraction: true,
    growthReportRatio: true,
    onMemoryPressure: true,
  };
  assertEquals(new Set(Object.keys(all)), new Set(MEMORY_CONFIG_KEYS));
  // @ts-expect-error — removed in alpha70
  const gone: MemoryConfig = { gcStressRatio: 0.05 };
  assert(gone);
});

Deno.test("alpha70: src/testing/internal.ts carries the test-only seams and is NOT an entry", () => {
  for (
    const v of [
      "gitWorkTreeOf",
      "notRunnableExit",
      "publishInstructions",
      "isArtifactName",
      "placedName",
      "suffixedTargets",
      "unsafeOutDir",
      "manifestReport",
      "permissionFlags",
      "extractAioVersion",
      "parseDevices",
    ]
  ) assertEquals(typeof (internal as Mod)[v], "function", v);
  assert(
    !Object.values(denoJson.exports).some((p) =>
      p.includes("testing/internal")
    ),
    "internal.ts must never be on the exports map",
  );
});

Deno.test("alpha70: the api snapshot no longer carries the removed spellings or the @internal sync sweep", async () => {
  const snap = JSON.parse(
    await Deno.readTextFile(
      new URL("../docs/api-snapshot.json", import.meta.url),
    ),
  ) as { entries: Record<string, { symbols: Record<string, unknown> }> };
  const has = (entry: string, sym: string) =>
    snap.entries[entry]?.symbols[sym] !== undefined;
  for (
    const [entry, sym] of [
      ["./db", "createDB"],
      ["./build", "shipApp"],
      ["./build", "manifestReport"],
      ["./testing", "appDirs"],
      ["./testing", "installUpdatesRuntime"],
      ["./testing", "testgen"],
      ["./air", "testComponent"],
      [".", "testCell"],
      [".", "SendOf"],
      ["./extras", "lint"],
      ["./extras", "ActionUnion"],
      ["./sync", "SYNC_DEFAULTS"],
      ["./sync", "compareHLC"],
      ["./android-install", "parseDevices"],
      ["./build-all", "unsafeOutDir"],
      ["./aiol", "lint"],
      ["./aiol", "Report"],
    ] as const
  ) assert(!has(entry, sym), `${entry} still snapshots ${sym}`);
  for (
    const [entry, sym] of [
      ["./ship", "shipApp"],
      ["./testing", "testCell"],
      ["./testing", "testComponent"],
      ["./server", "appDirs"],
      ["./updates", "installUpdatesRuntime"],
      ["./aiol", "lintProject"],
      ["./aiol", "LintReport"],
    ] as const
  ) assert(has(entry, sym), `${entry} lost ${sym}`);
});

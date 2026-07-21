// Complexity-audit regression — security/limit options must survive the
// CellsConfig → AioConfig bridge. `strictOrigin`/`allowedOrigins`/`wsLimits`
// were typed in CellsConfig and validated by config.ts, but buildLegacyConfig
// silently DROPPED them, so `aio.run({ strictOrigin: true })` never reached
// the WS origin check. Config that validates but doesn't act is worse than no
// config: it reads as security you don't have.
import { assertEquals } from "@std/assert";
import { buildLegacyConfig } from "../../src/server/aio-cells-bridge.ts";

Deno.test("bridge: security + limit options survive CellsConfig → AioConfig", () => {
  const cfg = buildLegacyConfig({
    fc: {
      cells: [],
      strictOrigin: true,
      allowedOrigins: ["https://app.example.com"],
      wsLimits: { maxMsgBytes: 1024 },
      maxConnections: 7,
    },
    composed: {
      initialState: {},
      reduce: (s: unknown) => ({ state: s, effects: [] }),
      execute: () => {},
      cells: [],
    },
    beforeReduce: undefined,
    onRestore: undefined,
    autoGetUIState: (s: unknown) => s,
    autoGetDBState: (s: unknown) => s,
    cellPatchStrategies: new Map(),
    cellFilterFieldsMap: new Map(),
    cellReportOpts: new Map(),
    logger: undefined,
    appRef: { current: null },
    // deno-lint-ignore no-explicit-any
  } as any);
  assertEquals(cfg.strictOrigin, true);
  assertEquals(cfg.allowedOrigins, ["https://app.example.com"]);
  assertEquals(
    (cfg.wsLimits as { maxMsgBytes?: number })?.maxMsgBytes,
    1024,
  );
  assertEquals(cfg.maxConnections, 7);
});

// risoto #9 — `am top`: live runtime observability. Tests the pure frame
// renderer + fmtBytes + the metrics route enrichment (per-cell state sizes).
import { assert, assertEquals } from "@std/assert";
import {
  fmtBytes,
  renderTopFrame,
  type TopMetrics,
} from "../src/am/am-cmd-inspect.ts";
import { handleTrojan, type TrojanDeps } from "../src/server/server-trojan.ts";

Deno.test("fmtBytes: human units + cyclic sentinel", () => {
  assertEquals(fmtBytes(0), "0 B");
  assertEquals(fmtBytes(512), "512 B");
  assertEquals(fmtBytes(2048), "2.0 KB");
  assertEquals(fmtBytes(3_145_728), "3.0 MB");
  assertEquals(fmtBytes(-1), "(cyclic)");
});

Deno.test("renderTopFrame: cells sorted by size desc, with header + total", () => {
  const m: TopMetrics = {
    uptime: 65,
    connections: 2,
    schedules: 3,
    cells: { nav: 100, accounts: 5000, prices: 800 },
  };
  const frame = renderTopFrame(m, "12:00:00");
  const lines = frame.split("\n");
  assert(lines[0]!.includes("aio top") && lines[0]!.includes("12:00:00"));
  assert(lines[1]!.includes("clients 2") && lines[1]!.includes("schedules 3"));
  assert(lines[1]!.includes("cells 3"), "cell count in header");
  assert(lines[1]!.includes("5.8 KB"), `total 5900 bytes; got: ${lines[1]}`);
  // Cell rows (after the blank line + CELL/STATE header) sorted biggest-first.
  const rows = lines.slice(4).filter((l) => l.trim());
  assertEquals(rows[0]!.includes("accounts"), true);
  assertEquals(rows[1]!.includes("prices"), true);
  assertEquals(rows[2]!.includes("nav"), true);
});

Deno.test("metrics route: reports per-cell serialized state sizes", async () => {
  const state = { nav: { status: "ready" }, big: { arr: [1, 2, 3, 4, 5] } };
  const deps = {
    getUIState: () => ({}),
    debug: () => {},
    prod: false,
    getWsClients: () => [{}, {}], // 2 connections
    trojan: {
      getState: () => state,
      getSchedules: () => ["tick"],
      startedAt: Date.now() - 5000,
    },
  } as unknown as TrojanDeps;
  const resp = await handleTrojan("/__aio/trojan/metrics", undefined, deps)!;
  const body = await resp.json() as TopMetrics;
  assertEquals(body.connections, 2);
  assertEquals(body.schedules, 1);
  assert(body.uptime >= 5, `uptime ~5s; got ${body.uptime}`);
  assertEquals(body.cells.nav, JSON.stringify(state.nav).length);
  assertEquals(body.cells.big, JSON.stringify(state.big).length);
});

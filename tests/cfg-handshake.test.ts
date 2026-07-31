// Runtime config handshake — the server's early "cfg" frame.
//
// The page shell embeds `__aioConfig` (syncCells / callTimeouts /
// renderBudget) — but electron's UDS shell and the android asset shell are
// templated at BUILD time, before compose-time decisions exist, so those
// clients booted with no config at all: silently non-local-first, wrong call
// ceilings. The server now sends the same resolved values as an early frame;
// shell-injected keys win (same values, delivered earlier), and late sync
// adoption upgrades routing without correcting state (pre-cfg actions
// round-tripped, which the server executes identically).
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dec } from "../src/protocol/envelope.ts";
import { _applyServerConfig } from "../src/browser/browser-protocol.ts";
import { resolveSyncCells } from "../src/browser/sync-cells.ts";

Deno.test("cfg frame: a connecting client receives the resolved config", async () => {
  const c = cell("cfg-cell", { state: { n: 0 }, methods: {} });
  await using srv = await testServer({
    cells: [c],
    effectTimeoutMs: 45_000,
    renderBudget: { staleness: 777 },
  });
  const ws = new WebSocket(srv.url.replace("http", "ws") + "/ws");
  const cfg = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no cfg frame")), 5000);
    ws.onmessage = (e) => {
      const f = dec(String(e.data));
      if (f?.t === "cfg") {
        clearTimeout(timer);
        resolve(f.d as Record<string, unknown>);
      }
    };
    ws.onerror = (e) => reject(e);
  });
  ws.close();
  await new Promise((r) => setTimeout(r, 50));
  const ct = cfg.callTimeouts as { default?: number };
  assertEquals(
    ct.default,
    45_000,
    "the resolved call ceiling rides the handshake",
  );
  assertEquals(
    (cfg.renderBudget as { staleness?: number }).staleness,
    777,
    "renderBudget survives the bridge AND rides the handshake — it used to be " +
      "silently dropped at the CellsConfig→AioConfig hop",
  );
});

Deno.test("cfg apply: fills gaps, never overrides the shell", () => {
  const g = globalThis as { __aioConfig?: Record<string, unknown> };
  const prev = g.__aioConfig;
  try {
    // No shell config (the electron case): the frame fills everything.
    delete g.__aioConfig;
    _applyServerConfig({
      syncCells: ["a"],
      callTimeouts: { default: 1000 },
    });
    assertEquals(g.__aioConfig, {
      syncCells: ["a"],
      callTimeouts: { default: 1000 },
    });

    // Shell config present: shell keys win, frame only fills gaps.
    g.__aioConfig = { syncCells: ["shell"] };
    _applyServerConfig({
      syncCells: ["frame"],
      callTimeouts: { default: 2000 },
    });
    assertEquals(
      (g.__aioConfig as { syncCells: string[] }).syncCells,
      ["shell"],
      "shell wins per-key",
    );
    assertEquals(
      (g.__aioConfig as { callTimeouts: { default: number } }).callTimeouts,
      { default: 2000 },
      "gap filled from the frame",
    );
  } finally {
    if (prev === undefined) delete g.__aioConfig;
    else g.__aioConfig = prev;
  }
});

Deno.test("cfg apply: late syncCells adopt via the one resolver", () => {
  // A def the server adopted (localFirst) that the client learned about ONLY
  // from the cfg frame — enableSync must run when the frame lands.
  const g = globalThis as { __aioConfig?: Record<string, unknown> };
  const prev = g.__aioConfig;
  let enabled = 0;
  try {
    delete g.__aioConfig;
    _applyServerConfig({ syncCells: ["late-adopted"] });
    // The resolver itself is pinned in tests/local-first.test.ts; here we pin
    // that the frame reaches it: resolveSyncCells sees the frame's ids.
    const def = {
      __aio: { id: "late-adopted", enableSync: () => enabled++ },
    } as never;
    const out = resolveSyncCells([def]);
    assertEquals([...out.keys()], ["late-adopted"]);
    assert(enabled === 1, "the frame's ids drive adoption");
  } finally {
    if (prev === undefined) delete g.__aioConfig;
    else g.__aioConfig = prev;
  }
});

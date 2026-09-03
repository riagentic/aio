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
  assertEquals(
    cfg.bootedCells,
    ["cfg-cell"],
    "the booted cell set must ride the frame — it was dropped at the " +
      "AioConfig→setupTransport hop (a hand-copied literal that never listed " +
      "_cellNames), so the frame carried callTimeouts and nothing else and " +
      "the browser's cell-set-drift warning was unreachable code",
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

// The app's IDENTITY, on both doors.
//
// `localStorage` is scoped to an ORIGIN, so the browser's offline sync queue
// scopes its key by the app id — two aio apps on one host:port otherwise
// shared pending CRDT ops for every cell name they had in common, and app B's
// first catch-up flushed app A's unsent mutations into B's server
// (tests/sync/offline-queue-app-scope.test.ts pins the client half). The
// client reads the id off the bridged config, so the server has to send it —
// in the SHELL as well as the frame, because a page can boot sync before the
// frame arrives, which is the same reason `syncCells` is injected there.
Deno.test("cfg: the app id reaches the browser through the shell AND the frame", async () => {
  const c = cell("appid-cell", { state: { n: 0 }, methods: {} });
  await using srv = await testServer({
    cells: [c],
    appId: "identity-under-test",
  });

  const html = await (await srv.fetch("/")).text();
  const m = /window\.__aioConfig=(\{.*?\})<\/script>/.exec(html);
  assert(m, `no injected config in the shell:\n${html.slice(0, 400)}`);
  const injected = JSON.parse(m[1]!) as { appId?: string };
  assertEquals(
    injected.appId,
    "identity-under-test",
    "the shell must name the app — the queue is scoped before any frame lands",
  );

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
  assertEquals(
    cfg.appId,
    "identity-under-test",
    "…and so must the frame, for shells templated at build time (electron, android)",
  );
});

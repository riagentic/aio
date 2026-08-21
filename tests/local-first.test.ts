// perfect-aio D3 — `aio.run({ localFirst: true })`, opt-in.
//
// The switch makes every SERVER cell run its methods where the caller is and
// propagate the change as a CRDT op; the server still re-runs each op and
// remains the authority. Mechanically that is "sync: true by default", with
// `sync: false` as the per-cell opt-out for anything whose optimistic preview
// would be a lie (auth, payments, a ledger).
//
// The half that is easy to get wrong is the CLIENT: `sync: true` lives in
// shared code so both ends see it, but localFirst is resolved on the server at
// compose time — so the browser is told, in the page shell, and adopts the cell
// through its own `enableSync` (config AND replay reducer, never one without
// the other). Spec: docs/specs/2026-07-22-local-first.md.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { composeCellsWiring } from "../src/server/aio-composition.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { generateHTML } from "../src/server/server-html-gen.ts";
import { resolveSyncCells } from "../src/browser/sync-cells.ts";

function compose(cells: unknown[], localFirst: boolean) {
  _resetAioRuntime();
  return composeCellsWiring({
    // deno-lint-ignore no-explicit-any
    cellEntries: cells as any,
    localFirst,
  });
}

Deno.test("localFirst: off by default — nothing syncs that didn't ask to", () => {
  const notes = cell("lf-notes", { state: { n: 0 }, methods: {} });
  const { composed } = compose([notes], false);
  assertEquals(composed.cells[0]!.__aio.syncConfig, undefined);
  _resetAioRuntime();
});

Deno.test("localFirst: on — every server cell syncs, `sync: false` opts out", () => {
  const notes = cell("lf-notes2", { state: { n: 0 }, methods: {} });
  const ledger = cell("lf-ledger", {
    state: { balance: 0 },
    methods: {},
    sync: false, // an optimistic preview here would be a lie
  });
  const tuned = cell("lf-tuned", {
    state: { xs: [] as string[] },
    methods: {},
    sync: { identity: { xs: "id" } },
  });
  const { composed } = compose([notes, ledger, tuned], true);
  const byId = new Map(composed.cells.map((c) => [c.__aio.id, c.__aio]));

  assert(byId.get("lf-notes2")!.syncConfig, "adopted");
  assertEquals(
    byId.get("lf-ledger")!.syncConfig,
    undefined,
    "sync: false is a decision, and it is respected",
  );
  assertEquals(
    byId.get("lf-tuned")!.syncConfig!.identity,
    { xs: "id" },
    "a cell that configured sync keeps ITS config, not the default",
  );
  _resetAioRuntime();
});

Deno.test("localFirst: client-scoped cells are never adopted", () => {
  const ui = cell("lf-ui", {
    state: { open: false },
    methods: {},
    scope: "client",
  });
  const server = cell("lf-srv", { state: { n: 0 }, methods: {} });
  const { composed } = compose([ui, server], true);
  // Client cells are filtered out of the server composition entirely.
  assertEquals(composed.cells.map((c) => c.__aio.id), ["lf-srv"]);
  assertEquals(ui.__aio.syncConfig, undefined);
  _resetAioRuntime();
});

Deno.test("localFirst: the decision reaches the browser through the page shell", () => {
  // Without this the client would keep dispatching to the server and localFirst
  // would be a server-side no-op that LOOKS enabled — the silent-half-feature
  // failure. The shell is the same channel the render budget already uses.
  const html = generateHTML({
    title: "t",
    prod: true,
    hasCSS: false,
    importMap: "{}",
    syncCells: ["lf-notes2", "lf-tuned"],
  });
  assert(html.includes("window.__aioConfig="), html.slice(0, 400));
  assert(html.includes('"syncCells":["lf-notes2","lf-tuned"]'), html);

  const none = generateHTML({
    title: "t",
    prod: true,
    hasCSS: false,
    importMap: "{}",
  });
  assert(!none.includes("syncCells"), "no cells ⇒ no config noise");
});

// The half that actually broke: TWO client-side places decide "does this cell
// sync" — the transport gate that loads the engine at all, and the engine's own
// boot. Both used to test `__aio.syncConfig` directly, which was complete only
// while a cell's own `sync: true` was the sole source of truth. Under localFirst
// the gate said no, so the engine never loaded and every method kept
// round-tripping while the SERVER logged "1 cell(s) run locally". Both callers
// now go through resolveSyncCells; this pins the rules it encodes.
Deno.test("localFirst: one resolver decides which cells sync, for every caller", () => {
  const mk = (
    id: string,
    aio: Record<string, unknown>,
  ) => ({ __aio: { id, ...aio } }) as never;
  let enabled = 0;
  const defs = [
    mk("own", { syncConfig: { merge: {} } }), // its own sync: true
    mk("adopted", { enableSync: () => enabled++ }), // localFirst
    mk("optout", { syncOptOut: true, enableSync: () => enabled++ }),
    mk("clientonly", { scope: "client", enableSync: () => enabled++ }),
    mk("unadopted", { enableSync: () => enabled++ }), // not in the shell list
    mk("cannot", {}), // adopted but has no enableSync (not a methods cell)
  ];
  const w = globalThis as unknown as { __aioConfig?: { syncCells?: string[] } };
  const prev = w.__aioConfig;
  const skipped: string[] = [];
  try {
    w.__aioConfig = {
      syncCells: ["adopted", "optout", "clientonly", "cannot"],
    };
    const out = resolveSyncCells(defs, (id) => skipped.push(id));
    assertEquals([...out.keys()], ["own", "adopted"]);
    assertEquals(enabled, 1, "enableSync runs exactly for the adopted cell");
    assertEquals(
      skipped,
      ["cannot"],
      "a cell that cannot replay is REPORTED, never silently downgraded",
    );
  } finally {
    w.__aioConfig = prev;
  }
});

Deno.test("localFirst: with no shell config, resolution is exactly today's behaviour", () => {
  const mk = (id: string, aio: Record<string, unknown>) =>
    ({ __aio: { id, ...aio } }) as never;
  const w = globalThis as unknown as { __aioConfig?: unknown };
  const prev = w.__aioConfig;
  try {
    delete w.__aioConfig;
    const out = resolveSyncCells([
      mk("a", { syncConfig: { merge: {} } }),
      mk("b", { enableSync: () => {} }),
    ]);
    assertEquals([...out.keys()], ["a"]);
  } finally {
    w.__aioConfig = prev;
  }
});

Deno.test("localFirst: the SPA-fallback shell carries syncCells too", async () => {
  // The trap that shipped: `/` passed syncCells to generateHTML, the
  // extensionless deep-link fallback (a reload on `/settings`) did not — so
  // WHICH URL a user reloaded on decided whether the app was local-first.
  // Both routes now come from one closure; this pins them together.
  const { createStaticHandler } = await import(
    "../src/server/server-static.ts"
  );
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/app.js`, "// bundle");
    const { serveStatic } = createStaticHandler({
      prod: true,
      debug: () => {},
      title: "T",
      absBaseDir: dir,
      absDistDir: dir,
      hasCSS: false,
      importMap: "{}",
      noCache: {},
      syncCells: ["lf-notes2"],
      getGraphResult: () => null,
      getVitalsExtra: () => ({
        payloadStats: new Map(),
        clientBackpressure: {},
      }),
      getTrojanDeps: () => ({}),
    });
    const root = await (await serveStatic("/")).text();
    const deep = await (await serveStatic("/settings/profile")).text();
    assert(root.includes('"syncCells":["lf-notes2"]'), "root shell");
    assert(deep.includes('"syncCells":["lf-notes2"]'), "deep-link shell");
    assertEquals(root, deep, "one shell, byte-identical on every route");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("localFirst: adopting a cell with existing persisted data keeps that data across restarts", async () => {
  // The flip trap: KV stops persisting a cell the moment it becomes a sync
  // cell — so unless adoption makes the restored state durable in the SYNC
  // store first, the first restart after the flip resurrects the cell as
  // initialState and the user's pre-flip data exists nowhere.
  const { createDB } = await import("../src/db/async-db.ts");
  const { SYNC_SCHEMA } = await import("../src/sync/compact.ts");
  const { replaySyncOps } = await import("../src/server/aio-boot.ts");
  const silent = { info: () => {}, error: () => {} };
  const reduce = (s: Record<string, unknown>) => s;

  const db = createDB(":memory:");
  try {
    for (const ddl of SYNC_SCHEMA) await db.execute(ddl);

    // Boot 1 — first boot after the flip: KV still restored the data.
    const restored = { notes: { items: ["pre-flip data"] } };
    const after1 = await replaySyncOps(db, ["notes"], reduce, restored, silent);
    assertEquals(after1.notes, { items: ["pre-flip data"] });

    // Boot 2 — KV no longer holds the cell (excluded since the flip); the
    // sync store must now be its home.
    const bare = { notes: { items: [] as string[] } };
    const after2 = await replaySyncOps(db, ["notes"], reduce, bare, silent);
    assertEquals(
      after2.notes,
      { items: ["pre-flip data"] },
      "the seeded sync snapshot restores the pre-flip data",
    );
  } finally {
    await db.close();
  }
});

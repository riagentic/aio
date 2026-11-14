// A cell that is NEW to an existing install has no older shape to convert —
// its `onMigrate` must not run.
//
// THE BUG: `applyCellMigrations` gated the hook on the MERGED state, which for
// a cell the store has never held is just the declared defaults. So an
// upgrade that added `limits` (version 2, `from < 2 → capCents *= 100`) ran
// the hook over the default 500, booted with 50000 and stamped v2 — the wrong
// value made permanent, since no later boot would migrate a v2 cell again. A
// fresh install never showed it (no store ⇒ no migration pass), only the
// upgrade path every real user takes.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

async function boot(dir: string, withLimits: boolean) {
  _resetAioRuntime();
  const calls: number[] = [];
  const counter = cell("mnc_counter", {
    state: { n: 0 },
    methods: {
      set(s: { n: number }, n: number) {
        s.n = n;
      },
    },
  });
  const limits = cell("mnc_limits", {
    version: 2,
    state: { capCents: 500 },
    onMigrate(s: { capCents: number }, from: number) {
      calls.push(from);
      if (from < 2) s.capCents *= 100; // v1 stored whole units
      return s;
    },
    methods: {},
  });
  const app = await aio.run({
    cells: withLimits ? [counter, limits] : [counter],
    appId: "mnc_app",
    dbPath: join(dir, "state.db"),
    libraryMode: true,
    client: "server-only",
    baseDir: dir,
  } as Any);
  return {
    app,
    calls,
    counter: counter as unknown as { set: (n: number) => Promise<void> },
  };
}

Deno.test("migrate: a cell new to an existing install is stamped, its onMigrate is not run over the defaults", async () => {
  const dir = await tempDir("mig-new-cell-");
  try {
    // v1 of the app: no `limits` cell; the store exists and holds data.
    const a = await boot(dir, false);
    await a.counter.set(3);
    await a.app.close();

    // The upgrade adds `limits` at version 2.
    const b = await boot(dir, true);
    const got = (b.app.getState() as Any).mnc_limits;
    await b.app.close();
    assertEquals(b.calls, [], "onMigrate ran over declared defaults");
    assertEquals(got, { capCents: 500 });

    // And it stays right: stamped at v2, so the next boot neither migrates
    // nor finds anything to change.
    const c = await boot(dir, true);
    const next = (c.app.getState() as Any).mnc_limits;
    await c.app.close();
    assertEquals(c.calls, []);
    assertEquals(next, { capCents: 500 });
  } finally {
    _resetAioRuntime();
    await Deno.remove(dir, { recursive: true });
  }
});

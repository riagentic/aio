// Closing an app releases ITS things only — never a later or a sibling app's.
//
// `close()` ends the app's scope and `_releaseCells` re-binds its cells to a
// tombstone (aio-cells-bridge.ts). Both used to reach past their own app:
//   - the scope was looked up by config object AT CLOSE: `aio.run(cfg)`,
//     close, `aio.run(cfg)` again with the same object, then a second
//     (idempotent) close of the first app ended the SECOND app's scope;
//   - every cell the app composed was tombstoned, even one a harness reset
//     (`_resetCellBindings`) had let another live app re-bind: the first
//     app's shutdown broke the second's live cell (DISPATCH_CLOSED for good).
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { _diagScopeNow } from "../src/diagnostics/diagnostic-bus.ts";
import { _resetCellBindings } from "../src/state/cell-reactive.ts";

// deno-lint-ignore no-explicit-any
type App = { close(): Promise<void>; getState(): any };
const tag = () => crypto.randomUUID().slice(0, 8);

const config = (id: string, dir: string, cells: unknown[]) => ({
  cells,
  appId: `${id}-${tag()}`,
  appDir: dir,
  client: "server-only",
  libraryMode: true,
  singleton: false,
  persist: false,
  port: freePort(),
});

Deno.test("close: a second close of an app never ends the scope of a later app booted from the same config object", async () => {
  const dir = await tempDir("aio-rel-scope-");
  // Whether the method ran inside a LIVE app scope.
  let inApp: boolean | undefined;
  const probe = cell(`scope${tag()}`, {
    state: { n: 0 },
    methods: {
      look(s: { n: number }) {
        inApp = _diagScopeNow() !== undefined;
        s.n++;
      },
    },
  });
  const cfg = config("relscope", dir, [probe]);
  const first = await aio.run(cfg as never) as unknown as App;
  await first.close();
  const second = await aio.run(cfg as never) as unknown as App;
  try {
    // deno-lint-ignore no-explicit-any
    await (probe as any).look();
    assertEquals(inApp, true, "precondition: the second app's call runs as it");
    await first.close(); // idempotent — must touch nobody else
    inApp = undefined;
    // deno-lint-ignore no-explicit-any
    await (probe as any).look();
    assertEquals(
      inApp,
      true,
      "a second close of the FIRST app ended the second app's scope",
    );
  } finally {
    await second.close();
    await dropTempDir(dir);
  }
});

Deno.test("close: an app's shutdown releases only the cells still bound to it — never one another app re-bound after a reset", async () => {
  const [da, db] = [await tempDir("aio-rel-a-"), await tempDir("aio-rel-b-")];
  const c = cell(`rebound${tag()}`, {
    state: { x: 0 },
    methods: {
      inc(s: { x: number }) {
        s.x++;
      },
    },
  });
  const A = await aio.run(config("rela", da, [c]) as never) as unknown as App;
  _resetCellBindings(); // a harness reset while A lives…
  const B = await aio.run(config("relb", db, [c]) as never) as unknown as App;
  try {
    await A.close(); // …then A's shutdown must leave B's binding alone
    // deno-lint-ignore no-explicit-any
    await (c as any).inc();
    assertEquals(B.getState()[c.__aio.id].x, 1, "B's live cell was released");
    // deno-lint-ignore no-explicit-any
    assertEquals((c as any).x, 1, "the cell reads B's live state");
    assert(c.__aio.bound, "B still holds its binding");
  } finally {
    await B.close();
    await dropTempDir(da);
    await dropTempDir(db);
  }
});

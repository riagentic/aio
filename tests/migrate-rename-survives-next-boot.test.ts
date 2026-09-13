// The documented rename migration must survive the boot AFTER it.
//
// docs/persistence/auto-persist.md: `onMigrate` is handed the declared shape
// PLUS whatever the store still holds, so a rename can read the old field. But
// what the hook returned was stored as-is — the old key included — so the
// first write after the migration put it back on disk, and the NEXT dev boot
// refused: "REFUSING to boot (dev) … ramBps (stored, not declared)". Following
// the docs to the letter bricked the second restart.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

async function boot(dir: string, v: 1 | 2) {
  _resetAioRuntime();
  const hw = v === 1
    ? cell("mig_hw", {
      state: { ramBps: 0 },
      methods: {
        set(s: { ramBps: number }, n: number) {
          s.ramBps = n;
        },
      },
    })
    : cell("mig_hw", {
      version: 2,
      state: { memBps: 0 }, // was: ramBps — the docs' snippet, verbatim
      onMigrate(state: { memBps: number }, from: number) {
        if (from < 2) {
          const old = state as unknown as { ramBps?: number };
          if (typeof old.ramBps === "number") state.memBps = old.ramBps;
        }
        return state;
      },
      methods: {
        set(s: { memBps: number }, n: number) {
          s.memBps = n;
        },
      },
    });
  const app = await aio.run({
    cells: [hw],
    appId: "mig_hw_app",
    dbPath: join(dir, "state.db"),
    libraryMode: true,
    client: "server-only",
    baseDir: dir,
  } as Any);
  return { app, hw: hw as unknown as { set: (n: number) => Promise<void> } };
}

Deno.test("migrate: a documented rename boots clean on the NEXT boot too (onMigrate output is narrowed to the declared shape)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mig-rename-" });
  try {
    const a = await boot(dir, 1);
    await a.hw.set(77);
    await a.app.close();

    const b = await boot(dir, 2);
    const migrated = (b.app.getState() as Any).mig_hw;
    await b.app.close();
    assertEquals(migrated, { memBps: 77 }, "the old key is not this build's");

    // The boot that used to refuse.
    const c = await boot(dir, 2);
    const next = (c.app.getState() as Any).mig_hw;
    await c.app.close();
    assertEquals(next, { memBps: 77 });
  } finally {
    _resetAioRuntime();
    await Deno.remove(dir, { recursive: true });
  }
});

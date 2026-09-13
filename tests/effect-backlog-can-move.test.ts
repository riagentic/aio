// `effectBacklog` is documented, served and rendered — and could never leave
// zero.
//
// `docs/debugging/vitals.md` calls it "Pending effects awaiting execution",
// `docs/basics/api-reference.md` advertises it on `GET /__aio/vitals`, and
// amui renders it yellow when it is above zero. The counter behind it only
// increments when an effect's executor RETURNS a promise, and no production
// executor does: `buildRootExecutor` is declared `=> void` and discards what
// the cell's `execute` returns, as do the server dispatch loop, the standalone
// loop, and both the schedule and own managers.
//
// Measured before: three async methods parked mid-flight gave
// `pendingCalls() = 3` and `.server.loop.effectBacklog = 0`. A dial that
// cannot move is worse than no dial — it reads as proof there is no backlog.
//
// The framework DOES know; it knows it in `method-cancel.ts`, which is what
// shutdown drains. The gauge answers from there now.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

Deno.test({
  name: "effectBacklog: /__aio/vitals sees a parked async method",
  sanitizeOps: false, // aio-ok: a live server, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    let release: () => void = () => {};
    const parked = new Promise<void>((r) => {
      release = r;
    });
    const c = cell("backlog", {
      state: { n: 0 },
      methods: {
        async slow(s: { n: number }) {
          s.n++;
          await parked;
          s.n++;
        },
      },
    });
    const port = freePort();
    const dir = await tempDir("aio-backlog-");
    const app = await aio.run({
      cells: [c],
      appId: `backlog-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      singleton: false,
      port,
      baseDir: dir,
      // deno-lint-ignore no-explicit-any
    } as any);
    const backlog = async (): Promise<number> => {
      const v = await (await fetch(`http://127.0.0.1:${port}/__aio/vitals`))
        .json() as { server?: { loop?: { effectBacklog?: number } } };
      return v.server?.loop?.effectBacklog ?? -1;
    };
    try {
      // The probe samples on an interval, so give it a tick either side.
      await new Promise((r) => setTimeout(r, 1200));
      assertEquals(await backlog(), 0, "nothing in flight to start with");

      const a = c.slow();
      const b = c.slow();
      await new Promise((r) => setTimeout(r, 1200));

      const parkedCount = await backlog();
      assert(
        parkedCount > 0,
        `two async methods are parked mid-flight and the gauge reads ` +
          `${parkedCount} — this is the number \`/__aio/vitals\` serves and ` +
          `amui paints yellow when it is above zero`,
      );

      release();
      await Promise.all([a, b]);
      await new Promise((r) => setTimeout(r, 1200));
      assertEquals(
        await backlog(),
        0,
        "…and it must come back down, or it is an alarm that never clears",
      );
    } finally {
      release();
      await app.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

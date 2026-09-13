// `app.cells.status(name)` and `health()[i].status` report something real.
//
// Both read `__aio_status`, which only the removed `machine:` API ever wrote,
// so `status()` was undefined for every cell and no health row had a status —
// while docs/state/lifecycle.md and docs/debugging/production.md show
// `'idle' | 'saving' | 'error'`. `CellStatus.status` is documented as the
// cell's OWN `status` field (the guard-line state machine that replaced
// `machine`), and a disabled cell is "disabled" from both entry points.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

Deno.test("cells.status/health: the cell's own status field, lastAction, and disabled", async () => {
  const saver = cell("hstatus", {
    state: { status: "idle" as "idle" | "saving", n: 0 },
    methods: {
      save(s) {
        s.n++;
        s.status = "saving";
      },
    },
  });
  const plain = cell("hplain", {
    state: { n: 0 },
    methods: {
      inc(s) {
        s.n++;
      },
    },
  });
  await using srv = await testServer({ cells: [saver, plain] });
  const cells = srv.app.cells!;
  assertEquals(
    cells.status("hstatus"),
    "idle",
    "status() reads the cell's own field",
  );
  await saver.save();
  await plain.inc();
  assertEquals(cells.status("hstatus"), "saving");
  assertEquals(
    cells.status("hplain"),
    undefined,
    "no status field → undefined",
  );

  const rows = Object.fromEntries(cells.health().map((r) => [r.name, r]));
  assertEquals(rows.hstatus!.status, "saving");
  assertEquals(rows.hstatus!.lastAction, "hstatus:save");
  assertEquals(typeof rows.hstatus!.lastActionAt, "number");
  assertEquals(rows.hplain!.status, undefined);
  assertEquals(rows.hplain!.lastAction, "hplain:inc");

  cells.disable("hstatus");
  assertEquals(
    cells.status("hstatus"),
    "disabled",
    "status() agrees with health()",
  );
  assertEquals(
    cells.health().find((r) => r.name === "hstatus")!.status,
    "disabled",
  );
});

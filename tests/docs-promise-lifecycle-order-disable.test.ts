// docs/state/lifecycle.md:67-85 — dependsOn: "Init runs in topological order
// … Destroy runs in reverse … Cycles throw: `dependency cycle: a → b → c → a`
// … Missing deps throw". docs/state/lifecycle.md:214-230 — disable: actions no
// longer routed, every schedule the cell issued is cancelled whatever its id,
// the destroy hook runs, state resets to initial; enable: init hook runs,
// state starts fresh.
import { assertEquals, assertRejects } from "@std/assert";
import { aio, cell, type CellDef, schedule } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const order: string[] = [];
const mk = (n: string) =>
  cell(n, {
    state: { v: 0, ticks: 0 },
    onInit() {
      order.push(`init:${n}`);
    },
    onDestroy() {
      order.push(`destroy:${n}`);
    },
    methods: {
      set(s, v: number) {
        s.v = v;
      },
      tick(s) {
        s.ticks++;
      },
      arm(s) {
        // A bare id, not prefixed with the cell name — still the cell's.
        s.$do(
          schedule.every("poll", 15, {
            type: `${n}:tick`,
            payload: { args: [] },
          }),
        );
      },
    },
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("docs promise: dependsOn init order, reverse destroy, disable/enable", async () => {
  const dir = await tempDir("docs-promise-lifecycle-");
  const a = mk("lcA"), b = mk("lcB"), c = mk("lcC");
  order.length = 0;
  const app = await aio.run({
    // Listed out of order on purpose: the declared deps decide.
    cells: [
      { cell: c, dependsOn: ["lcA", "lcB"] },
      { cell: b, dependsOn: ["lcA"] },
      a,
    ] as unknown as CellDef[],
    appId: "docs-promise-lifecycle",
    client: "server-only",
    libraryMode: true,
    port: freePort(),
    appDir: dir,
  });
  let closed = false;
  try {
    assertEquals(order, ["init:lcA", "init:lcB", "init:lcC"]);

    await b.set(5);
    await b.arm();
    await sleep(60);
    assertEquals(b.ticks > 0, true, "the schedule was firing before disable");

    order.length = 0;
    app.cells!.disable("lcB");
    assertEquals(order, ["destroy:lcB"]);
    assertEquals({ v: b.v, ticks: b.ticks }, { v: 0, ticks: 0 }, "state reset");
    await sleep(60);
    assertEquals(b.ticks, 0, "the cell's schedule was cancelled");

    order.length = 0;
    app.cells!.enable("lcB");
    assertEquals(order, ["init:lcB"]);
    await b.set(3);
    assertEquals(b.v, 3, "routed again after enable");

    order.length = 0;
    await app.close();
    closed = true;
    assertEquals(order, ["destroy:lcC", "destroy:lcB", "destroy:lcA"]);
  } finally {
    if (!closed) await app.close();
    await dropTempDir(dir);
  }
});

Deno.test("docs promise: a dependency cycle and a missing dependency refuse the boot", async () => {
  const x = mk("lcX"), y = mk("lcY");
  const bad: [unknown[], string][] = [
    [
      [{ cell: x, dependsOn: ["lcY"] }, { cell: y, dependsOn: ["lcX"] }],
      "dependency cycle: lcX → lcY → lcX",
    ],
    [
      [{ cell: x, dependsOn: ["missing"] }],
      "depends on unknown cell 'missing'",
    ],
  ];
  for (const [cells, msg] of bad) {
    const dir = await tempDir("docs-promise-lifecycle-bad-");
    try {
      await assertRejects(
        () =>
          aio.run({
            cells: cells as CellDef[],
            appId: "docs-promise-lifecycle-bad",
            client: "server-only",
            libraryMode: true,
            port: freePort(),
            appDir: dir,
          }),
        Error,
        msg,
      );
    } finally {
      await dropTempDir(dir);
    }
  }
});

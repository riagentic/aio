// docs/basics/pitfalls.md:103-105 — "Schedule ids replace. Two schedules with
// the same `id` — the later one wins … Boot warns on static/dynamic id
// collisions." The schedule manager's warning is unit-pinned
// (tests/schedule.test.ts "schedule #5"); this pins it through a real
// `aio.run({ schedules })` + a cell's `s.$do(schedule.every(sameId, …))`.
import { assert } from "@std/assert";
import { aio, cell, schedule } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("docs promise: a dynamic schedule reusing a static id warns, naming it", async () => {
  const dir = await tempDir("docs-promise-sched-coll-");
  const poller = cell("collpoller", {
    state: { n: 0 },
    methods: {
      tick(s) {
        s.n++;
      },
      arm(s) {
        s.$do(schedule.every("shared-poll", 60_000, poller.tick.action()));
      },
    },
  });
  const warned: string[] = [];
  const ow = console.warn;
  console.warn = (...x: unknown[]) => warned.push(x.map(String).join(" "));
  let app: Awaited<ReturnType<typeof aio.run>> | null = null;
  try {
    app = await aio.run({
      cells: [poller],
      appId: "docs-promise-sched-coll",
      client: "server-only",
      libraryMode: true,
      port: freePort(),
      appDir: dir,
      schedules: [{
        id: "shared-poll",
        every: 60_000,
        action: poller.tick.action(),
      }],
    });
    await poller.arm();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    console.warn = ow;
    await app?.close();
    await dropTempDir(dir);
  }
  const hit = warned.filter((w) =>
    w.includes("shared-poll") && w.includes("statically") &&
    w.includes("dynamically")
  );
  assert(
    hit.length === 1,
    `expected one collision warning:\n${warned.join("\n")}`,
  );
});

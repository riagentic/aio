// `am replay` applies the journal's cell-version stamp — the same rule boot
// recovery applies.
//
// Every journal line records the `version` of each cell it writes (`v`), and
// boot replay refuses a line that ran through a method the running build no
// longer has. `am replay` ignored the stamp: it re-sent a v1 `add(5)` ("+5
// units") to a running v2 app whose `add` takes cents — a repro of a state no
// build ever held, reported as "replayed 1 action".
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { cmdReplay, planReplay } from "../src/am/am-cmd-timeline.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

// deno-lint-ignore no-explicit-any
type D = any;

async function capture(fn: () => Promise<void>): Promise<unknown> {
  const orig = console.log;
  const origErr = console.error;
  let captured: unknown;
  console.log = (v: unknown) => {
    captured = typeof v === "string" ? JSON.parse(v) : v;
  };
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.log = orig;
    console.error = origErr;
  }
  return captured;
}

Deno.test("am replay: a line stamped with another cell version is not sent to the running app — skipped, and said", async () => {
  const dir = await tempDir("aio-replay-version-");
  const journal = `${dir}/captured.journal`;
  const line = (seq: number, v: number, by: number) =>
    JSON.stringify({
      seq,
      type: "w:add",
      payload: { args: [by] },
      ts: 0,
      cause: "input",
      v: { w: v },
    });
  // seq 1 ran under v1 (the running build migrates from it), seq 2 under v2.
  await Deno.writeTextFile(journal, [line(1, 1, 5), line(2, 2, 7)].join("\n"));
  _resetAioRuntime();
  const w = cell("w", {
    version: 2,
    state: { cents: 0 },
    onMigrate: (s: D) => s,
    methods: {
      add(s: D, v: number) {
        s.cents += v;
      },
    },
  } as D);
  const port = freePort();
  const appId = `replay-version-${Deno.pid}`;
  const app = await aio.run({
    cells: [w],
    appId,
    persist: false,
    libraryMode: true,
    singleton: false,
    client: "server-only",
    port,
    baseDir: dir,
  } as D);
  try {
    const flags = { json: true, port, app: appId } as unknown as GlobalFlags;
    const dry = await capture(() =>
      cmdReplay([`--from=${journal}`, "--dry"], flags)
    ) as D;
    assertEquals(dry.count, 1, JSON.stringify(dry));
    const res = await capture(() =>
      cmdReplay([`--from=${journal}`], flags)
    ) as D;
    assertEquals(res.replayed, 1, JSON.stringify(res));
    assertEquals((w as D).cents, 7, "only the v2 line may reach the v2 app");
    const skip = res.notSent.find((k: D) => k.seq === 1);
    assert(skip, JSON.stringify(res));
    assertEquals(skip.reason, "version");
    assertStringIncludes(skip.why, "version");
  } finally {
    await app.close();
    _resetAioRuntime();
    await dropTempDir(dir);
  }
});

Deno.test("planReplay: the stamp rule is boot replay's — older on a converting cell and newer always skip; older on a non-converting cell sends", () => {
  const row = (seq: number, cell: string, v: number) => ({
    seq,
    type: `${cell}:add`,
    payload: { args: [1] },
    cause: "input",
    v: { [cell]: v },
  });
  const plan = planReplay(
    [row(1, "m", 1), row(2, "m", 2), row(3, "m", 3), row(4, "k", 1), {
      seq: 5,
      type: "m:add",
      payload: { args: [1] },
    }],
    {
      m: { version: 2, migrates: true },
      k: { version: 2, migrates: false },
    },
  );
  assertEquals(plan.send.map((r) => r.seq), [2, 4, 5]);
  assertEquals(
    plan.skip.map((k) => [k.seq, k.reason]),
    [[1, "version"], [3, "version"]],
  );
});

// `backupLogs: true` says "keep previous logs on restart". The one thing it
// must never do is delete the MOST RECENT one.
//
// Rotation used to pick its target slot by scanning for the first FREE index:
// `app.log` → `app.log.<first n where app.log.n does not exist>`, then prune
// `.1 … .(n-keep)`. That works exactly until the first prune frees a low slot.
// From then on the newest archive lands in `.1`, i.e. BELOW every older one,
// and the next prune — which walks upward from the bottom — deletes it while
// keeping the older files it was supposed to age out.
//
// With `backupKeep: 2`: run 4's log went to `app.log.1`, and run 5 deleted
// `app.log.1` and kept `app.log.3` from run 3. An operator restarting to
// capture a crash lost the crash.
//
// The invariant these tests pin: `.1` is ALWAYS the previous run, indices only
// grow older, and at most `keep` archives survive.

import { assert, assertEquals } from "@std/assert";
import { rotateOnStart } from "../src/diagnostics/logger-rotate.ts";

async function readIf(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

async function archives(dir: string, base: string): Promise<number[]> {
  const out: number[] = [];
  for await (const e of Deno.readDir(dir)) {
    const m = e.name.match(new RegExp(`^${base}\\.(\\d+)$`));
    if (m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

Deno.test("logger-rotate: .1 is always the previous run, never a pruned survivor", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-rot-" });
  try {
    const pathFn = () => `${dir}/app.log`;
    const keep = 2;
    for (let run = 1; run <= 6; run++) {
      await Deno.writeTextFile(`${dir}/app.log`, `run ${run}\n`);
      await rotateOnStart(pathFn as never, keep);
      // After rotating, the run that just ended is the newest archive.
      assertEquals(
        await readIf(`${dir}/app.log.1`),
        `run ${run}\n`,
        `after run ${run}: app.log.1 must hold the run that just ended — ` +
          `found ${JSON.stringify(await readIf(`${dir}/app.log.1`))}`,
      );
      const idx = await archives(dir, "app\\.log");
      assert(
        idx.length <= keep,
        `after run ${run}: backupKeep=${keep} but ${idx.length} archives ` +
          `survive (${idx.join(", ")})`,
      );
      // Older archives must be strictly older, in index order.
      const contents = [];
      for (const i of idx) contents.push(await readIf(`${dir}/app.log.${i}`));
      const runs = contents.map((c) => Number(c!.match(/run (\d+)/)![1]));
      const sorted = [...runs].sort((a, b) => b - a);
      assertEquals(
        runs,
        sorted,
        `archives must age monotonically (.1 newest): got ${runs.join(", ")}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logger-rotate: keep=0 keeps every archive, still newest-first", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-rot0-" });
  try {
    const pathFn = () => `${dir}/app.log`;
    for (let run = 1; run <= 4; run++) {
      await Deno.writeTextFile(`${dir}/app.log`, `run ${run}\n`);
      await rotateOnStart(pathFn as never, 0);
    }
    assertEquals(await readIf(`${dir}/app.log.1`), "run 4\n");
    assertEquals(await readIf(`${dir}/app.log.2`), "run 3\n");
    assertEquals(await readIf(`${dir}/app.log.3`), "run 2\n");
    assertEquals(await readIf(`${dir}/app.log.4`), "run 1\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logger-rotate: a legacy non-contiguous archive set is pruned to keep", async () => {
  // Files left by the old first-free-slot scheme: gaps, and the newest at .1.
  const dir = await Deno.makeTempDir({ prefix: "aio-rotl-" });
  try {
    for (const n of [1, 3, 4, 9]) {
      await Deno.writeTextFile(`${dir}/app.log.${n}`, `legacy ${n}\n`);
    }
    await Deno.writeTextFile(`${dir}/app.log`, "current\n");
    await rotateOnStart((() => `${dir}/app.log`) as never, 3);
    assertEquals(await readIf(`${dir}/app.log.1`), "current\n");
    const idx = await archives(dir, "app\\.log");
    assert(
      idx.length <= 3,
      `backupKeep=3 must bound the set even with legacy files: ${
        idx.join(", ")
      }`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

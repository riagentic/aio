// `wipeOnStart` — "clean slate" must mean the whole slate.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { wipeOnStart } from "../src/diagnostics/logger-rotate.ts";
import type { LogKind } from "../src/diagnostics/logger-rotate.ts";

Deno.test("wipeOnStart: a clean slate includes the archives a previous run left", async () => {
  // Turning `backupLogs` OFF stopped new archives appearing but never removed
  // the old ones, so "clean slate" quietly meant "clean slate plus whatever you
  // accumulated before" — and the count only ever grew.
  const dir = await Deno.makeTempDir({ prefix: "aio-wipe-" });
  try {
    const pathFn = (kind: LogKind) => join(dir, `${kind}.log`);
    for (
      const name of [
        "app.log",
        "app.log.1",
        "app.log.2",
        "error.log",
        "error.log.1",
      ]
    ) {
      await Deno.writeTextFile(join(dir, name), "old");
    }
    // A file that is not a log of ours must survive any wipe.
    await Deno.writeTextFile(join(dir, "keep.txt"), "mine");

    await wipeOnStart(pathFn as (k: LogKind) => string);

    const left = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(left, ["keep.txt"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

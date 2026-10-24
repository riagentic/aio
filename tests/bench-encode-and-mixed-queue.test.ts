// The bench had no metric for the compressed-body memo (a static/encoded
// response served from cache, an untagged body admitted on its second
// sighting) and never made the busy-queue write-set ordering path hot. The
// three metrics run, record, and each has a floor in the baselines.
import { assert, assertEquals } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const NEW = ["encode-hit-256k", "encode-admit-64k", "dispatch-mixed-queue"];

Deno.test("bench — the encode-memo and mixed-queue metrics run, record, and are gated", async () => {
  const dir = await tempDir("aio-bench-encode-");
  try {
    const results = `${dir}/bench-results.json`;
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--v8-flags=--expose-gc",
        "scripts/bench.ts",
        `--only=${NEW.join(",")}`,
      ],
      cwd: new URL("../", import.meta.url),
      env: { AIO_BENCH_RESULTS: results },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    const got = JSON.parse(await Deno.readTextFile(results)) as {
      metrics: Record<string, { p10: number; n: number }>;
    };
    const floors = JSON.parse(
      await Deno.readTextFile(
        new URL("../scripts/bench-baselines.json", import.meta.url),
      ),
    ).maxMedian as Record<string, number>;
    for (const m of NEW) {
      assert((got.metrics[m]?.n ?? 0) > 0, `${m} not recorded`);
      assert((floors[m] ?? 0) > 0, `${m} has no floor in bench-baselines.json`);
    }
  } finally {
    await dropTempDir(dir);
  }
});

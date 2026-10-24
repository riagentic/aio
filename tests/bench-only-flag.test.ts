// `deno task bench --only=…` measures those metrics alone. The bench's
// aio.run() calls parse the process's own flags, so an undeclared `--only=`
// was refused as "unknown flag" unless a bare `--` happened to precede it, and
// a first `--only` run with no results file yet crashed on the read.
// Results go to a temp file (AIO_BENCH_RESULTS), never the repo root.
import { assert, assertEquals } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("bench — --only=dispatch-sync runs without a bare --, and with no results file yet", async () => {
  const dir = await tempDir("aio-bench-only-");
  try {
    const results = `${dir}/bench-results.json`;
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--v8-flags=--expose-gc",
        "scripts/bench.ts",
        "--only=dispatch-sync",
      ],
      cwd: new URL("../", import.meta.url),
      env: { AIO_BENCH_RESULTS: results },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    const got = JSON.parse(await Deno.readTextFile(results)) as {
      metrics: Record<string, unknown>;
    };
    assert("dispatch-sync" in got.metrics);
    assert(!("boot" in got.metrics), "--only measured every metric");
  } finally {
    await dropTempDir(dir);
  }
});

// `deno test` runs each file in its own isolate, but the environment is the
// process's: the sandboxed store a file pinned (src/testing/test-strict.ts)
// is removed when that file ends — and a variable left pointing at it made
// the NEXT file's writes re-create the folder, with no one left to remove it
// (a whole Electron per run under the test root).
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { HOME_STORE_VARS } from "../src/testing/test-strict.ts";

const FIX = fromFileUrl(
  new URL("./fixtures/store-sandbox-per-file/", import.meta.url),
);

Deno.test("test sandbox: a store one test file pinned is gone after the run — the next file pins its own", async () => {
  const root = await tempDir("store-sandbox-root-");
  try {
    const env: Record<string, string> = {
      ...Deno.env.toObject(),
      AIO_TEST_ROOT: root,
    };
    // Unset, as outside the shard runner: each file pins its own.
    for (const k of HOME_STORE_VARS) delete env[k];
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "-A",
        "--no-check",
        join(FIX, "a-probe.ts"),
        join(FIX, "b-probe.ts"),
      ],
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const log = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    assertEquals(out.code, 0, log);
    const left = [...Deno.readDirSync(root)].map((e) => e.name)
      .filter((n) => n.startsWith("stores-"));
    assertEquals(left, [], `a store folder outlived its file:\n${log}`);
  } finally {
    await dropTempDir(root);
  }
});

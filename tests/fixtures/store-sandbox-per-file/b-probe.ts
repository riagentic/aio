// One of two files run in ONE `deno test` process by
// tests/store-sandbox-per-file.test.ts: each writes into the sandboxed store.
import { dropTempDir, tempDir } from "../../../src/testing/temp-dir.ts";

Deno.test("b writes into the sandboxed store", async () => {
  const d = await tempDir("store-probe-");
  const store = Deno.env.get("AIO_SHARED_ELECTRON_DIR")!;
  Deno.mkdirSync(store, { recursive: true });
  Deno.writeTextFileSync(`${store}/mark-b`, "x");
  await dropTempDir(d);
});

// A download that failed after its staged file existed (EFBIG, ENOSPC
// mid-file, a host dropping the connection) surfaced the raw OS text alone —
// "File too large (os error 27)" — naming neither the release nor the file.
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { downloadArtifact } from "../src/server/updates-check.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("updates: an error mid-download names the release URL and the staged file", async () => {
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    () =>
      new Response(
        new ReadableStream({
          async pull(c) {
            c.enqueue(new Uint8Array(64 * 1024));
            await new Promise((r) => setTimeout(r, 50));
            c.error(new Error("host went away"));
          },
        }),
        { headers: { "content-length": String(1024 * 1024) } },
      ),
  );
  const dir = await tempDir("aio-upd-write-err-");
  try {
    const url = `http://127.0.0.1:${port}/app`;
    const r = await downloadArtifact({
      url,
      dest: join(dir, "app.new"),
      expectSha256: "0".repeat(64),
      expectSize: 1024 * 1024,
    });
    assert(!r.ok);
    assertStringIncludes(r.error, `${url} → `);
    assertStringIncludes(r.error, join(dir, ".aio-update-app.new-"));
  } finally {
    await server.shutdown();
    await dropTempDir(dir);
  }
});

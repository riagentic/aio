// A download a few bytes short read "sent 186.7 MB, but the manifest promises
// 186.7 MB" (measured on a real tampered-release run): both sizes round to the
// same figure. The exact byte counts stand beside them.
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { downloadArtifact } from "../src/server/updates-check.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("updates: a size mismatch names both exact byte counts", async () => {
  const bytes = new Uint8Array(3 * 1024 * 1024 - 1);
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    () => new Response(bytes),
  );
  const dir = await tempDir("aio-upd-size-bytes-");
  try {
    const r = await downloadArtifact({
      url: `http://127.0.0.1:${port}/app`,
      dest: join(dir, "app.new"),
      expectSha256: "0".repeat(64),
      expectSize: bytes.byteLength + 1,
    });
    assert(!r.ok);
    assertStringIncludes(r.error, `(${bytes.byteLength} bytes)`);
    assertStringIncludes(r.error, `(${bytes.byteLength + 1} bytes)`);
  } finally {
    await server.shutdown();
    await dropTempDir(dir);
  }
});

Deno.test("updates: an oversize download names the exact promised byte count", async () => {
  const bytes = new Uint8Array(3 * 1024 * 1024);
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    () => new Response(bytes),
  );
  const dir = await tempDir("aio-upd-size-bytes-");
  try {
    const r = await downloadArtifact({
      url: `http://127.0.0.1:${port}/app`,
      dest: join(dir, "app.new"),
      expectSha256: "0".repeat(64),
      expectSize: bytes.byteLength - 1,
    });
    assert(!r.ok);
    assertStringIncludes(r.error, `(${bytes.byteLength - 1} bytes)`);
    assertStringIncludes(r.error, "bytes and counting");
  } finally {
    await server.shutdown();
    await dropTempDir(dir);
  }
});

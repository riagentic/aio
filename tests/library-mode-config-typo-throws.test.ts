// docs/basics/every-option.md, `libraryMode`: "no `Deno.exit` … `app.close()`
// leaves the process alive". A typo'd aio.run() key under libraryMode still
// called Deno.exit(1) — the test runner or embedding host died with the app.
import { assertRejects } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("libraryMode: an unknown aio.run() key rejects aio.run instead of Deno.exit", async () => {
  const c = cell("libtypo", { state: { n: 0 }, methods: {} });
  const dir = await tempDir("aio-libtypo-");
  const realExit = Deno.exit;
  let exited = false;
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (code?: number): never => {
    exited = true;
    throw new Error(`Deno.exit(${code}) called`);
  };
  try {
    const err = await assertRejects(() =>
      aio.run({
        cells: [c],
        appId: `libtypo-${crypto.randomUUID().slice(0, 8)}`,
        appDir: dir,
        client: "server-only",
        libraryMode: true,
        singleton: false,
        persist: false,
        port: freePort(),
        persistDebouceMs: 5, // the typo
        // deno-lint-ignore no-explicit-any
      } as any)
    );
    if (exited) throw new Error(`libraryMode called Deno.exit: ${err}`);
  } finally {
    Deno.exit = realExit;
    await dropTempDir(dir);
  }
});

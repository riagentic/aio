// `boot()` / `withE2E` made the app dir and handed it to the caller only once
// the server answered — a server that died first left the dir behind, one per
// failed e2e run. Now the failure path removes it before it throws.
import { assertEquals, assertRejects } from "@std/assert";
import { boot } from "./e2e-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("e2e harness: a server that dies before it is ready leaves no app dir", async () => {
  // A private test root, so the check sees only this boot's dirs.
  const root = await tempDir("aio-e2e-root-");
  const prev = Deno.env.get("AIO_TEST_ROOT");
  Deno.env.set("AIO_TEST_ROOT", root);
  try {
    await assertRejects(
      () =>
        boot({
          cells: "export {};",
          app: "export default () => null;",
          appTs: 'throw new Error("boom before ready");',
        }),
      Error,
      "server exited before it was ready",
    );
    const left: string[] = [];
    for await (const e of Deno.readDir(root)) {
      if (e.name.startsWith("aio-e2e-")) left.push(e.name);
    }
    assertEquals(left, []);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_TEST_ROOT");
    else Deno.env.set("AIO_TEST_ROOT", prev);
    await dropTempDir(root);
  }
});

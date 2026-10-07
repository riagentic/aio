// A boot that REFUSES releases the database it opened.
//
// `bootStorage` hands `state.db` to the caller's undo list only when it
// returns. A refusal thrown after the open — a migration that throws,
// a table load that fails — left the file open and its
// worker thread alive. Linux hides the first half (an open file can be
// unlinked); Windows does not: the "remove this directory" a refusal advises
// failed with "being used by another process" (os error 32), found by running
// the suite on a real Windows 11.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../src/state/cell-create.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** Open descriptors of THIS process under `dir` (Linux), or null where the OS
 *  gives no such list — there the delete is the proof. */
function fdsUnder(dir: string): string[] | null {
  if (Deno.build.os !== "linux") return null;
  const held: string[] = [];
  for (const e of Deno.readDirSync("/proc/self/fd")) {
    try {
      const to = Deno.readLinkSync(`/proc/self/fd/${e.name}`);
      if (to.startsWith(dir)) held.push(to);
    } catch { /* aio-ok: an fd closed between the listing and the read */ }
  }
  return held;
}

Deno.test("boot: a migration that throws leaves the data directory removable", async () => {
  const appId = "boot-refusal-migrate";
  const dir = await Deno.realPath(await tempDir("aio-boot-refusal-"));
  const prevApps = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", dir);
  try {
    const { aio } = await import("../mod.ts");
    const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
    const methods = {
      add(s: { items: string[] }, v: string) {
        s.items.push(v);
      },
    };
    const run = (c: unknown) =>
      aio.run({
        watch: false,
        cells: [c],
        appId,
        client: "server-only",
        libraryMode: true,
        port: freePort(),
        // deno-lint-ignore no-explicit-any
      } as any);

    // v1 stores something: a boot with nothing stored migrates nothing.
    const v1 = cell("refusing", {
      version: 1,
      state: { items: [] as string[] },
      methods,
    });
    const a = await run(v1);
    // deno-lint-ignore no-explicit-any
    await (v1 as any).add("keep me");
    await a.close();
    _resetAioRuntime();

    const v2 = cell("refusing", {
      version: 2,
      state: { items: [] as string[], extra: "" },
      onMigrate(_s: unknown): never {
        throw new Error("migration is broken on purpose");
      },
      methods,
      // deno-lint-ignore no-explicit-any
    } as any);
    const e = await assertRejects(() => run(v2));
    assert(/migration is broken on purpose/.test(String(e)), String(e));
    _resetAioRuntime();

    assertEquals(fdsUnder(dir) ?? [], [], "files the refused boot left open");
    // Windows: this is the line that failed with os error 32.
    await Deno.remove(join(dir, appId), { recursive: true });
  } finally {
    if (prevApps === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prevApps);
    await dropTempDir(dir);
  }
});

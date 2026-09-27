// Two sites the class ratchets flagged, each a real bug:
// - skv planMulti tested a removed key with `in`, which sees Object.prototype:
//   a state key named `toString`/`constructor` that went away never got its
//   DELETE, and its stale row came back on restore.
// - writeDenoJsonPin passed the user's pin ref inside a replacement STRING:
//   `$&` / `$'` in a ref (a local path) spliced the match or the rest of
//   deno.json into it.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { planMulti } from "../src/server/skv-sqlite.ts";
import { writeDenoJsonPin } from "../src/am/am-versions.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("skv planMulti: a removed key named like a builtin is deleted", () => {
  const stmts = planMulti("app", { kept: 1 }, [
    "kept",
    "toString",
    "constructor",
  ]);
  const deleted = stmts
    .filter((s) => s.sql.startsWith("DELETE"))
    .map((s) => String(s.params?.[0]));
  assertEquals(deleted.length, 2, JSON.stringify(deleted));
  assert(deleted.some((k) => k.endsWith("toString")));
  assert(deleted.some((k) => k.endsWith("constructor")));
});

Deno.test("writeDenoJsonPin: a ref with $-patterns is written literally", async () => {
  const dir = await tempDir("aio-pin-dollar-");
  try {
    const path = join(dir, "deno.json");
    await Deno.writeTextFile(
      path,
      `{\n  "aioVersion": "v1.0.0",\n  "name": "x"\n}\n`,
    );
    const ref = "../aio-$&-$'-checkout";
    await writeDenoJsonPin(dir, ref);
    const json = JSON.parse(await Deno.readTextFile(path));
    assertEquals(json.aioVersion, ref);
    assertEquals(json.name, "x");
  } finally {
    await dropTempDir(dir);
  }
});

// The `web` target names its browser workers by CONTENT
// (src/build/build-web.ts `nameWorkersByContent`): `workerBundleName` hashes
// the script's PATH, so build B's worker had build A's name, and a tab still
// running A after B's service worker took over (skipWaiting + claim) started
// B's worker — two builds in one page. Named by content, A's page asks for a
// file only A's cache holds.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { nameWorkersByContent } from "../src/build/build-web.ts";
import { isWorkerBundle, workerBundlesIn } from "../src/server/app-files.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const OUTER = "worker-outer-0123abcd.js";
const INNER = "worker-inner-89abcdef.js";

/** A web folder: a bundle that starts OUTER, which starts INNER. */
async function build(dir: string, outer: string, inner: string) {
  for (const e of Deno.readDirSync(dir)) await Deno.remove(join(dir, e.name));
  await Deno.writeTextFile(
    join(dir, "app.js"),
    `new Worker(new URL("./${OUTER}", location.href))`,
  );
  await Deno.writeTextFile(
    join(dir, OUTER),
    `${outer};new Worker(new URL("./${INNER}", location.href))`,
  );
  await Deno.writeTextFile(join(dir, INNER), inner);
  return await nameWorkersByContent(dir, [INNER, OUTER]);
}

Deno.test("web build: workers are renamed by content, every reference follows", async () => {
  const dir = await tempDir("aio-web-worker-names-");
  try {
    const a = await build(dir, "A", "a");
    const files = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(files, ["app.js", a[INNER]!, a[OUTER]!].sort());
    assert(isWorkerBundle(a[INNER]!) && isWorkerBundle(a[OUTER]!));
    assert(a[OUTER]!.startsWith("worker-outer-"), a[OUTER]);
    assertEquals(
      workerBundlesIn(await Deno.readTextFile(join(dir, "app.js"))),
      [a[OUTER]!],
    );
    assertEquals(
      workerBundlesIn(await Deno.readTextFile(join(dir, a[OUTER]!))),
      [a[INNER]!],
    );

    // The same bytes: the same names (a rebuild keeps them).
    assertEquals(await build(dir, "A", "a"), a);
    // The outer worker changed: it is renamed, the inner one is not.
    const b = await build(dir, "B", "a");
    assertNotEquals(b[OUTER], a[OUTER]);
    assertEquals(b[INNER], a[INNER]);
    // Only the INNER changed: the outer one names it, so it is renamed too —
    // else A's outer worker would start B's inner one.
    const c = await build(dir, "A", "c");
    assertNotEquals(c[INNER], a[INNER]);
    assertNotEquals(c[OUTER], a[OUTER]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("web build: no workers — the bundle is left as it is", async () => {
  const dir = await tempDir("aio-web-worker-names-");
  try {
    await Deno.writeTextFile(join(dir, "app.js"), "x");
    assertEquals(await nameWorkersByContent(dir, []), {});
    assertEquals(await Deno.readTextFile(join(dir, "app.js")), "x");
  } finally {
    await dropTempDir(dir);
  }
});

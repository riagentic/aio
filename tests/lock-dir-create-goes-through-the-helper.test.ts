// Nothing makes the lock dir and THEN creates in it by hand.
//
// A scoped lock dir is removed by whoever leaves it empty, so "make sure it
// is there, then create a file in it" has a gap: a sibling's exit prune in
// between fails the create (ENOENT; on macOS EINVAL too). Three sites had
// that shape — both socket binds and the watcher's sentinel — and an app's
// start failed because another app quit. `createInLockDir` /
// `listenInLockDir` (single-instance-lock.ts) close the gap; this keeps the
// next site from opening it again.
import { assertEquals } from "@std/assert";
import { fromFileUrl, join, relative } from "@std/path";

const SRC = fromFileUrl(new URL("../src", import.meta.url));

function* tsFiles(dir: string): Generator<string> {
  for (const e of Deno.readDirSync(dir)) {
    const path = join(dir, e.name);
    if (e.isDirectory) yield* tsFiles(path);
    else if (/\.tsx?$/.test(e.name)) yield path;
  }
}

Deno.test("lock dir: `ensureLockDirOf` is called by the helper alone", () => {
  const callers = [...tsFiles(SRC)]
    .filter((f) => /\bensureLockDirOf\(/.test(Deno.readTextFileSync(f)))
    .map((f) => relative(SRC, f).replaceAll("\\", "/"));
  assertEquals(callers, ["server/single-instance-lock.ts"]);
});

// `unsafeOutDir` compared paths byte-exactly, so on a case-insensitive
// filesystem (macOS / Windows defaults) `--out=Src` — which IS `src/` there —
// passed, and the build's out-dir wipe deleted the app's source. Protected
// dirs are compared case-folded.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { unsafeOutDir } from "../src/testing/internal.ts";

const root = join("/", "proj");

Deno.test("unsafeOutDir: a protected dir spelled in another case is refused", () => {
  for (const out of ["Src", "SRC", "src/Nested", ".GIT", ".Aio/x"]) {
    assertEquals(unsafeOutDir(join(root, out), root), true, out);
  }
});

Deno.test("unsafeOutDir: an ordinary build folder is still accepted", () => {
  for (const out of ["dist", "build", "Out", "srcs"]) {
    assertEquals(unsafeOutDir(join(root, out), root), false, out);
  }
});

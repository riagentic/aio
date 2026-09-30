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

Deno.test("unsafeOutDir: dist/ is folded too — `DIST/x` IS inside dist/", () => {
  // The dedicated dist check compared byte-exactly while the protected-dir
  // check folded, so `--out=DIST` and `--out=Dist/x` sailed through on a
  // case-insensitive host and a sibling target's dist/ wipe deleted them —
  // the exact case the guard exists for. `dist` (any case) itself stays legal.
  for (const out of ["DIST/x", "Dist/nested", "dIsT/x"]) {
    assertEquals(unsafeOutDir(join(root, out), root), true, out);
  }
  for (const out of ["dist", "DIST", "Dist"]) {
    assertEquals(unsafeOutDir(join(root, out), root), false, out);
  }
});

// `isPlacedBinary` (tests/e2e-app-harness.ts): which file in dist/ the
// artifact tests START. It asked for "no extension", so on Windows — where
// the binary is `app-0.1.7.exe` — `placedBinary` found none and every
// artifact test using it could not run there.
import { assert } from "@std/assert";
import { isPlacedBinary } from "./e2e-app-harness.ts";

Deno.test("isPlacedBinary: the host's own binary, per OS", () => {
  for (const os of ["linux", "darwin"]) {
    assert(isPlacedBinary("app-0.1.7", os));
    assert(isPlacedBinary("app-0.1.0-nogit.9f3ac2b1", os));
    assert(!isPlacedBinary("app-0.1.7.exe", os), "a cross-built artifact");
    assert(!isPlacedBinary("app-0.1.7-x86_64.AppImage", os));
    assert(!isPlacedBinary("manifest.json", os));
    assert(!isPlacedBinary("app", os), "unversioned: not a fleet output");
  }
  assert(isPlacedBinary("app-0.1.7.exe", "windows"));
  assert(isPlacedBinary("app-0.1.0-nogit.9f3ac2b1.exe", "windows"));
  assert(!isPlacedBinary("app-0.1.7", "windows"), "not runnable there");
  assert(!isPlacedBinary("app-0.1.7.zip", "windows"));
  assert(!isPlacedBinary("app.exe", "windows"), "unversioned");
  assert(!isPlacedBinary("manifest.json", "windows"));
});

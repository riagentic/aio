// assembleMacApp joined the display TITLE into the bundle path raw: "AC/DC"
// nested the bundle in directories, and "../../x" placed it — and the
// recursive remove that clears the previous bundle — outside the out dir.
import { assert, assertEquals } from "@std/assert";
import { macBundleFileName } from "../src/build/macos-app.ts";

Deno.test("macBundleFileName: separators never reach the path", () => {
  assertEquals(macBundleFileName("AC/DC"), "AC-DC");
  assertEquals(macBundleFileName("Notes: Work"), "Notes- Work");
  for (const t of ["../../x", "..\\\\evil", "/abs", "a/../b"]) {
    const n = macBundleFileName(t);
    assert(!n.includes("/") && !n.includes("\\"), `${t} -> ${n}`);
  }
});

Deno.test("macBundleFileName: dot-only names cannot name a bundle", () => {
  for (const t of ["", ".", "..", " .. "]) {
    assertEquals(macBundleFileName(t), "App", JSON.stringify(t));
  }
  assertEquals(macBundleFileName("Counter"), "Counter");
});

// A scaffold wrote no `.gitattributes`, so git's `core.autocrlf` decided what a
// Windows clone of a new app held: CRLF on a default Git for Windows — and
// `deno fmt --check` then fails on every file there ("Text differed by line
// endings"), on a tree nobody edited.
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { scaffold } from "../src/am/am-cmd-create.ts";

Deno.test("am create: every template pins LF line endings for every checkout", () => {
  for (const template of ["counter", "cli"] as const) {
    const files = scaffold("demo", template, false);
    const attrs = files[".gitattributes"];
    assert(attrs, `${template}: no .gitattributes`);
    const rules = attrs.split("\n").filter((l) => l && !l.startsWith("#"));
    assertEquals(rules, ["* text=auto eol=lf"]);
    // The scaffold's own files are LF — the rule describes what is written.
    assert(Object.keys(files).length > 3, "the scaffold wrote no files");
    for (const [path, text] of Object.entries(files)) {
      assert(!text.includes("\r"), `${template}: ${path} holds a CR`);
    }
  }
});

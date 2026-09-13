// `am dispatch cell:m key=value` — a named key is a NAME, not a JS identifier.
//
// Tightening "contains an =" (which turned a URL positional into a named
// payload) to `[A-Za-z_$][\w$]*=` fixed the URL and broke three key shapes that
// had always been named: `due-date=…`, `user.name=…`, `título=…`. They became
// positionals — no error, just a different payload at the method.
import { assertEquals } from "@std/assert";
import { isNamedArg } from "../src/am/am-cmd-state.ts";
import { parsePayload } from "../src/am/am-utils.ts";

Deno.test("isNamedArg: dashed, dotted and non-ASCII keys are named", () => {
  for (
    const named of [
      "due-date=2026-09-13",
      "user.name=ada",
      "título=x",
      "名前=x",
      "_x=1",
      "$y=2",
      "a1=b",
      "host=h",
    ]
  ) {
    assertEquals(isNamedArg(named), true, named);
  }
  assertEquals(parsePayload(["due-date=2026-09-13", "user.name=ada"]), {
    "due-date": "2026-09-13",
    "user.name": "ada",
  });
});

Deno.test("isNamedArg: URLs, sentences and JSON stay positional", () => {
  for (
    const positional of [
      "https://example.com/?q=1",
      "example.com/?q=1",
      "2 + 2 = 4",
      "a b=c",
      '{"f":"a=b"}',
      '["a=b"]',
      '"a=b"',
      "=x",
      "1a=b",
      "-a=b",
      ".a=b",
      "x",
    ]
  ) {
    assertEquals(isNamedArg(positional), false, positional);
  }
});

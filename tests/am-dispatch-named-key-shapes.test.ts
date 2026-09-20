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

// `am dispatch x:y __proto__='{"a":1}' b=2` sent `{"b":2}`: the pair was
// assigned into a plain object, which runs the `__proto__` accessor instead of
// storing a key, so it vanished — no error, and the method got a payload
// without it. The server (the trojan route's `JSON.parse`, like `--body`)
// takes that key as ordinary DATA, so the CLI must carry it as data too.
Deno.test("parsePayload: a __proto__ pair is carried as an own key, never dropped or re-parenting", () => {
  assertEquals(isNamedArg('__proto__={"a":1}'), true);
  const p = parsePayload(['__proto__={"a":1}', "b=2"]);
  assertEquals(Object.getPrototypeOf(p), Object.prototype);
  assertEquals(Object.keys(p), ["__proto__", "b"]);
  assertEquals(JSON.stringify(p), '{"__proto__":{"a":1},"b":2}');
  assertEquals((p as Record<string, unknown>).a, undefined);
  // The bare-flag form, and a repeated key (last wins, like any other key).
  const q = parsePayload(["__proto__", "__proto__=3"]);
  assertEquals(JSON.stringify(q), '{"__proto__":3}');
  // What the server's JSON.parse makes of the same text — the parity pinned.
  assertEquals(
    JSON.stringify(JSON.parse(JSON.stringify(p))),
    JSON.stringify(p),
  );
});

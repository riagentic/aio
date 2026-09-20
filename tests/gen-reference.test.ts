// The one-page reference generator (scripts/gen-reference.ts): its pure parts.
// The page itself is gated by `update:reference -- --check` in check:release.
import { assert, assertEquals } from "@std/assert";
import {
  anchor,
  dedent,
  exampleOf,
  oneLine,
  problems,
  typeText,
} from "../scripts/gen-reference.ts";

const kw = (value: string) => ({ kind: "keyword", value, repr: value });
const str = (s: string) => ({
  kind: "literal",
  repr: s,
  value: { kind: "string", string: s },
});

Deno.test("typeText: string literals keep their quotes; long shapes are cut, not paraphrased", () => {
  assertEquals(
    typeText({ kind: "union", value: [str("client"), str("server")] }),
    '"client" | "server"',
  );
  assertEquals(
    typeText({
      kind: "mapped",
      value: {
        typeParam: {
          name: "K",
          constraint: {
            kind: "typeOperator",
            value: { operator: "keyof", tsType: kw("M") },
          },
        },
        optional: true,
        tsType: kw("number"),
      },
    }),
    "{ [K in keyof M]?: number }",
  );
  const long = typeText({
    kind: "union",
    value: Array.from({ length: 30 }, (_, i) => str(`option${i}`)),
  });
  assert(long.endsWith("…") && long.length === 90, long);
  assertEquals(typeText(undefined), "unknown");
});

Deno.test("oneLine: first paragraph, at most the first sentence past 40 chars", () => {
  // A first sentence under 40 chars is too thin alone: the next one joins.
  assertEquals(
    oneLine("Bind address for the socket. Defaults to loopback. Rest.\n\nX."),
    "Bind address for the socket. Defaults to loopback.",
  );
  assertEquals(
    oneLine("The address the server binds, on every start. Defaults to x."),
    "The address the server binds, on every start.",
  );
  assertEquals(oneLine("Short. Then more."), "Short. Then more.");
  assertEquals(
    oneLine("See {@linkcode Foo.bar} for it"),
    "See `Foo.bar` for it",
  );
  assertEquals(oneLine(undefined), "");
});

Deno.test("exampleOf: the @example tag, else the first fence; indent removed", () => {
  // aio-ok: the expected text is a literal — it contains the same code as the input by design
  assertEquals(
    exampleOf({
      tags: [{ kind: "example", doc: "```ts\n  a();\n    b();\n```" }],
    }),
    "a();\n  b();",
  );
  assertEquals(exampleOf({ doc: "Text.\n```ts\nx();\n```" }), "x();");
  assertEquals(exampleOf({ doc: "No example here." }), undefined);
  assertEquals(dedent("\n   one\n\n   two"), "one\n\ntwo");
});

Deno.test("problems: a missing one-liner is named; the example count is a ratchet", () => {
  const e = (name: string, line: string, example?: string) => ({
    name,
    signature: name,
    line,
    example,
    file: "src/x.ts",
  });
  const secs = [{
    title: "t",
    intro: "",
    entries: [e("a", "A.", "x"), e("b", "")],
  }];
  const out = problems(secs, 0);
  assertEquals(out.length, 2);
  assert(out[0]!.includes("no one-line doc: t › b"), out[0]);
  assert(out[1]!.includes("1 entries have no example"), out[1]);
  assertEquals(
    problems(secs, 1).length,
    1,
    "at the ceiling: only the one-liner",
  );
});

Deno.test("anchor: the heading ids the page's contents list links to", () => {
  assertEquals(anchor("aio.run options"), "aiorun-options");
  assertEquals(anchor("aio/air"), "aioair");
});

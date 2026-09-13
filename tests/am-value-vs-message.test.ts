// `--json` must not change SHAPE by type.
//
// `out()` wraps a string as `{ message: … }`, which is right: a command with a
// human sentence to deliver should say it under a key a script can find. But
// `am state` passed the STATE VALUE through the same function, so:
//
//   am state counter.count   --json  →  0
//   am state counter.ok      --json  →  true
//   am state counter.tags    --json  →  ["a"]
//   am state counter.nothing --json  →  null
//   am state counter.name    --json  →  {"message":"ada"}      ← string only
//
// Plain mode prints `ada`, so `--json` was not a superset of it — it was a
// different shape for one type, against `am-output.ts`'s own promise that
// "`--json` output is a superset of plain mode, never a mode that loses
// information". And it was AMBIGUOUS: a string field and an object field
// `{ message: "hello" }` produced byte-identical output, so nothing reading
// the JSON could tell them apart. `am state` is the primary scripting surface.
import { assertEquals } from "@std/assert";
import { out, outValue } from "../src/am/am-output.ts";

/** Capture what a printer writes to stdout. */
function captured(fn: () => void): string {
  const real = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = real;
  }
  return lines.join("\n");
}

Deno.test("outValue: a string value stays a string in --json", () => {
  assertEquals(captured(() => outValue("ada", "json")), '"ada"');
});

Deno.test("outValue: every other type is unchanged", () => {
  assertEquals(captured(() => outValue(0, "json")), "0");
  assertEquals(captured(() => outValue(true, "json")), "true");
  assertEquals(captured(() => outValue(null, "json")), "null");
  assertEquals(captured(() => outValue(["a"], "json")), '["a"]');
});

Deno.test("outValue: a string field and a {message} field are distinguishable", () => {
  const asString = captured(() => outValue("hello", "json"));
  const asObject = captured(() => outValue({ message: "hello" }, "json"));
  assertEquals(asString, '"hello"');
  assertEquals(asObject, '{"message":"hello"}');
});

Deno.test("outValue: plain mode is unchanged, so --json is its superset", () => {
  assertEquals(captured(() => outValue("ada", "pretty")), "ada");
});

Deno.test("out: a MESSAGE is still wrapped — that is the other half of the pair", () => {
  // The wrapping is not a bug where a command has a sentence to say; it is a
  // bug where the string IS the answer. Both spellings must keep working.
  assertEquals(captured(() => out("stopped", "json")), '{"message":"stopped"}');
});

Deno.test("outValue: quiet prints nothing, like out", () => {
  assertEquals(captured(() => outValue("ada", "quiet")), "");
});

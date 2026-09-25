// A multi-line refusal lost its layout on a terminal. `outError` joined every
// line of the body into one paragraph and re-wrapped it, and `wrap` dropped
// each line's leading indent — so `am trigger`'s usage came out as
//
//     am trigger <clientIdx> "<…>" <action> [text] # a specific client actions:
//     click, dblclick, …
//
// (the `# comment` running into the next heading), and `am link`'s
// "Install it with\n  curl … | sh\nthen re-run" buried the one command to
// copy mid-sentence. A newline the author wrote is a line break; an indent is
// kept. (--json never had the problem: the message is data there.)
import { assert, assertEquals } from "@std/assert";
import { outError } from "../src/am/am-output.ts";
import { wrap } from "../src/diagnostics/fmt.ts";

Deno.test("fmt wrap: an indented line keeps its indent, continuation lines too", () => {
  assertEquals(wrap("head\n  indented line", 80), ["head", "  indented line"]);
  const lines = wrap("  one two three four", 10);
  assertEquals(lines, ["  one two", "  three", "  four"]);
  for (const l of lines) assert(l.length <= 10, `too wide: ${l}`);
});

Deno.test("am error: a multi-line refusal keeps its line breaks on a terminal", () => {
  const seen: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void seen.push(a.join(" "));
  try {
    outError(
      "can't find the aio framework to link against. Install it with\n" +
        "  curl -fsSL https://example.test/install.sh | sh\n" +
        "then re-run `am link`.",
      "pretty",
    );
  } finally {
    console.error = orig;
  }
  assertEquals(seen.length, 1);
  // deno-lint-ignore no-control-regex -- strip ANSI SGR for the comparison
  const lines = seen[0]!.replace(/\x1b\[[0-9;]*m/g, "").split("\n")
    .map((l) => l.trimEnd());
  assertEquals(lines.length, 4, lines.join("\n"));
  assert(lines[1]!.endsWith("Install it with"), lines[1]);
  assert(
    lines[2]!.endsWith("  curl -fsSL https://example.test/install.sh | sh"),
    lines[2],
  );
  assert(lines[3]!.endsWith("then re-run `am link`."), lines[3]);
});

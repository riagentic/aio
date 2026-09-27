// aio/cli args(): "When a boolean flag named `json` is declared and given,
// refusals go to stdout as {"error": …}", and `a.json` is "true when --json
// was given" (docs/clients/cli-toolkit.md). `json` was decided by scanning the
// raw argv for the literal string "--json" instead of by the parser, so:
//   • `-j` (the flag's declared `short`) sets flags.json = true, yet a.json is
//     false and a refusal is printed as plain text on stderr — a script that
//     asked for JSON parses nothing;
//   • `--out --json` (the word is the VALUE of a string flag) leaves
//     flags.json false, yet a.json is true.
import { assertEquals } from "@std/assert";
import { args, CliExit, testIO } from "../src/cli.ts";

const SPEC = {
  name: "t",
  flags: {
    out: { type: "string" },
    json: { type: "boolean", short: "j" },
  },
} as const;

Deno.test("args: -j (short for --json) makes a.json true", () => {
  const a = args(SPEC, { argv: ["-j"], io: testIO() });
  assertEquals(a.flags.json, true);
  assertEquals(a.json, a.flags.json, "a.json disagrees with flags.json");
});

Deno.test("args: -j refusals are JSON on stdout", () => {
  const io = testIO();
  let code: number | undefined;
  try {
    args(SPEC, { argv: ["-j", "--bogus"], io });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    code = e.code;
  }
  assertEquals(code, 2);
  assertEquals(io.stderr, "", "refusal went to stderr as plain text");
  assertEquals(
    typeof JSON.parse(io.stdout.trim()).error,
    "string",
  );
});

Deno.test("args: '--json' as a string flag's VALUE is not --json", () => {
  const a = args(SPEC, { argv: ["--out", "--json"], io: testIO() });
  assertEquals(a.flags.out, "--json");
  assertEquals(a.flags.json, false);
  assertEquals(a.json, false);
});

// cli-args-own-keys-and-array-default.test.ts — `args()` refuses names that
// only exist on Object.prototype, and never writes into the spec it was given.
//
// Three defects on one parser:
//   * the command lookup used `in`, so `todo constructor` / `todo toString` /
//     `todo __proto__` were ACCEPTED commands, handed to the app's dispatch;
//   * the flag lookup indexed `flagSpecs[name]` with no own check, so
//     `--constructor=1` and `--toString x` were accepted as string flags nobody
//     declared, while every other unknown flag is refused;
//   * a `string[]` flag's default array WAS the value: `--tag a` pushed into
//     the spec, the next parse started from the previous one's tags, and the
//     default was appended to rather than replaced.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { args, CliExit, testIO } from "../src/cli.ts";

const spec = () => ({
  name: "todo",
  commands: { list: "l", add: "a" },
  rest: "text",
  flags: {
    url: { type: "string" as const },
    tag: { type: "string[]" as const, default: ["x"] },
  },
});

function refusal(s: ReturnType<typeof spec>, argv: string[]): string {
  const io = testIO();
  try {
    args(s, { argv, io });
  } catch (e) {
    if (e instanceof CliExit) {
      assertEquals(e.code, 2, `${argv.join(" ")} exits with the usage code`);
      return io.stderr;
    }
    throw e;
  }
  throw new Error(`accepted: ${argv.join(" ")}`);
}

Deno.test("args: a prototype name is not a command", () => {
  for (const c of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assertStringIncludes(refusal(spec(), [c]), `unknown command: ${c}`);
  }
});

Deno.test("args: a prototype name is not a flag", () => {
  for (
    const argv of [["--constructor=1"], ["--toString", "x"], ["--valueOf"]]
  ) {
    assertStringIncludes(refusal(spec(), ["list", ...argv]), "unknown flag");
  }
});

Deno.test("args: a string[] default is replaced by the first explicit value and never mutated", () => {
  const s = spec();
  const io = testIO();
  assertEquals(args(s, { argv: ["list"], io }).flags.tag, ["x"]);
  assertEquals(args(s, { argv: ["list", "--tag", "a"], io }).flags.tag, ["a"]);
  assertEquals(
    args(s, { argv: ["list", "--tag", "b", "--tag=c"], io }).flags.tag,
    ["b", "c"],
  );
  assertEquals(s.flags.tag.default, ["x"], "the spec is never written to");
  const untouched = args(s, { argv: ["list"], io }).flags.tag;
  assertEquals(untouched, ["x"]);
  untouched.push("y");
  assertEquals(s.flags.tag.default, ["x"], "nor through the returned default");
});

// aiol reads code written without semicolons: a newline after a complete
// operand ends the statement. The first cut decided "complete" by the LAST
// CHARACTER of the line, and several operands end in an operator's character:
// postfix `seq++` / `seq--`, TypeScript's non-null `x!`, a regex literal's
// closing `/`, a generic's closing `>`. Each of them made the next line part
// of the arrow body before it, so
//
//   const nextId = () => seq++
//   s.t = Deno.readTextFileSync("f")
//
// hid the sync I/O as if it were inside the arrow — while the same two lines
// WITH semicolons were reported. The differential below asks both spellings
// the same question for every operand ending, so the rule cannot depend on
// the author's semicolon habit again.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkSyncMethodIO } from "../aiol/checks.ts";
import type { Issue } from "../aiol/types.ts";

const DENO_JSON = JSON.stringify({
  imports: { aio: "jsr:@riagentic/aio@1.0.0" },
});

async function syncIO(body: string): Promise<Issue[]> {
  const dir = await Deno.makeTempDir({ prefix: "aiol-asi-end-" });
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(join(dir, "deno.json"), DENO_JSON);
    await Deno.writeTextFile(
      join(dir, "src/a.ts"),
      `import { cell } from "aio"\nlet seq = 0\nconst arr = [0]\nconst obj = { x: 1 }\n` +
        `export const a = cell("a", { state: { n: 0, t: "" }, methods: {\n` +
        `  load(s) {\n${body}\n  },\n} })\n`,
    );
    const { ctx, report } = await buildContext(dir);
    await checkSyncMethodIO(ctx);
    return report.issues;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Arrow expression bodies that are complete at the end of their line. */
const OPERAND_ENDINGS: Record<string, string> = {
  postfixIncrement: "seq++",
  postfixDecrement: "seq--",
  postfixOnIndex: "arr[0]++",
  postfixSpaced: "seq ++",
  nonNull: "obj!",
  nonNullMember: "obj.x!",
  call: "String(seq)",
  index: "arr[0]",
  identifier: "seq",
  number: "42",
  string: '"str"',
  template: "`t${seq}`",
  regex: "/ab+c/",
  regexFlags: "/ab+c/g",
  keyword: "null",
  genericCast: "arr as Array<number>",
  nestedGenericCast: "arr as Array<Set<number>>",
};

Deno.test("sync I/O: every operand ending ends the statement, with or without semicolons", async () => {
  const disagree: string[] = [];
  for (const [name, expr] of Object.entries(OPERAND_ENDINGS)) {
    const io = '    s.t = Deno.readTextFileSync("f")';
    const withSemi = await syncIO(`    const f = () => ${expr};\n${io};`);
    const noSemi = await syncIO(`    const f = () => ${expr}\n${io}`);
    // Verify the instrument: the semicolon spelling must be the reported one,
    // or agreement would only mean both are blind.
    if (withSemi.length !== 1) {
      disagree.push(`${name}: with semicolons ${withSemi.length} issues`);
    }
    if (noSemi.length !== withSemi.length) {
      disagree.push(
        `${name}: no-semicolon ${noSemi.length} vs semicolon ${withSemi.length}`,
      );
    }
  }
  assertEquals(disagree, [], `\n${disagree.join("\n")}`);
});

Deno.test("sync I/O: a line that starts with ++/-- begins a new statement", async () => {
  // `seq⏎++arr[i]` is `seq; ++arr[i]` — the language forbids a line break
  // before a POSTFIX operator, so the `++` belongs to the next line's operand
  // and the I/O in it is the method's, not the arrow's.
  const next = '    ++arr[Deno.readTextFileSync("f").length]';
  const withSemi = await syncIO(`    const f = () => seq;\n${next};`);
  const noSemi = await syncIO(`    const f = () => seq\n${next}`);
  assertEquals(withSemi.length, 1, JSON.stringify(withSemi));
  assertEquals(noSemi.length, 1, JSON.stringify(noSemi));
});

Deno.test("sync I/O: an operator at the end of the line still continues the arrow body", async () => {
  // The other direction: none of the operand endings above may swallow a real
  // continuation. Each of these keeps the I/O inside the deferred arrow.
  const continued = [
    "seq +",
    "seq -",
    "seq * 2 +",
    "seq !== 1 ||",
    "seq++ +",
    "obj! &&",
    "seq > 1 ?",
    "seq < 2 &&",
    "seq >",
    "seq /",
  ];
  const leaked: string[] = [];
  for (const head of continued) {
    const issues = await syncIO(
      `    const f = () => ${head}\n      Deno.readTextFileSync("f")`,
    );
    if (issues.length) leaked.push(head);
  }
  assertEquals(leaked, []);
});

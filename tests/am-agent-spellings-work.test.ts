// `am agent` handed an agent two spellings that fail as typed:
//
//   am preview <Component>                   — preview takes a FILE
//                                              (`am preview src/Card.tsx
//                                              --export=Card`); a component
//                                              name is "no such file".
//   am record tests/x.test.ts --from=journal — `--from` is a PATH; "journal"
//                                              is a file that does not exist.
//                                              With no `--from`, record reads
//                                              the app's own journal.
//
// And a bare `am agent --task` printed the whole brief with exit 0 — the
// silent twin of the refusal a mistyped slug already gets. Measured by a
// hunter running `am` as a user.
//
// The replacement spelling was wrong too, measured by running it in a fresh
// `am create` app: `am preview src/Card.tsx` answers "no such file …/src/src/
// Card.tsx — paths are relative to the app directory". The app directory is
// the ENTRY's directory (src/ in every scaffold), so the working spelling was
// `am preview ui/Card.tsx`. The verb now resolves a file argument the way a
// shell user means it (cwd first — tests/am-file-arg-resolution.test.ts), so
// the brief teaches the path tab completion writes.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { agentBrief, BRIEF_TASKS } from "../src/am/am-agent-text.ts";

const BRIEF = agentBrief({ version: "test", task: "all" });

Deno.test("am agent: no spelling that fails as typed", () => {
  assert(!BRIEF.includes("--from=journal"), "--from=journal is not a path");
  assert(
    !/am preview <Component>/.test(BRIEF),
    "am preview takes a file, not a component name",
  );
  assertStringIncludes(BRIEF, "am preview src/ui/Card.tsx --export=Card");
  assertStringIncludes(BRIEF, "am record tests/x.test.ts");
});

Deno.test("am agent --task with no section is refused", async () => {
  const run = async (...args: string[]) => {
    const o = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        new URL("../src/am.ts", import.meta.url).pathname,
        "agent",
        ...args,
      ],
      env: { ...Deno.env.toObject(), AIO_AM_NO_DELEGATE: "1", NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const d = new TextDecoder();
    return { code: o.code, text: d.decode(o.stdout) + d.decode(o.stderr) };
  };
  for (const args of [["--task"], ["--task="]]) {
    const r = await run(...args);
    assertEquals(r.code, 1, `am agent ${args.join(" ")} printed the brief`);
    assertStringIncludes(r.text, "--task needs a section");
    assertStringIncludes(r.text, BRIEF_TASKS[0]!);
  }
  // The real spellings still work — and print what they claim to.
  const one = await run(`--task=${BRIEF_TASKS[0]}`);
  assertEquals(one.code, 0);
  assertStringIncludes(
    one.text,
    agentBrief({ version: "x", task: BRIEF_TASKS[0] }).split("\n").slice(3)
      .join("\n").trim(),
  );
  const page = await run();
  assertEquals(page.code, 0);
  assertStringIncludes(page.text, "BUILD A NEW APP");
  assert(
    !page.text.includes("PITFALLS — the long list"),
    "the default page printed a deep section",
  );
  const all = await run("--task=all");
  assertEquals(all.code, 0);
  assertStringIncludes(all.text, "PITFALLS — the long list");
  const list = await run("--list");
  assertEquals(list.code, 0);
  for (const slug of BRIEF_TASKS) assertStringIncludes(list.text, slug);
  assertEquals((await run("--task=nope")).code, 1);
});

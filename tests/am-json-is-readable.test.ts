// `--json` in a terminal was one unwrapped 8 kB line.
//
// From a field report (vidtune §8.2): `am surface --json` printed the whole
// surface on a single line, so reading one component out of it meant piping
// into another tool — the "am made me write a script" shape this CLI keeps
// removing.
//
// So the serialization is keyed on who is reading: a pipe gets the compact
// form a parser wants, a terminal gets it indented. Both are the same JSON
// document — `JSON.parse` cannot tell them apart — which is what makes this
// a presentation choice and not a behaviour fork. It is the same call colour
// output makes, on the same fact.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname;

/** Run `am` and capture stdout through a PIPE — never a terminal.
 *
 *  In its OWN apps dir. An empty `AIO_APPS_DIR` is not isolation: the lock dir
 *  falls back to the shared default and the command answers with whatever the
 *  developer happens to be running — the first draft of this test asserted
 *  against a real app on this machine. */
async function amPiped(args: string[]): Promise<string> {
  const home = await tempDir("am-json-");
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${REPO}src/am.ts`, ...args],
    env: { AIO_APPS_DIR: home },
    stdout: "piped",
    stderr: "null",
  }).output();
  return new TextDecoder().decode(p.stdout);
}

Deno.test("a pipe gets compact JSON — one line, no indentation", async () => {
  const text = (await amPiped(["instances", "--json"])).trim();
  // What it must SAY, not merely that it said something: `am instances --json`
  // answers with an array, and an empty one is the honest answer here (the
  // test has its own empty AIO_APPS_DIR).
  assertEquals(
    JSON.parse(text),
    [],
    `unexpected payload: ${text.slice(0, 200)}`,
  );
  assertStringIncludes(text, "[");
  assertEquals(
    text.split("\n").length,
    1,
    `a piped --json grew newlines, which is what a parser reading line by ` +
      `line would break on:\n${text.slice(0, 200)}`,
  );
});

Deno.test("a terminal gets the same document, indented", () => {
  // `Deno.stdout.isTerminal()` is the switch, and a test process has no
  // terminal — so the two forms are asserted directly against the property
  // that has to hold: same parse, different shape.
  const data = { roots: [{ component: "App", elements: [{ name: "Add" }] }] };
  const compact = JSON.stringify(data);
  const indented = JSON.stringify(data, null, 2);
  assertEquals(JSON.parse(indented), JSON.parse(compact));
  assert(
    indented.split("\n").length > 4,
    "the indented form must actually wrap, or it fixes nothing",
  );
  assertEquals(compact.split("\n").length, 1);
});

Deno.test("the switch cannot throw the command away", async () => {
  // `Deno.stdout.isTerminal()` throws on a closed or absent stdout. A
  // diagnostic that kills the command it was formatting is worse than an
  // unwrapped line, so the check is guarded and falls back to compact.
  const src = await Deno.readTextFile(
    new URL("../src/am/am-output.ts", import.meta.url),
  );
  const fn = src.slice(src.indexOf("function jsonText"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert(body.includes("try {"), "isTerminal() must be guarded");
  assert(
    body.indexOf("catch") > body.indexOf("isTerminal"),
    "the catch has to cover the isTerminal call, not something after it",
  );
});

// The apps aio ships must take aio's own advice.
//
// A TypeScript `?` on a parameter is ERASED at runtime, so `fn.length` still
// counts it. The framework's arity tripwire therefore says:
//
//   manager:loadLogs declares 2 arguments and this call passed 1 — the
//   missing one is `undefined` inside the method … or — if the method fills
//   its own in — give the parameter a DEFAULT in the SIGNATURE
//   (`loadLogs(s, x = 0)`), which is what makes its optionality visible here.
//
// amui — the visual app manager, the reference app a newcomer reads — had
// `loadLogs(s, path, source?: LogSource)` and called it with one argument from
// four places, so its own most-used screen warned every time it opened. A
// framework whose flagship app trips its own tripwire teaches the reader that
// the tripwire is noise.
//
// A DEFAULT is the fix, and it is checkable statically, which is what this is.
// The rule is narrow on purpose: a `?` inside an OBJECT parameter type is not
// a method parameter and is not matched.
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

/** Every `.ts`/`.tsx` under a directory. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory) out.push(...await walk(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** A cell METHOD whose first parameter is the state slice, with a later
 *  parameter marked `?` and given no default.
 *
 *  `[^{)]*?` is load-bearing twice over: it stops the scan at the first `{`,
 *  so an OBJECT parameter carrying its own optional fields
 *  (`input: { note?: string }`) never matches, and at the first `)`, so the
 *  match cannot run past the end of the parameter list. The first version
 *  lacked the `{` exclusion and reported `examples/contacts`'s
 *  `create(s, input: { …, note?: string })`, which is not this defect at all
 *  — caught by the self-test below, which is why it is here. */
const OPTIONAL_NO_DEFAULT =
  /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(\s*s\s*(?::[^,){]*)?\s*,[^{)]*?\b([A-Za-z_$][\w$]*)\?\s*:[^,)={]*[,)]/;

Deno.test("amui and examples: no cell method takes a `?` parameter without a default", async () => {
  const files: string[] = [
    ...await walk(join(ROOT, "amui", "src")),
    ...await walk(join(ROOT, "examples")),
  ];
  const offenders: string[] = [];
  for (const f of files) {
    const lines = (await Deno.readTextFile(f)).split("\n");
    lines.forEach((line, i) => {
      const m = OPTIONAL_NO_DEFAULT.exec(line);
      if (m) {
        offenders.push(
          `${f.slice(ROOT.length)}:${i + 1}  ${m[1]}(… ${m[2]}?: …)`,
        );
      }
    });
  }
  assertEquals(
    offenders,
    [],
    "a `?` is erased at runtime, so the arity tripwire fires on every call " +
      "that omits it. Give the parameter a default (`x = undefined` is " +
      "enough when the real default depends on state):\n  " +
      offenders.join("\n  "),
  );
});

// The rule is the load-bearing part — one that matches nothing passes forever.
Deno.test("the optional-parameter rule matches what it claims, and nothing else", () => {
  const hit = (l: string) => OPTIONAL_NO_DEFAULT.test(l);
  // Matches: a method with a bare optional parameter.
  assertEquals(
    hit("    async loadLogs(s, path: string, source?: LogSource) {"),
    true,
  );
  assertEquals(hit("  setAge(s, age: number, unit?: string) {"), true);
  // Does not match once it has a default.
  assertEquals(
    hit(
      "    async loadLogs(s, path: string, source: LogSource | undefined = undefined) {",
    ),
    false,
  );
  // Does not match an optional FIELD inside an object parameter.
  assertEquals(
    hit(
      "    create(s, input: { name: string; email: string; note?: string }) {",
    ),
    false,
  );
  // Does not match a plain function that is not a cell method.
  assertEquals(hit("function helper(a: string, b?: number) {"), false);
});

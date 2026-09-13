// Every path a `deno task` names must exist.
//
// `deno task example` ran `examples/counter/app.ts` for who knows how long.
// The examples grew a `src/` directory and the task did not follow, so the one
// command a newcomer is most likely to type answered:
//
//   error: Module not found "…/examples/counter/app.ts".
//
// Nothing caught it, because a task is only run by the person who runs it.
// Type-checking does not read `deno.json`, and no gate walked the task list.
// This is the gate: it is about the whole CLASS, not that one path — 58 tasks
// reference scripts, sources, examples and docs, and any of them can rot the
// same way the moment a file moves.
import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

/** Repo-relative file paths a shell command names. Deliberately narrow: a
 *  leading known directory plus a real extension, so a flag value or a URL is
 *  never mistaken for a path. */
function pathsIn(cmd: string): string[] {
  const re =
    /(?<![\w/.-])((?:scripts|src|examples|tests|amui|aiol|docs)\/[\w./-]+\.(?:ts|tsx|json|md|js))/g;
  return [...cmd.matchAll(re)].map((m) => m[1]!);
}

Deno.test("deno.json: every task's file paths exist", async () => {
  const cfg = JSON.parse(
    await Deno.readTextFile(`${ROOT}deno.json`),
  ) as { tasks?: Record<string, string | { command?: string }> };
  const tasks = cfg.tasks ?? {};
  const missing: string[] = [];
  for (const [name, raw] of Object.entries(tasks)) {
    const cmd = typeof raw === "string" ? raw : raw.command ?? "";
    for (const p of pathsIn(cmd)) {
      try {
        await Deno.stat(`${ROOT}${p}`);
      } catch {
        missing.push(`deno task ${name} → ${p}`);
      }
    }
  }
  assertEquals(
    missing,
    [],
    "a task names a file that is not there — the command fails the moment " +
      "anyone runs it:\n  " + missing.join("\n  "),
  );
});

// The regex is the load-bearing part: a rule that matches nothing passes
// forever and proves nothing. This pins that it actually finds paths, and that
// it does not grab things that are not paths.
Deno.test("the task-path scanner finds paths, and only paths", () => {
  assertEquals(
    pathsIn("deno run -A examples/counter/src/app.ts"),
    ["examples/counter/src/app.ts"],
  );
  assertEquals(
    pathsIn("deno run --allow-read scripts/a.ts && deno run scripts/b.ts"),
    ["scripts/a.ts", "scripts/b.ts"],
  );
  assertEquals(pathsIn("deno test -A --filter x"), []);
  assertEquals(pathsIn("deno publish --dry-run"), []);
  assertEquals(pathsIn("echo https://example.com/src/a.ts"), []);
});

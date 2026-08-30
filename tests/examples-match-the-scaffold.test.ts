// examples/counter and examples/todo ARE what `am create` writes — byte for
// byte, not "in the same spirit".
//
// They were meant to be in lockstep (a comment in am-cmd-create.ts said so)
// and nothing checked it, so all six files had drifted: the scaffold had
// moved to aio's default theme — semantic HTML plus card/row/badge — while the
// examples still carried 170 lines of inline `style={{…}}` and a hard-coded
// `#c77`. The two copies were the same app in two designs, and the one people
// READ (the example, linked from the README) was the stale one.
//
// One source, checked. `deno task update:examples` regenerates them.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";

const ROOT = new URL("..", import.meta.url).pathname;

const CASES = [
  { dir: "counter", template: "counter" },
  { dir: "todo", template: "todo" },
] as const;

const FILES = ["app.ts", "cell.ts", "App.tsx"] as const;

Deno.test({
  name:
    "examples: counter and todo are byte-identical to what `am create` writes",
  // Spawns `am create` twice — real scaffolds, not a re-read of the constants,
  // so a bug anywhere between the template and the file on disk is caught too.
  async fn() {
    const tmp = await Deno.makeTempDir({ prefix: "aio-scaffold-check-" });
    try {
      for (const { dir, template } of CASES) {
        const out = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            join(ROOT, "src/am.ts"),
            "create",
            dir,
            `--template=${template}`,
          ],
          cwd: tmp,
          stdout: "null",
          stderr: "piped",
        }).output();
        assertEquals(
          out.code,
          0,
          `am create ${dir} failed: ${new TextDecoder().decode(out.stderr)}`,
        );
        for (const f of FILES) {
          const scaffolded = await Deno.readTextFile(join(tmp, dir, "src", f));
          const example = await Deno.readTextFile(
            join(ROOT, "examples", dir, f),
          );
          assertEquals(
            example,
            scaffolded,
            `examples/${dir}/${f} has drifted from the scaffold — run ` +
              `\`deno task update:examples\` (the scaffold is the source; the ` +
              `example is the copy that gets read)`,
          );
        }
      }
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  },
});

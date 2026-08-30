// sync-examples.ts — regenerate examples/counter and examples/todo from the
// scaffold that `am create` actually runs.
//
// The examples are CI fixtures AND the code people read from the README, and
// they are the same two apps `am create --template=…` writes. Keeping a second
// hand-edited copy is how they drifted a design apart (see
// tests/examples-match-the-scaffold.test.ts). This is the one direction that
// makes sense: the scaffold is the source, the example is the artifact.
//
//   deno task update:examples

import { join } from "@std/path";
import { count, mark, style } from "../src/diagnostics/fmt.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const CASES = [
  { dir: "counter", template: "counter" },
  { dir: "todo", template: "todo" },
];
const FILES = ["app.ts", "cell.ts", "App.tsx"];

const tmp = await Deno.makeTempDir({ prefix: "aio-sync-examples-" });
let changed = 0;
try {
  for (const { dir, template } of CASES) {
    const r = await new Deno.Command(Deno.execPath(), {
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
      stderr: "inherit",
    }).output();
    if (r.code !== 0) {
      console.error(`${mark("bad")} am create ${dir} failed`);
      Deno.exit(1);
    }
    for (const f of FILES) {
      const from = join(tmp, dir, "src", f);
      const to = join(ROOT, "examples", dir, f);
      const next = await Deno.readTextFile(from);
      const prev = await Deno.readTextFile(to).catch(() => null);
      if (prev === next) continue;
      await Deno.writeTextFile(to, next);
      console.log(`${mark("ok")} examples/${dir}/${f}`);
      changed++;
    }
  }
} finally {
  await Deno.remove(tmp, { recursive: true }).catch(() => {});
}
console.log(
  changed === 0
    ? `${mark("ok")} examples already match the scaffold`
    : `${mark("ok")} ${count(changed, "file")} regenerated`,
);

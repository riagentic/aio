// a field report #3/#4 — a freshly scaffolded app must pass aio's OWN linter.
//
// `am create --template=counter` produced an app that reported
// `✗ ERROR [config] missing appVersion in aio.run()` on the very first
// `deno task lint`, plus two hints about the template's own files. Generated
// code failing the shipped linter in the first five minutes teaches "the linter
// is noise" — after which the genuine findings go unread too.
//
// This is the gate: every template × target the scaffolder can emit, linted.
// Only `build`-area findings are tolerated, because those are about the
// developer's machine (esbuild/Electron not installed yet), not the code.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  scaffold,
  type Target,
  type Template,
} from "../src/am/am-cmd-create.ts";
import { lint } from "../aiol/mod.ts";

async function lintScaffold(template: Template, target: Target) {
  const dir = await Deno.makeTempDir({ prefix: `aiol-scaffold-${template}-` });
  try {
    for (
      const [rel, content] of Object.entries(
        scaffold(template, template, false, target),
      )
    ) {
      const path = join(dir, rel);
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, content);
    }
    const report = await lint(dir);
    return report.issues.filter((i) => i.area !== "build");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const CASES: [Template, Target][] = [
  ["counter", "server"],
  ["counter", "browser"],
  ["counter", "electron"],
  ["todo", "browser"],
  ["todo", "server"],
];

for (const [template, target] of CASES) {
  Deno.test(`scaffold: ${template}/${target} lints clean`, async () => {
    const issues = await lintScaffold(template, target);
    assertEquals(
      issues.map((i) => `${i.severity} [${i.area}] ${i.message}`),
      [],
      "a fresh scaffold must not be flagged by the linter it ships with",
    );
  });
}

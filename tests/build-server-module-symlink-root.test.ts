// `*.server.ts` embedding from a project reached through a SYMLINK (v1.0.11
// hunt). `deno info` reports real paths; `localModuleGraph` made them relative
// to the link, so every module read as `../<real>/…` — outside the project —
// and a sibling-folder server module the entry imports was left out of the
// binary, which then dies at that import. And the "not embedding" line, the
// one hint that names the fix, was a console.log that scrolls past.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { assetIncludes } from "../src/build/build-compile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { HEY } from "../src/diagnostics/fmt.ts";

async function project(dir: string): Promise<void> {
  await Deno.mkdir(join(dir, "app", "sub"), { recursive: true });
  await Deno.mkdir(join(dir, "other"), { recursive: true });
  await Deno.mkdir(join(dir, "relay"), { recursive: true });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.writeTextFile(
    join(dir, "app", "main.ts"),
    'import "./sub/a.ts";\nimport "../other/b.server.ts";\n',
  );
  await Deno.writeTextFile(join(dir, "app", "sub", "a.ts"), "export {};\n");
  await Deno.writeTextFile(join(dir, "other", "b.server.ts"), "export {};\n");
  await Deno.writeTextFile(join(dir, "other", "c.server.ts"), "export {};\n");
  await Deno.writeTextFile(join(dir, "relay", "r.server.ts"), "export {};\n");
}

const included = (args: string[]) =>
  args.filter((_, i) => args[i - 1] === "--include").sort();

Deno.test("assetIncludes: a symlinked project root embeds the same *.server.ts as the real one, and says loudly what it skips", async () => {
  const base = await tempDir("aio-symroot-");
  const warned: string[] = [];
  const logged: string[] = [];
  const { warn, log } = console;
  try {
    const real = join(base, "real");
    const link = join(base, "link");
    await project(real);
    await Deno.symlink(real, link);
    console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
    console.log = (...a: unknown[]) => void logged.push(a.join(" "));
    const viaReal = included(await assetIncludes(real, "app/main.ts"));
    const viaLink = included(await assetIncludes(link, "app/main.ts"));
    console.warn = warn;
    console.log = log;
    assertEquals(viaReal, [
      "deno.json",
      "other/b.server.ts",
      "other/c.server.ts",
    ]);
    assertEquals(
      viaLink,
      viaReal,
      "the link must see the graph the real dir sees",
    );
    const skip = warned.filter((w) => w.includes("not embedding"));
    assertEquals(skip.length, 2, warned.join("\n"));
    assert(skip.every((w) => w.startsWith(`${HEY} `)), skip.join("\n"));
    assert(skip.every((w) => w.includes("relay/r.server.ts")));
    assert(skip.every((w) => w.includes('"compile": { "include": [] }')));
    assert(
      !logged.some((l) => l.includes("not embedding")),
      "the skip line is a warning, not progress output",
    );
  } finally {
    console.warn = warn;
    console.log = log;
    await dropTempDir(base);
  }
});

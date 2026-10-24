// Run from `src/`, aiol linted `src` as a project with no deno.json — and
// `--safe-fix` then wrote `appId: "src"` into app.ts: a NEW appId, so the next
// boot opened an empty database beside the real one. The CLI now lints the
// nearest directory holding a deno.json, and refuses a FILE argument.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { projectRoot } from "../aiol/mod.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AIOL = fromFileUrl(new URL("../aiol/mod.ts", import.meta.url));
const APP = `import { aio } from "aio";\nawait aio.run({});\n`;

async function aiol(cwd: string, ...args: string[]) {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", AIOL, ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: { NO_COLOR: "1" },
  }).output();
  return { code: o.code, err: new TextDecoder().decode(o.stderr) };
}

Deno.test("aiol: run from src/, --safe-fix lints the project and leaves app.ts alone", async () => {
  const dir = await tempDir("aiol-root-walk-");
  try {
    await Deno.mkdir(join(dir, ".git"));
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        name: "@x/walk",
        imports: { aio: "jsr:@riagentic/aio@1.0.0" },
      }),
    );
    await Deno.writeTextFile(join(dir, "src", "app.ts"), APP);
    assertEquals(projectRoot(join(dir, "src")), dir);
    const r = await aiol(join(dir, "src"), "--safe-fix");
    assertStringIncludes(r.err, "nearest deno.json");
    assertEquals(await Deno.readTextFile(join(dir, "src", "app.ts")), APP);
    // A file argument is refused, not linted as an empty project.
    const f = await aiol(dir, "src/app.ts");
    assertEquals(f.code, 2);
    assertStringIncludes(f.err, "is a file");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("aiol: the walk stops at a repository root", async () => {
  const dir = await tempDir("aiol-root-stop-");
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.mkdir(join(dir, "repo", ".git"), { recursive: true });
    await Deno.mkdir(join(dir, "repo", "src"));
    const src = join(dir, "repo", "src");
    assertEquals(projectRoot(src), src);
  } finally {
    await dropTempDir(dir);
  }
});

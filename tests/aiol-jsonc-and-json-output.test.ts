// Two ways `aiol --safe-fix` lied about what it did.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { fixAddNodeModulesDir } from "../aiol/fixes.ts";

const AIO_ROOT = new URL("..", import.meta.url).pathname;

async function project(
  config: string,
  name: "deno.json" | "deno.jsonc",
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aiol-jsonc-" });
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(join(dir, name), config);
  await Deno.writeTextFile(
    join(dir, "src", "app.ts"),
    `import { aio } from "aio";\nawait aio.run({ appId: "x" });\n`,
  );
  return dir;
}

// The patcher READ `deno.json`, fell back to reading `deno.jsonc`, and then
// wrote `deno.json` unconditionally. On a jsonc project that meant one of two
// silent outcomes: nothing happened (a commented config threw in JSON.parse
// and the failure was swallowed — the same issue reappearing as `[fixable]` on
// every run with no reason given), or a SECOND config file appeared that Deno
// silently prefers, so from then on every edit the owner made to their own
// `deno.jsonc` was ignored.
Deno.test("aiol safe-fix: a jsonc project is patched IN PLACE, no second config appears", async () => {
  const dir = await project(
    `{ "imports": { "aio": "jsr:@riagentic/aio@1.0.0" } }`,
    "deno.jsonc",
  );
  try {
    assertEquals(await fixAddNodeModulesDir(dir), true, "the fix applied");
    const patched = JSON.parse(
      await Deno.readTextFile(join(dir, "deno.jsonc")),
    );
    assertEquals(patched.nodeModulesDir, "auto", "written where it was read");
    assertEquals(
      await Deno.stat(join(dir, "deno.json")).then(() => true).catch(() =>
        false
      ),
      false,
      "a shadow deno.json would take over the project silently",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("aiol safe-fix: a config with real comments is REFUSED out loud, not mangled", async () => {
  const src = `{
  // the reason this app pins an old esbuild
  "imports": { "aio": "jsr:@riagentic/aio@1.0.0" }
}
`;
  const dir = await project(src, "deno.jsonc");
  const errs: string[] = [];
  const real = console.error;
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  try {
    assertEquals(
      await fixAddNodeModulesDir(dir),
      false,
      "a fix that did not happen must not report success",
    );
    assertEquals(
      await Deno.readTextFile(join(dir, "deno.jsonc")),
      src,
      "the comments are worth more than the automation — nothing was touched",
    );
    assert(
      errs.some((e) => e.includes("cannot safe-fix") && e.includes("by hand")),
      `the refusal must say so and name the file — got ${JSON.stringify(errs)}`,
    );
    assertEquals(
      await Deno.stat(join(dir, "deno.json")).then(() => true).catch(() =>
        false
      ),
      false,
    );
  } finally {
    console.error = real;
    await Deno.remove(dir, { recursive: true });
  }
});

// `--json` means stdout carries ONE parseable document and nothing else. The
// human progress lines ("applying safe fixes", "✓ fixed …") were printed
// around it on stdout, so `aiol . --json --safe-fix | jq` could not parse the
// output of the tool that produced it.
Deno.test("aiol: --json --safe-fix writes ONE JSON document to stdout", async () => {
  const dir = await project(
    JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }, null, 2),
    "deno.json",
  );
  try {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        join(AIO_ROOT, "aiol", "mod.ts"),
        dir,
        "--json",
        "--safe-fix",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout, stderr } = await cmd.output();
    const out = new TextDecoder().decode(stdout).trim();
    const err = new TextDecoder().decode(stderr);
    const parsed = JSON.parse(out); // the assertion: this must not throw
    assert(
      Array.isArray(parsed.issues),
      `the document is the report — got ${out.slice(0, 120)}`,
    );
    // The narration is not lost, it is just on the other stream.
    assertStringIncludes(err, "applying safe fixes");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

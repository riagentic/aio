// `aiol <dir> --json` promises ONE parseable document on stdout. On an app
// with a local path pin (`.aio/pin.local`, what `am create --mirror` writes)
// the framework's pin reader logged `aio: local path pin → …` at info level —
// to STDOUT — ahead of the document, so `aiol . --json | jq` could not parse.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url));

Deno.test("aiol --json: stdout is only the JSON document on a path-pinned app", async () => {
  const dir = await tempDir("aiol-json-stdout-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.mkdir(join(dir, ".aio"));
    await Deno.writeTextFile(join(dir, ".aio", "pin.local"), REPO + "\n");
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: join(REPO, "mod.ts") } }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "app.ts"),
      `import { aio } from "aio";\nawait aio.run({});\n`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(REPO, "aiol", "mod.ts"), dir, "--json"],
      stdout: "piped",
      stderr: "piped",
      env: { NO_COLOR: "1" },
    }).output();
    const stdout = new TextDecoder().decode(out.stdout);
    const doc = JSON.parse(stdout); // throws on a leading log line
    assertEquals(typeof doc.summary, "object");
    // The line still reaches a human — on stderr.
    assertStringIncludes(
      new TextDecoder().decode(out.stderr),
      "local path pin",
    );
  } finally {
    await dropTempDir(dir);
  }
});

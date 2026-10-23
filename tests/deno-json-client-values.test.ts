// deno.json `"client"`: every value aio knows maps to a client, the
// `--client=` flag's own spelling `"server-only"` included — and a value it
// does not know is SAID. It fell through to the electron default silently,
// and the boot then blamed a missing App.tsx, never the typo.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { spec } from "./module-spec-helper.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const aioRoot = join(import.meta.dirname!, "..");

async function clientOf(
  value: unknown,
): Promise<{ client: unknown; err: string }> {
  const proj = await tempDir("aio-client-value-");
  try {
    await Deno.mkdir(join(proj, "src"));
    await Deno.writeTextFile(
      join(proj, "deno.json"),
      JSON.stringify({ client: value }),
    );
    const probe = join(proj, "src", "app.ts");
    await Deno.writeTextFile(
      probe,
      `import { _denoJsonTargetClient } from "${
        spec(join(aioRoot, "src/server/aio.ts"))
      }";\nconsole.log(JSON.stringify({ client: _denoJsonTargetClient() ?? null }));\n`,
    );
    const r = await new Deno.Command(Deno.execPath(), {
      // aio's own imports resolve through its config; the app's deno.json
      // is still found entry-relative, which is what is read.
      args: ["run", "-A", "--config", join(aioRoot, "deno.json"), probe],
      cwd: proj,
      stdout: "piped",
      stderr: "piped",
      env: { NO_COLOR: "1" },
    }).output();
    const out = new TextDecoder().decode(r.stdout);
    const line = out.split("\n").find((l) => l.startsWith("{"));
    if (!line) {
      throw new Error(
        `probe printed nothing: ${new TextDecoder().decode(r.stderr)}`,
      );
    }
    return {
      client: JSON.parse(line).client,
      err: out + new TextDecoder().decode(r.stderr),
    };
  } finally {
    await dropTempDir(proj);
  }
}

Deno.test("deno.json client: server and server-only are no UI; an unknown value is said, by name", async () => {
  assertEquals((await clientOf("server")).client, "server-only");
  assertEquals((await clientOf("server-only")).client, "server-only");
  const typo = await clientOf("srever");
  assertEquals(typo.client, null);
  assertStringIncludes(typo.err, `"client": "srever" is not a client`);
  assertStringIncludes(typo.err, `"server" (no UI)`);
});

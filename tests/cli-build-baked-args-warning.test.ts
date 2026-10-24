// A `cli` binary built from an app whose deno.json does not declare
// `"client": "cli"` gets `--client=cli` BAKED in front of its users' argv, so
// the program's own `Deno.args[0] === "serve"` check fails in the binary
// while it works from source (measured on examples/cli-tool: `serve` fell
// through to "no server running"). The build says so; the example declares it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { bakedCliArgsWarning, cliCompileArgs } from "../src/build/build-cli.ts";

const base = {
  doRemote: false,
  out: "bin",
  entry: "src/app.ts",
  excludes: [],
  v8Flags: [],
};

Deno.test("cli build: baking --client=cli in front of argv is said at build time", () => {
  const w = bakedCliArgsWarning(cliCompileArgs({ ...base, assets: [] }));
  assert(w, "an undeclared client bakes --client=cli and must be said");
  assertStringIncludes(w, `"client": "cli"`);
  assertStringIncludes(w, "Deno.args[0]");
});

Deno.test("cli build: declared client (embedded deno.json) or --remote bakes nothing, says nothing", () => {
  assertEquals(
    bakedCliArgsWarning(
      cliCompileArgs({
        ...base,
        assets: ["--include", "deno.json"],
        declaredClient: "cli",
      }),
    ),
    null,
  );
  assertEquals(
    bakedCliArgsWarning(
      cliCompileArgs({ ...base, doRemote: true, assets: [] }),
    ),
    null,
  );
});

Deno.test("examples/cli-tool declares client cli, so its compiled `serve` sees its own argv", async () => {
  const cfg = JSON.parse(
    await Deno.readTextFile(
      fromFileUrl(
        new URL("../examples/cli-tool/deno.json", import.meta.url),
      ),
    ),
  );
  assertEquals(cfg.client, "cli");
});

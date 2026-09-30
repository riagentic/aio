// The docs-completeness gate must FAIL when it checked nothing.
//
// `check-doc-coverage` iterated the deno.json exports and counted the public
// symbols it saw. With none — a typo'd exports map, or a `deno doc --json`
// whose `nodes` shape changed — it printed "✓ all 0 public symbols documented"
// and exited 0. A completeness gate that passes vacuously is the one answer
// nobody can notice, so it is driven here against a fixture that has none,
// exactly as `tests/coverage-counts-this-repo.test.ts` drives `check-coverage`.
import { assert, assertStringIncludes } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const SCRIPT = new URL("../scripts/check-doc-coverage.ts", import.meta.url);

Deno.test("check:doc-coverage fails when no public symbol was checked", async () => {
  const dir = await tempDir("aio-doc-coverage-empty-");
  try {
    await Deno.mkdir(`${dir}/scripts`, { recursive: true });
    await Deno.copyFile(SCRIPT, `${dir}/scripts/check-doc-coverage.ts`);
    // The only export is internal, so the gate's `total` stays 0.
    await Deno.writeTextFile(
      `${dir}/empty.ts`,
      "const _secret = 1;\nexport { _secret as _internalThing };\n",
    );
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        name: "fake",
        version: "0.0.0",
        exports: { ".": "./empty.ts" },
      }),
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-run",
        "scripts/check-doc-coverage.ts",
      ],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(
      out.code !== 0,
      `an empty symbol set must fail the gate, got exit ${out.code}: ` +
        new TextDecoder().decode(out.stdout),
    );
    assertStringIncludes(
      new TextDecoder().decode(out.stderr),
      "checked nothing",
    );
  } finally {
    await dropTempDir(dir);
  }
});

// The fleet's summary says when an updating app ships no signing key — the
// wiring around the pure `updatesKeyOnFirstUse` / `firstUseKeyWarning`
// (tests/am-harden.test.ts): which entry it reads, and that a target that
// built is what makes it read one. The builder is stubbed (`--build-spec`),
// as in tests/build-fleet-service-unit-final.test.ts.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildAll } from "../src/build-all.ts";
import { firstUseKeyWarning } from "../src/build/capabilities.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const STUB = `
const root = Deno.cwd();
const arg = (f) => Deno.args.find((a) => a.startsWith(f))?.slice(f.length);
const bin = arg("--name=").toLowerCase();
await Deno.writeTextFile(root + "/" + bin, "#!/bin/sh\\necho '" + bin + " 0.1.0 (aio 1.0.0-beta)'\\n");
await Deno.chmod(root + "/" + bin, 0o755);
`;

/** The fleet's printed lines for an app whose entry is `entry`. */
async function build(entry: string): Promise<string[]> {
  const dir = await tempDir("aio-fleet-first-use-");
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const origArgs = Deno.args;
  const origCwd = Deno.cwd();
  const lines: string[] = [];
  try {
    const stub = join(dir, "stub-build.ts");
    await Deno.writeTextFile(stub, STUB);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ title: "fuapp", build: { targets: ["cli"] } }),
    );
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "src", "app.ts"), entry);
    Object.defineProperty(Deno, "args", {
      value: [`--build-spec=${stub}`],
      configurable: true,
    });
    Deno.chdir(dir);
    console.log = console.warn = console.error = (...a: unknown[]) =>
      void lines.push(a.map(String).join(" "));
    const code = await buildAll();
    Object.assign(console, orig);
    assertEquals(code, 0, lines.join("\n"));
    return lines;
  } finally {
    Object.assign(console, orig);
    Deno.chdir(origCwd);
    Object.defineProperty(Deno, "args", {
      value: origArgs,
      configurable: true,
    });
    await dropTempDir(dir);
  }
}

const said = (lines: string[]) =>
  lines.filter((l) => l.includes(firstUseKeyWarning("src/app.ts"))).length;

Deno.test("fleet summary: an entry that trusts its update key on first use is named once — one that ships the key is not", async () => {
  const source = `source: "https://releases.example.com/fuapp"`;
  assertEquals(
    said(await build(`aio.run({ cells: [], updates: { ${source} } });\n`)),
    1,
  );
  assertEquals(
    said(
      await build(
        `aio.run({ cells: [], updates: { ${source}, key: { kty: "OKP" } } });\n`,
      ),
    ),
    0,
  );
});

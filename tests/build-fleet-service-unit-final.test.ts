// The fleet says the FINAL truth about a service unit (v1.0.11 hunt, Y1).
//
// 1. The builder printed `✓ …/multi/multi-agent.service` — a staged path the
//    fleet then moved to `dist/multi-agent-<ver>.service`.
// 2. manifest.json recorded the unit's size at staging (1618), then
//    `placeServiceUnit` rewrote its install comment (1639 on disk) — the
//    manifest a release pipeline checks bytes against.
//
// The builder is stubbed (`--build-spec`), as in
// tests/build-fleet-placement-identity.test.ts: what is under test is what the
// orchestrator does with the artifacts.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildAll } from "../src/build-all.ts";
import { writeServiceFile } from "../src/build/build-compile.ts";
import { BUILD_VERSION_ENV } from "../src/server/app-version.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const STUB = `
const root = Deno.cwd();
const arg = (f) => Deno.args.find((a) => a.startsWith(f))?.slice(f.length);
const bin = arg("--name=").toLowerCase();
await Deno.writeTextFile(root + "/" + bin, "#!/bin/sh\\necho '" + bin + " 0.1.0 (aio 1.0.0-beta)'\\n");
await Deno.chmod(root + "/" + bin, 0o755);
await Deno.writeTextFile(root + "/" + bin + ".service",
  "# Adjust the path after install (sudo cp " + bin + " /usr/local/bin/" + bin + ").\\n" +
  "ExecStart=/usr/local/bin/" + bin + "\\n");
`;

Deno.test("fleet: manifest.json records every placed artifact's size ON DISK, after the unit's rewrite", async () => {
  const dir = await tempDir("aio-fleet-unit-bytes-");
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const origArgs = Deno.args;
  const origCwd = Deno.cwd();
  const lines: string[] = [];
  try {
    const stub = join(dir, "stub-build.ts");
    await Deno.writeTextFile(stub, STUB);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ title: "spapp", build: { targets: ["server"] } }),
    );
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "src", "app.ts"), "export {};\n");
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
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, "dist", "manifest.json")),
    ) as { targets: { artifacts: { file: string; bytes: number }[] }[] };
    const arts = manifest.targets.flatMap((t) => t.artifacts);
    const unit = arts.find((a) => a.file.endsWith(".service"));
    assert(unit, JSON.stringify(arts));
    assert(unit.file !== "spapp.service", "the unit was placed (renamed)");
    assert(arts.length >= 2, "the manifest lists the binary and the unit");
    for (const a of arts) {
      assertEquals(
        a.bytes,
        (await Deno.stat(join(dir, "dist", a.file))).size,
        `${a.file}: manifest bytes vs disk`,
      );
    }
  } finally {
    Object.assign(console, orig);
    Deno.chdir(origCwd);
    Object.defineProperty(Deno, "args", {
      value: origArgs,
      configurable: true,
    });
    await dropTempDir(dir);
  }
});

Deno.test("writeServiceFile under the fleet: the unit's path is said as STAGED, never as a finished ✓", async () => {
  const dir = await tempDir("aio-unit-staged-");
  const orig = console.log;
  const had = Deno.env.get(BUILD_VERSION_ENV);
  const out: string[] = [];
  try {
    Deno.env.set(BUILD_VERSION_ENV, JSON.stringify({ version: "0.1.0" }));
    console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    await writeServiceFile(
      {
        binaryName: "svc",
        appTitle: "Svc",
        outDir: dir,
        root: dir,
        doRemote: false,
        doHeadless: true,
      } as unknown as Parameters<typeof writeServiceFile>[0],
    );
    console.log = orig;
    // deno-lint-ignore no-control-regex
    const text = out.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert(text.includes("svc.service"), text);
    assert(text.includes("staged"), text);
    assert(!text.includes(`✓ ${join(dir, "svc.service")}`), text);
  } finally {
    console.log = orig;
    if (had === undefined) Deno.env.delete(BUILD_VERSION_ENV);
    else Deno.env.set(BUILD_VERSION_ENV, had);
    await dropTempDir(dir);
  }
});

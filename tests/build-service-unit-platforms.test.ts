// A `server` target built for several platforms (R6 hunt).
//
// The documented example — `"targets": ["server", "cli"], "platforms":
// ["host", "windows", "macos-arm64"]` — compiled every binary and then died
// with an uncaught `targets "server" and "server" both produce
// dist/<name>-<ver>-server.service`: every platform's unit was written as
// `<name>.service`, and a systemd unit was written for a Windows .exe and a
// Mach-O binary too. The stub builder calls the REAL `writeServiceFile`, so
// what is under test is the unit's name and the fleet's placement of it.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { buildAll } from "../src/build-all.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const COMPILE = toFileUrl(
  join(import.meta.dirname!, "..", "src", "build", "build-compile.ts"),
).href;
const PLATFORMS = toFileUrl(
  join(import.meta.dirname!, "..", "src", "build", "platforms.ts"),
).href;

const STUB = `
import { writeServiceFile } from ${JSON.stringify(COMPILE)};
import { artifactName, PLATFORMS } from ${JSON.stringify(PLATFORMS)};
const root = Deno.cwd();
const arg = (f) => Deno.args.find((a) => a.startsWith(f))?.slice(f.length);
const bin = arg("--name=").toLowerCase();
const platform = arg("--platform=");
await Deno.writeTextFile(root + "/" + artifactName(bin, platform), "#!/bin/sh\\n");
await writeServiceFile({
  binaryName: bin, appTitle: bin, root, outDir: root, doRemote: true,
  doHeadless: true, platform, os: PLATFORMS[platform].os,
});
`;

Deno.test("fleet: a server target built for several platforms places one unit per Linux binary", async () => {
  const dir = await tempDir("aio-fleet-unit-platforms-");
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const origArgs = Deno.args;
  const origCwd = Deno.cwd();
  const lines: string[] = [];
  try {
    const stub = join(dir, "stub-build.ts");
    await Deno.writeTextFile(stub, STUB);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        title: "spapp",
        // The stub imports the real builder, so the child needs aio's own
        // import map (it runs in this temp project, not in the repo).
        imports: JSON.parse(
          await Deno.readTextFile(
            join(import.meta.dirname!, "..", "deno.json"),
          ),
        ).imports,
        build: {
          targets: ["server"],
          platforms: ["host", "linux-arm64", "windows", "macos-arm64"],
        },
      }),
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
    const units = [...Deno.readDirSync(join(dir, "dist"))]
      .map((e) => e.name).filter((n) => n.endsWith(".service")).sort();
    // The host and linux-arm64 — never Windows or macOS.
    assertEquals(units.length, 2, units.join(", "));
    assert(units.some((u) => u.includes("linux-arm64")), units.join(", "));
    assert(!units.some((u) => /windows|macos/.test(u)), units.join(", "));
    // Each unit's install line names the binary of ITS platform, and the
    // summary tells the operator how to install every one of them.
    const said = lines.join("\n");
    for (const u of units) {
      assert(
        said.includes(
          `sudo cp ${join("dist", u)} /etc/systemd/system/spapp.service`,
        ),
        `no install steps for ${u}:\n${said}`,
      );
      const text = await Deno.readTextFile(join(dir, "dist", u));
      const armUnit = u.includes("linux-arm64");
      assertEquals(
        /sudo cp spapp-[^ ]*linux-arm64 /.test(text),
        armUnit,
        `${u}:\n${text}`,
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

Deno.test("fleet: the 'no longer holds' note names each dropped target once", async () => {
  // dist/manifest.json has one entry per target PER PLATFORM, so rebuilding
  // a three-platform project with a different target said "no longer holds
  // server, server, server" and suggested `--targets=server,server,server,…`.
  const dir = await tempDir("aio-fleet-dropped-once-");
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const origArgs = Deno.args;
  const origCwd = Deno.cwd();
  const lines: string[] = [];
  const setArgs = (value: string[]) =>
    Object.defineProperty(Deno, "args", { value, configurable: true });
  try {
    const stub = join(dir, "stub-build.ts");
    await Deno.writeTextFile(stub, STUB);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        title: "spapp",
        imports: JSON.parse(
          await Deno.readTextFile(
            join(import.meta.dirname!, "..", "deno.json"),
          ),
        ).imports,
        build: { platforms: ["host", "windows", "macos-arm64"] },
      }),
    );
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "src", "app.ts"), "export {};\n");
    Deno.chdir(dir);
    console.log = console.warn = console.error = (...a: unknown[]) =>
      void lines.push(a.map(String).join(" "));
    setArgs([`--build-spec=${stub}`, "--targets=server"]);
    assertEquals(await buildAll(), 0, lines.join("\n"));
    lines.length = 0;
    setArgs([`--build-spec=${stub}`, "--targets=server-app"]);
    assertEquals(await buildAll(), 0, lines.join("\n"));
    Object.assign(console, orig);
    // deno-lint-ignore no-control-regex
    const said = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert(said.includes("no longer holds server (built"), said);
    assert(
      said.includes("--targets=server,server-app\n") ||
        said.endsWith("--targets=server,server-app"),
      said,
    );
  } finally {
    Object.assign(console, orig);
    Deno.chdir(origCwd);
    setArgs(origArgs);
    await dropTempDir(dir);
  }
});

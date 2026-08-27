// `am fix` — "electron runtime installed" asks about the BINARY, via the
// framework's own installer, on both the check and the repair side.
//
// It used to test that `node_modules/electron` exists (true after any `deno
// install`, dist/ or not) and repair with the bare
// `deno install --allow-scripts=npm:electron` — the command known to exit 0
// having skipped the download. On the one-liner that read: "fixed · installed
// npm:electron", then the build: "electron is not installed", then every later
// `am fix`: "ok". Two of those three lines were false.
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const ROOT = dirname(fromFileUrl(import.meta.url)).replace(/\/tests$/, "");
const dec = new TextDecoder();

Deno.test("am fix: electron repair goes through electron-install.ts, never the bare deno install", async () => {
  const src = await Deno.readTextFile(join(ROOT, "src/am/am-cmd-fix.ts"));
  assert(
    !src.includes('"--allow-scripts=npm:electron"'),
    "am-cmd-fix.ts must not run the bare `deno install --allow-scripts` (skips the download, exits 0)",
  );
  assert(
    src.includes("electron-install.ts"),
    "repair = the framework installer",
  );
  assert(
    src.includes('"--check"'),
    "presence = the installer's --check, not a directory stat",
  );
});

Deno.test("electron-install.ts --check: exit 1 with no runtime, 0 with <pkg>/dist, no download", async () => {
  const installer = join(ROOT, "src/electron-install.ts");
  const check = (cwd: string) =>
    new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", installer, "--check"],
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
  const tmp = await Deno.makeTempDir();
  const none = await check(tmp);
  assertEquals(none.code, 1, dec.decode(none.stderr));
  assertEquals(dec.decode(none.stdout) + dec.decode(none.stderr), "", "silent");
  // The empty package: what a skipped lifecycle script leaves behind.
  await Deno.mkdir(join(tmp, "node_modules/electron"), { recursive: true });
  await Deno.writeTextFile(join(tmp, "node_modules/electron/install.js"), "");
  assertEquals(
    (await check(tmp)).code,
    1,
    "a package without dist/ is NOT installed",
  );
  await Deno.mkdir(join(tmp, "node_modules/electron/dist"));
  assertEquals((await check(tmp)).code, 0);
  // Deno's own layout, no top-level symlink.
  const tmp2 = await Deno.makeTempDir();
  await Deno.mkdir(
    join(tmp2, "node_modules/.deno/electron@1.0.0/node_modules/electron/dist"),
    { recursive: true },
  );
  assertEquals((await check(tmp2)).code, 0);
  await Deno.remove(tmp, { recursive: true });
  await Deno.remove(tmp2, { recursive: true });
});

// …and it only asks the question for an app that actually SHIPS Electron.
//
// The scaffold writes aio's whole import map into every new project —
// `aio/electron-install`, and `"electron": "npm:electron"` — browser-only apps
// included. `am fix` inferred "this is an Electron app" from that map, so the
// first repair a new browser app ever ran downloaded 334 MB of Electron
// runtime, declared `browser, electron` as its build targets and added
// electron tasks. Nothing the user did asked for any of it.
Deno.test("am fix: a browser-only app is never told it ships Electron", async () => {
  const { cmdFix } = await import("../src/am/am-cmd-fix.ts");
  const orig = Deno.cwd();
  const dir = await Deno.makeTempDir({ prefix: "am-fix-browser-" });
  const capture = async (fn: () => Promise<void>): Promise<string[]> => {
    const lines: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      await fn();
    } finally {
      console.log = real;
    }
    return lines;
  };
  try {
    // Exactly what `am create <name>` writes for the default target.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        client: "browser",
        build: { targets: ["browser"], platforms: ["host"], out: "dist" },
        imports: {
          "aio": "./dep/aio/mod.ts",
          // the scaffold's map, verbatim: these are aio's entry points, not
          // this app's dependencies
          "aio/electron-install": "./dep/aio/src/electron-install.ts",
          "electron": "npm:electron",
        },
        tasks: { dev: "deno run -A src/app.ts" },
      }),
    );
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "src", "app.ts"),
      `import { aio } from "aio";\nawait aio.run({ appId: "b" });\n`,
    );
    Deno.chdir(dir);
    const lines = await capture(() => cmdFix(["--dry-run"], { json: true }));
    const doc = JSON.parse(lines.at(-1)!) as {
      results: { name: string; note?: string }[];
    };
    const names = doc.results.map((r) => r.name);
    assert(
      !names.includes("electron runtime installed"),
      `a browser app must not be offered a 334 MB download: ${
        names.join(", ")
      }`,
    );
    assert(!names.includes('nodeModulesDir "auto"'), names.join(", "));
    const targets = doc.results.find((r) =>
      r.name === "declared build targets"
    );
    assertEquals(targets?.note, "browser", "electron is not in this fleet");
  } finally {
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true });
  }
});

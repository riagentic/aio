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

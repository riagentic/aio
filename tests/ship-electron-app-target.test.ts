// `--target=electron-app` is documented (docs/deploy/signing.md) and a member
// of RELEASE_TARGETS, but `ship` validated `--target=` against the FROZEN
// UPDATE_TARGETS — so the documented spelling was refused as "unknown", by the
// CLI and by the `shipApp` door alike.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { shipRelease } from "../src/build/ship.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const SHIP = new URL("../src/build/ship.ts", import.meta.url).pathname;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

async function fixture(): Promise<{ dir: string; archive: string }> {
  const dir = await tempDir("aio-ship-electron-app-");
  await Deno.mkdir(join(dir, "src"));
  await Deno.writeTextFile(join(dir, "src", "a.ts"), `fetch("x");`);
  const archive = join(dir, "app-1.0.0-mac-x64.app.tar.gz");
  // gzip magic — the shape a packed `.app` has.
  await Deno.writeFile(archive, new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0]));
  return { dir, archive };
}

Deno.test("ship: --target=electron-app is accepted by shipRelease (the door shipApp delegates to)", async () => {
  const { dir, archive } = await fixture();
  try {
    const m = await shipRelease({
      binaryPath: archive,
      sourceDir: join(dir, "src"),
      name: "app",
      version: "1.0.0",
      target: "electron-app",
      noData: true,
    });
    assertEquals(m.target as string, "electron-app");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("ship: --target=electron-app is accepted by the CLI", async () => {
  const { dir, archive } = await fixture();
  try {
    const r = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        CONFIG,
        SHIP,
        archive,
        "--target=electron-app",
        "--no-data",
        "--name=app",
        "--version=1.0.0",
        `--src=${join(dir, "src")}`,
      ],
      cwd: dir,
      env: { HOME: dir },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const err = new TextDecoder().decode(r.stderr);
    assertEquals(r.code, 0, err);
    const m = JSON.parse(await Deno.readTextFile(`${archive}.ship.json`));
    assertEquals(m.target, "electron-app");
  } finally {
    await dropTempDir(dir);
  }
});

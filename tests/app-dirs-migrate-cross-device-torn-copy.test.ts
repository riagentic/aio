// A cross-device legacy move that dies MID-COPY must not leave a torn
// database under the new name.
//
// `moveFile` copied straight onto the target. A death inside the copy left a
// truncated `state.db` beside the intact `data.db` — and the next boot saw the
// target already there, so it KEPT the legacy file ("state.db already exists,
// nothing was overwritten") and opened the torn copy as the app's database.
// The copy is now written under a temporary name and renamed into place (one
// rename, same directory) only once it is whole.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { appDirs } from "../src/server/app-dirs.ts";
import { migrateLegacyLayout } from "../src/server/app-dirs-migrate.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MIGRATE = new URL("../src/server/app-dirs-migrate.ts", import.meta.url)
  .href;
const DIRS = new URL("../src/server/app-dirs.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const APP_ID = "cross-device-torn-probe";

// Cross-device everywhere except within one directory (a real EXDEV only
// ever crosses filesystems); the database's copy dies halfway.
const MOVE = `
import { dirname } from "@std/path";
import { migrateLegacyLayout } from "${MIGRATE}";
import { appDirs } from "${DIRS}";
const ROOT = Deno.env.get("ROOT");
const rename = Deno.renameSync;
Deno.renameSync = (from, to) => {
  if (dirname(String(from)) === dirname(String(to))) return rename(from, to);
  const e = new Error("Invalid cross-device link (os error 18)");
  e.code = "EXDEV";
  throw e;
};
Deno.copyFileSync = (from, to) => {
  const bytes = Deno.readFileSync(from);
  Deno.writeFileSync(to, bytes.subarray(0, bytes.length >> 1));
  Deno.writeTextFileSync(ROOT + "/killed-at", String(to));
  Deno.kill(Deno.pid, "SIGKILL");
};
migrateLegacyLayout({
  appId: "${APP_ID}",
  dirs: appDirs("${APP_ID}", ROOT + "/home"),
  cwd: Deno.env.get("CWD"),
  legacyXdgDir: ROOT + "/xdg",
});
`;

Deno.test("migrate: a death mid cross-device copy never leaves a torn state.db to boot on", async () => {
  const root = await tempDir("aio-migrate-torn-copy-");
  try {
    const cwd = join(root, "project");
    await Deno.mkdir(cwd, { recursive: true });
    const whole = "D".repeat(64 * 1024);
    await Deno.writeTextFile(join(cwd, "data.db"), whole);
    await Deno.writeTextFile(join(root, "move.ts"), MOVE);
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, join(root, "move.ts")],
      env: { ROOT: root, CWD: cwd },
      stdout: "piped",
      stderr: "piped",
    }).output();
    await Deno.readTextFile(join(root, "killed-at")).catch(() => {
      throw new Error(
        `the kill never landed:\n${new TextDecoder().decode(out.stderr)}`,
      );
    });

    // The next boot, on one filesystem.
    const dirs = appDirs(APP_ID, join(root, "home"));
    migrateLegacyLayout({
      appId: APP_ID,
      dirs,
      cwd,
      legacyXdgDir: join(root, "xdg"),
    });
    assertEquals(
      (await Deno.readTextFile(dirs.stateDb)).length,
      whole.length,
      "state.db is the WHOLE legacy database, not the torn half",
    );
  } finally {
    await dropTempDir(root);
  }
});

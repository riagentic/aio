// The unsafe-unpack warning tells the user to relaunch as
// `TMPDIR=<home>/app <appimage>` — and the AppImage runtime cannot stage into a
// TMPDIR that does not exist. `ensureAppPayloadDir` (0700) existed for exactly
// this directory and nothing in src/ ever called it, so the advice named a
// path no one had created. Pin: when the warning fires, `<home>/app` exists,
// owner-only.
import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const appDirsUrl = new URL("../src/server/app-dirs.ts", import.meta.url).href;

Deno.test({
  name: "checkUnpackLocation: the TMPDIR it advises exists, 0700",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await tempDir("aio-unpack-advice-");
    try {
      // `/tmp` shape: a world-writable parent holding the "mount" whose
      // executable is the running one (so the AppImage counts as OURS).
      const shared = join(root, "shared");
      const mount = join(shared, "mnt");
      await Deno.mkdir(mount, { recursive: true });
      await Deno.chmod(shared, 0o777);
      const exe = join(mount, "deno");
      try {
        await Deno.link(Deno.realPathSync(Deno.execPath()), exe);
      } catch {
        // aio-ok: another filesystem — a copy is the same executable
        await Deno.copyFile(Deno.execPath(), exe);
        await Deno.chmod(exe, 0o755);
      }
      const home = join(root, "home");
      const out = await new Deno.Command(exe, {
        args: [
          "eval",
          `import { appDirs, checkUnpackLocation } from ${
            JSON.stringify(appDirsUrl)
          };` +
          `const d = appDirs("unpack-advice", ${JSON.stringify(home)});` +
          `console.log(JSON.stringify({ msg: checkUnpackLocation(d), app: d.app }));`,
        ],
        env: {
          PATH: Deno.env.get("PATH") ?? "",
          HOME: root,
          NO_COLOR: "1",
          APPIMAGE: join(root, "x.AppImage"),
          APPDIR: mount,
          DENO_DIR: Deno.env.get("DENO_DIR") ??
            join(Deno.env.get("HOME") ?? root, ".cache", "deno"),
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const text = new TextDecoder().decode(out.stdout).trim();
      assert(
        out.success,
        new TextDecoder().decode(out.stderr) || "child failed",
      );
      const { msg, app } = JSON.parse(text.split("\n").at(-1)!);
      assert(msg, "the warning must fire for a world-writable unpack parent");
      assert(String(msg).includes(`TMPDIR=${app}`), msg);
      const st = await Deno.stat(app);
      assert(
        st.isDirectory,
        `${app} must exist — the advice relaunches into it`,
      );
      assertEquals(st.mode! & 0o777, 0o700);
      assertEquals(dirname(app), home);
    } finally {
      await dropTempDir(root);
    }
  },
});

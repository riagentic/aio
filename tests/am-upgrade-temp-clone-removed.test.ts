// `am upgrade <app>` of an app installed from a git URL runs run.sh in a temp
// directory, where it clones and builds — and the artifact goes to the install
// root, outliving the clone. The clone (a whole build tree) was left in the
// temp directory after every upgrade, succeeded or failed.
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url));

for (const ok of [true, false]) {
  Deno.test(`am upgrade: the temp clone of a URL source is removed after a${ok ? " successful" : " failed"} build`, async () => {
    const root = await tempDir("aio-am-upgrade-clone-");
    try {
      const home = join(root, "home"), tmp = join(root, "tmp");
      const apps = join(root, "apps");
      await Deno.mkdir(home);
      await Deno.mkdir(tmp);
      await Deno.mkdir(join(apps, "demo"), { recursive: true });
      await Deno.writeTextFile(
        join(apps, "demo", "installed.json"),
        JSON.stringify({
          name: "demo",
          version: "1.0.0",
          source: "https://example.invalid/demo.git",
        }),
      );
      // A stand-in run.sh / run.ps1 (what `am upgrade` runs on Windows):
      // "clones" into its cwd, as the real one does.
      await Deno.writeTextFile(
        join(home, "run.sh"),
        `mkdir demo && echo built > demo/dist.bin && pwd > "${root}/cwd"\n` +
          (ok ? "" : "exit 7\n"),
      );
      await Deno.writeTextFile(
        join(home, "run.ps1"),
        `New-Item -ItemType Directory demo | Out-Null\n` +
          `Set-Content demo\\dist.bin built\n` +
          `(Get-Location).Path | Set-Content '${join(root, "cwd")}'\n` +
          (ok ? "" : "exit 7\n"),
      );
      const p = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          join(REPO, "deno.json"),
          join(REPO, "src", "am.ts"),
          "upgrade",
          "demo",
        ],
        env: {
          AIO_HOME: home,
          AIO_INSTALL_ROOT: apps,
          AIO_AM_NO_DELEGATE: "1",
          TMPDIR: tmp,
          TMP: tmp,
          TEMP: tmp,
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const said = new TextDecoder().decode(p.stdout) +
        new TextDecoder().decode(p.stderr);
      assertEquals(p.success, ok, said);
      const cwd = (await Deno.readTextFile(join(root, "cwd"))).trim();
      assert(cwd.startsWith(tmp), `run.sh ran in ${cwd}`);
      // The clone's dir, by its prefix: on Windows the temp dir is also the
      // runtime dir, where am keeps its lock registry (`.aio-roots`).
      assertEquals(
        [...Deno.readDirSync(tmp)].map((e) => e.name)
          .filter((n) => n.startsWith("aio-upgrade-")),
        [],
        said,
      );
      assert(cwd.includes("aio-upgrade-demo-"), cwd);
    } finally {
      await dropTempDir(root);
    }
  });
}

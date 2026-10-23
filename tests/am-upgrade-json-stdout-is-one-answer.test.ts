// `am upgrade <app> --json`: stdout is ONE JSON answer. run.sh's progress
// (forty lines of "· updating aio…", "✓ built …") was inherited onto stdout
// ahead of it, so `am upgrade <app> --json | jq` could not parse a byte.
import "./store-sandbox.ts";
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url));

Deno.test("am upgrade --json: run.sh's progress goes to stderr, stdout parses", async () => {
  const root = await tempDir("aio-am-upgrade-json-");
  try {
    const home = join(root, "home"), src = join(root, "src");
    const apps = join(root, "apps");
    await Deno.mkdir(home);
    await Deno.mkdir(src);
    await Deno.mkdir(join(apps, "demo"), { recursive: true });
    await Deno.writeTextFile(
      join(apps, "demo", "installed.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", source: src }),
    );
    await Deno.writeTextFile(join(home, "run.sh"), `echo "✓ built demo"\n`);
    await Deno.writeTextFile(
      join(home, "run.ps1"),
      `Write-Output "built demo"\n`,
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
        "--json",
      ],
      env: {
        AIO_HOME: home,
        AIO_INSTALL_ROOT: apps,
        AIO_AM_NO_DELEGATE: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(p.stdout);
    const stderr = new TextDecoder().decode(p.stderr);
    assertEquals(p.success, true, stdout + stderr);
    assertEquals(
      JSON.parse(stdout).upgraded,
      "demo",
      `stdout is not one JSON answer:\n${stdout}`,
    );
  } finally {
    await dropTempDir(root);
  }
});

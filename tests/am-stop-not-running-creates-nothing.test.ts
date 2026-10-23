// `am stop` of an app that is not running answers "not running" — and left
// the app's `logs/` folder behind (`stdoutLogPath` creates it), so every typo'd
// `am stop --app=x` put an `~/.x/` in the user's home.
import "./store-sandbox.ts";
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url));

Deno.test("am stop: a not-running app's data home is not created", async () => {
  const root = await tempDir("am-stop-nothing-");
  try {
    const apps = join(root, "apps");
    const p = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        join(REPO, "deno.json"),
        join(REPO, "src", "am.ts"),
        "stop",
        "--app=nosuchapp",
        "--json",
      ],
      cwd: root,
      env: { AIO_APPS_DIR: apps, AIO_AM_NO_DELEGATE: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(p.success, false, "a stop of nothing is a failure");
    const left = (() => {
      try {
        return [...Deno.readDirSync(apps)].map((e) => e.name);
      } catch {
        return [];
      }
    })();
    assertEquals(left.includes("nosuchapp"), false, `left: ${left}`);
  } finally {
    await dropTempDir(root);
  }
});
